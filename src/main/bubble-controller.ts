/**
 * 对话气泡控制器（Main 进程）。
 *
 * 职责只有两件，且必须成对发生：
 *   1. 把"显示/隐藏 + 文本"换算成气泡尺寸与窗口尺寸（`shared/bubble.ts` 的纯函数）；
 *   2. 让窗口按**宠物锚点**扩张/收缩，并把最终布局下发给 Renderer。
 *
 * 为什么不做成"Renderer 自己画一个 div"：桌宠窗口是按宠物裁剪的透明无边框窗口，
 * 气泡在宠物上方，窗口不够大就会被裁掉。窗口尺寸只能由 Main 改，
 * 所以"气泡多大 -> 窗口多大"这件事必须由 Main 决策，否则两边各算一遍必然漂移。
 *
 * 第一版刻意**不做触发机制**（行为/插件/AI 都不会自动说话），
 * 只提供 `show()` / `hide()` 供托盘菜单与验收脚本调用。
 */

import type { Logger } from '../shared/logger';
import {
  resolveBubbleLayout,
  type BubbleLayout,
  type BubblePayload,
  type BubbleState,
} from '../shared/bubble';
import type { WindowSize } from '../shared/ipc';

export interface BubbleControllerDeps {
  readonly logger: Logger;
  /**
   * 当前的**宠物**像素尺寸（未显示气泡时的窗口尺寸）。
   * 每次都要实时取：用户可能刚拖过尺寸滑块。
   */
  getPetSize(): WindowSize;
  /** 窗口是否已创建（未创建时只更新状态，不碰窗口）。 */
  hasWindow(): boolean;
  /**
   * 含气泡的窗口最大高度（通常是显示器工作区高度）。
   *
   * 超过就要等比缩小气泡：否则窗口会被顶到屏幕外、位置被 clamp 拉回，
   * 宠物在屏幕上会一路漂移（实测）。
   */
  getMaxWindowHeight(): number;
  /**
   * 按宠物锚点缩放窗口。
   *
   * @param previousPetBottomOffset 调整前宠物底边到窗口底边的距离
   * @param nextPetBottomOffset     调整后宠物底边到窗口底边的距离
   */
  resizeWindow(
    previousPet: WindowSize,
    nextPet: WindowSize,
    nextWindow: WindowSize,
    previousPetBottomOffset: number,
    nextPetBottomOffset: number,
  ): void;
  /** 把气泡状态 + 布局下发给 Renderer。 */
  notify(payload: BubblePayload): void;
}

export class BubbleController {
  private readonly deps: BubbleControllerDeps;
  private state: BubbleState = { visible: false, text: '', ready: false };
  private layout: BubbleLayout;
  /**
   * 最近一次由 Renderer 测出的文本行数。
   *
   * 气泡高度按它贴合文本 —— 这是"气泡随文本长短变化"的输入。
   * null 表示还没测出来（按最大高度渲染，且**不调整窗口、不显示气泡**）。
   */
  private textLines: number | null = null;
  /**
   * 是否正处于"首次测量中"（已请求显示、但行数还没回来）。
   *
   * 这段时间里窗口尺寸按旧布局保持不变、气泡也不画出来，
   * 避免"先撑大再收缩"造成的闪烁（逐帧诊断实测过）。
   */
  private awaitingMeasure = false;
  /** 测量兜底定时器：万一 Renderer 没回报，也要把气泡显示出来。 */
  private measureFallback: ReturnType<typeof setTimeout> | null = null;

  public constructor(deps: BubbleControllerDeps) {
    this.deps = deps;
    // 初始布局按当前宠物尺寸算一次，保证 `payload()` 任何时候都可用
    this.layout = resolveBubbleLayout(this.layoutInput(this.deps.getPetSize()));
  }

  /** 组装布局输入（宠物尺寸 + 文本行数 + 工作区高度上限）。 */
  private layoutInput(pet: WindowSize): {
    petWidth: number;
    petHeight: number;
    textLines?: number;
    maxWindowHeight: number;
  } {
    return {
      petWidth: pet.width,
      petHeight: pet.height,
      ...(this.textLines !== null ? { textLines: this.textLines } : {}),
      maxWindowHeight: this.deps.getMaxWindowHeight(),
    };
  }

  public isVisible(): boolean {
    return this.state.visible;
  }

  public getText(): string {
    return this.state.text;
  }

  public getLayout(): BubbleLayout {
    return this.layout;
  }

  /** 当前状态 + 布局（bootstrap 与 IPC 下发用同一份）。 */
  public payload(): BubblePayload {
    return { state: { ...this.state }, layout: { ...this.layout } };
  }

  /**
   * 显示气泡（带文本）。
   *
   * **首次显示（或文本变化）时先不调整窗口、也不显示气泡**：
   * 此刻还不知道文本占几行，若照最大高度撑大窗口，会先渲染一帧很高的气泡、
   * 等行数回报后再收缩 —— 用户看到"显示气泡时闪一下"（逐帧诊断实测：
   * 窗口 resize 两次、气泡 419px 闪到 197px、宠物位置跳 400+px）。
   *
   * 因此这里只把布局按最大高度算好下发给渲染层（它需要宽度与字号来量行数），
   * 状态标记 `ready: false` 让渲染层先不要画；等 `reportTextLines()` 回报后
   * 再一次性定型并调整窗口。
   */
  public show(text: string): BubblePayload {
    const wasVisible = this.state.visible;
    const textChanged = text !== this.state.text;
    if (textChanged) this.textLines = null;

    const needsMeasure = (!wasVisible || textChanged) && this.textLines === null;
    this.state = { visible: true, text, ready: !needsMeasure };
    this.awaitingMeasure = needsMeasure;

    if (needsMeasure) {
      /* 先不画、也不动窗口：只更新布局（渲染层要用宽度/字号量行数） */
      this.scheduleMeasureFallback();
      this.applyLayout(null);
      return this.payload();
    }

    this.applyLayout(!wasVisible || textChanged ? this.deps.getPetSize() : null);
    return this.payload();
  }

