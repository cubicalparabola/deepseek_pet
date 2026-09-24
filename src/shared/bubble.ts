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

/**
 * 气泡素材原始像素（assets/bubble.png）。
 *
 * 素材 1263x1246，但**气泡主体只占图像上方一部分**，下方是留给右下角尾巴的
 * 透明区。所以贴图不能按"整图比例"铺容器 —— 那会把主体拉伸变形（实测很扁）。
 * 几何全部按下面三个**实测比例**描述，含义各自唯一：
 *   BUBBLE_BODY_TOP_PCT / BOTTOM_PCT：主体在整图中的上下边界（相对图高）
 *   BUBBLE_BODY_HEIGHT_RATIO       ：主体高度占整图高度的比例
 *   BUBBLE_BODY_ASPECT_RATIO       ：主体自身的宽高比
 */
export const BUBBLE_IMAGE_WIDTH = 1263;
export const BUBBLE_IMAGE_HEIGHT = 1246;

/**
 * 主体在整图中的上下边界（相对图高的百分比）。
 *
 * 实测方法：逐行扫 200 以上的 alpha，取"宽度 ≥ 97% 图宽"的连续区间 ——
 * 这一段是气泡主体的**饱满区**，y=125..1059（占图 10%~85%）。
 * 尾巴在 y≈1110..1167（89%~94%），所以主体下方还留了一段透明区。
 *
 * ⚠️ 不要用"整图 alpha 包围盒"或单列扫描来量：左上角星星会把上边界拉高，
 * 右下角尾巴会把下边界拉低（实测因此得到 7.8%~87.9% 的错误值，
 * 导致正文区只占主体一半、下方一大片空白）。
 */
export const BUBBLE_BODY_TOP_PCT = (97 / 1246) * 100;
export const BUBBLE_BODY_BOTTOM_PCT = (1072 / 1246) * 100;

/** 主体高度占整图高度的比例（≈ 80.2%）。 */
export const BUBBLE_BODY_HEIGHT_RATIO = (BUBBLE_BODY_BOTTOM_PCT - BUBBLE_BODY_TOP_PCT) / 100;

/** 主体自身的宽高比（≈ 1.13）：实测主体 x≈24..1238、y≈97..1095。 */
export const BUBBLE_BODY_ASPECT_RATIO = (1238 - 24) / (1095 - 97);

/**
 * 由**内容高度**（正文需要的高度）反推**容器**高度。
 *
 * 容器高度 = 正文区所需高度 + 按钮带高度。
 *
 * - 正文区高度 = 内容高 / 0.55（`BUBBLE_CONTENT_TO_CONTAINER`）；
 * - 按钮带高度 = 渲染层那条占位行的高度，**必须加进来** ——
 *   它是气泡内部的第 2 行，不加的话按钮带会超出气泡下沿被裁掉
 *   （实测超出 46px，按钮整个看不见）。
 *
 * 为什么正文区必须跟着内容走、**不能**由宽度推：否则短文本时容器仍然很高，
 * 正文只在中间一小块、上下大量留白（实测 141px 空白）。
 */
export function bubbleContainerHeight(contentHeight: number, buttonBand = 0): number {
  return contentHeight * BUBBLE_CONTENT_TO_CONTAINER + Math.max(0, buttonBand);
}

/**
 * 气泡相对**宠物**的水平偏移（占气泡宽度的比例，负值 = 左移）。
 *
 * 用户要求：气泡整体左移 1/3 个气泡宽。
 * 因为素材的尾巴在**右下角**，左移之后尾巴正好落在宠物头顶附近。
 *
 * 实现要点：窗口宽度必须为此留出空间（见 windowWidth 的算法），
 * 否则左移部分会被舞台的 overflow 裁掉。
 */
export const BUBBLE_OFFSET_X_RATIO = -1 / 3;

/**
 * 气泡宽度 = 宠物**高度** × 该系数。
 *
 * 为什么基准取高度而不是宽度（实测教训）：
 * 本素材的宠物宽高比约 0.75（360x480），若以"宽度 × 1.5"定气泡，
 * 气泡高度会达到宠物高度的 1.1 倍以上 —— 两者叠起来远超常见工作区高度，
 * 于是不得不把气泡大幅收缩（实测文字区只剩 257x252）。
 * 改为以高度为预算基准后，气泡与宠物叠起来正好落在工作区内。
 *
 * 取值 1.2：气泡主体略宽于宠物（符合对话气泡观感），
 * 且在 816px 高的工作区下、宠物高度 ≤ 0.75×工作区时不会被强制收缩。
 */
