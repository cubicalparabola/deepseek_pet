/**
 * 对话气泡的**视图层**（纯 DOM，不做任何决策）。
 *
 * 分工：
 *   - Main（`bubble-controller.ts` + `shared/bubble.ts`）决定"气泡多大、窗口多大"；
 *   - 这里只负责把下发的 `BubbleLayout` 落到 DOM 上。
 *
 * 两个关键点：
 *   1. **宠物尺寸与窗口尺寸解耦**：显示气泡时窗口会变大，但宠物必须原地不动，
 *      因此宠物的像素尺寸写成 CSS 变量（`--pet-px-*`），宠物容器用固定尺寸，
 *      窗口多出来的空间全部给气泡；
 *   2. **长文本滚动**：文字层是绝对定位在气泡留白区里的滚动容器
 *      （`overflow-y: auto`），滚轮与拖动滚动条都由浏览器原生处理。
 */

import type { BubbleLayout, BubbleState } from '../../shared/bubble';

export interface BubbleViewOptions {
  /** 舞台根元素（CSS 变量写在它上面）。 */
  readonly stage: HTMLElement;
  /** 气泡容器。 */
  readonly element: HTMLElement;
  /** 气泡里的文字层（滚动容器）。 */
  readonly textElement: HTMLElement;
}

export class BubbleView {
  private readonly stage: HTMLElement;
  private readonly element: HTMLElement;
  private readonly textElement: HTMLElement;
  /** 最近一次应用的布局（验收要按它断言"宠物在窗口内的偏移"）。 */
  private layout: BubbleLayout | null = null;

  public constructor(options: BubbleViewOptions) {
    this.stage = options.stage;
    this.element = options.element;
    this.textElement = options.textElement;
  }

  /**
   * 应用布局（宠物尺寸 + 气泡尺寸 + 字号）。
   *
   * 每次尺寸变化都要重新写一遍：气泡必须**跟随宠物大小**一起缩放。
   */
  public applyLayout(layout: BubbleLayout): void {
    this.layout = layout;
    const style = this.stage.style;
    style.setProperty('--pet-px-width', `${layout.petWidth}px`);
    style.setProperty('--pet-px-height', `${layout.petHeight}px`);
    style.setProperty('--bubble-gap', `${layout.gap}px`);
    style.setProperty('--bubble-pad', `${layout.padding}px`);
    style.setProperty('--bubble-font-size', `${layout.fontSize}px`);

    this.element.style.width = `${layout.bubbleWidth}px`;
    this.element.style.height = `${layout.bubbleHeight}px`;
  }

  /** 应用状态（显隐 + 文本）。 */
  public applyState(state: BubbleState): void {
    const visible = state.visible;
    this.element.hidden = !visible;
    if (this.textElement.textContent !== state.text) {
      this.textElement.textContent = state.text;
      // 换文本后回到顶部：否则"上一次滚到底"会留在新文本上，看起来像内容缺失
      this.textElement.scrollTop = 0;
    }
  }

  public isVisible(): boolean {
    return !this.element.hidden;
  }

  /** 文字层当前是否需要滚动（验收断言用：长文本必须出现滚动条）。 */
  public isScrollable(): boolean {
    return this.textElement.scrollHeight > this.textElement.clientHeight + 1;
  }

  /** 供验收/调试读取的只读快照。 */
  public describe(): Record<string, unknown> {
    const text = this.textElement;
    const layout = this.layout;
    return {
      visible: this.isVisible(),
      textLength: (text.textContent ?? '').length,
      clientWidth: text.clientWidth,
      clientHeight: text.clientHeight,
      scrollWidth: text.scrollWidth,
      scrollHeight: text.scrollHeight,
      scrollable: this.isScrollable(),
      fontSize: getComputedStyle(text).fontSize,
      bubble: {
        width: this.element.clientWidth,
        height: this.element.clientHeight,
      },
      /* 布局参数：验收按它断言"宠物在窗口内的偏移"，不必依赖窗口屏幕坐标 */
      padding: layout?.padding ?? 0,
      gap: layout?.gap ?? 0,
    };
  }
}
