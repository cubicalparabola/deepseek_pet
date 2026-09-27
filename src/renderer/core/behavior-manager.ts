/**
 * BehaviorManager —— 自动行为系统（显示状态 -> 随机动画池 / 随机小动作）。
 *
 * 关键约束（需求明确要求）：
 * BehaviorManager **不直接播放视频**，它只产生 Action Request：
 *
 *   { type: 'animation', animationId: 'roll', priority: 45, reason: 'random-pool:normal-random' }
 *
 * 然后交给 Action Pipeline -> StateMachine -> AnimationManager。
 *
 * 两个概念，别混（都由 `behavior.json` 驱动）：
 *
 *   **随机池**（`pools`）—— 空闲时替换掉默认动画
 *     正常状态      25–60 秒从 normal-random 池里随机挑一个（roll/hot/bomb/play/…）
 *
 *   **随机小动作**（`fidget`）—— 默认姿势**正在循环**时插一小段，播完回到同一个默认姿势
 *     下方收起      sleep 循环中随机时刻 -> 先播完 sleep 的 end -> lie ×N -> 回到 sleep
 *     右侧收起      watch 阶段同理 -> peek ×N -> 回到 watch
 *
 * 池与间隔、小动作与间隔全部来自 `behavior.json`（见 shared/behavior-config.ts），
 * 因此**新增动画 / 换间隔不需要改这个文件**。
 *
 * **心情过低时池子的内容被替换**（`behavior.json` 的 `sadPool`，需求原文：
 * "在心情低于阈值的时候，所有随机池的动画都变成 sad，高于阈值再变回来，
 * 收起状态的动画不受影响"）：心情 `<= moodBelow` 时，池里挑出来的那条一律换成
 * `sadPool.animation`；间隔/冷却照旧。**只换池，不碰默认姿势与 fidget** ——
 * 收起状态的 `sleep`/`watch`/`lie`/`peek` 完全不受影响（收起状态本来也没有池）。
 */

import type { PetAction } from '../../shared/action-types';
import {
  DEFAULT_BEHAVIOR_CONFIG,
  availableFidgetAnimations,
  availablePoolAnimations,
  defaultAnimationFor,
  fidgetFor,
  pickPoolAnimation,
  poolsFor,
  sadPoolAnimation,
  type BehaviorConfig,
  type BehaviorPool,
  type DisplayStateId,
  type FidgetConfig,
} from '../../shared/behavior-config';
import { PetEvents } from '../../shared/events';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import type { EventBus } from './event-bus';

export interface BehaviorManagerOptions {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  /** 把 Action 投递到 Pipeline。 */
  readonly dispatch: (action: PetAction) => void;
  /** 当前状态（用于"只在空闲时触发随机动画"判定）。 */
  readonly getState: () => string;
  /** 当前显示状态（收起方向 / 隐藏）——决定用哪个池。 */
  readonly getDisplayState: () => DisplayStateId;
  /** 随机池与间隔配置。 */
  readonly config?: BehaviorConfig;
  /** 已知动画 id（池里引用了不存在的动画时跳过并告警）。 */
  readonly getKnownAnimations?: () => ReadonlySet<string>;
  /**
   * 当前正在播的动画 id / 持续动画所处阶段。
   *
   * 只有"随机小动作"（fidget）需要它们：它必须**插在默认姿势的循环段里**
   * （`lie` 要在 `sleep` 过程中、`peek` 要在 `watch` 阶段），
   * 详见 `tickFidget()`。
   */
  readonly getCurrentAnimation?: () => string | null;
  readonly getPersistentPhase?: () => 'start' | 'loop' | 'end' | null;
  /**
   * 当前心情（0–100）。心情过低时随机池整体换成 `sadPool.animation`。
   *
   * 心情住在主进程（要持久化、要按在场状态衰减），渲染层只是**跟着最新的状态推送走**
   * （见 Renderer 里对 `ai.onStatus` 的订阅）——这里只读缓存，不做任何 IPC。
   */
  readonly getMood?: () => number;
  /** 调度精度（毫秒），默认 1000。 */
  readonly tickMs?: number;
  /** 注入随机源（验收可以固定它，让"随机"可复现）。 */
  readonly random?: () => number;
}

