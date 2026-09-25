/**
 * InteractionManager —— 鼠标互动。
 *
 * 职责：
 * - 命中区域（region）计算：把鼠标位置映射到 head/face/ear/body/belly/skirt/legs/tail/outside；
 * - 点击 / 双击 / 右键 / 进入退出 / 拖拽 的识别，并发布 pet:* 事件；
 * - **不直接播放动画**：只发布事件 + 通过回调把交互意图交给 Action Pipeline。
 *
 * 拖拽说明：
 * Windows 上无边框窗口拖动推荐使用 `-webkit-app-region: drag`，
 * 但桌宠需要精确区分“点击”与“拖动”，因此这里用指针事件计算位移，
 * 超过阈值才切换为拖动模式，并把屏幕坐标交给 Main 进程移动窗口。
 */

import type { PetClickPayload, PetDragPayload, PetPointerPayload } from '../../shared/events';
import { PetEvents } from '../../shared/events';
import type { Logger } from '../../shared/logger';
import type { EventBus } from './event-bus';

export interface InteractionRegions {
  /** 归一化区域划分（均为 0-1，基于桌宠窗口内部坐标）。 */
  readonly headTop: number;
  readonly faceBottom: number;
  readonly earWidth: number;
  readonly bodyBottom: number;
  readonly bellyBottom: number;
  readonly skirtBottom: number;
  readonly tailX: number;
  readonly contentBottom: number;
}

export const DEFAULT_REGIONS: InteractionRegions = {
  headTop: 0,
  faceBottom: 0.32,
  earWidth: 0.22,
  bodyBottom: 0.6,
  bellyBottom: 0.68,
  skirtBottom: 0.86,
  tailX: 0.2,
  // 素材底部约 5% 是投影/空白，避免点空白也触发互动
  contentBottom: 0.97,
};

export type PetRegion = 'head' | 'face' | 'ear' | 'body' | 'belly' | 'skirt' | 'legs' | 'tail' | 'outside';

export interface InteractionManagerOptions {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  /** 交互目标（桌宠舞台元素）。 */
  readonly stage: HTMLElement;
  readonly regions?: Partial<InteractionRegions>;
  /** 点击意图回调：由 compose 层转成 Action 投递到 Pipeline。 */
  readonly onIntent: (intent: InteractionIntent) => void;
  /** 请求打开原生右键菜单。 */
  readonly onContextMenu: (context: { region: PetRegion }) => void;
  /** 拖拽：请求 Main 进程把窗口移动到指定屏幕坐标。 */
  readonly onDragMove: (screenX: number, screenY: number) => void;
  readonly onDragStart: (screenX: number, screenY: number) => void;
  readonly onDragEnd: (screenX: number, screenY: number) => void;
  /**
   * 上报"发生了一次互动"（2.3 情绪系统的输入）。
   *
   * 为什么放在这里而不是监听 pet:* 事件：情绪只关心**用户真的碰了她**，
   * 而 `pet:*` 事件还会被插件/行为触发（例如定时抚摸）。
   * 在事件源头上报，"互动"与"非互动"的边界才是清楚的。
   */
  readonly onInteraction?: (kind: 'click' | 'doubleclick' | 'drag') => void;
}

export type InteractionIntent =
  | { readonly kind: 'click'; readonly region: PetRegion; readonly payload: PetClickPayload }
  | { readonly kind: 'double-click'; readonly region: PetRegion; readonly payload: PetClickPayload }
  | { readonly kind: 'region-enter'; readonly region: PetRegion; readonly payload: PetPointerPayload };

export class InteractionManager {
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly stage: HTMLElement;
  private readonly regions: InteractionRegions;
  private readonly options: InteractionManagerOptions;

  private pointerDown = false;
  private dragging = false;
  private dragOriginScreen = { x: 0, y: 0 };
  private downAt = 0;
  private downPoint = { x: 0, y: 0 };
  private currentRegion: PetRegion = 'outside';
  private lastClickAt = 0;
  private readonly dragThreshold = 5;

  public constructor(options: InteractionManagerOptions) {
    this.options = options;
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.stage = options.stage;
    this.regions = { ...DEFAULT_REGIONS, ...options.regions };
  }