export const BUBBLE_WIDTH_RATIO = 1.2;

/**
 * 文字区**左右**内缩（相对容器宽度，百分比）。
 *
 * 只用左右，**上下不再用百分比** —— 这是踩过坑之后的结论：
 * 加上"知道了"按钮带后，容器高度 = 正文区 + 按钮带，上下百分比等于要同时
 * 表达"正文区"和"按钮带"两件事，必然算错（实测把正文区从 123px 挤到 108px，
 * 又把上边距顶到 31%，于是正文上方出现一大片空白）。
 *
 * 现在改成 flex 布局：按钮固定占底部一条，正文区自动占剩余空间，
 * 上下留白由 `BUBBLE_TEXT_PADDING_RATIO` 在**剩余空间内**按比例分配 ——
 * 按钮带怎么变都不会影响正文区。
 *
 * 左右仍用百分比（与容器高度无关）：
 *   - 左 5%：实心描边从 x=16（1.3%）开始，文字再往里收；
 *   - 右 9%：滚动条会占用右边缘，额外多留 4%，否则文字顶到描边上。
 */
export const BUBBLE_TEXT_INSET = {
  left: 5,
  right: 9,
} as const;

/**
 * 主体在整图中的**左右**边界（相对图宽的百分比）。
 *
 * 实测：实心填充从 x=16 到 x=1246（图宽 1263）。
 * 渲染层据此把正文区的左右边界锚定到**实心区**内 ——
 * 之前右内缩 9% 是按整个容器宽算的，正文区右边界仍超出气泡约 20px
 * （视觉验证：截图 + 看框发现）。
 */
export const BUBBLE_BODY_LEFT_PCT = (16 / 1263) * 100;
export const BUBBLE_BODY_RIGHT_PCT = (1246 / 1263) * 100;

/**
 * 文字区相对**主体**左右边界的内缩（相对图宽百分比）。
 *   - 左 3%：与描边留一点距离；
 *   - 右 2.5%：滚动条就在这条边界上，再往右会顶到描边。
 *     原来是 6%，用户反馈"文字和滚动条稍微往右移动一点就好"，故收到 2.5%。
 */
export const BUBBLE_TEXT_INSET_FROM_BODY = { left: 3, right: 2.5 } as const;

/**
 * 正文区**上下留白**占正文区高度的比例（上下各留这么多）。
 *
 * 与左右内缩不同：这是"在剩余空间里按比例分配"，不是相对整个容器，
 * 因此按钮带变高时不会连带影响它。
 */
export const BUBBLE_TEXT_PADDING_RATIO = 0.16;

/**
 * 正文区上边界相对**实心区顶**再往下移多少（占容器高的比例）。
 *
 * 贴着实心区顶时首行文字紧贴描边，用户要求"顶部往下移动一点点"。
 * 取 0.02（宠物 288 时约 6px）。
 */
export const BUBBLE_TEXT_TOP_GAP_RATIO = 0.02;

/**
 * 正文区高度占**整个容器**高度的比例（近似值，仅用于反推容器高度）。
 *
 * = 1 - 左右无关的上下留白 ≈ 1 / (1 + 2×0.16)… 这里直接用实测的 0.55：
 * 正文区高度 ≈ 容器高 × 0.55（扣掉按钮带之后仍然成立，因为按钮带是**另加**的）。
 * 容器的精确高度由 `bubbleContainerHeight()` 给出。
 *
 * ⚠️ 这个比例只用于**反推容器高度**，不再用于 CSS 定位 ——
 * CSS 用 flex 让按钮占底部一条、正文区自动占剩余空间。
 * 正文区高度 = 容器高 × 该比例；内容高度已由 `alignToBubbleTextHeight()`
 * 对齐到整数行高，因此正文区高度也是整数行高的倍数 —— 滚动时下边界落在
 * **行与行之间**，不会把最后一行从中间切断（实测踩过：正文区高 155px 配
 * 24.65px 行高，底边正好切在字中间，看起来像被裁掉）。
 */
