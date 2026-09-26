/**
 * AnimationManager —— 动画播放的唯一入口（第一优先级模块）。
 *
 * 业务代码永远不写：
 *     video.src = 'coffee.webm'; video.play();
 * 而是：
 *     animationManager.play('coffee', { reason: 'user-tap' })
 *
 * 职责：
 * - 持有动画定义注册表（来自 assets/config/animations.json，可由插件注册临时动画）；
 * - 统一裁决 **优先级 / interruptible / 冷却 / 排队**，业务代码不得自己判断；
 * - 统一监听 <video> 的 ended / error，并发布 animation:end / animation:error；
 * - 统一做背景扣除（premultiplied-alpha 黑底素材 -> 真实透明）；
 * - 播放细节（图层切换、循环、class）全部封装在本类内。
 *
 * 明确不负责：状态迁移（那是 StateMachine 的职责）、事件语义（EventBus 的职责）。
 */

import {
  ANIMATION_DEFAULTS,
  inferAnimationCategory,
  resolvePlayLoopCount,
  type AnimationDefinition,
  type AnimationRenderOptions,
  type InterruptPolicy,
  type PersistentPhase,
  type PlayOptions,
  type PlayRejectionReason,
  type PlayResult,
  type ResolvedAnimation,
} from '../../shared/animation-types';
import { AnimationError, describeError } from '../../shared/errors';
import { PetEvents } from '../../shared/events';
import type { Logger } from '../../shared/logger';
import type { EventBus } from './event-bus';
import type { PetLayers } from './layers';

export interface AnimationManagerOptions {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly layers: PetLayers;
  /** 把 assets 相对路径解析为可用 URL（由 preload 提供）。 */
  readonly resolveAsset: (relativePath: string) => string;
  /**
   * "安静模式"策略：桌宠处于**收起（贴边）**状态时允许演哪些动画。
   *
   * 返回 `null` = 没有限制（正常状态 / 隐藏）；否则只允许 `allowed` 里的 id，
   * 其它自动来源（system / behavior / plugin / ai）的请求一律拒 `'docked'`。
   * **用户明确点的**（`source: 'user'`）不受限。
   *
   * 为什么必须在这一层拦（实测真 bug）：收起状态的默认姿势是 watch / lie（三段式）。
   * 只要有别的动画被请求（例如自愈链路硬编码回 idle、插件、AI），
   * 就会 `watch -> end -> 别的动画`；而那条动画若自己循环（idle 就是），
   * 她就停在"没收起的样子"，再被 `resumeFallbackLoop` 接回默认又是一次 end ——
   * 表现就是**end 一直循环、回不到 idle**。
   *
   * `allowed` 里除了默认姿势，还必须包含**该状态自己的随机池**（下方收起 = sleep、
   * 右侧收起 = peek）—— 需求要求"收起的随机动画只有一个、随机时间触发"，
   * 那是收起状态的一部分，不能被这条规则挡掉。
   */
  readonly getQuietPolicy?: () => { readonly allowed: readonly string[] } | null;
}

interface ActivePlayback {
  readonly animation: ResolvedAnimation;
  readonly priority: number;
  readonly reason: string;
  readonly source: string;
  readonly startedAt: number;
  /** 打断令牌：只有当前令牌的 ended/error 才被采信，避免竞态。 */
  readonly token: number;
  /** 持续动画当前处于哪一段；一次性动画恒为 null。 */
  persistentPhase: PersistentPhase | null;
  /** 循环段已经播完几轮。 */
  loopCycles: number;
  /**
   * 这次播放实际要循环几轮（进入 loop 段时随机定下，之后不再变）。
   * `0` = 无限循环（只在中途被打断或外部请求结束时才进收尾段）。
   */
  loopTarget: number;
  /**
   * 这次播放用的 loop 标志（`PlayOptions.loop` 覆盖优先）。
   *
   * 用途：状态的**默认动画**要把一条"一次性"素材循环起来（例如"下方收起"的 lie），
   * 而同一个 id 在随机池里又只该播一遍 —— 循环与否由播放参数决定，不由定义决定。
   */
  loop: boolean;
  /** 这次播放的"循环几轮"覆盖（`'forever'` = 无限；见 `PlayOptions.loopCountRange`）。 */
  loopCountRange: readonly [number, number] | 'forever' | undefined;
  /** 已经请求结束（等本轮循环播完就转收尾），避免重复触发。 */
  endingRequested: boolean;
}

interface QueuedRequest {
  readonly animationId: string;
  readonly options: PlayOptions;
}

/**
 * "等持续动画收尾段播完再播"的挂起请求。
 *
 * 需求："播放 loop 时被点击或者触发其它动画时播放 end，再播放其它动画。"
 * 只存一条（连点/连续触发只保留最后一次意图），由 `finishActive` 在收尾段结束时接上。
 */
interface PendingRequest {
  readonly animationId: string;
  readonly options: PlayOptions;
  readonly priority: number;
}

/**
 * 持续动画切段的交叉淡化时长（毫秒）。
 *
 * 三段素材是分开做的，衔接帧不同，硬切会有可见跳变（实测：逐帧录制无空帧、
 * 两段 alpha 一致，纯粹是画面差异）。用一小段交叉淡化把跳变抹掉。
 * 太短盖不住跳变，太长会看出"两个画面叠在一起"，140ms 是实测观感较自然的值。
 */
const SEGMENT_CROSSFADE_MS = 140;

export class AnimationManager {
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly layers: PetLayers;
  private readonly resolveAsset: (relativePath: string) => string;
  private readonly getQuietPolicy: (() => { readonly allowed: readonly string[] } | null) | undefined;

  private readonly registry = new Map<string, ResolvedAnimation>();
  private active: ActivePlayback | null = null;
  private readonly lastPlayedAt = new Map<string, number>();
  private queue: QueuedRequest | null = null;
  /** "等持续动画收尾段播完再播"的挂起请求（见 requestAnimation 第 5 步）。 */
  private pendingAfterEnd: PendingRequest | null = null;
  /**
   * 收尾段抖动看门狗：`animationId -> 最近几次进入 end 段的时间戳`。
   *
   * 用途：三段式动画"进 end"本应是一次性的（离开这个状态时才播）。
   * 如果同一条动画在短时间内反复进 end，说明有调用方在**重复请求**它 ——
   * 那正是"end 一直循环、回不到 idle"的病根。这里做**熔断**：
   * 触发阈值后不再延迟，直接让位给新请求，保证桌宠不会卡在收尾段里。
   */
  private readonly endEntries = new Map<string, number[]>();

  private tokenCounter = 0;
  /** 非循环动画的结束看门狗（ended 事件丢失时兜底）。 */
  private completionTimer: number | null = null;
  /** 持续动画"循环到片尾"的 rAF 轮询句柄。 */
  private loopEdgeFrame: number | null = null;
  /** 当前循环段的精确时长（由 media-meta 的 fps/帧数推算，用于判定"这一轮播完了"）。 */
  private loopSegmentDuration = 0;
  private paused = false;
  private fallbackId: string | null = null;
  private bound = false;

  public constructor(options: AnimationManagerOptions) {
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.layers = options.layers;
    this.resolveAsset = options.resolveAsset;
    this.getQuietPolicy = options.getQuietPolicy;
    this.bindVideoEvents();
  }

