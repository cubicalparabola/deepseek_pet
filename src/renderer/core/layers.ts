/**
 * PetLayers —— 桌宠的渲染图层（DOM 表现层）。
 *
 * 设计要点：
 * - 舞台上有多个图层（双缓冲视频、PNG 静态图），集中在这里管理；
 * - AnimationManager 只做“决策”，显示/隐藏/换源/交换交给本类；
 * - 素材已由 `tools/convert-alpha.mjs` **离线烘焙成带 alpha 的 VP9 WebM**，
 *   因此视频层可以直接显示，运行时**不再做任何逐帧像素处理**。
 *
 * 为什么视频要**双缓冲**：
 * 给 `<video>` 换 `src` 会让 Chromium 立刻丢掉当前帧（`emptied`，readyState -> 0）。
 * 如果这时元素还是可见的，桌宠会整只变透明 —— 表现为"播放前/播放后闪一下"。
 * 因此换源必须发生在**隐藏的那个** `<video>` 上，等它可播之后再交换可见性。
 *
 * 为什么不用 fetch + Blob 加载素材：
 * 页面 CSP 是 `connect-src 'none'`，`fetch('pet-asset://...')` 会被直接拒绝。
 * 素材一律交给 `<video src>` 自己读取，由 pet-asset:// 协议处理器服务。
 *
 * 布局：舞台 = 窗口尺寸；视频用 object-fit: contain 保持宽高比，
 * 因此 834x1112 与 720x966 两种素材都能正确铺满而不变形。
 */

import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export type LayerKind = 'video' | 'image';

export interface StageOptions {
  /** 舞台容器（透明，占满窗口）。 */
  readonly stage: HTMLElement;
  /** 视频缓冲 A。 */
  readonly videoA: HTMLVideoElement;
  /** 视频缓冲 B。 */
  readonly videoB: HTMLVideoElement;
  /** 图片元素：静态动画层（Manifest 中 type 为 "image" 的条目）。 */
  readonly image: HTMLImageElement;
  readonly logger: Logger;
}

export class PetLayers {
  public readonly stage: HTMLElement;
  public readonly image: HTMLImageElement;

  private readonly videos: readonly [HTMLVideoElement, HTMLVideoElement];
  private readonly logger: Logger;
  /** 当前可见/生效的视频缓冲索引。 */
  private activeIndex: 0 | 1 = 0;
  private currentClassName = '';
  /** 最近一次要播放的素材 URL（自愈重载用）。 */
  private currentVideoSourceHint = '';

  public constructor(options: StageOptions) {
    this.stage = options.stage;
    this.image = options.image;
    this.logger = options.logger;
    this.videos = [options.videoA, options.videoB];

    // 初始态：两个缓冲都不可见，由 showLayer 决定谁露出来
    for (const video of this.videos) video.classList.remove('layer-active');
  }

  /* ------------------------------------------------------------------ */
  /* 视频双缓冲                                                          */
  /* ------------------------------------------------------------------ */

  /** 当前正在显示的视频元素。 */
  public get activeVideo(): HTMLVideoElement {
    return this.videos[this.activeIndex];
  }

  /** 处于备用的视频元素（换源应该发生在它身上）。 */
  public get spareVideo(): HTMLVideoElement {
    return this.videos[this.activeIndex === 0 ? 1 : 0];
  }

  /** 所有视频元素（用于统一绑定事件）。 */
  public get allVideos(): readonly [HTMLVideoElement, HTMLVideoElement] {
    return this.videos;
  }

  /**
   * 把备用缓冲切为可见，同时隐藏原缓冲并清掉它的素材。
   * 只有当新缓冲**已经可播**时才应该调用。
   */
  public commitVideoSwap(): void {
    const incoming = this.spareVideo;
    const outgoing = this.activeVideo;

    // 先让新缓冲可见，再撤掉旧的：顺序反了会露出一帧空白
    incoming.classList.add('layer-active');
    outgoing.classList.remove('layer-active');
    outgoing.pause();

    this.activeIndex = this.activeIndex === 0 ? 1 : 0;

    // 清掉旧缓冲的素材，释放解码资源
    try {
      outgoing.removeAttribute('src');
      outgoing.load();
    } catch (error) {
      this.logger.warn('releasing old video buffer failed', { error: describeError(error) });
    }
  }

  /**
   * 记录本次要播放的素材 URL。
   * 必须在 setVideoSource 之前调用，这样自愈重载才知道该加载哪个素材。
   */
  public setVideoSourceHint(source: string): void {
    this.currentVideoSourceHint = source;
  }

  /** 目前生效的素材 URL（原始 pet-asset:// 地址）。 */
  public get activeVideoSource(): string {
    return this.currentVideoSourceHint;
  }

