/**
 * 对话气泡的几何模型（Main / Renderer / Preload 共用）。
 *
 * 为什么几何算在 **Main** 进程：
 * 气泡要显示在宠物上方，而桌宠窗口是按宠物尺寸精确裁剪的（透明无边框），
 * 因此显示气泡时**必须把窗口变大**。窗口尺寸只能由 Main 改，
 * 所以"气泡多大、窗口要长多少"这件事必须和窗口尺寸在同一处算，
 * 否则两边各算一遍必然漂移。
 *
 * 气泡素材是近正方形的（1434x1426），文字可用区域相对偏小，
 * 所以窗口不仅变高，还要变宽 —— 但宠物本身**尺寸和位置都不动**：
 * 窗口以宠物为中心水平扩展、向**上**扩展（底边固定），
 * 这样宠物的脚不会因为弹个气泡就跳一下。
 */

/** 气泡素材原始像素（assets/bubble.png）。 */
export const BUBBLE_IMAGE_WIDTH = 1434;
export const BUBBLE_IMAGE_HEIGHT = 1426;

/** 气泡宽高比（宽 / 高 ≈ 1.0056，几乎正方形）。 */
export const BUBBLE_ASPECT_RATIO = BUBBLE_IMAGE_WIDTH / BUBBLE_IMAGE_HEIGHT;

/**
 * 气泡宽度 = 宠物**高度** × 该系数。
 *
 * 为什么基准取高度而不是宽度（实测教训）：
 * 本素材的宠物宽高比约 0.75（360x480），若以"宽度 × 1.5"定气泡，
 * 气泡高度会达到宠物高度的 1.12 倍 —— 两者叠起来远超常见工作区高度，
 * 于是不得不把气泡大幅收缩（实测被削到 298px，文字区只剩 257x252）。
 * 改为以高度为预算基准后，气泡高度 ≈ 宠物高度 × 0.88，
 * 与宠物叠起来正好落在工作区内，几乎不需要收缩。
 *
 * 取值 1.25 效果：气泡宽度略宽于宠物（比宠物"胖"一点，符合对话气泡观感），
 * 文字区一行能放下的字数也够用。
 */
export const BUBBLE_WIDTH_RATIO = 1.25;

/**
 * 文字区内缩（相对气泡宽/高，百分比）。
 *
 * 由 `tools/measure-bubble.mjs` 量出实际素材后加余量：
 *   - 左右：描边内侧到近白填充区的过渡位置（量得 3.42% / 3.07%）；
 *   - 顶部：素材顶部就是描边，留 4% 避免压线；
 *   - 底部：避开向下指的尾巴（量得尾巴占 8.27%，再加余量）；
 *   - 右侧额外多留 4%：滚动条会占用右边缘，否则文字会顶到描边上（实测）。
 */
export const BUBBLE_TEXT_INSET = {
  left: 5.4,
  right: 9.1,
  top: 4,
  bottom: 11.3,
} as const;

/**
 * 气泡与宠物之间的空隙（像素，按宠物高度等比）。
 *
 * 实测：素材底部那条尾巴占气泡高度的 8.27%（见 assets/bubble.png 量测），
 * 所以气泡容器最后 8.27% 是"空"的（只有尾巴）。若还额外留一段间隙，
 * 尾巴就会悬空、甚至压到宠物的头发上。
 * 取一个**很小的负值**让尾巴尖正好落在宠物头顶附近：
 * 尾巴尖相对气泡底边的偏移是 -8.27%，因此约 -0.02 的间隙刚好抵掉一部分。
 */
export const BUBBLE_GAP_RATIO = -0.028;

/** 窗口内四周留白（像素，按宠物高度等比）——透明窗口也需要一点余量给气泡外发光。 */
export const BUBBLE_PADDING_RATIO = 0.03;

/** 正文最小字号（像素），避免宠物很小的时候文字完全看不清。 */
export const BUBBLE_FONT_MIN = 11;
/** 正文字号 = 宠物高度 × 该系数。 */
export const BUBBLE_FONT_RATIO = 0.06;

/**
 * 气泡被工作区限制时的**最小收缩系数**。
 *
 * 缩得再小也不能让文字区变成一条缝；到这个下限就宁可让窗口超出工作区
 * （那时宠物本身也已经接近屏幕高度了）。
 */
export const BUBBLE_MIN_SHRINK = 0.35;

/** 气泡状态 + 由它推导出的窗口布局（Main -> Renderer 下发）。 */
export interface BubbleState {
  readonly visible: boolean;
  /** 正文；空字符串表示只显示空气泡（用于调试/贴图）。 */
  readonly text: string;
}