  /* ------------------------------------------------------------------ */
  /* 注册表                                                              */
  /* ------------------------------------------------------------------ */

  /** 注册/覆盖动画定义。返回是否成功（重复 id 覆盖并告警，不抛异常给调用方）。 */
  public registerAnimation(animation: AnimationDefinition): boolean {
    const resolved = this.normalize(animation);
    if (!resolved) return false;
    if (this.registry.has(resolved.id)) {
      this.logger.warn('animation definition overridden', { data: { id: resolved.id } });
    }
    this.registry.set(resolved.id, resolved);
    if (resolved.fallback === true || this.fallbackId === null) {
      this.fallbackId = resolved.fallback === true ? resolved.id : (this.fallbackId ?? resolved.id);
    }
    return true;
  }

  /** 批量注册（来自 Manifest）。返回成功注册的数量。 */
  public registerAll(animations: readonly AnimationDefinition[]): number {
    let count = 0;
    for (const animation of animations) {
      if (this.registerAnimation(animation)) count += 1;
    }
    this.logger.info('animations registered', { data: { total: this.registry.size } });
    return count;
  }

  public getDefinition(animationId: string): AnimationDefinition | null {
    return this.registry.get(animationId) ?? null;
  }

  public list(): readonly string[] {
    return [...this.registry.keys()];
  }

  public getFallbackId(): string | null {
    return this.fallbackId;
  }

  public setFallbackId(animationId: string): void {
    if (!this.registry.has(animationId)) {
      this.logger.warn('fallback animation not registered; ignored', { data: { animationId } });
      return;
    }
    this.fallbackId = animationId;
  }

