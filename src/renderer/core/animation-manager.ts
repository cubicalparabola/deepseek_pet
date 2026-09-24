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
  /** 已经请求结束（等本轮循环播完就转收尾），避免重复触发。 */
  endingRequested: boolean;
}

interface QueuedRequest {
  readonly animationId: string;
  readonly options: PlayOptions;
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

  private readonly registry = new Map<string, ResolvedAnimation>();
  private active: ActivePlayback | null = null;
  private readonly lastPlayedAt = new Map<string, number>();
  private queue: QueuedRequest | null = null;

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
    if (current && current.animation.id === animationId && interrupt !== 'force') {
      this.logger.debug('duplicate play request ignored', { data: { animationId } });
      return { accepted: false, animationId, reason: 'same-animation' };
    }

    // 3) 排队策略
    if (current && interrupt === 'queue') {
      this.queue = { animationId, options: { ...options, priority } };
      this.logger.info('animation queued', { data: { animationId, after: current.animation.id } });
      return { accepted: true, animationId, queued: true };
    }

    // 4) 优先级仲裁
    if (current && interrupt !== 'force') {
      if (!current.animation.interruptible) {
        this.reject(animationId, 'not-interruptible', options, `当前动画 ${current.animation.id} 不可打断`);
        return { accepted: false, animationId, reason: 'not-interruptible' };
      }
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
     * 5) 抢占旧动画（旧动画发布 completed=false 的 animation:end）
     *
     * **一律立刻切断**，包括持续动画正处在收尾段（end）的情况：
     * 用户明确要求"end 阶段被打断时立刻切回 idle 或播放打断它的动画"，
     * 而收尾段最长可达 4.4s（watch-end），等它播完才让位会被判定为"点不动"。
     * 持续动画主动结束的路径（endPersistent）也已经是立刻进 end 段，
     * 因此这里不再需要按 reason 前缀区分"用户交互 / 自动化来源"。
     */
    const interruptedId = current?.animation.id;

    if (current) {
      if (current.persistentPhase !== null) {
        this.logger.info('persistent animation cut immediately', {
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

  /** 持续动画当前阶段；null = 当前不是持续动画。 */
  public getPersistentPhase(): PersistentPhase | null {
    return this.active?.persistentPhase ?? null;
  }

  /** 持续动画循环段已完成的轮数（一次性动画返回 0）。 */
  public getLoopCycles(): number {
    return this.active?.loopCycles ?? 0;
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

    const playback: ActivePlayback = {
      animation: definition,
      priority,
      reason,
      source,
      startedAt: Date.now(),
      token,
      persistentPhase: null,
      loopCycles: 0,
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
        ...(definition.segments?.loopCount !== undefined
          ? { loopCount: definition.segments.loopCount }
          : {}),
      },
    });

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

    /*
     * 持续动画：素材已就绪，进入"开场 -> 循环"编排。
     * 有 start 段时先播它，由它的 ended 事件驱动进入循环；
     * 没有 start 段就直接起循环。
     */
    if (definition.kind === 'persistent' && definition.segments && this.layers.activeVideo) {
      await this.beginPersistent(playback);
      if (!this.isStillCurrent(playback)) return true;
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
    this.logger.info('persistent loop', {
      data: {
        id: playback.animation.id,
        source,
        loopCount: segments?.loopCount ?? 'infinite',
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
        const target = active.animation.segments?.loopCount;
        const reached = typeof target === 'number' && target > 0 && active.loopCycles >= target;

        this.eventBus.emit('animation:loop-cycle', {
          animationId: active.animation.id,
          cycle: active.loopCycles,
          ...(typeof target === 'number' && target > 0 ? { target } : {}),
        });
        this.logger.debug('persistent loop cycle', {
          data: { id: active.animation.id, cycle: active.loopCycles, target: target ?? 'infinite' },
        });

        if (reached || active.endingRequested) {
          this.logger.info('persistent loop finished', {
            data: {
              id: active.animation.id,
              cycles: active.loopCycles,
              target: target ?? 'infinite',
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

  /** 播放收尾段；播完即结束整个动画。 */
  private async playEnd(playback: ActivePlayback): Promise<void> {
    const active = this.active;
    if (!active || active.token !== playback.token) return;
    const end = playback.animation.segments?.end;
    if (!end) {
      this.finishActive(true, 'persistent-end:no-end-segment');
      return;
    }

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
      active.loop = definition.loop;
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
    incoming.loop = definition.loop;
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

    this.layers.commitVideoSwap();
    this.layers.showLayer('video');
    await this.layers.playVideo();
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
    // 一次性循环动画也不装
    if (playback.animation.loop && this.active?.persistentPhase === null) return;

    const durationMs = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration * 1000
      : 20000;
    const timeoutMs = Math.max(2000, durationMs + 800);

    this.completionTimer = window.setTimeout(() => {
      this.completionTimer = null;
      const active = this.active;
      if (!active || active.token !== playback.token) return;
      if (active.persistentPhase === 'loop') return;
      if (active.animation.loop && active.persistentPhase === null) return;
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

    this.eventBus.emit(PetEvents.AnimationEnd, {
      animationId: active.animation.id,
      completed,
      reason,
      source: active.source,
    });

    this.flushQueue();
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
