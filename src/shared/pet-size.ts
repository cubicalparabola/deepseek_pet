/**
 * 桌宠尺寸模型（Main / Renderer / Preload 共用）。
 *
 * 设计：
 * - **素材宽高比是唯一来源**，尺寸只用一个缩放系数 `scale` 表示；
 * - 基准高度 480px（对应素材原始 834x1112 时约 360x480），
 *   实际窗口高度 = 480 × scale，宽度 = 高度 × 素材宽高比；
 * - 窗口高度受当前显示器工作区限制（自动收敛），因此实际生效的 scale 会回传给 Renderer；
 * - 尺寸是可持久化的设置（assets/config/settings.json）。
 *
 * 调节入口只有**设置窗口里的滚动条**（拖动即生效 + 写盘）。
 * 这里刻意不再提供"预设档位"：需求明确只要拖动改大小，
 * 少一套档位就少一条会跟滑块打架的代码路径（滑块拖到 85% 时
 * 菜单里的 radio 全都不勾，属于自找的歧义）。
 */

/**
 * 缩放下限/上限。
 *
 * 下限 20% 对应窗口 96×72（基准高 480 × 0.2）—— 这是"只剩一小只"的下限；
 * 再小就会撞上窗口最小尺寸（64px）而无法继续等比缩小。
 */
export const PET_SCALE_MIN = 0.2;
export const PET_SCALE_MAX = 2.5;
/**
 * 默认缩放（≈288×384）。
 *
 * 为什么不是 100%：100% 对应 360×480，在 1080p 笔记本工作区上占了近 60% 高度，
 * 会明显挡住桌面内容。20%–250% 的完整区间由设置窗口的滚动条提供。
 */
export const PET_SCALE_DEFAULT = 0.6;

/** 基准窗口高度（scale = 1 时的高度）。 */
export const PET_BASE_HEIGHT = 480;

/** 持久化设置（存于 assets/config/settings.json）。 */
export interface PetSettings {
  /** 桌宠尺寸缩放系数。 */
  readonly scale: number;
  /** 是否始终置顶。 */
  readonly alwaysOnTop: boolean;
}

export const DEFAULT_PET_SETTINGS: PetSettings = {
  scale: PET_SCALE_DEFAULT,
  alwaysOnTop: true,
};

/**
 * 滑块步进（5%）。
 * 用它做吸附，保证「拖到哪儿就存到哪儿」的值是干净的两/三位小数，
 * 不会在 settings.json 里留下 0.7000000000000001 这种浮点垃圾。
 */
export const PET_SCALE_STEP = 0.05;

/** 把任意比例吸附到滑块步进上（结果一定落在 [MIN, MAX] 内）。 */
export function snapPetScale(scale: number): number {
  if (!Number.isFinite(scale)) return PET_SCALE_DEFAULT;
  const snapped = Math.round(scale / PET_SCALE_STEP) * PET_SCALE_STEP;
  // 先按步进吸附再夹取，避免 2.52 被夹成 2.5 却仍显示 252%
  return clampPetScale(Math.round(snapped * 1000) / 1000);
}

/** 比例 -> 百分比整数（0.6 -> 60）。用于菜单/设置界面的文案。 */
export function toScalePercent(scale: number): number {
  return Math.round(scale * 100);
}

/** 比例 -> 文案（0.6 -> "60%"）。 */
export function formatPetScale(scale: number): string {
  return `${toScalePercent(scale)}%`;
}

/** 步进槽位数量（滑块 index 的合法范围是 0..PET_SCALE_STEPS）。 */
export const PET_SCALE_STEPS = Math.round((PET_SCALE_MAX - PET_SCALE_MIN) / PET_SCALE_STEP);

/** 比例 -> 滑块槽位（0-based）。 */
export function scaleToStepIndex(scale: number): number {
  const steps = (snapPetScale(scale) - PET_SCALE_MIN) / PET_SCALE_STEP;
  return Math.min(PET_SCALE_STEPS, Math.max(0, Math.round(steps)));
}

/** 滑块槽位 -> 比例。 */
export function stepIndexToScale(index: number): number {
  const clamped = Math.min(PET_SCALE_STEPS, Math.max(0, Math.round(index)));
  return clampPetScale(Math.round((PET_SCALE_MIN + clamped * PET_SCALE_STEP) * 1000) / 1000);
}

/** 主进程解析出的窗口尺寸与生效比例。 */
export interface PetSizeInfo {
  readonly width: number;
  readonly height: number;
  /** 用户请求的比例（已按上下限夹取）。用于菜单勾选与设置回显。 */
  readonly scale: number;
  /** 同 scale；保留独立字段便于未来区分“请求值”与“生效值”。 */
  readonly requestedScale: number;
  /** **实际作用到窗口上**的比例（可能因显示器高度限制小于 scale）。 */
  readonly windowScale: number;
  /** 是否因为显示器限制而收敛。 */
  readonly clampedByDisplay: boolean;
  /** 素材宽高比（width / height）。 */
  readonly aspectRatio: number;
  /** 基准高度。 */
  readonly baseHeight: number;
}

/** 尺寸 + 设置的可序列化快照（IPC / 托盘 / Renderer 共用）。 */
export interface PetSettingsState {
  readonly size: PetSizeInfo;
  readonly alwaysOnTop: boolean;
}

export function clampPetScale(scale: number): number {
  if (!Number.isFinite(scale)) return PET_SCALE_DEFAULT;
  return Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, scale));
}