  private normalize(animation: AnimationDefinition): ResolvedAnimation | null {
    if (!animation || typeof animation.id !== 'string' || animation.id.trim() === '') {
      this.logger.error('registerAnimation: invalid id');
      return null;
    }
    if (animation.type !== 'video' && animation.type !== 'image') {
      this.logger.error('registerAnimation: unsupported type', { data: { id: animation.id, type: animation.type } });
      return null;
    }
    if (typeof animation.source !== 'string' || animation.source.trim() === '') {
      this.logger.error('registerAnimation: missing source', { data: { id: animation.id } });
      return null;
    }
    // 形态推导与 Manifest 校验保持一致：有 segments 就是持续动画
    const kind = animation.kind ?? (animation.segments !== undefined ? 'persistent' : 'one-shot');

    return {
      ...animation,
      kind,
      category: inferAnimationCategory(animation),
      loop: animation.loop ?? (animation.type === 'video' ? ANIMATION_DEFAULTS.videoLoop : ANIMATION_DEFAULTS.imageLoop),
      priority: animation.priority ?? ANIMATION_DEFAULTS.priority,
      interruptible: animation.interruptible ?? ANIMATION_DEFAULTS.interruptible,
      cooldown: animation.cooldown ?? ANIMATION_DEFAULTS.cooldown,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 查询                                                                */
  /* ------------------------------------------------------------------ */

  public isPlaying(): boolean {
    return this.active !== null;
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public getCurrentAnimation(): string | null {
    return this.active?.animation.id ?? null;
  }

  public getCurrentPriority(): number {
    return this.active?.priority ?? -Infinity;
  }

  public getCurrentRenderOptions(): AnimationRenderOptions | undefined {
    return this.active?.animation.render;
  }

  /* ------------------------------------------------------------------ */
  /* 播放裁决（核心）                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * 请求播放动画（统一入口，包含优先级仲裁）。
   * 永不抛异常：被拒绝时返回 `{ accepted: false, reason }`。
   */
  public async requestAnimation(animationId: string, options: PlayOptions = {}): Promise<PlayResult> {
    const definition = this.registry.get(animationId);
    if (!definition) {
      this.reject(animationId, 'not-registered', options, `动画未注册: ${animationId}`);
      return { accepted: false, animationId, reason: 'not-registered' };
    }

    const priority = options.priority ?? definition.priority;
    const interrupt: InterruptPolicy = options.interrupt ?? 'auto';
    const current = this.active;

    // 1) 冷却检查（同一动画短时间内被重复触发）
    // 注意：冷却与"抢占"是两件正交的事 —— 冷却防刷屏，interrupt 控制能否打断别人。
    // 因此即使 interrupt: 'force' 也必须遵守冷却，否则业务代码可以绕过防抖刷爆动画。
    // 唯一的例外是 bypassCooldown：它代表"用户明确点了这一条动画"（托盘 / 右键菜单），
    // 用户的主动操作不该被防刷屏逻辑吞掉（bomb 冷却 5 分钟，被挡时看起来像"只能播一次"）。
    if (definition.cooldown > 0) {
      const last = this.lastPlayedAt.get(animationId);
      const remaining = last === undefined ? 0 : definition.cooldown - (Date.now() - last);
      if (last !== undefined && remaining > 0 && options.bypassCooldown !== true) {
        this.reject(animationId, 'cooldown', options, `冷却中（剩余 ${remaining}ms）`);
        return { accepted: false, animationId, reason: 'cooldown' };
      }
      if (last !== undefined && remaining > 0) {
        this.logger.info('manual play bypasses cooldown', {
          data: { animationId, remaining, source: options.source ?? 'system' },
        });
      }
    }

    // 2) 同一个动画正在播放 -> 忽略（避免重复触发把动画重置到第一帧）
    //
    // ⚠️ 这条对 `force` 同样生效（除非显式 `restart: true`）。
    // 原因是实测到的真 bug：三段式动画在 loop 段被"请求同一条动画"时会走
    // "先播 end 再播这条请求"，于是重复请求 = `end -> start -> end -> ...`
    // 死循环（用户报告"end 一直循环、回不到 idle"）。`force` 的语义是
    // "允许抢占其它动画"，不是"允许把自己重播一遍"。
    if (current && current.animation.id === animationId && (interrupt !== 'force' || options.restart !== true)) {
      this.logger.debug('duplicate play request ignored', { data: { animationId, forced: interrupt === 'force' } });
      return { accepted: false, animationId, reason: 'same-animation' };
    }

    /*
     * 2.5) 收起（贴边）状态的"安静模式"：只允许它自己的默认姿势。
     *
     * 用户明确点的（`source: 'user'`，例如托盘里手动挑一条动画）不受限；
     * 自动来源（自愈 / 插件 / AI / 行为 / 系统）一律拒绝 —— 见
     * `AnimationManagerOptions.getQuietDefault` 的注释（这就是"end 一直循环"的病根）。
     */
    const quiet = this.getQuietPolicy?.() ?? null;
    if (quiet !== null && !quiet.allowed.includes(animationId) && (options.source ?? 'system') !== 'user') {
      this.reject(animationId, 'docked', options, `收起状态只允许 ${quiet.allowed.join('/')}`);
      return { accepted: false, animationId, reason: 'docked' };
    }

    // 3) 排队策略（排队不算"打断"，所以在硬锁判定之前）
    if (current && interrupt === 'queue') {
      this.queue = { animationId, options: { ...options, priority } };
      this.logger.info('animation queued', { data: { animationId, after: current.animation.id } });
      return { accepted: true, animationId, queued: true };
    }

    /*
     * 3.5) **不可打断的硬锁**（需求："点击动画不可被打断，必须等待播放结束后才能继续点击"）。
     *
     * 这一条必须在优先级仲裁之前、并且对 `force` 一样生效：
     * `force` 的语义只是"绕过优先级比较"，不是"无视硬约束"。
     * 原来的写法把这条判定放在了 `interrupt !== 'force'` 分支里，
     * 于是 `force` 能切开 `interruptible: false` 的动画 —— 与注释承诺相反
     * （点击动画会因此被托盘菜单/AI 打断，"必须播完"形同虚设）。
     */
    if (current && !current.animation.interruptible) {
      this.reject(
        animationId,
        'not-interruptible',
        options,
        `当前动画 ${current.animation.id} 不可打断（点击动画必须播完）`,
      );
      return { accepted: false, animationId, reason: 'not-interruptible' };
    }

    // 4) 优先级仲裁
    if (current && interrupt !== 'force') {
      if (priority < current.priority) {
        this.reject(animationId, 'lower-priority', options, `优先级不足（${priority} < ${current.priority}）`);
        return { accepted: false, animationId, reason: 'lower-priority' };
      }
      if (priority === current.priority) {
        this.reject(animationId, 'equal-priority', options, `优先级相同（${priority}），保持当前动画`);
        return { accepted: false, animationId, reason: 'equal-priority' };
      }
    }

    /*
     * 5) 抢占旧动画。
     *
     * 需求把"持续动画被打断"分成两种，必须区别对待：
     *   - 正在 **start / loop** 段：先播它的 `end` 段，**再**播这次请求的动画
     *     （动作连贯；`end` 立刻开始，不等本轮循环播完）；
     *   - 正在 **end** 段：直接结束播放，立刻让位。
     *
     * 因此这里不再"一律立刻切断"，而是把请求挂到 `pendingAfterEnd`，
     * 由收尾段结束的 `finishActive` 接上（见 flushPendingAfterEnd）。
     */
    const interruptedId = current?.animation.id;

    if (current) {
      if (
        (current.persistentPhase === 'start' || current.persistentPhase === 'loop') &&
        !this.isEndChurning(current.animation.id)
      ) {
        this.pendingAfterEnd = {
          animationId: definition.id,
          options: { ...options, priority },
          priority,
        };
        const phase = current.persistentPhase;
        /*
         * `endPersistent()` 一定会受理（start/loop 阶段返回 true）：
         *   - 有 end 段：立刻切进 end 段，收尾播完由 finishActive 接上挂起请求；
         *   - 没有 end 段：它当场 finishActive -> 立刻接上挂起请求。
         * 两条路径都由 `flushPendingAfterEnd` 收口，这里不需要分支。
         */
        this.endPersistent(`preempted-by:${animationId}`);
        this.logger.info('interrupt deferred until persistent end segment', {
          data: { from: current.animation.id, to: animationId, phase, priority },
        });
        return { accepted: true, animationId, queued: true };
      }
      if (current.persistentPhase !== null) {
        this.logger.info('persistent animation cut in end phase', {
          data: { from: current.animation.id, to: animationId, phase: current.persistentPhase },
        });
      }
      this.finishActive(false, 'interrupted');
    }

    const accepted = await this.start(definition, { ...options, priority }, reasonOrDefault(options.reason));
    if (!accepted) {
      return { accepted: false, animationId, reason: 'load-failed' };
    }
    if (interruptedId !== undefined) {
      this.logger.info('animation preempted', { data: { from: interruptedId, to: animationId, priority } });
    }
    return { accepted: true, animationId };
  }

  /** 语义化别名：AnimationManager 的对外主 API。 */
  public async play(animationId: string, options: PlayOptions = {}): Promise<PlayResult> {
    return this.requestAnimation(animationId, options);
  }

  /** 播放兜底动画（idle）。 */
  public async playFallback(options: PlayOptions = {}): Promise<PlayResult> {
    const fallbackId = this.fallbackId;
    if (!fallbackId) {
      this.logger.warn('no fallback animation available');
      return { accepted: false, animationId: '', reason: 'not-registered' };
    }
    return this.requestAnimation(fallbackId, { interrupt: 'force', ...options });
  }

  public stop(reason = 'stopped'): void {
    if (!this.active) return;
    this.finishActive(false, reason);
  }

  /**
   * 请求结束**持续动画**：会先播收尾段（end），播完才算真正结束。
   *
   * 这是需求里"被打断"的显式入口。行为：
   * - 正在循环：把当前这一轮播完，然后转去播 `end`（动作更连贯）；
   * - 正在开场段：开场播完后转 `end`；
   * - 正在收尾段：不做任何事（已经要结束了）；
   * - 没有 `end` 段：直接结束；
   * - 对**一次性动画**：空操作，返回 false（避免调用方误用）。
   */
  /**
   * 请求结束持续动画。
   *
   * 语义（按用户明确要求）：
   * - **触发打断就立刻进 `end` 阶段**：不等当前这一轮循环播完。原来要等本轮
   *   播完（watch-loop 2s）才切收尾，用户点一下要等两秒才看到反应，
   *   判定为"点不动"；响应速度优先于动作完整性。
   * - **在 `end` 阶段再次被打断 -> 立刻结束**（切回 idle / 让位给打断它的动画）：
   *   收尾段最长可达 4.4s（watch-end），已经在收尾了就不该再拖。
   *
   * @returns true = 当前确实是持续动画且已受理；false = 不是持续动画（一次性动画请用 stop）
   */
  public endPersistent(reason = 'requested'): boolean {
    const active = this.active;
    if (!active || active.persistentPhase === null) return false;

    // 已经在收尾段：立刻收干净
    if (active.persistentPhase === 'end') {
      this.logger.info('persistent end interrupted; finishing immediately', {
        data: { id: active.animation.id, reason, phase: active.persistentPhase },
      });
      /*
       * 必须用 completed=true。
       *
       * renderer 只在 `completed === true` 时才把状态从 PLAYING 迁回 IDLE
       * （renderer.ts 的 AnimationEnd 处理），而这条路径**没有任何新动画接替** ——
       * 用 false 会让状态机永远停在 PLAYING：兜底 idle 接不回来，
       * 画面冻结在收尾段的最后一帧直到用户下一次点击。
       * 语义上也确实是"这次播放干净地收尾了"（用户主动要求提前结束），
       * 与"被新动画抢占"（那条路径由新动画的 start 接管状态）不是一回事。
       */
      this.finishActive(true, `persistent-end-interrupted:${reason}`);
      return true;
    }

    if (active.endingRequested) return true;
    active.endingRequested = true;

    this.logger.info('persistent end requested', {
      data: { id: active.animation.id, reason, phase: active.persistentPhase },
    });

    if (!active.animation.segments?.end) {
      // 没有收尾段：直接结束
      this.finishActive(true, `persistent-end:${reason}`);
      return true;
    }

    /*
     * 无论当前在 start 还是 loop，都**立刻**切到收尾段。
     * 切段会清掉循环段的边缘看门狗，因此不会再触发"本轮播完"那条路径。
     */
    void this.playEnd(active);
    return true;
  }

  /** 当前是否正在播持续动画（可选按 id 过滤）。 */
  public isPersistentPlaying(animationId?: string): boolean {
    const active = this.active;
    if (!active || active.persistentPhase === null) return false;
    return animationId === undefined || active.animation.id === animationId;
  }

  /**
   * 是否有持续动画在播，且它的优先级**不高于** `maxPriority`。
   *
   * 用途：用户点击的瞬时反应（priority 50/60）碰到走神/发呆类持续动画
   * （priority 10~15）时，应该"先让它把收尾段播完"再播反应，而不是硬切。
   */
  public isPersistentPlayingWithin(maxPriority: number): boolean {
    const active = this.active;
    if (!active || active.persistentPhase === null) return false;
    return active.priority <= maxPriority;
  }

  /** 持续动画当前阶段；null = 当前不是持续动画。 */
  public getPersistentPhase(): PersistentPhase | null {
    return this.active?.persistentPhase ?? null;
  }

  /** 持续动画循环段已完成的轮数（一次性动画返回 0）。 */
  public getLoopCycles(): number {
    return this.active?.loopCycles ?? 0;
  }

  /** 这次播放实际要循环几轮（0 = 无限；非持续动画返回 0）。 */
  public getLoopTarget(): number {
    return this.active?.loopTarget ?? 0;
  }

  /**
   * 当前动画是否"不可打断"（点击动画）。
   *
   * 供渲染层/自动化判断："现在点了也没用，必须等她播完"。
   */
  public isLocked(): boolean {
    return this.active !== null && !this.active.animation.interruptible;
  }

  /** 是否有"等收尾段播完就播"的挂起请求。 */
  public hasPendingAfterEnd(): boolean {
    return this.pendingAfterEnd !== null;
  }

  /**
   * 当前**实际生效**的素材相对路径。
   *
   * 为什么需要它：`layers.activeVideoSource` 返回的是"下一次要播的素材提示"，
   * 在切段的一瞬间它已经指向新素材、但缓冲还没交换完，因此不能用来断言
   * "现在播的是哪一段"。这里按持续动画的当前阶段返回权威答案。
   */
  public getActiveSource(): string | null {
    const active = this.active;
    if (!active) return null;
    const segments = active.animation.segments;
    if (!segments || active.persistentPhase === null) return active.animation.source;
    if (active.persistentPhase === 'start') return segments.start ?? active.animation.source;
    if (active.persistentPhase === 'loop') return segments.loop ?? active.animation.source;
    return segments.end ?? active.animation.source;
  }

  /**
   * 清空所有动画的冷却计时。
   *
   * 仅供自动化验收做"用例自包含"：否则前一个用例播过的动画会因 cooldown 被拒。
   * 正常业务路径不该调用（冷却是对自动化来源的保护）。
   */
  public resetCooldowns(): void {
    this.lastPlayedAt.clear();
    this.logger.debug('cooldowns cleared');
  }

  public pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.layers.pauseVideo();
    this.logger.info('animation paused');
  }

  public resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.active) {
      void this.layers.playVideo().catch(() => undefined);
    }
    this.logger.info('animation resumed');
  }