export const BUBBLE_BODY_TEXT_RATIO = 0.55;

/**
 * 关闭按钮（"知道了"）额外占用的高度（相对**容器**高度）。
 *
 * 按钮带落在贴图的**尾巴带**里（实心填充到 86%，尾巴区 86%~94%）。
 * 取容器高的 15% 时按钮正好压在尾巴带上方、且仍在实心区内 ——
 * 之前按宠物高 0.16 算出的带子让按钮落到了实心区之外
 * （实测按钮视觉上跑到了气泡外面）。
 */
export const BUBBLE_BUTTON_BAND_RATIO = 0.15;
/** 按钮到气泡底边的间距（相对宠物高）。 */
export const BUBBLE_BUTTON_MARGIN_RATIO = 0.025;

/** 关闭按钮高度 = 字号 × 该系数，并夹在上下限之间。 */
export const BUBBLE_BUTTON_HEIGHT_RATIO = 1.55;
export const BUBBLE_BUTTON_HEIGHT_MIN = 20;
export const BUBBLE_BUTTON_HEIGHT_MAX = 44;

/** 计算关闭按钮的实际像素高度。 */
export function resolveBubbleButton(fontSize: number): number {
  return Math.round(
    Math.min(
      BUBBLE_BUTTON_HEIGHT_MAX,
      Math.max(BUBBLE_BUTTON_HEIGHT_MIN, fontSize * BUBBLE_BUTTON_HEIGHT_RATIO),
    ),
  );
}

/**
 * 内容高度 -> 容器高度 的换算系数（**唯一的换算入口**）。
 *
 * 正文区高度 = 容器高 × 正文占比（55%），希望它 == 所需内容高度，
 * 于是 容器高 = 内容高 / 0.55。
 * 主体高度 = 容器 × BUBBLE_BODY_HEIGHT_RATIO（0.75）。
 */
export const BUBBLE_CONTENT_TO_CONTAINER = 1 / BUBBLE_BODY_TEXT_RATIO;

/**
 * 气泡与宠物之间的空隙（像素，按宠物高度等比）。
 *
 * 新素材的尾巴在**右下角**（不是底部正中），且只占气泡高度的约 4.6%
 * （尾巴尖端 y≈1110-1167 / 高 1246）。因此不需要像旧素材那样留负间隙，
 * 一个很小的正值就能让尾巴靠近宠物头顶。
 */
export const BUBBLE_GAP_RATIO = -0.02;

/** 窗口内四周留白（像素，按宠物高度等比）——透明窗口也需要一点余量给气泡外发光。 */
export const BUBBLE_PADDING_RATIO = 0.03;

/** 正文最小字号（像素），避免宠物很小的时候文字完全看不清。 */
export const BUBBLE_FONT_MIN = 11;
/** 正文字号 = 宠物高度 × 该系数。 */
export const BUBBLE_FONT_RATIO = 0.06;

/**
 * 行高倍数（与 styles.css 的 `line-height: 1.45` 必须一致）。
 *
 * 主进程要靠它把"文字占几行"换算成所需像素高度，因此这个数字是
 * **跨进程契约**：改了 CSS 就必须同步改这里。
 */
export const BUBBLE_LINE_HEIGHT = 1.45;

/**
 * 气泡被工作区限制时的**最小收缩系数**。
 */
export const BUBBLE_MIN_SHRINK = 0.35;

/**
 * 内容高度下限 / 上限（相对宠物高度的系数）。
 *
 * ⚠️ 这是**内容**高度（正文区需要的高度），下面直接由"目标**主体**高度"换算，
 * 换算系数只有一条 `BUBBLE_CONTENT_PER_BODY`（主体高 = 内容高 × 2.23），
 * 避免多个比例相乘绕错（实测因此反复算错过容器高度）。
 * 到上限后不再变高，多出来的部分由正文区内部滚动条承担。
 */
/** 气泡**主体**高度上限（相对宠物高度）——与宠物一样高。 */
export const BUBBLE_MAX_VISIBLE_RATIO = 1.0;
/** 气泡**主体**高度下限（相对宠物高度）——约两行文字。 */
export const BUBBLE_MIN_VISIBLE_RATIO = 0.4;

