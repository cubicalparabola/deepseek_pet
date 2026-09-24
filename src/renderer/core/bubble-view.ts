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
import { BUBBLE_LINE_HEIGHT, BUBBLE_TEXT_INSET } from '../../shared/bubble';
export interface BubbleViewOptions {
  /** 舞台根元素（CSS 变量写在它上面）。 */
  readonly stage: HTMLElement;
  /** 气泡容器。 */
  readonly element: HTMLElement;
  /** 气泡里的文字层（滚动容器）。 */
  readonly textElement: HTMLElement;
  /**
   * 正文元素（滚动容器的子元素）。
   *
   * 必须与滚动容器分开：垂直居中靠正文上的 `margin-block: auto` 实现，
   * 而**不能**用滚动容器的 `justify-content: center`（内容超高时会裁掉顶部）。
   * 同时也能避免写正文时把内部结构覆盖掉。
   */
  readonly bodyElement: HTMLElement;
  /** "知道了"关闭按钮。 */
  readonly ackElement: HTMLElement;
  /** 点击关闭按钮时回调（由 App 负责真正隐藏气泡）。 */
  readonly onAcknowledge: () => void;
}

export class BubbleView {
  private readonly stage: HTMLElement;
  private readonly element: HTMLElement;
  private readonly textElement: HTMLElement;
  private readonly bodyElement: HTMLElement;
  private readonly ackElement: HTMLElement;
  /** 最近一次应用的布局（验收要按它断言"宠物在窗口内的偏移"）。 */
  private layout: BubbleLayout | null = null;
  /** 复用的测量用 canvas 上下文（避免每次量文本都新建元素）。 */
  private measureContext: CanvasRenderingContext2D | null = null;

  public constructor(options: BubbleViewOptions) {
    this.stage = options.stage;
    this.element = options.element;
    this.textElement = options.textElement;
    this.bodyElement = options.bodyElement;
    this.ackElement = options.ackElement;
    /*
     * 按钮的点击只做"上报"，真正隐藏气泡由 App 负责 ——
     * 状态在 Main 进程（窗口尺寸也要跟着收），这里不该自己改状态。
     */
    this.ackElement.addEventListener('click', () => options.onAcknowledge());
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

    /*
     * 容器高度由共享模型给出（按"主体比例 + 尾巴区比例"反推），
     * 渲染层不再自己算 —— 两边各算一遍必然把主体拉伸变形。
     *
     * 额外把容器高度**对齐到整数行高**：正文区高度 = 容器 × 36%，
     * 不对齐时它的底边会正好切在一行字中间，滚动时最后一行像是被裁掉。
     * 对齐后上下边界都落在行与行之间（实测踩过：155px 正文区配 24.65px 行高）。
     */
    const lineHeight = layout.fontSize * BUBBLE_LINE_HEIGHT;
    const containerHeight = lineHeight > 0
      ? Math.round(layout.containerHeight / lineHeight) * lineHeight
      : layout.containerHeight;
    this.element.style.width = `${layout.bubbleWidth}px`;
    this.element.style.height = `${Math.round(containerHeight)}px`;
    /*
     * 水平位置用**显式左边距**，不要用 flex 居中 + 位移。
     *
     * 舞台是 `align-items: center` 的 flex 容器，会先把气泡居中；
     * 再叠 `left`/`transform` 的偏移时，两者在窗口尺寸变化下结果不可预测
     * （实测气泡左边缘跑到窗口外 23px 被裁）。这里改成：让舞台左对齐，
     * 气泡位置完全由 marginLeft 决定（窗口宽度已含偏移量，不会溢出）。
     */
    this.element.style.marginLeft = `${layout.marginLeft}px`;

    /* "知道了"按钮：高度随宠物缩放（0 = 不显示） */
    const showButton = layout.buttonHeight > 0;
    this.ackElement.hidden = !showButton;
    if (showButton) this.ackElement.style.height = `${layout.buttonHeight}px`;
  }

