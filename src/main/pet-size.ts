/**
 * 桌宠尺寸计算（Main 进程）。
 *
 * 单一事实来源：**素材宽高比**。
 * 窗口尺寸 = (基准高度 480 × scale) × 素材宽高比，
 * 并受当前显示器工作区高度限制（超出时自动收敛，避免桌宠比屏幕还高）。
 *
 * 收敛后实际生效的 scale 会通过 `PetSizeInfo.scale` 回传给 Renderer，
 * 这样 Renderer 不需要自己算尺寸，也不需要知道显示器信息。
 */

import { screen } from 'electron';
import {
  PET_BASE_HEIGHT,
  clampPetScale,
  type PetSizeInfo,
} from '../shared/pet-size';
import type { Logger } from '../shared/logger';

/** 宽高比兜底值：834 / 1112（本项目素材的比例）。 */
export const FALLBACK_ASPECT_RATIO = 834 / 1112;

/** 窗口宽度夹取范围，避免极端比例产生不可用的窗口。 */
const MIN_WIDTH = 120;
const MAX_WIDTH = 1400;

export interface ResolvePetSizeOptions {
  readonly requestedScale: number;
  readonly aspectRatio: number;
  readonly logger: Logger;
}

export function resolvePetSize(options: ResolvePetSizeOptions): PetSizeInfo {
  const requestedScale = clampPetScale(options.requestedScale);
  const aspectRatio = Number.isFinite(options.aspectRatio) && options.aspectRatio > 0
    ? options.aspectRatio
    : FALLBACK_ASPECT_RATIO;

  // 显示器可用高度（工作区，已排除任务栏）；取主屏即可，桌宠默认出现在主屏
  let maxHeight = Number.POSITIVE_INFINITY;
  try {
    maxHeight = screen.getPrimaryDisplay().workArea.height;
  } catch (error) {
    options.logger.warn('display work area unavailable; skipping size clamping', { error });
  }

  const idealHeight = PET_BASE_HEIGHT * requestedScale;
  const height = Math.max(80, Math.round(Math.min(idealHeight, maxHeight)));
  const clampedByDisplay = idealHeight > maxHeight + 1;
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, height * aspectRatio)));

  // 实际作用到窗口上的比例（可能因显示器限制小于请求值）
  const windowScale = Math.round((height / PET_BASE_HEIGHT) * 1000) / 1000;

  return {
    width,
    height,
    /*
     * `scale` 语义 = **用户请求并已按上下限夹取**的比例。
     * 显示器限制只影响窗口像素尺寸（width/height），不应该改写用户的选择，
     * 否则“我设了 250% 但读回来是 170%”会让人困惑。
     * 需要真实生效比例时用 windowScale。
     */
    scale: requestedScale,
    requestedScale,
    windowScale,
    clampedByDisplay,
    aspectRatio,
    baseHeight: PET_BASE_HEIGHT,
  };
}
