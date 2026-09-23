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
}

interface QueuedRequest {
  readonly animationId: string;
  readonly options: PlayOptions;
}

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
    return {
      ...animation,
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

    // 5) 抢占旧动画（旧动画发布 completed=false 的 animation:end）
    const interruptedId = current?.animation.id;
    if (current) {
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
    };
    this.active = playback;
    this.paused = false;
    this.lastPlayedAt.set(definition.id, Date.now());

    const url = this.resolveAsset(definition.source);
    this.logger.info(`play ${definition.id}`, {
      data: { type: definition.type, priority, source, reason },
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

    this.eventBus.emit(PetEvents.AnimationStart, {
      animationId: definition.id,
      priority,
      loop: definition.loop,
      reason,
      source,
    });
    return true;
  }

  /**
   * 播放视频动画。
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
    if (playback.animation.loop) return;

    const durationMs = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration * 1000
      : 20000;
    const timeoutMs = Math.max(2000, durationMs + 800);

    this.completionTimer = window.setTimeout(() => {
      this.completionTimer = null;
      const active = this.active;
      if (!active || active.token !== playback.token) return;
      if (active.animation.loop) return;
      this.logger.warn('no ended event; finishing by duration fallback', {
        data: { id: active.animation.id, timeoutMs },
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
    this.layers.pauseVideo();

    this.logger.info(`ended ${active.animation.id}`, {
      data: { completed, reason, durationMs: Date.now() - active.startedAt },
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