/**
 * 内容高度上下限（相对宠物高度）。
 *
 * 换算关系（只此一条，避免多处比例相乘绕错）：
 *   主体高 = 容器高 × 主体占图比例 = (内容高 × 1/0.36) × 0.802 = 内容高 × 2.23
 *   -> 内容上限 = 1.2 × 宠物高 / 2.23 ≈ 0.54 × 宠物高
 * 到上限后不再变高，多出来的部分由正文区内部滚动条承担。
 */
export const BUBBLE_CONTENT_PER_BODY = BUBBLE_BODY_HEIGHT_RATIO * BUBBLE_CONTENT_TO_CONTAINER;

export const BUBBLE_MAX_HEIGHT_RATIO = BUBBLE_MAX_VISIBLE_RATIO / BUBBLE_CONTENT_PER_BODY;
export const BUBBLE_MIN_HEIGHT_RATIO = BUBBLE_MIN_VISIBLE_RATIO / BUBBLE_CONTENT_PER_BODY;

/**
 * 文字与气泡留白之间的**呼吸余量**（相对一行的高度）。
 *
 * 只按"精确装下 N 行"算高度会让首行/末行紧贴描边（实测首行被裁一半）。
 * 多留 0.6 行的高度既能让文字居中留白，又不至于让短文本的气泡明显变高。
 */
export const BUBBLE_TEXT_BREATHING = 0.6;

/**
 * 把"所需内容高度"取整到**行高的整数倍**（多留一行作为取整余量）。
 *
 * 为什么需要：正文区高度 = 容器高 × 36%，与行高没有整数关系；
 * 不对齐时滚动区的下边界会正好切在一行字中间，视觉上像"字被裁掉"。
 *
 * @param wanted   期望的内容高度（px）
 * @param fontSize 当前字号（px）
 */
export function alignToBubbleTextHeight(wanted: number, fontSize: number): number {
  const lineHeight = fontSize * BUBBLE_LINE_HEIGHT;
  const lines = Math.max(1, Math.ceil(wanted / lineHeight));
  return Math.round(lines * lineHeight);
}

/**
 * N 行正文所需的**内容高度**（像素）。
 *
 * 只按行高换算；取整与余量交给 `alignToBubbleTextHeight()`，
 * 避免两处各加一次余量（曾经因此把气泡算得过大）。
 */