  /**
   * Renderer 量出的文本行数回报。
   *
   * 行数决定气泡高度，因此这里要按行数重算并调整窗口 ——
   * 这就是"气泡大小随文本长短变化"。行数只依赖"文字区宽度 + 字号"，
   * 两者在一次布局内固定，所以这个闭环最多两轮就收敛。
   */
  public reportTextLines(text: string, lines: number): BubblePayload {
    // 只接受"当前正在显示的那条文本"的回报，避免旧文本的迟到回报改错高度
    if (!this.state.visible || text !== this.state.text) return this.payload();
    if (lines <= 0) return this.payload();
    if (this.textLines === lines) return this.payload();

    this.deps.logger.debug('bubble text lines reported', {
      data: { lines, previous: this.textLines ?? null, textLength: text.length },
    });
    this.textLines = lines;
    this.clearMeasureFallback();
    /*
     * 首次测量完成：这一次才是"真正把窗口调成含气泡尺寸"。
     * 之前窗口一直保持宠物尺寸、气泡也没画出来，因此不会"先撑大再收缩"。
     */
    const wasWaiting = this.awaitingMeasure;
    this.awaitingMeasure = false;
    this.state = { ...this.state, ready: true };
    this.deps.logger.debug('bubble layout finalized', { data: { wasWaiting, lines } });
    this.applyLayout(this.deps.getPetSize());
    return this.payload();
  }

  /** 测量兜底：Renderer 若没回报，也要把气泡显示出来（否则永远不出现）。 */
  private scheduleMeasureFallback(): void {
    this.clearMeasureFallback();
    this.measureFallback = setTimeout(() => {
      this.measureFallback = null;
      if (!this.state.visible || !this.awaitingMeasure) return;
      this.deps.logger.warn('bubble text measure timed out; showing with max height');
      this.awaitingMeasure = false;
      this.state = { ...this.state, ready: true };
      this.applyLayout(this.deps.getPetSize());
    }, 400);
  }

  private clearMeasureFallback(): void {
    if (this.measureFallback === null) return;
    clearTimeout(this.measureFallback);
    this.measureFallback = null;
  }

  /** 隐藏气泡（窗口收回宠物尺寸）。 */
  public hide(): BubblePayload {
    const wasVisible = this.state.visible;
    this.clearMeasureFallback();
    this.awaitingMeasure = false;
    this.state = { visible: false, text: this.state.text, ready: false };
    this.textLines = null;
    this.applyLayout(wasVisible ? this.deps.getPetSize() : null);
    return this.payload();
  }

  /**
   * 宠物尺寸变化后重新计算结果（用户拖了尺寸滑块）。
   *
   * 气泡必须跟着宠物一起缩放，所以尺寸一变就要重算并再次调整窗口。
   * 这里传入旧宠物尺寸用于锚点计算。
   */
  public onPetSizeChanged(previousPet: WindowSize): BubblePayload {
    this.applyLayout(previousPet);
    return this.payload();
  }

  /**
   * 应用布局并按需调整窗口。
   *
   * @param previousPet 需要调整窗口时传入"调整前的宠物尺寸"；null 表示尺寸没变、不必动窗口
   */
  private applyLayout(previousPet: WindowSize | null): void {
    const pet = this.deps.getPetSize();
    const next = resolveBubbleLayout(this.layoutInput(pet));
    const windowSize = windowSizeFor(this.state.visible, next);

    if (previousPet === null) {
      this.layout = next;
      this.notifyOnly();
      return;
    }

    /*
     * 锚点用"宠物底边"：有气泡时宠物下面还有 gap + padding，
     * 它并不贴窗口底边 —— 用窗口底边做锚会导致隐藏时宠物跳位置（实测）。
     * 旧状态的偏移由上一版布局给出，新状态用刚算出来的。
     */
    const previousOffset = this.layout.petBottomOffset;
    const previousWindowSize: WindowSize = { width: previousPet.width, height: previousPet.height };
    this.layout = next;

    if (this.deps.hasWindow()) {
      this.deps.resizeWindow(
        previousWindowSize,
        pet,
        windowSize,
        previousOffset,
        next.petBottomOffset,
      );
    }
    this.deps.logger.info('bubble layout applied', {
      data: {
        visible: this.state.visible,
        textLength: this.state.text.length,
        pet: `${pet.width}x${pet.height}`,
        bubble: `${next.bubbleWidth}x${next.bubbleHeight}`,
        window: `${windowSize.width}x${windowSize.height}`,
        /* 水平定位相关：排查"气泡被裁 / 偏移不生效"时直接看这四个数 */
        offsetX: next.offsetX,
        marginLeft: next.marginLeft,
        padding: next.padding,
      },
    });
    this.notifyOnly();
  }

  /** 只下发状态（窗口已经由调用方或本类调好）。 */
  private notifyOnly(): void {
    try {
      this.deps.notify(this.payload());
    } catch (error) {
      this.deps.logger.warn('bubble notify failed', { error });
    }
  }
}

/**
 * 由气泡布局推出**窗口**尺寸（气泡可见时含气泡，隐藏时收回纯宠物尺寸）。
 *
 * 提成纯函数便于直接断言"气泡越大窗口越高"，不必真的开窗口。
 */
export function windowSizeFor(visible: boolean, layout: BubbleLayout): WindowSize {
  return visible
    ? { width: layout.windowWidth, height: layout.windowHeight }
    : { width: layout.petWidth, height: layout.petHeight };
}