/** 气泡可见时的窗口布局（像素，均为 CSS px）。 */
export interface BubbleLayout {
  /** 气泡可见时的完整窗口尺寸。 */
  readonly windowWidth: number;
  readonly windowHeight: number;
  /** 窗口内四周留白。 */
  readonly padding: number;
  /** 宠物渲染尺寸（与窗口尺寸解耦后，宠物大小完全由这两个值决定）。 */
  readonly petWidth: number;
  readonly petHeight: number;
  /** 气泡尺寸。 */
  readonly bubbleWidth: number;
  readonly bubbleHeight: number;
  /** 气泡与宠物之间的空隙。 */
  readonly gap: number;
  /** 正文基础字号。 */
  readonly fontSize: number;
  /**
   * **宠物底边到窗口底边的距离**（含窗口 padding）。
   *
   * 为什么必须由布局给出：显示气泡时窗口向上扩张，要保持宠物原地不动，
   * 锚点必须是"宠物底边"而不是"窗口底边"——有气泡时宠物下面还有
   * gap + padding，它并不贴窗口底边。实测用窗口底边做锚，
   * 显示时正常、**隐藏时宠物跳了 700 多像素**。
   */
  readonly petBottomOffset: number;
}

/** Main -> Renderer：气泡状态 + 布局。 */
export interface BubblePayload {
  readonly state: BubbleState;
  readonly layout: BubbleLayout;
}

export interface BubbleLayoutInput {
  /** 宠物在窗口中占的像素尺寸（即未显示气泡时的窗口尺寸）。 */
  readonly petWidth: number;
  readonly petHeight: number;
  /**
   * 含气泡的窗口**最大高度**（通常传显示器工作区高度）。
   *
   * 为什么必须限制：气泡在宠物**上方**，窗口高度 ≈ 宠物 + 空隙 + 气泡。
   * 实测踩过的坑：不限制时 scale=1 的窗口高达 1055px，超过 1080p 的工作区，
   * 窗口被顶到屏幕上方、位置被 clamp 拉回，宠物在屏幕上**一路往上漂**
   * （显示/隐藏/缩放几次之后就跑到屏幕外了）。
   * 超过上限时**等比缩小气泡**（文字区与字号一起缩），宠物尺寸不变。
   */
  readonly maxWindowHeight?: number;
}

/**
 * 由宠物尺寸推导气泡尺寸与"含气泡的窗口尺寸"。
 *
 * 纯函数，便于单测与验收断言（不需要真的开窗口）。
 */
export function resolveBubbleLayout(input: BubbleLayoutInput): BubbleLayout {
  const petWidth = Math.max(1, Math.round(input.petWidth));
  const petHeight = Math.max(1, Math.round(input.petHeight));

  const gap = Math.round(petHeight * BUBBLE_GAP_RATIO);
  const padding = Math.max(2, Math.round(petHeight * BUBBLE_PADDING_RATIO));
  const baseWidth = Math.max(1, Math.round(petHeight * BUBBLE_WIDTH_RATIO));

  /*
   * 气泡缩放系数 k：默认 1（等比 1.5 倍宠物宽）。
   * 若"宠物 + 空隙 + 气泡 + padding"超出工作区，就整体缩小气泡到刚好放下。
   * 只缩不放 —— 缩得再小也不会小于 0.35，否则文字区会小到没法看。
   */
  const availableForBubble = input.maxWindowHeight === undefined
    ? Number.POSITIVE_INFINITY
    : input.maxWindowHeight - petHeight - gap - padding * 2;
  const idealBubbleHeight = baseWidth / BUBBLE_ASPECT_RATIO;
  const shrink = Number.isFinite(availableForBubble)
    ? Math.min(1, Math.max(BUBBLE_MIN_SHRINK, availableForBubble / idealBubbleHeight))
    : 1;

  const bubbleWidth = Math.max(1, Math.round(baseWidth * shrink));
  const bubbleHeight = Math.max(1, Math.round(bubbleWidth / BUBBLE_ASPECT_RATIO));

  // 窗口 = 气泡在上、宠物在下，两者之间留 gap；四周再留 padding
  const windowWidth = Math.max(petWidth + padding * 2, bubbleWidth + padding * 2);
  const windowHeight = petHeight + gap + bubbleHeight + padding * 2;

  return {
    windowWidth,
    windowHeight,
    padding,
    petWidth,
    petHeight,
    bubbleWidth,
    bubbleHeight,
    gap,
    fontSize: Math.max(BUBBLE_FONT_MIN, Math.round(petHeight * BUBBLE_FONT_RATIO * shrink)),
    /*
     * 宠物是这段 flex 布局的最后一项，容器 padding 在它下方还有一份，
     * 所以"宠物底边到窗口底边"就等于 padding。
     * （有气泡时窗口高度 = padding + 气泡 + gap + 宠物 + padding。）
     */
    petBottomOffset: padding,
  };
}