export function bubbleHeightForLines(fontSize: number, lines: number): number {
  return Math.max(1, lines) * fontSize * BUBBLE_LINE_HEIGHT;
}

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
  /** 正文贴合文本后算出的**内容**高度（不含尾巴区）。 */
  readonly bubbleHeight: number;
  /**
   * 气泡**容器**高度（含图像底部的尾巴透明区）。
   *
   * 贴图会按 100% 拉伸铺满容器，所以容器高度必须按"主体比例 + 尾巴区比例"
   * 反推，否则主体会被拉伸变形。窗口高度用的是这个值。
   */
  readonly containerHeight: number;
  /** 气泡与宠物之间的空隙。 */
  readonly gap: number;
  /** 正文基础字号。 */
  readonly fontSize: number;
  /**
   * 关闭按钮（"知道了"）的像素高度。
   *
   * 按钮**另加**在正文区下方（按钮带高度已计入 containerHeight），
   * 不挤压正文。0 表示不显示按钮。
   */
  readonly buttonHeight: number;
  /**
   * 按钮**带**的总高度（按钮 + 它到气泡底边的间距 + 上边留白）。
   *
   * 容器 = 正文区 + 按钮带。渲染层由此得到正文区的**精确高度**：
   * `正文区高 = 容器高 - buttonBand`，两行都用显式高度，不靠 flex 推算
   * （实测 flex 推算时按钮会溢出气泡下沿 13px）。
   */
  readonly buttonBand: number;
  /** 按钮到气泡底边的间距（px）。 */
  readonly buttonMargin: number;
  /**
   * 本次布局是按"文本占多少行"算出来的（0 = 未提供行数，按最大高度）。
   *
   * Renderer 用它与自己实测的行数比较，决定要不要请求重新布局 ——
   * 这就是"气泡随文本长短变化"的闭环。
   */
  readonly textLines: number;
  /**
   * **宠物底边到窗口底边的距离**（含窗口 padding）。
   *
   * 为什么必须由布局给出：显示气泡时窗口向上扩张，要保持宠物原地不动，
   * 锚点必须是"宠物底边"而不是"窗口底边"——有气泡时宠物下面还有
   * gap + padding，它并不贴窗口底边。实测用窗口底边做锚，
   * 显示时正常、**隐藏时宠物跳了 700 多像素**。
   */
  readonly petBottomOffset: number;
  /**
   * 气泡相对宠物中心线的水平偏移（像素，负值 = 左移）。
   *
   * 窗口宽度已含这份偏移量，渲染层把它作用到气泡元素上即可（不会溢出舞台）。
   */
  readonly offsetX: number;
  /**
   * 气泡左边缘到舞台内容区左边的距离（像素）。
   *
   * 由"宠物中心 + offsetX 处居中"反推，渲染层直接用 `margin-left` 落地。
   *
   * 为什么不交给 flex 居中 + 位移：气泡是 flex 项，舞台 `align-items: center`
   * 会先把它居中，再叠上 `left`/`transform` 的位移 —— 两者叠加在窗口尺寸变化时
   * 结果不可预测（实测气泡左边缘跑到窗口外 23px 被裁）。
   * 显式给出左边距后，气泡位置完全由这个数决定。
   */
  readonly marginLeft: number;
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
   * 正文在"一行宽度 = 文字区宽度"下会占多少行。
   *
   * 由 **Renderer** 量出后回传（它才有字体度量：用 canvas 按同样的字号与
   * 可用宽度折行计数）。气泡高度据此贴合文本 —— 这就是"气泡随文本长短变化"：
   * 一两行 -> 气泡变矮；很多行 -> 长到上限后由内部滚动条接管。
   *
   * 省略或 <= 0 表示"按最大高度"（初始布局、或文字区还没测出来时）。
   */
  readonly textLines?: number;
  /**
   * 是否显示"知道了"关闭按钮（默认 true）。
   *
   * 按钮是**另加**在正文区下方的一条按钮带，容器会相应加高，不挤压正文。
   */
  readonly showButton?: boolean;
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
 * 由宠物尺寸 + 文本行数推导气泡尺寸与"含气泡的窗口尺寸"。
 *
 * 纯函数，便于单测与验收断言（不需要真的开窗口）。
 */