interface PoolRuntime {
  readonly pool: BehaviorPool;
  readonly state: DisplayStateId;
  /**
   * 这个池**本次生效**的动画列表。
   *
   * 平时就是池自己的 `animations`；心情过低时会被换成 `['sad']`。
   * 池本身（`pool`）始终保留，因此 `intervalMs` / `cooldownMs` / `onlyWhenIdle`
   * 这些"多久动一次"的语义完全不参与替换 —— 换的只是"动的时候演什么"。
   */
  animations: readonly string[];
  nextAt: number;
}

/** "随机小动作"的运行时（在一段默认姿势里插一小段，播完回到默认姿势）。 */
interface FidgetRuntime {
  readonly state: DisplayStateId;
  readonly config: FidgetConfig;
  /** 这个状态的默认姿势 id（`sleep` / `watch`）。 */
  readonly defaultAnimation: string;
  /** 可播的小动作（已过滤掉清单里不存在的）。 */
  animations: readonly string[];
  /** 下次触发的时刻；0 = 还没排期。 */
  nextAt: number;
}

export class BehaviorManager {
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly dispatch: (action: PetAction) => void;
  private readonly getState: () => string;
  private readonly getDisplayState: () => DisplayStateId;
  private readonly getKnownAnimations: (() => ReadonlySet<string>) | undefined;
  private readonly getCurrentAnimation: (() => string | null) | undefined;
  private readonly getPersistentPhase: (() => 'start' | 'loop' | 'end' | null) | undefined;
  private readonly getMood: (() => number) | undefined;
  private readonly tickMs: number;
  private readonly random: () => number;
  private config: BehaviorConfig;

  private runtimes: PoolRuntime[] = [];
  /** 当前显示状态的"随机小动作"（没有配置 = null）。 */
  private fidget: FidgetRuntime | null = null;
  private timer: number | null = null;
  private paused = false;
  private lastInteractionAt = Date.now();
  private lastGlobalTriggerAt = 0;
  /** 上一次构建运行时的显示状态：变化时重建并重新排期。 */
  private builtForState: DisplayStateId | null = null;
  /** 上一次构建时已知的动画集合（插件注册新动画后要重建）。 */
  private knownSignature = '';
  /** 上一次构建时"心情过低"是否生效（跨越阈值时立刻重建，见 `tick()`）。 */
  private sadActive = false;