  public clearQueue(): void {
    this.queue = null;
  }

  /** 清空"等收尾段播完再播"的挂起请求（隐藏/收起切换时用，避免旧意图迟到生效）。 */
  public clearPendingAfterEnd(): void {
    this.pendingAfterEnd = null;
  }

  /* ------------------------------------------------------------------ */
  /* 内部：播放                                                          */
  /* ------------------------------------------------------------------ */

  private async start(
    definition: ResolvedAnimation,
    options: PlayOptions,
    reason: string,
  ): Promise<boolean> {
    const token = ++this.tokenCounter;
    const priority = options.priority ?? definition.priority;
    const source = options.source ?? 'system';
    // loop 覆盖：状态默认动画要把一次性素材循环起来（见 PlayOptions.loop）
    const loop = options.loop ?? definition.loop;

    const playback: ActivePlayback = {
      animation: definition,
      priority,
      reason,
      source,
      startedAt: Date.now(),
      token,
      persistentPhase: null,
      loopCycles: 0,
      loopTarget: 0,
      loop,
      loopCountRange: options.loopCountRange,
      endingRequested: false,
    };
    this.active = playback;
    this.paused = false;
    this.lastPlayedAt.set(definition.id, Date.now());

    const url = this.resolveAsset(definition.source);
    this.logger.info(`play ${definition.id}`, {
      data: {
        type: definition.type,
        kind: definition.kind,
        priority,
        source,
        reason,
        loop,
        ...(definition.segments?.loopCountRange !== undefined
          ? { loopCountRange: definition.segments.loopCountRange.join('-') }
          : definition.segments?.loopCount !== undefined
            ? { loopCount: definition.segments.loopCount }
            : {}),
      },
    });

    /*
     * 三段式动画**不**走 `startVideo` 那条"一次性"路径。
     *
     * 为什么必须分开（实测踩到的真 bug）：`startVideo` 会把 `source`（= start 段素材）
     * 当一次性动画加载并播一遍，**然后**才进 `beginPersistent` 再播一次 start 段 ——
     *  1. 开场段被播了两遍，视觉上就是"她趴下、又趴下"；
     *  2. 更严重的是加载期间 `persistentPhase` 还是 null：这时的抢占会走
     *     "一次性动画"分支被直接硬切，**收尾段被跳过**（需求要求的
     *     "loop 中被打断先播 end" 在这段时间里失效）。
     * 现在三段式直接进 `beginPersistent`（它自己负责加载 start 段 + 双缓冲切换），
     * 而 `persistentPhase` 在任何 await 之前就设成 'start'，抢占语义立刻生效。
     */
    if (definition.kind === 'persistent' && definition.segments) {
      try {
        await this.beginPersistent(playback);
      } catch (error) {
        const message = error instanceof Error ? error.message : describeError(error);
        this.logger.error(`persistent animation load failed ${definition.id}`, {
          error,
          data: { source: definition.source },
        });
        this.eventBus.emit(PetEvents.AnimationRejected, {
          animationId: definition.id,
          priority,
          reason,
          source,
          rejection: 'load-failed' as PlayRejectionReason,
        });
        this.failAnimation(definition, message);
        return false;
      }
      if (!this.isStillCurrent(playback)) return true;
      this.eventBus.emit(PetEvents.AnimationStart, {
        animationId: definition.id,
        priority,
        loop: definition.loop,
        reason,
        source,
      });
      return true;
    }

    try {
      if (definition.type === 'video') {
        await this.startVideo(definition, url, playback);
      } else {
        await this.startImage(definition, url, playback);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : describeError(error);
      this.logger.error(`animation load failed ${definition.id}`, {
        error,
        data: { source: definition.source },
      });
      this.eventBus.emit(PetEvents.AnimationRejected, {
        animationId: definition.id,
        priority,
        reason,
        source,
        rejection: 'load-failed' as PlayRejectionReason,
      });
      this.failAnimation(definition, message);
      return false;
    }

    this.eventBus.emit(PetEvents.AnimationStart, {
      animationId: definition.id,
      priority,
      loop: definition.loop,
      reason,
      source,
    });
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 持续动画：start -> loop × N -> end                                   */
  /* ------------------------------------------------------------------ */

  /**
   * 启动持续动画。
   *
   * - 有 `start` 段：先播它（loop=false），等 ended 后进入循环；
   * - 没有 `start`：直接进入循环。
   */
  private async beginPersistent(playback: ActivePlayback): Promise<void> {
    const segments = playback.animation.segments;
    if (segments?.start) {
      playback.persistentPhase = 'start';
      this.logger.info('persistent start', { data: { id: playback.animation.id } });
      await this.playSegment(playback, segments.start, false, SEGMENT_CROSSFADE_MS);
      if (!this.isStillCurrent(playback)) return;
      /*
       * 开场段也是 loop=false 的一段：同样要看门狗兜底（丢了 ended 就进不了循环）。
       * 见 `armCompletionWatchdog` 里 start 阶段的特殊处理。
       */
      this.armCompletionWatchdog(playback, this.layers.activeVideo);
      return;
    }
    await this.enterLoopPhase(playback);
  }

  /** 进入循环段：循环播放，直到轮数用尽或收到结束请求。 */
  private async enterLoopPhase(playback: ActivePlayback): Promise<void> {
    const segments = playback.animation.segments;
    const source = segments?.loop ?? playback.animation.source;
    playback.persistentPhase = 'loop';
    playback.endingRequested = false;
    playback.loopCycles = 0;
    /*
     * "loop 循环随机次"：每次进入循环段现抽一次并**定下来**（`loopTarget`），
     * 之后每一轮都跟它比 —— 否则每一轮都重抽，收敛性就没法保证了。
     * 0 = 无限循环。
     *
     * 轮数来源有三层（`resolvePlayLoopCount`）：这次播放的覆盖 > 定义里的 range > 固定值。
     * 覆盖是必要的：同一个 lie 作为"收起的默认姿势"要永远循环，
     * 作为"正常状态的随机动画"只该播一两轮，作为"主人不在"的触发演一次。
     */
    playback.loopTarget = resolvePlayLoopCount(segments, playback.loopCountRange);
    this.logger.info('persistent loop', {
      data: {
        id: playback.animation.id,
        source,
        loopCount: playback.loopTarget > 0 ? playback.loopTarget : 'infinite',
        ...(playback.loopCountRange === 'forever' ? { loopOverride: 'forever' } : {}),
        ...(Array.isArray(playback.loopCountRange) ? { loopOverride: playback.loopCountRange.join('-') } : {}),
        ...(segments?.loopCountRange !== undefined ? { range: segments.loopCountRange.join('-') } : {}),
      },
    });

    await this.playSegment(playback, source, true, SEGMENT_CROSSFADE_MS);
    if (!this.isStillCurrent(playback)) return;

    /*
     * 循环段的精确时长：media-meta 里有 fps 与帧数，用它算比 video.duration 稳，
     * 也避免不同浏览器对 WebM 时长的小数处理差异。
     */
    const video = this.layers.activeVideo;
    this.loopSegmentDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    this.armLoopEdgeWatch(playback);
  }

  /**
   * 播放持续动画的某一段素材。
   *
   * 复用双缓冲换源：换源发生在**隐藏**的缓冲上，等它就绪后再切换可见性，
   * 因此段与段切换不会露出空白帧（沿用第一版修闪屏的机制）。
   * token 不变，所以 `isStillCurrent` 依然成立。
   *
   * ⚠️ 关于"切段还要交叉淡化"（实测结论）：
   * 三段素材是分开做的，**衔接帧并不相同** —— start 的末帧与 loop 的首帧、
   * loop 的末帧与 end 的首帧都不是同一画面。逐帧录制证明这里**没有空帧**
   * （异常帧 0、两段 alpha 一致），所以用户看到的闪是**硬切造成的跳变**。
   * 因此持续动画的切段默认走交叉淡化，把跳变抹掉。
   */
  private async playSegment(
    playback: ActivePlayback,
    source: string,
    loop: boolean,
    crossfadeMs = 0,
  ): Promise<void> {
    const url = this.resolveAsset(source);
    this.layers.applyRenderHints(playback.animation.render);
    const active = this.layers.activeVideo;

    if (this.layers.isActiveSource(url)) {
      active.loop = loop;
      active.muted = true;
      active.playsInline = true;
      try {
        active.currentTime = 0;
      } catch {
        /* 元数据未就绪时忽略 */
      }
      await this.waitForVideoReady(active, playback.token);
      if (!this.isStillCurrent(playback)) return;
      this.layers.showLayer('video');
      await this.layers.playVideo();
      return;
    }

    const incoming = this.layers.spareVideo;
    incoming.loop = loop;
    incoming.muted = true;
    incoming.playsInline = true;
    // 清掉可能残留的过渡样式，避免上一次淡化的 transition 影响本次
    incoming.style.transition = '';
    incoming.style.opacity = '';
    // 换代：此前尚未执行的延时释放作废（否则可能误伤这个缓冲）
    const generation = this.layers.beginSegmentGeneration();
    this.layers.setVideoSourceHint(url);
    this.layers.setVideoSource(incoming, url);

    await this.waitForVideoReady(incoming, playback.token);
    if (!this.isStillCurrent(playback)) return;
    await nextFrame();
    if (!this.isStillCurrent(playback)) return;

    if (crossfadeMs > 0) {
      /*
       * 交叉淡化：新旧缓冲同时可见一小段，靠 opacity 过渡抹掉接缝跳变。
       * 旧缓冲保持播放（不能 pause —— 定格比跳变更难看），淡化结束后再释放。
       */
      const outgoing = this.layers.crossfadeToSpare(crossfadeMs);
      this.layers.showLayer('video');
      await this.layers.playVideo();
      window.setTimeout(() => {
        // 这段淡化已经被后续切段顶掉：不要动缓冲，它可能已经在播新内容
        if (!this.layers.isCurrentSegmentGeneration(generation)) return;
        outgoing.pause();
        this.layers.releaseVideo(outgoing);
      }, crossfadeMs + 40);
      return;
    }

    this.layers.commitVideoSwap();
    this.layers.showLayer('video');
    await this.layers.playVideo();
  }

  /**
   * 轮询循环段是否播到片尾。
   *
   * 为什么不用 `ended`：循环段设了 `loop=true`，Chromium 会无缝从头再来，
   * **永远不会**触发 `ended`。所以必须在它回到开头之前接管。
   *
   * ⚠️ 关键坑（实测踩过）：tick 是**每帧**跑的，而视频到达片尾后会在
   * "接近 duration"这个位置停留若干帧。如果只判断 `currentTime >= duration - eps`
   * 就 `cycle++`，同一轮会被重复计数 —— 实测 4 轮在 20ms 内全部计完，
   * 于是立刻切到 end 段，看起来就是"循环时闪一下"。
   *
   * 因此必须记录"这一轮已经计过数"，并且**等到时间轴真正回绕之后**才允许计下一轮。
   */
  private armLoopEdgeWatch(playback: ActivePlayback): void {
    this.clearLoopEdgeWatch();
    /** 上一次计数时的时间轴位置；null 表示还没计过。 */
    let lastCycleAt = -1;
    /** 是否已经"离开过片尾"（回绕成功），用于解锁下一轮计数。 */
    let rewound = true;

    const tick = (): void => {
      this.loopEdgeFrame = null;
      const active = this.active;
      if (!active || active.token !== playback.token) return;
      if (active.persistentPhase !== 'loop') return;

      const video = this.layers.activeVideo;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : this.loopSegmentDuration;
      if (!(duration > 0) || video.paused) {
        this.loopEdgeFrame = window.requestAnimationFrame(tick);
        return;
      }

      const atEdge = video.currentTime >= duration - 0.06;

      if (!atEdge) {
        // 已经离开片尾（说明成功回绕到了开头），解锁下一轮计数
        rewound = true;
      } else if (rewound && video.currentTime !== lastCycleAt) {
        // 到达片尾，且这一轮尚未计过数 -> 计一轮
        rewound = false;
        lastCycleAt = video.currentTime;
        active.loopCycles += 1;
        // 目标轮数是本次播放进入 loop 段时随机定下的（0 = 无限）
        const target = active.loopTarget;
        const reached = target > 0 && active.loopCycles >= target;

        this.eventBus.emit('animation:loop-cycle', {
          animationId: active.animation.id,
          cycle: active.loopCycles,
          ...(target > 0 ? { target } : {}),
        });
        this.logger.debug('persistent loop cycle', {
          data: { id: active.animation.id, cycle: active.loopCycles, target: target > 0 ? target : 'infinite' },
        });

        if (reached || active.endingRequested) {
          this.logger.info('persistent loop finished', {
            data: {
              id: active.animation.id,
              cycles: active.loopCycles,
              target: target > 0 ? target : 'infinite',
              reason: reached ? 'loop-count-reached' : 'end-requested',
            },
          });
          // 这里就不再重排 rAF：由 playEnd 全权接管（它会切段并重装看门狗）
          void this.playEnd(playback);
          return;
        }
      }

      this.loopEdgeFrame = window.requestAnimationFrame(tick);
    };
    this.loopEdgeFrame = window.requestAnimationFrame(tick);
  }

  private clearLoopEdgeWatch(): void {
    if (this.loopEdgeFrame === null) return;
    window.cancelAnimationFrame(this.loopEdgeFrame);
    this.loopEdgeFrame = null;
  }

  /* ------------------------------------------------------------------ */
  /* 收尾段抖动熔断                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * 收尾段抖动的判定窗口与阈值。
   *
   * ⚠️ 这是**最后一道保险**，阈值必须远高于任何真实交互：
   * 用户连续点击 / 连续换动画时，持续动画每次都会"先播 end"，一分钟里出现几次
   * 完全正常（实测：验收里 click-defer + 菜单切换 + 反复 toggle 一共 6~8 次 end）。
   * 阈值定得太低会把正常交互的收尾段吃掉 —— 第一版定 3 次/60s，
   * 直接把"点击持续动画先播 end"这条断言判红了。现在取 8 次/30 秒：
   * 真实操作达不到，而真正的死循环（实测 12 次/9 秒）会在十几秒内被熔断。
   */
  private static readonly END_CHURN_WINDOW_MS = 30_000;
  private static readonly END_CHURN_LIMIT = 8;

  private noteEndEntry(animationId: string): void {
    const now = Date.now();
    const recent = (this.endEntries.get(animationId) ?? []).filter(
      (at) => now - at < AnimationManager.END_CHURN_WINDOW_MS,
    );
    recent.push(now);
    this.endEntries.set(animationId, recent);
  }

  /**
   * 这条动画是不是正在"收尾段抖动"（短时间反复进 end）。
   *
   * 熔断行为：命中后**不再延迟**，直接结束当前播放并让新请求立刻开始 ——
   * 宁可少播一次收尾，也不能让她卡在一串 end 里回不到 idle。
   */
  private isEndChurning(animationId: string): boolean {
    const now = Date.now();
    const recent = (this.endEntries.get(animationId) ?? []).filter(
      (at) => now - at < AnimationManager.END_CHURN_WINDOW_MS,
    );
    const churning = recent.length >= AnimationManager.END_CHURN_LIMIT;
    if (churning) {
      this.logger.error('animation end segment is churning; bypassing the end-first rule', {
        data: { animationId, entriesInWindow: recent.length, windowMs: AnimationManager.END_CHURN_WINDOW_MS },
      });
    }
    return churning;
  }

  /** 播放收尾段；播完即结束整个动画。 */
  private async playEnd(playback: ActivePlayback): Promise<void> {
    const active = this.active;
    if (!active || active.token !== playback.token) return;
    const end = playback.animation.segments?.end;
    if (!end) {
      this.finishActive(true, 'persistent-end:no-end-segment');
      return;
    }

    this.noteEndEntry(playback.animation.id);
    this.clearLoopEdgeWatch();
    playback.persistentPhase = 'end';
    // 进入收尾段即视为"结束请求已兑现"；此后若再被打断，由 endPersistent 立刻收干净
    playback.endingRequested = false;
    this.logger.info('persistent end', { data: { id: playback.animation.id, cycles: playback.loopCycles } });

    try {
      await this.playSegment(playback, end, false, SEGMENT_CROSSFADE_MS);
    } catch (error) {
      this.logger.error('persistent end segment failed', { error, data: { id: playback.animation.id } });
      if (this.isStillCurrent(playback)) this.finishActive(false, 'end-segment-error');
      return;
    }
    if (!this.isStillCurrent(playback)) return;
    // end 段 loop=false，由 ended 结束整个动画；另装时长看门狗兜底
    this.armCompletionWatchdog(playback, this.layers.activeVideo);
  }

  /**
   * 播放视频动画（一次性动画的入口）。
   *
   * **双缓冲**：换源一定发生在隐藏的备用缓冲上，等它可播之后才交换可见性。
   * 直接给可见的 `<video>` 换源会让 Chromium 丢掉当前帧（readyState -> 0），
   * 那一刻画面为空 -> 桌宠整只透明 -> 看起来"闪一下"。
   *
   * 复用：如果目标素材就是当前可见缓冲正在播的，则只是把时间轴拨回 0，
   * 连换源都不需要（点击后回到 idle 的场景就走这条路径）。
   */
  private async startVideo(
    definition: ResolvedAnimation,
    url: string,
    playback: ActivePlayback,
  ): Promise<void> {
    this.layers.applyRenderHints(definition.render);

    const active = this.layers.activeVideo;
    /*
     * 复用条件必须同时满足两点：
     *  1. 当前缓冲就是目标素材（用原始 URL 比对，兼容 Blob 加载）；
     *  2. 当前缓冲**真的有可用帧**（isVideoReady 已包含 readyState 判断）。
     * 否则（例如缓冲被换源后停在 readyState 0）即使"复用"也永远播不出画面。
     */
    const sameSource = this.layers.isActiveSource(url);

    if (sameSource) {
      // 同一个素材：不换源、不隐藏，只复位时间轴并保证在播
      active.loop = playback.loop;
      active.muted = true;
      active.playsInline = true;
      try {
        active.currentTime = 0;
      } catch {
        /* 元数据未就绪时忽略 */
      }
      await this.waitForVideoReady(active, playback.token);
      if (!this.isStillCurrent(playback)) return;
      this.layers.showLayer('video');
      await this.layers.playVideo();
      this.armCompletionWatchdog(playback, active);
      return;
    }

    // 换源：在隐藏的备用缓冲上加载
    const incoming = this.layers.spareVideo;
    /*
     * ⚠️ 必须**在动这个缓冲之前**换代，和 playSegment 一致。
     *
     * 为什么：上一次交叉淡化会挂一个"140ms 后暂停并释放旧缓冲"的定时器，
     * 而旧缓冲**就是**这次的 incoming。若此刻还拿着旧代次，那个定时器会在
     * 我们加载到一半时 `releaseVideo()` 把这个缓冲的 src 清掉 ——
     * 表现是素材永远等不到 readyState>=2，6s 后报
     * "animation load failed ... 视频加载超时"（实测踩到：read-start.webm）。
     */
    const generation = this.layers.beginSegmentGeneration();
    incoming.loop = playback.loop;
    incoming.muted = true;
    incoming.playsInline = true;
    this.layers.setVideoSourceHint(url);
    this.layers.setVideoSource(incoming, url);

    await this.waitForVideoReady(incoming, playback.token);
    // 等待期间可能已经被别的播放请求取代（或本次拖拽已结束），
    // 这时不能再去交换缓冲，否则会把新动画顶掉。
    if (!this.isStillCurrent(playback)) return;

    // 等新缓冲真的解出一帧后再交换，避免换上去的瞬间还是空纹理
    await nextFrame();
    if (!this.isStillCurrent(playback)) return;

    /*
     * 一次性动画的**进入**（兜底 idle -> 反应动画）与**退出**（反应动画 ->
     * 兜底 idle）不能硬切，要和持续动画切段一样走交叉淡化。
     *
     * 为什么：两段素材的首末帧并不相同，`commitVideoSwap()` 会在切换的那一帧
     * 露出"上一段的末帧 + 这一段的空纹理"，就是用户报告的
     * "所有动画开始和结束都要闪一次"。
     *
     * 只在本层**确实露着画面**时才淡化：从空白切过来（启动第一条动画、
     * 上一次交换刚清空缓冲）时没有旧画面可淡，直接提交更干净。
     */
    if (!this.layers.isVideoLayerVisible()) {
      this.layers.commitVideoSwap();
      this.layers.showLayer('video');
      await this.layers.playVideo();
      this.armCompletionWatchdog(playback, incoming);
      return;
    }

    const outgoing = this.layers.crossfadeToSpare(SEGMENT_CROSSFADE_MS);
    this.layers.showLayer('video');
    await this.layers.playVideo();
    window.setTimeout(() => {
      /* 这次淡化已被后续切换顶掉：不要动缓冲，它可能已经在播新内容 */
      if (!this.layers.isCurrentSegmentGeneration(generation)) return;
      outgoing.pause();
      this.layers.releaseVideo(outgoing);
    }, SEGMENT_CROSSFADE_MS + 40);
    this.armCompletionWatchdog(playback, incoming);
  }

  /**
   * 这次播放是否仍然是"当前播放"。
   *
   * 用于每个 await 之后做检查：`ended` 事件可能在我们等待期间到达，
   * 把 `this.active` 置空（或被新的请求替换）。若不检查，旧请求醒来后
   * 会继续交换缓冲 / 发 animation:start，把新动画顶掉，
   * 结果就是"动画状态和实际画面不一致、兜底循环再也接不回来"。
   */
  private isStillCurrent(playback: ActivePlayback): boolean {
    return this.active !== null && this.active.token === playback.token;
  }

  /**
   * 给非循环动画装一个"结束看门狗"。
   *
   * 为什么要它：正常结束依赖 `<video>` 的 `ended` 事件，但在双缓冲 / 高频切换的
   * 场景下这个事件偶发会丢（实测：视频确实播完了，但 ended 没到，
   * 于是动画状态永远停在 PLAYING，兜底循环再也接不回来）。
   *
   * 这里按素材时长 + 余量设一个定时器作为兜底：只要时间到了、
   * 且仍然是同一次播放（token 未变），就主动走一次结束流程。
   * 循环动画不装（它们的 ended 本来就不该触发）。
   */
  private armCompletionWatchdog(playback: ActivePlayback, video: HTMLVideoElement): void {
    this.clearCompletionWatchdog();
    // 循环段不装：它的"结束"由 armLoopEdgeWatch 负责（loop=true 永不触发 ended）
    if (this.active?.persistentPhase === 'loop') return;
    // 一次性循环动画也不装（含"状态默认动画把一次性素材循环起来"这种情况）
    if (playback.loop && this.active?.persistentPhase === null) return;

    const durationMs = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration * 1000
      : 20000;
    const timeoutMs = Math.max(2000, durationMs + 800);

    this.completionTimer = window.setTimeout(() => {
      this.completionTimer = null;
      const active = this.active;
      if (!active || active.token !== playback.token) return;
      if (active.persistentPhase === 'loop') return;
      if (active.loop && active.persistentPhase === null) return;
      /*
       * 开场段丢了 `ended` 时的兜底：**该进循环**，而不是把整段动画结束掉。
       * （开场段 loop=false，正常由 ended 驱动；丢了 ended 就卡在 start 永不入循环，
       * 表现是"她一直定格在开场姿势"。）
       */
      if (active.persistentPhase === 'start') {
        this.logger.warn('no ended event for start segment; entering loop by duration fallback', {
          data: { id: active.animation.id, timeoutMs },
        });
        if (active.endingRequested) void this.playEnd(active);
        else void this.enterLoopPhase(active);
        return;
      }
      this.logger.warn('no ended event; finishing by duration fallback', {
        data: { id: active.animation.id, timeoutMs, phase: active.persistentPhase ?? 'one-shot' },
      });
      this.finishActive(true, 'ended-watchdog');
    }, timeoutMs);
  }

  private clearCompletionWatchdog(): void {
    if (this.completionTimer === null) return;
    window.clearTimeout(this.completionTimer);
    this.completionTimer = null;
  }

  private async startImage(
    definition: ResolvedAnimation,
    url: string,
    playback: ActivePlayback,
  ): Promise<void> {
    this.layers.applyRenderHints(definition.render);
    await this.waitForImageReady(url, playback.token);
    this.layers.showLayer('image');

    // 非循环的静态图：不循环等同于一直显示，直到被替换或 stop()
    if (!definition.loop) {
      this.logger.debug('static animation loop=false; stays visible until replaced or stop()', {
        data: { id: definition.id },
      });
    }
  }

  /**
   * 等待指定视频缓冲可播（元数据已解出）。
   *
   * 超时故意设得比较短（6s）：素材都是本地小文件，正常情况下远快于此。
   * 若真的失败，早点失败才能早点走降级/自愈路径 ——
   * 之前用 15s，一旦某次加载卡住就会把"点击后恢复 idle"这类衔接拖到超时之后，
   * 表现为桌宠长时间没有画面。
   */
  private waitForVideoReady(video: HTMLVideoElement, token: number): Promise<void> {
    if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new AnimationError('视频加载超时', {
          code: 'ANIMATION_LOAD_FAILED',
          module: 'AnimationManager',
          details: { src: video.currentSrc || video.src, token },
        }));
      }, 6000);

      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new AnimationError(`视频解码失败: ${video.error?.message ?? 'unknown'}`, {
          code: 'ANIMATION_LOAD_FAILED',
          module: 'AnimationManager',
          details: { src: video.src, code: video.error?.code },
        }));
      };
      const cleanup = (): void => {
        window.clearTimeout(timeout);
        video.removeEventListener('loadeddata', onReady);
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('error', onError);
      };

      video.addEventListener('loadeddata', onReady);
      video.addEventListener('canplay', onReady);
      video.addEventListener('error', onError);
    });
  }

  private waitForImageReady(url: string, token: number): Promise<void> {
    const image = this.layers.image;
    if (image.complete && image.naturalWidth > 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new AnimationError('图片加载超时', {
          code: 'ANIMATION_LOAD_FAILED',
          module: 'AnimationManager',
          details: { url, token },
        }));
      }, 10000);

      const onLoad = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new AnimationError('图片加载失败（文件不存在或格式不支持）', {
          code: 'ANIMATION_LOAD_FAILED',
          module: 'AnimationManager',
          details: { url },
        }));
      };
      const cleanup = (): void => {
        window.clearTimeout(timeout);
        image.removeEventListener('load', onLoad);
        image.removeEventListener('error', onError);
      };

      image.addEventListener('load', onLoad);
      image.addEventListener('error', onError);
    });
  }

  /** 加载失败降级：发布错误事件并尝试回到兜底动画（不再触发新一轮抢占）。 */
  private failAnimation(definition: AnimationDefinition, message: string): void {
    this.active = null;
    this.eventBus.emit('animation:error', { animationId: definition.id, message });
    if (this.fallbackId && this.fallbackId !== definition.id) {
      const fallbackId = this.fallbackId;
      window.setTimeout(() => {
        void this.requestAnimation(fallbackId, {
          interrupt: 'force',
          reason: `fallback-after-error:${definition.id}`,
          source: 'system',
        });
      }, 0);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 内部：结束                                                          */
  /* ------------------------------------------------------------------ */

  private finishActive(completed: boolean, reason: string): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.clearCompletionWatchdog();
    this.clearLoopEdgeWatch();
    /*
     * 先做缓冲交接再暂停：持续动画可能在交叉淡化途中被打断，
     * 此时可见缓冲已被清空，只 pause() 会让桌宠整只消失。
     */
    this.layers.settleAfterInterrupt();
    this.layers.pauseVideo();

    this.logger.info(`ended ${active.animation.id}`, {
      data: {
        completed,
        reason,
        durationMs: Date.now() - active.startedAt,
        ...(active.persistentPhase !== null ? { phase: active.persistentPhase } : {}),
        ...(active.persistentPhase !== null ? { loopCycles: active.loopCycles } : {}),
      },
    });

    /*
     * **先接上"等收尾段播完再播"的挂起请求，再回放排队项，最后才发 AnimationEnd**。
     *
     * 顺序理由（和排队项那条一样）：renderer 在 `AnimationEnd` 上是同步处理，
     * 会把状态迁回 IDLE 并接回兜底 idle（`playFallback` 带 `interrupt: 'force'`）。
     * 若先 emit，刚接上的新动画会被兜底 idle 顶掉 —— 表现就是
     * "点了没反应 / end 播完却回到发呆"。
     *
     * 两条挂起队列只放行一条：接上 pendingAfterEnd 时**保留** queue，
     * 它会在新动画结束时由下一次 finishActive 回放（否则新动画刚起就被排队项顶掉）。
     */
    const resumed = this.flushPendingAfterEnd();
    if (!resumed) this.flushQueue();

    this.eventBus.emit(PetEvents.AnimationEnd, {
      animationId: active.animation.id,
      completed,
      reason,
      source: active.source,
    });
  }

  /**
   * 接上"等收尾段播完再播"的挂起请求。
   *
   * @returns true = 确实接上了一条（调用方不要再回放排队项 / 接回兜底）
   */
  private flushPendingAfterEnd(): boolean {
    const pending = this.pendingAfterEnd;
    if (!pending) return false;
    this.pendingAfterEnd = null;
    this.logger.info('playing animation deferred until persistent end', {
      data: { animationId: pending.animationId, priority: pending.priority },
    });
    window.setTimeout(() => {
      void this.requestAnimation(pending.animationId, { ...pending.options, interrupt: 'force' });
    }, 0);
    return true;
  }

  private flushQueue(): void {
    const queued = this.queue;
    if (!queued) return;
    this.queue = null;
    this.logger.info('playing queued animation', { data: { animationId: queued.animationId } });
    window.setTimeout(() => {
      void this.requestAnimation(queued.animationId, { ...queued.options, interrupt: 'auto' });
    }, 0);
  }

  /**
   * 绑定视频事件。
   *
   * 因为用了双缓冲，这里要给**两个** `<video>` 都绑上：
   * - `ended` 只认"当前正在播放的那个缓冲"，否则旧缓冲被清空时也可能触发事件；
   * - `error` 同理，避免把已经废弃的缓冲报错当成当前动画失败。
   */
  private bindVideoEvents(): void {
    if (this.bound) return;
    this.bound = true;

    for (const video of this.layers.allVideos) {
      // 统一在这里监听 ended —— 业务代码绝不允许自己写 video.onended
      video.addEventListener('ended', () => {
        if (video !== this.layers.activeVideo) return;
        const active = this.active;
        if (!active || active.animation.type !== 'video') return;

        /*
         * 持续动画的分段推进。能走到这里的 ended 只可能来自 loop=false 的段：
         *   start -> 开始循环（或已请求结束则直接进 end）
         *   end   -> 整段动画结束
         *   loop  -> 不该发生（loop=true），防御性结束
         */
        if (active.persistentPhase !== null) {
          if (active.persistentPhase === 'start') {
            if (active.endingRequested) void this.playEnd(active);
            else void this.enterLoopPhase(active);
            return;
          }
          this.finishActive(true, 'ended');
          return;
        }

        if (active.animation.loop) return; // 循环动画不会触发 ended，双保险
        this.finishActive(true, 'ended');
      });

      video.addEventListener('error', () => {
        if (video !== this.layers.activeVideo) return;
        const active = this.active;
        if (!active) return;
        const code = video.error?.code ?? 0;
        const message = video.error?.message ?? 'unknown media error';
        this.logger.error('video playback error', { data: { id: active.animation.id, code, message } });
        this.failAnimation(active.animation, message);
      });

      video.addEventListener('stalled', () => {
        if (video !== this.layers.activeVideo) return;
        this.logger.warn('video decoding stalled', { data: { id: this.active?.animation.id ?? null } });
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 内部：拒绝                                                          */
  /* ------------------------------------------------------------------ */

  private reject(
    animationId: string,
    rejection: PlayRejectionReason,
    options: PlayOptions,
    detail: string,
  ): void {
    this.logger.info(`animation request rejected: ${animationId}`, {
      data: { rejection, detail, source: options.source ?? 'system', reason: options.reason ?? '' },
    });
    this.eventBus.emit(PetEvents.AnimationRejected, {
      animationId,
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.interrupt !== undefined ? { interrupt: options.interrupt } : {}),
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.source !== undefined ? { source: options.source } : {}),
      rejection,
    });
  }

  public dispose(): void {
    this.clearCompletionWatchdog();
    this.clearLoopEdgeWatch();
    this.registry.clear();
    this.lastPlayedAt.clear();
    this.active = null;
    this.queue = null;
    this.pendingAfterEnd = null;
  }
}

function reasonOrDefault(reason: string | undefined): string {
  return reason && reason.trim() !== '' ? reason : 'unspecified';
}

/**
 * 等待浏览器完成一次绘制。
 * 换视频缓冲前调用它，确保新缓冲真的已经解出并绘制了一帧，
 * 否则交换可见性后仍可能露出空白帧（就是"闪一下"的来源）。
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}