  /**
   * 量出该文本在**当前气泡宽度**下会占多少行。
   *
   * 为什么要在 Renderer 量：只有这里能做字体度量。用 canvas 的
   * `measureText` 逐字折行，规则与 CSS 一致（中文逐字断行、英文按空格断行），
   * 因此结果可以直接交给主进程换算气泡高度。
   *
   * @returns 行数；无法测量（无 canvas / 无布局）时返回 0，调用方按"最大高度"处理
   */
  public measureTextLines(text: string): number {
    const layout = this.layout;
    if (!layout || text === '') return 0;
    const context = this.resolveMeasureContext(layout.fontSize);
    if (context === null) return 0;

    /* 文字区可用宽度 = 气泡宽 × (1 - 左内缩 - 右内缩)，与 CSS 的左右 insets 一致 */
    const usableWidth = layout.bubbleWidth * (1 - (BUBBLE_TEXT_INSET.left + BUBBLE_TEXT_INSET.right) / 100);
    if (usableWidth <= 0) return 0;

    let lines = 0;
    for (const paragraph of text.split('\n')) {
      lines += this.wrapParagraph(context, paragraph, usableWidth);
    }
    return lines;
  }

  /** 把一个段落按可用宽度折行，返回行数（空段落算 1 行，与 CSS 一致）。 */
  private wrapParagraph(context: CanvasRenderingContext2D, paragraph: string, usableWidth: number): number {
    if (paragraph === '') return 1;
    let lines = 1;
    let current = '';
    /*
     * 逐字符累加：中英文混排下"逐字符断行"是最接近 CSS 行为的稳妥近似
     * （英文单词会被拆开，但只影响"需要几行"的估算，不影响实际渲染）。
     */
    for (const char of paragraph) {
      const candidate = current + char;
      if (context.measureText(candidate).width > usableWidth && current !== '') {
        lines += 1;
        current = char;
      } else {
        current = candidate;
      }
    }
    return lines;
  }

  private resolveMeasureContext(fontSize: number): CanvasRenderingContext2D | null {
    if (this.measureContext === null) {
      try {
        this.measureContext = document.createElement('canvas').getContext('2d');
      } catch {
        this.measureContext = null;
      }
    }
    if (this.measureContext === null) return null;
    /*
     * 字体必须与 CSS 完全一致，否则量出的宽度不准。
     * 这里与 styles.css 的 .pet-bubble-text 同源：系统 UI 字体栈。
     */
    this.measureContext.font = `${fontSize}px 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif`;
    return this.measureContext;
  }

  /** 当前字号下的行高（px），供验收核对"文字区能放几行"。 */
  public currentLineHeight(): number {
    const layout = this.layout;
    if (!layout) return 0;
    const fromStyle = Number.parseFloat(getComputedStyle(this.textElement).lineHeight);
    return Number.isFinite(fromStyle) && fromStyle > 0 ? fromStyle : layout.fontSize * BUBBLE_LINE_HEIGHT;
  }

  /** 应用状态（显隐 + 文本）。 */
  public applyState(state: BubbleState): void {
    const visible = state.visible;
    this.element.hidden = !visible;
    // 写**正文元素**而不是滚动容器：容器里还有正文这一层结构，不能被覆盖
    if (this.bodyElement.textContent !== state.text) {
      this.bodyElement.textContent = state.text;
      // 换文本后回到顶部：否则"上一次滚到底"会留在新文本上，看起来像内容缺失
      this.textElement.scrollTop = 0;
    }
  }

  public isVisible(): boolean {
    return !this.element.hidden;
  }

  /** 当前气泡高度（px）—— 渲染层用它判断"回报后布局是否真的变了"。 */
  public getBubbleHeight(): number {
    return this.layout?.bubbleHeight ?? 0;
  }

  /** 当前气泡文本（`applyState` 时更新）。 */
  public getText(): string {
    /*
     * 必须与 applyState 写入的是**同一个元素**（正文元素）。
     * 读滚动容器的 textContent 会把 HTML 缩进产生的空白也算进去，
     * 导致"文字内容原样落地"这条断言失败（实测）。
     */
    return this.bodyElement.textContent ?? '';
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
      textLength: (this.bodyElement.textContent ?? '').length,
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
      /** 主进程算出的**内容**高度（正文贴合文本的结果，不含尾巴区）。 */
      contentHeight: layout?.bubbleHeight ?? 0,
      /** 主进程算出的容器高度（含尾巴区）——应与 bubble.height 相等。 */
      containerHeight: layout?.containerHeight ?? 0,
      /* 布局参数：验收按它断言"宠物在窗口内的偏移"，不必依赖窗口屏幕坐标 */
      padding: layout?.padding ?? 0,
      gap: layout?.gap ?? 0,
    };
  }
}