  /** 绑定 DOM 事件。只调用一次。 */
  public attach(): void {
    const stage = this.stage;
    stage.addEventListener('pointerdown', this.handlePointerDown, { capture: true });
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerCancel);
    stage.addEventListener('contextmenu', this.handleContextMenu);
    stage.addEventListener('pointerenter', this.handlePointerEnter);
    stage.addEventListener('pointerleave', this.handlePointerLeave);
    stage.addEventListener('dblclick', this.handleDoubleClick);
    this.logger.info('interaction events bound');
  }

  public detach(): void {
    const stage = this.stage;
    stage.removeEventListener('pointerdown', this.handlePointerDown, { capture: true });
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerCancel);
    stage.removeEventListener('contextmenu', this.handleContextMenu);
    stage.removeEventListener('pointerenter', this.handlePointerEnter);
    stage.removeEventListener('pointerleave', this.handlePointerLeave);
    stage.removeEventListener('dblclick', this.handleDoubleClick);
  }

  public getRegion(): PetRegion {
    return this.currentRegion;
  }

  /** 把窗口内坐标映射到身体区域。导出为公共方法便于测试与插件复用。 */
  public resolveRegion(clientX: number, clientY: number): { region: PetRegion; nx: number; ny: number } {
    const rect = this.stage.getBoundingClientRect();
    const nx = clamp01((clientX - rect.left) / Math.max(1, rect.width));
    const ny = clamp01((clientY - rect.top) / Math.max(1, rect.height));
    return { region: this.classify(nx, ny), nx, ny };
  }

  private classify(nx: number, ny: number): PetRegion {
    const r = this.regions;
    if (ny > r.contentBottom) return 'outside';
    // 尾巴：素材中尾巴在左下侧
    if (nx < r.tailX && ny > r.faceBottom && ny < r.skirtBottom) return 'tail';
    if (ny >= r.headTop && ny < r.faceBottom) {
      if (nx < r.earWidth || nx > 1 - r.earWidth) return 'ear';
      return 'head';
    }
    if (ny < r.bodyBottom) return 'body';
    if (ny < r.bellyBottom) return 'belly';
    if (ny < r.skirtBottom) return 'skirt';
    return 'legs';
  }

  /* ------------------------------------------------------------------ */
  /* 事件处理                                                            */
  /* ------------------------------------------------------------------ */

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    /*
     * 从**界面元素**（如气泡上的"知道了"按钮、气泡里的文字/滚动条）发起的指针事件
     * 一律不参与宠物交互 —— 否则点按钮会顺带触发一次宠物点击动画（用户反馈）。
     * 用 `data-pet-ui` 标记，而不是写死元素 id：以后再加别的浮层 UI 只要打标记。
     */
    if (isFromPetUi(event.target)) return;
    this.pointerDown = true;
    this.dragging = false;
    this.downAt = Date.now();
    this.downPoint = { x: event.screenX, y: event.screenY };
    this.dragOriginScreen = { x: event.screenX, y: event.screenY };
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.pointerDown) return;
    const dx = event.screenX - this.downPoint.x;
    const dy = event.screenY - this.downPoint.y;
    if (!this.dragging && Math.hypot(dx, dy) < this.dragThreshold) return;

    if (!this.dragging) {
      this.dragging = true;
      this.options.onDragStart(event.screenX, event.screenY);
      this.emitDrag('start', event.screenX, event.screenY);
      // 拖动算一次互动（但比点击轻：她只是被挪了个位置）
      this.options.onInteraction?.('drag');
      this.logger.info('drag start');
    }
    this.options.onDragMove(event.screenX, event.screenY);
    this.emitDrag('move', event.screenX, event.screenY);
    event.preventDefault();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.pointerDown) return;
    /* 兜底：pointerup 落在 UI 元素上时同样不当作宠物点击 */
    if (isFromPetUi(event.target)) return;
    const wasDragging = this.dragging;
    this.pointerDown = false;
    this.dragging = false;

    if (wasDragging) {
      this.options.onDragEnd(event.screenX, event.screenY);
      this.emitDrag('end', event.screenX, event.screenY);
      this.logger.info('drag end');
      return;
    }

    if (event.button !== 0) return;
    const elapsed = Date.now() - this.downAt;
    if (elapsed > 900) return; // 长按不视为点击

    const { region, nx, ny } = this.resolveRegion(event.clientX, event.clientY);
    if (region === 'outside') return;

    // 双击由 dblclick 处理，这里避免重复触发
    const now = Date.now();
    if (now - this.lastClickAt < 320) return;
    this.lastClickAt = now;

    const payload: PetClickPayload = {
      button: 'left',
      x: event.clientX,
      y: event.clientY,
      nx,
      ny,
      region,
      detail: 1,
    };

    this.eventBus.emit(PetEvents.PetClick, payload);
    this.options.onIntent({ kind: 'click', region, payload });
    this.options.onInteraction?.('click');
  };

  private handlePointerCancel = (): void => {
    if (this.dragging) this.options.onDragEnd(this.downPoint.x, this.downPoint.y);
    this.pointerDown = false;
    this.dragging = false;
  };

  private handleDoubleClick = (event: MouseEvent): void => {
    if (isFromPetUi(event.target)) return;
    const { region, nx, ny } = this.resolveRegion(event.clientX, event.clientY);
    if (region === 'outside') return;
    const payload: PetClickPayload = {
      button: 'left',
      x: event.clientX,
      y: event.clientY,
      nx,
      ny,
      region,
      detail: 2,
    };
    this.eventBus.emit(PetEvents.PetDoubleClick, payload);
    this.options.onIntent({ kind: 'double-click', region, payload });
    this.options.onInteraction?.('doubleclick');
  };

  private handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    /* 在气泡 UI 上右键不该弹出宠物右键菜单 */
    if (isFromPetUi(event.target)) return;
    const { region } = this.resolveRegion(event.clientX, event.clientY);
    this.logger.debug('context menu requested', { data: { region } });
    this.options.onContextMenu({ region });
  };

  private handlePointerEnter = (event: PointerEvent): void => {
    const { region, nx, ny } = this.resolveRegion(event.clientX, event.clientY);
    this.emitPointer(PetEvents.PetPointerEnter, region, nx, ny, event);
    this.updateRegion(region, nx, ny, event);
  };

  private handlePointerLeave = (event: PointerEvent): void => {
    const payload: PetPointerPayload = {
      x: event.clientX,
      y: event.clientY,
      nx: 0,
      ny: 0,
      region: 'outside',
    };
    this.eventBus.emit(PetEvents.PetPointerLeave, payload);
    this.currentRegion = 'outside';
  };

  /** 指针移动时更新 region 并发布区域变化事件。 */
  public trackPointer(event: PointerEvent): void {
    const { region, nx, ny } = this.resolveRegion(event.clientX, event.clientY);
    this.emitPointer(PetEvents.PetPointerMove, region, nx, ny, event);
    this.updateRegion(region, nx, ny, event);
  }

  private updateRegion(region: PetRegion, nx: number, ny: number, event: PointerEvent): void {
    if (region === this.currentRegion) return;
    this.currentRegion = region;
    const payload = { region, x: event.clientX, y: event.clientY, nx, ny };
    this.eventBus.emit(PetEvents.PetRegion, payload);
    this.options.onIntent({ kind: 'region-enter', region, payload });
  }

  private emitPointer(
    eventName: string,
    region: PetRegion,
    nx: number,
    ny: number,
    event: PointerEvent,
  ): void {
    const payload: PetPointerPayload = { x: event.clientX, y: event.clientY, nx, ny, region };
    this.eventBus.emit(eventName, payload);
  }

  private emitDrag(phase: PetDragPayload['phase'], screenX: number, screenY: number): void {
    const payload: PetDragPayload = {
      phase,
      screenX,
      screenY,
      offsetX: screenX - this.dragOriginScreen.x,
      offsetY: screenY - this.dragOriginScreen.y,
    };
    this.eventBus.emit(PetEvents.PetDrag, payload);
  }
}

/**
 * 事件是否来自**浮层 UI**（带 `data-pet-ui` 标记的元素内部，例如对话气泡）。
 *
 * 为什么要这个判断：气泡与宠物在同一个窗口里，气泡上的点击/拖动/右键都会
 * 冒泡到舞台的指针事件，被当成"点到了宠物" —— 点"知道了"按钮会顺带触发
 * 一次宠物点击动画（用户反馈）。打标记而不是写死元素 id，
 * 以后再加别的浮层 UI 只要给元素加 `data-pet-ui` 即可。
 */
function isFromPetUi(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('[data-pet-ui]') !== null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
