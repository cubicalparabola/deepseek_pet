/**
 * BehaviorManager —— 自动行为系统（显示状态 -> 随机动画池）。
 *
 * 关键约束（需求明确要求）：
 * BehaviorManager **不直接播放视频**，它只产生 Action Request：
 *
 *   { type: 'animation', animationId: 'roll', priority: 45, reason: 'random-pool:normal-random' }
 *
 * 然后交给 Action Pipeline -> StateMachine -> AnimationManager。
 *
 * 这一版把"随机动画"从"一串写死的行为条目"改成**池 + 显示状态**（需求 6.2）：
 *
 *   正常状态      25–60 秒从 normal-random 池里随机挑一个（roll/hot/bomb/lie/play/…）
 *   下方收起      3–8 分钟，池里只有 sleep
 *   右侧收起      3–8 分钟，池里只有 peek
 *   隐藏          没有池（窗口都看不见了，不该再耗电）
 *
 * 池与间隔全部来自 `behavior.json`（见 shared/behavior-config.ts），
 * 因此**新增动画 / 换间隔不需要改这个文件**。
 */

import type { PetAction } from '../../shared/action-types';
import {
  DEFAULT_BEHAVIOR_CONFIG,
  availablePoolAnimations,
  pickPoolAnimation,
  poolsFor,
  type BehaviorConfig,
  type BehaviorPool,
  type DisplayStateId,
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
  /** 调度精度（毫秒），默认 1000。 */
  readonly tickMs?: number;
  /** 注入随机源（验收可以固定它，让"随机"可复现）。 */
  readonly random?: () => number;
}

interface PoolRuntime {
  readonly pool: BehaviorPool;
  readonly state: DisplayStateId;
  /** 该池可用的动画（已过滤掉清单里不存在的）。 */
  animations: readonly string[];
  nextAt: number;
}

export class BehaviorManager {
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly dispatch: (action: PetAction) => void;
  private readonly getState: () => string;
  private readonly getDisplayState: () => DisplayStateId;
  private readonly getKnownAnimations: (() => ReadonlySet<string>) | undefined;
  private readonly tickMs: number;
  private readonly random: () => number;
  private config: BehaviorConfig;

  private runtimes: PoolRuntime[] = [];
  private timer: number | null = null;
  private paused = false;
  private lastInteractionAt = Date.now();
  private lastGlobalTriggerAt = 0;
  /** 上一次构建运行时的显示状态：变化时重建并重新排期。 */
  private builtForState: DisplayStateId | null = null;
  /** 上一次构建时已知的动画集合（插件注册新动画后要重建）。 */
  private knownSignature = '';

  public constructor(options: BehaviorManagerOptions) {
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.dispatch = options.dispatch;
    this.getState = options.getState;
    this.getDisplayState = options.getDisplayState;
    this.getKnownAnimations = options.getKnownAnimations;
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
      animations: runtime.animations,
      intervalMs: runtime.pool.intervalMs,
      nextInMs: Math.max(0, runtime.nextAt - now),
    }));
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

    const runtimes: PoolRuntime[] = [];
    for (const pool of poolsFor(this.config, this.builtForState)) {
      const animations = known ? availablePoolAnimations(pool, known) : pool.animations;
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
    this.logger.info('behavior pools ready', {
      data: {
        state: this.builtForState,
        pools: runtimes.map((runtime) => `${runtime.pool.id}(${runtime.animations.length})`).join(','),
      },
    });
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