  public constructor(options: BehaviorManagerOptions) {
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.dispatch = options.dispatch;
    this.getState = options.getState;
    this.getDisplayState = options.getDisplayState;
    this.getKnownAnimations = options.getKnownAnimations;
    this.getCurrentAnimation = options.getCurrentAnimation;
    this.getPersistentPhase = options.getPersistentPhase;
    this.getMood = options.getMood;
    this.tickMs = options.tickMs ?? 1000;
    this.random = options.random ?? Math.random;
    this.config = options.config ?? DEFAULT_BEHAVIOR_CONFIG;
    this.rebuild();
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  public start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        // 行为调度异常不能影响桌宠主体
        this.logger.error('behavior scheduling error', { error: describeError(error) });
      }
    }, this.tickMs);
    this.logger.info('behavior system started', {
      data: { state: this.getDisplayState(), pools: this.runtimes.map((r) => r.pool.id).join(',') },
    });
  }

  public stop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
    this.logger.info('behavior system stopped');
  }

  public pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.eventBus.emit(PetEvents.BehaviorPaused, { paused: true });
    this.logger.info('behaviors paused');
  }

  public resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // 恢复后重新排期，避免"暂停期间积累"导致瞬间连续触发
    this.reschedule();
    this.eventBus.emit(PetEvents.BehaviorPaused, { paused: false });
    this.logger.info('behaviors resumed');
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public toggle(): boolean {
    if (this.paused) this.resume();
    else this.pause();
    return this.paused;
  }

  /** 用户交互后调用：重置"多久没互动"的计时（随机动画会避开刚互动完的时刻）。 */
  public notifyInteraction(): void {
    this.lastInteractionAt = Date.now();
  }

  /** 换一份池配置（设置界面改完随机间隔时调用）。 */
  public setConfig(config: BehaviorConfig): void {
    this.config = config;
    this.rebuild();
    this.logger.info('behavior config applied', { data: { pools: this.runtimes.length } });
  }

  public getConfig(): BehaviorConfig {
    return this.config;
  }

  /** 当前生效的池（调试/验收：回答"现在这个状态会随机播什么"）。 */
  public describePools(): readonly {
    readonly poolId: string;
    readonly state: DisplayStateId;
    readonly animations: readonly string[];
    readonly intervalMs: readonly [number, number];
    readonly nextInMs: number;
  }[] {
    const now = Date.now();
    return this.runtimes.map((runtime) => ({
      poolId: runtime.pool.id,
      state: runtime.state,
      // 心情过低时这里就是 ['sad'] —— 界面上"现在会随机播什么"必须和真实行为一致
      animations: runtime.animations,
      intervalMs: runtime.pool.intervalMs,
      nextInMs: Math.max(0, runtime.nextAt - now),
    }));
  }

  /**
   * 心情过低 -> 随机池换 sad，是否正在生效。（调试/验收用）
   */
  public isSadPool(): boolean {
    return this.sadActive;
  }

  /** 当前心情与阈值（调试/验收：解释上面那个布尔值为什么是它）。 */
  public describeSadPool(): {
    readonly active: boolean;
    readonly mood: number;
    readonly moodBelow: number;
    readonly animation: string;
    readonly enabled: boolean;
  } {
    const rule = this.config.sadPool;
    return {
      active: this.sadActive,
      mood: this.currentMood(),
      moodBelow: rule?.moodBelow ?? 0,
      animation: rule?.animation ?? '',
      enabled: rule?.enabled === true,
    };
  }

  /** 当前生效的"随机小动作"（没有 = null）。调试/验收用。 */
  public describeFidget(): {
    readonly state: DisplayStateId;
    readonly defaultAnimation: string;
    readonly animations: readonly string[];
    readonly intervalMs: readonly [number, number];
    readonly nextInMs: number;
  } | null {
    const fidget = this.fidget;
    if (!fidget) return null;
    return {
      state: fidget.state,
      defaultAnimation: fidget.defaultAnimation,
      animations: fidget.animations,
      intervalMs: fidget.config.intervalMs,
      nextInMs: fidget.nextAt === 0 ? 0 : Math.max(0, fidget.nextAt - Date.now()),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 调度                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 按当前显示状态重建运行时（池 -> 运行条目）。
   *
   * 每次显示状态变化都重建并**重新排期**：
   * 收起时不该继承"正常状态已经等了一半"的计时（收起后立刻就蹦一下会很怪）。
   */
  private rebuild(): void {
    this.builtForState = this.getDisplayState();
    const known = this.getKnownAnimations?.();
    this.knownSignature = known ? [...known].sort().join(',') : '';

    /*
     * 心情过低 -> 池里挑出来的那条换成 sad（需求）。
     *
     * 只在**这一层**做替换，所以：
     * - `intervalMs` / `cooldownMs` / `onlyWhenIdle` / `persistentLoopCountRange` 全部照旧；
     * - `fidget` 与默认姿势完全不走这里 —— 收起状态不受影响；
     * - 换出来的动画如果清单里没有（有人删了 sad），就当规则不生效并记一条日志，
     *   而不是留下一个"永远挑不出动画"的空池。
     */
    const sadCandidate = sadPoolAnimation(this.config, this.currentMood());
    const sadAnimation = sadCandidate !== null && (known === undefined || known.has(sadCandidate))
      ? sadCandidate
      : null;
    if (sadCandidate !== null && sadAnimation === null) {
      this.logger.warn('sad pool animation is not registered; keeping the normal pool', {
        data: { animation: sadCandidate },
      });
    }
    const sadNow = sadAnimation !== null;
    if (sadNow !== this.sadActive && this.builtForState !== null) {
      this.logger.info('sad pool mode changed', {
        data: { active: sadNow, mood: this.currentMood(), animation: sadCandidate ?? '' },
      });
    }
    this.sadActive = sadNow;

    const runtimes: PoolRuntime[] = [];
    for (const pool of poolsFor(this.config, this.builtForState)) {
      const animations = sadAnimation !== null
        ? [sadAnimation]
        : known
          ? availablePoolAnimations(pool, known)
          : pool.animations;
      if (animations.length === 0) {
        this.logger.warn('random pool has no usable animation; skipped', {
          data: { poolId: pool.id, state: this.builtForState },
        });
        continue;
      }
      runtimes.push({
        pool,
        state: this.builtForState,
        animations,
        nextAt: Date.now() + (pool.initialDelayMs ?? pool.intervalMs[0]),
      });
    }
    this.runtimes = runtimes;
    this.fidget = this.buildFidget(this.builtForState, known);
    this.logger.info('behavior pools ready', {
      data: {
        state: this.builtForState,
        pools: runtimes.map((runtime) => `${runtime.pool.id}(${runtime.animations.length})`).join(','),
        sad: sadAnimation ?? 'off',
        fidget: this.fidget
          ? `${this.fidget.defaultAnimation}->${this.fidget.animations.join('/')}`
          : 'none',
      },
    });
  }

  /** 当前心情（拿不到就当"正常"，即不触发 sad 池）。 */
  private currentMood(): number {
    const mood = this.getMood?.();
    return typeof mood === 'number' && Number.isFinite(mood) ? mood : 100;
  }

  /**
   * "心情过低"此刻是否应该生效。
   *
   * 与 `rebuild()` 里的判定保持同一套条件（规则命中 **且** 那条动画真的存在），
   * 否则会出现"每一 tick 都认为该重建"的死循环。
   */
  private sadShouldBe(): boolean {
    const candidate = sadPoolAnimation(this.config, this.currentMood());
    if (candidate === null) return false;
    const known = this.getKnownAnimations?.();
    return known === undefined || known.has(candidate);
  }

  /**
   * 组装"随机小动作"运行时。
   *
   * 三个必要条件缺一不可，缺了就当作没有小动作（而不是留下一个永远不会触发的运行时）：
   *   1. 这个状态配了 `fidget`；
   *   2. 它有**默认姿势**（隐藏状态是 null，没有"过程中"可言）；
   *   3. 小动作里至少有一条在清单里真实存在。
   */
  private buildFidget(state: DisplayStateId, known: ReadonlySet<string> | undefined): FidgetRuntime | null {
    const config = fidgetFor(this.config, state);
    if (!config) return null;
    const defaultAnimation = defaultAnimationFor(this.config, state);
    if (defaultAnimation === null) return null;
    const animations = known ? availableFidgetAnimations(config, known) : config.animations;
    if (animations.length === 0) {
      this.logger.warn('fidget has no usable animation; skipped', {
        data: { state, animations: config.animations.join(',') },
      });
      return null;
    }
    return { state, config, defaultAnimation, animations, nextAt: 0 };
  }

  private reschedule(): void {
    const now = Date.now();
    for (const runtime of this.runtimes) {
      runtime.nextAt = now + this.randomBetween(runtime.pool.intervalMs[0], runtime.pool.intervalMs[1]);
    }
  }

  /** 显示状态变了（收起/展开/隐藏）时由渲染层调用。 */
  public onDisplayStateChanged(): void {
    const state = this.getDisplayState();
    if (state === this.builtForState && this.signatureUnchanged()) return;
    this.rebuild();
  }

  private signatureUnchanged(): boolean {
    const known = this.getKnownAnimations?.();
    if (!known) return true;
    return [...known].sort().join(',') === this.knownSignature;
  }

  private tick(): void {
    if (this.paused) return;
    // 显示状态/动画清单可能在两次 tick 之间变了（收起、插件注册新动画）
    if (this.getDisplayState() !== this.builtForState || !this.signatureUnchanged()) {
      this.rebuild();
    } else if (this.sadShouldBe() !== this.sadActive) {
      /*
       * 心情跨过阈值：**立刻**生效，而不是等下一个池触发（池要 25–60 秒才动一次）。
       * 重建会重新排期，所以"刚好在阈值上下抖动"最多让下一次随机动作晚十几秒，
       * 不会出现连续触发。
       */
      this.rebuild();
    }

    const now = Date.now();
    const state = this.getState();

    for (const runtime of this.runtimes) {
      if (now < runtime.nextAt) continue;
      // 正在播动画时顺延：随机动作不该打断用户正在看的反应
      if (runtime.pool.onlyWhenIdle !== false && state !== 'IDLE') {
        runtime.nextAt = now + 2000;
        continue;
      }

      const cooldown = runtime.pool.cooldownMs ?? 0;
      if (cooldown > 0 && now - this.lastGlobalTriggerAt < cooldown) {
        this.logger.debug('random pool in global cooldown; deferred', { data: { poolId: runtime.pool.id } });
        continue;
      }

      this.trigger(runtime, now);
    }

    this.tickFidget(now);
  }

  /**
   * "随机小动作"调度：在一段默认姿势里，随机挑个时刻插一小段。
   *
   * 门槛是**当前正在播的就是这个状态的默认姿势、且已经在循环段**。这一条同时表达了
   * 两条需求语义：
   *   - `lie` 在 `sleep` 过程中触发 → 收起在下方、`sleep` 正在 loop；
   *   - `peek` 只在 `watch` 阶段触发 → 收起在右侧、`watch` 正在 loop。
   *
   * 为什么要求 loop 段：`start` 段是"刚趴下/刚探头"的那一两秒，在这里打断会变成
   * 「刚趴下就爬起来」，所以只在稳定循环之后才允许插入。
   *
   * 不在门槛内时把排期清零：下次真正进入默认姿势时**重新随机**一个时刻，
   * 而不是"攒着"一个早就该触发的计时（否则一展开就会立刻插一段）。
   */
  private tickFidget(now: number): void {
    const fidget = this.fidget;
    if (!fidget) return;

    const playing = this.getCurrentAnimation?.() ?? null;
    const phase = this.getPersistentPhase?.() ?? null;
    if (playing !== fidget.defaultAnimation || phase !== 'loop') {
      fidget.nextAt = 0;
      return;
    }

    if (fidget.nextAt === 0) {
      const delay = this.randomBetween(fidget.config.intervalMs[0], fidget.config.intervalMs[1]);
      fidget.nextAt = now + delay;
      this.logger.info('fidget scheduled', {
        data: {
          state: fidget.state,
          animations: fidget.animations.join('/'),
          inMs: delay,
        },
      });
      return;
    }
    if (now < fidget.nextAt) return;

    const index = Math.min(fidget.animations.length - 1, Math.max(0, Math.floor(this.random() * fidget.animations.length)));
    const animationId = fidget.animations[index] ?? null;
    // 无论成功与否都重新排期：下一次触发要重新随机一个时刻
    fidget.nextAt = 0;
    if (!animationId) return;

    const reason = `fidget:${fidget.state}`;
    /*
     * 以 `interrupt: 'auto'` 投递：默认姿势是持续动画，于是 AnimationManager 会
     * **先让它播完 end 段**，再把这一小段接上（需求："先播放完 sleep 的 end 再播放 lie"）。
     * 播完之后由"动画结束 -> 回 IDLE -> resumeFallbackLoop"接回同一个默认姿势。
     */
    const action: PetAction = {
      type: 'animation',
      animationId,
      source: 'behavior',
      reason,
      ...(fidget.config.loopCountRange ? { loopCountRange: fidget.config.loopCountRange } : {}),
      metadata: { fidget: fidget.state, defaultAnimation: fidget.defaultAnimation },
    };
    this.lastGlobalTriggerAt = now;
    this.logger.info('fidget triggered', {
      data: {
        state: fidget.state,
        animationId,
        defaultAnimation: fidget.defaultAnimation,
        loopCountRange: fidget.config.loopCountRange?.join('-') ?? 'definition',
      },
    });
    this.eventBus.emit(PetEvents.BehaviorTriggered, { animationId, reason });
    this.dispatch(action);
  }

  private trigger(runtime: PoolRuntime, now: number): void {
    runtime.nextAt = now + this.randomBetween(runtime.pool.intervalMs[0], runtime.pool.intervalMs[1]);
    this.lastGlobalTriggerAt = now;

    // 池内等概率（或按 weights 加权）挑一个
    const animationId = pickPoolAnimation(
      { ...runtime.pool, animations: runtime.animations },
      this.random,
    );
    if (!animationId) {
      this.logger.warn('random pool produced no animation; skipped', { data: { poolId: runtime.pool.id } });
      return;
    }

    const reason = `random-pool:${runtime.pool.id}`;
    const action: PetAction = {
      type: 'animation',
      animationId,
      source: 'behavior',
      reason,
      // 池里的三段式动画压成一两轮（见 BehaviorPool.persistentLoopCountRange）
      ...(runtime.pool.persistentLoopCountRange
        ? { loopCountRange: runtime.pool.persistentLoopCountRange }
        : {}),
      metadata: {
        poolId: runtime.pool.id,
        state: runtime.state,
        elapsedSinceInteractionMs: now - this.lastInteractionAt,
      },
    };

    this.logger.info(`random animation triggered ${animationId}`, {
      data: {
        poolId: runtime.pool.id,
        state: runtime.state,
        nextInMs: runtime.nextAt - now,
        intervalMs: `${runtime.pool.intervalMs[0]}-${runtime.pool.intervalMs[1]}`,
      },
    });
    this.eventBus.emit(PetEvents.BehaviorTriggered, { animationId, reason });
    this.dispatch(action);
  }

  private randomBetween(min: number, max: number): number {
    if (!Number.isFinite(min)) return 1000;
    if (!Number.isFinite(max) || max <= min) return min;
    return Math.round(min + this.random() * (max - min));
  }
}