  /** 当前可见缓冲是否正在播放指定素材且画面可用。 */
  public isActiveSource(source: string): boolean {
    return this.currentVideoSourceHint === source && this.isVideoReady();
  }

  /**
   * 设置某个视频缓冲的素材（不改变可见性）。
   *
   * 两个必须注意的点：
   * 1. 比对时要把"当前没有可用帧"也当成需要重载
   *    （释放缓冲会清空 src，而 currentSrc 可能仍是旧值）；
   * 2. 只要 readyState < 2 就必须重新 load，
   *    否则元素会停在 readyState 0 这种"有 src、没画面"的僵死状态。
   */
  public setVideoSource(video: HTMLVideoElement, source: string): void {
    const effective = video.currentSrc || video.src || '';
    if (effective === source && video.readyState >= 2) return;
    this.forceVideoSource(video, source);
  }

  /**
   * 无条件重新加载素材（先清空再设置）。
   * 清空 src 可以强制走一遍完整加载，用于从僵死状态恢复。
   */
  public forceVideoSource(video: HTMLVideoElement, source: string): void {
    try {
      video.removeAttribute('src');
      video.load();
    } catch {
      /* 忽略：紧接着就会写入新 src */
    }
    video.src = source;
    video.load();
  }

  /** 强制重新加载当前可见缓冲的素材（自愈用）。 */
  public forceReloadActiveVideo(): void {
    const source = this.currentVideoSourceHint;
    if (!source) {
      this.logger.warn('cannot force reload: no asset URL recorded');
      return;
    }
    this.forceVideoSource(this.activeVideo, source);
  }

  /**
   * 重置**两个**视频缓冲（清空素材 + 释放解码资源）。
   * 自愈用：不确定是哪个缓冲出的问题，索性整体重来。
   */
  public resetVideoBuffers(): void {
    for (const video of this.videos) {
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch (error) {
        this.logger.warn('resetting video buffers failed', { error: describeError(error), data: { id: video.id } });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 通用                                                               */
  /* ------------------------------------------------------------------ */

  /** 当前舞台尺寸（CSS 像素）。 */
  public get size(): { width: number; height: number } {
    const rect = this.stage.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }

  public showLayer(kind: LayerKind): void {
    this.activeVideo.classList.toggle('layer-active', kind === 'video');
    this.image.classList.toggle('layer-active', kind === 'image');
  }

  /** 播放当前缓冲。 */
  public async playVideo(): Promise<void> {
    try {
      await this.activeVideo.play();
    } catch (error) {
      this.logger.warn('video play rejected', { error: describeError(error) });
      throw error;
    }
  }

  public pauseVideo(): void {
    try {
      this.activeVideo.pause();
    } catch (error) {
      this.logger.warn('video pause failed', { error: describeError(error) });
    }
  }

  /** 当前缓冲的元数据是否可用。 */
  public isVideoReady(): boolean {
    const video = this.activeVideo;
    return video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
  }

  /**
   * 当前可见画面是否**真的能画出来**。
   * 用于自愈：区分"有个元素在播但没数据"和"确实有画面"。
   */
  public isVideoRenderable(): boolean {
    if (this.image.classList.contains('layer-active')) return this.image.naturalWidth > 0;
    return this.isVideoReady();
  }

  /**
   * 应用逐动画的 CSS 类名与对位微调。
   * 旧类名会被移除，避免切换动画时样式互相污染。
   */
  public applyRenderHints(
    hints: {
      readonly className?: string;
      readonly offsetXPercent?: number;
      readonly offsetYPercent?: number;
    } | undefined,
  ): void {
    const classes = (hints?.className ?? '').split(' ').filter(Boolean);
    const previous = this.currentClassName.split(' ').filter(Boolean);

    for (const element of [...this.videos, this.image] as const) {
      if (previous.length > 0) element.classList.remove(...previous);
      if (classes.length > 0) element.classList.add(...classes);
    }
    this.currentClassName = hints?.className ?? '';

    const offsetX = hints?.offsetXPercent ?? 0;
    const offsetY = hints?.offsetYPercent ?? 0;
    const transform = offsetX === 0 && offsetY === 0 ? '' : `translate(${offsetX}%, ${offsetY}%)`;
    for (const element of [...this.videos, this.image] as const) {
      element.style.transform = transform;
    }
  }

  public setImageSource(source: string): void {
    if (this.image.src !== source) this.image.src = source;
  }

  /** 阻止图片/视频被浏览器原生拖拽（桌宠拖动由 InteractionManager 处理）。 */
  public disableNativeDrag(): void {
    for (const element of [...this.videos, this.image] as const) {
      element.addEventListener('dragstart', (event) => event.preventDefault());
    }
  }
}