export function resolveBubbleLayout(input: BubbleLayoutInput): BubbleLayout {
  const petWidth = Math.max(1, Math.round(input.petWidth));
  const petHeight = Math.max(1, Math.round(input.petHeight));

  const gap = Math.round(petHeight * BUBBLE_GAP_RATIO);
  const padding = Math.max(2, Math.round(petHeight * BUBBLE_PADDING_RATIO));
  /*
   * 宽度保持"随宠物等比"，**不随文本变化**：否则同一只桌宠的气泡会忽宽忽窄，
   * 观感不稳；文本长短只影响高度。
   */
  const bubbleWidth = Math.max(1, Math.round(petHeight * BUBBLE_WIDTH_RATIO));
  const fontSize = Math.max(BUBBLE_FONT_MIN, Math.round(petHeight * BUBBLE_FONT_RATIO));

  /*
   * 气泡高度（= 正文区所需高度）按文本行数贴合：
   *   - 行数未知（初始布局/未测出）-> 用上限；
   *   - 行数少 -> 气泡变矮（但有下限，避免缩成一条缝）；
   *   - 行数多 -> 到上限为止，再多出来交给正文区内部滚动条。
   *
   * ⚠️ 最后必须 `alignToBubbleTextHeight`：正文区高度是容器的固定比例，
   * 只有把内容高度对齐到整数行高，正文区的底边才会落在行与行之间，
   * 否则滚动时最后一行会被从中间切断（看起来像被裁掉）。
   */
  const maxBubbleHeight = Math.round(petHeight * BUBBLE_MAX_HEIGHT_RATIO);
  const minBubbleHeight = Math.round(petHeight * BUBBLE_MIN_HEIGHT_RATIO);
  const lines = input.textLines;
  const wanted = typeof lines === 'number' && lines > 0
    ? bubbleHeightForLines(fontSize, lines)
    : maxBubbleHeight;
  const aligned = alignToBubbleTextHeight(wanted, fontSize);
  const bubbleHeight = Math.round(Math.min(maxBubbleHeight, Math.max(minBubbleHeight, aligned)));

  /*
   * 气泡整体收缩系数：气泡宽度固定，因此收缩体现在"高度够不够用"上。
   * 窗口放不下时等比缩小字号（文字区随之变矮），宠物尺寸不变。
   */
  const availableForBubble = input.maxWindowHeight === undefined
    ? Number.POSITIVE_INFINITY
    : input.maxWindowHeight - petHeight - gap - padding * 2;
  const shrink = Number.isFinite(availableForBubble)
    ? Math.min(1, Math.max(BUBBLE_MIN_SHRINK, availableForBubble / bubbleHeight))
    : 1;

  const finalBubbleHeight = shrink < 1 ? Math.max(1, Math.round(bubbleHeight * shrink)) : bubbleHeight;
  /** 不含按钮带时的容器高度（按钮带按它的比例取）。 */
  const containerHeightBase = bubbleContainerHeight(finalBubbleHeight);

  /*
   * 关闭按钮**另加**一条按钮带：不挤压正文区，容器相应加高。
   * 按钮带按**基础容器高**（不含按钮带时的高度）取比例 ——
   * 仍以宠物高为基准会让按钮落到贴图的实心区之外（实测按钮视觉上跑到气泡外面）。
   * 下界保证带子至少放得下"按钮 + 下边距 + 6px 上边留白"。
   */
  const showButton = input.showButton !== false;
  const buttonMargin = showButton ? Math.max(2, Math.round(petHeight * BUBBLE_BUTTON_MARGIN_RATIO)) : 0;
  const buttonHeight = showButton
    ? resolveBubbleButton(Math.max(BUBBLE_FONT_MIN, Math.round(fontSize * shrink)))
    : 0;
  const buttonBand = showButton
    ? Math.max(
        Math.round(containerHeightBase * BUBBLE_BUTTON_BAND_RATIO),
        buttonHeight + buttonMargin + 6,
      )
    : 0;

  const containerHeight = Math.round(bubbleContainerHeight(finalBubbleHeight, buttonBand));
  const offsetX = Math.round(bubbleWidth * BUBBLE_OFFSET_X_RATIO);

  /*
   * 窗口宽度要能同时容纳"气泡左移"和"宠物居中"。
   *
   * 直觉上只需 `气泡宽 + |偏移|`，但实测那样会算不出足够的余量
   * （气泡左边缘仍被窗口裁掉、且 flex 居中与偏移叠加后基准不可预测）。
   * 这里干脆按 `气泡宽 + 2×|偏移|` 留足空间：无论位于哪种基准，
   * 左移后的气泡都完整落在窗口内。代价是窗口略宽（多出的部分是透明的）。
   */
  const windowWidth = Math.max(
    petWidth + padding * 2,
    bubbleWidth + padding * 2 + Math.abs(offsetX) * 2,
  );
  const windowHeight = petHeight + gap + containerHeight + padding * 2;

  /*
   * 气泡左边距：让"气泡中心"落在"宠物中心 + offsetX"上。
   * 内容区宽 = windowWidth - 2×padding；宠物在内容区里居中。
   */
  const contentWidth = windowWidth - padding * 2;
  const petLeft = (contentWidth - petWidth) / 2;
  const marginLeft = Math.max(0, Math.round(petLeft + petWidth / 2 + offsetX - bubbleWidth / 2));

  return {
    windowWidth,
    windowHeight,
    padding,
    petWidth,
    petHeight,
    bubbleWidth,
    bubbleHeight: finalBubbleHeight,
    containerHeight,
    gap,
    offsetX,
    marginLeft,
    fontSize: Math.max(BUBBLE_FONT_MIN, Math.round(fontSize * shrink)),
    buttonHeight,
    buttonBand,
    buttonMargin,
    /** 本次布局对应的文本行数（Renderer 用它判断"要不要重算"）。 */
    textLines: typeof lines === 'number' && lines > 0 ? lines : 0,
    /*
     * 宠物是这段 flex 布局的最后一项，容器 padding 在它下方还有一份，
     * 所以"宠物底边到窗口底边"就等于 padding。
     * （有气泡时窗口高度 = padding + 气泡 + gap + 宠物 + padding。）
     */
    petBottomOffset: padding,
  };
}
