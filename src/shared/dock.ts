/**
 * 贴边收起（"收起宠物"）的几何判定 —— 纯函数，主进程与验收脚本共用。
 *
 * 需求：
 * - "拖动宠物放到最右边或者最下边时触发收起宠物状态"；
 * - "拖动离开边缘即展开"、"点击宠物展开"。
 *
 * 为什么单独一个模块：这些判断全是"矩形与边缘的距离"，
 * 放进 main.ts 就只能靠跑真机去验证。抽成纯函数后可以：
 *   1. 直接单测边界（刚好贴边 / 差 1px / 角落同时贴两边 / 拖离多少算展开）；
 *   2. 让 `petRectIn` 这一处集中解释"宠物在窗口里的位置怎么算"（气泡会把窗口撑大）。
 */

import type { PetDock } from './behavior-config';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 距边缘多少像素内算"贴上了"。
 *
 * 从 24 收到 8（用户实测反馈："需要鼠标向右移到最右侧和最下方时才能触发"）：
 * 24px 时离屏幕边还有一段距离就先收起了，感觉像"我没拖到边上她自己贴上来了"。
 *
 * 为什么 8px 仍然拖得到（不会被"太严格"卡住）：
 * 窗口位置只保证"宠物可见"，**允许窗口越过屏幕边缘挂出去**
 * （见 `WindowManager.clampToDisplays`：最多挂到只剩 60px 可见），
 * 所以往右/往下一直推时宠物边缘会**越过**工作区边缘（gap 变负数），
 * 想触发是很容易的；只有"停在离边 8px 以外"才不再收起。
 *
 * 想调手感就改这一个数。
 */
export const DOCK_EDGE_THRESHOLD_PX = 8;

/**
 * 已经收起后，拖离边缘多少像素算"展开"。
 *
 * 比"DOCK_EDGE_THRESHOLD_PX"大得多是刻意的：两个阈值如果一样，
 * 手抖一下就会在收起/展开之间来回跳（状态抖动）。
 */
export const UNDOCK_DISTANCE_PX = 56;

export interface DockEvaluation {
  readonly dock: PetDock;
  /** 宠物右边缘到工作区右边缘的距离（负 = 已经出界）。 */
  readonly rightGap: number;
  /** 宠物下边缘到工作区下边缘的距离。 */
  readonly bottomGap: number;
}

/**
 * 宠物在窗口内的矩形。
 *
 * 宠物在窗口里**水平居中**，垂直方向底部留 `petBottomOffset`（气泡占的地方）——
 * 这个换算以前散落在 pointer 命中测试的注释里，现在集中在这里。
 */
export function petRectIn(
  windowRect: Rect,
  petSize: { readonly width: number; readonly height: number },
  petBottomOffset = 0,
): Rect {
  const width = Math.max(1, Math.round(petSize.width));
  const height = Math.max(1, Math.round(petSize.height));
  return {
    x: Math.round(windowRect.x + (windowRect.width - width) / 2),
    y: Math.round(windowRect.y + windowRect.height - petBottomOffset - height),
    width,
    height,
  };
}

/**
 * 判定当前该不该收起、以及贴哪条边。
 *
 * 角落同时够到两条边时**优先右边**：右侧收起是"偷看"姿势，
 * 竖屏空间也更常见；下边缘留给"趴下"。
 */
export function evaluateDock(
  pet: Rect,
  workArea: Rect,
  threshold = DOCK_EDGE_THRESHOLD_PX,
): DockEvaluation {
  const rightGap = Math.round(workArea.x + workArea.width - (pet.x + pet.width));
  const bottomGap = Math.round(workArea.y + workArea.height - (pet.y + pet.height));
  if (rightGap <= threshold) return { dock: 'right', rightGap, bottomGap };
  if (bottomGap <= threshold) return { dock: 'bottom', rightGap, bottomGap };
  return { dock: 'free', rightGap, bottomGap };
}

/**
 * 收起后窗口应该摆在哪：把宠物**贴平**到边缘（不露缝、也不出界）。
 *
 * - 贴右：宠物右边缘 = 工作区右边缘，纵向**保持用户放下的位置**（只夹进工作区）；
 * - 贴下：宠物下边缘 = 工作区下边缘（含 `petBottomOffset` 的气泡留白反算回窗口），
 *   横向保持用户放下的位置。
 *
 * 只挪窗口，不改尺寸 —— 尺寸由气泡控制器统一决策。
 */
export function dockTargetPosition(input: {
  readonly dock: Exclude<PetDock, 'free'>;
  readonly petSize: { readonly width: number; readonly height: number };
  readonly windowSize: { readonly width: number; readonly height: number };
  readonly workArea: Rect;
  /** 当前窗口位置（另一条轴保持不动）。 */
  readonly current: { readonly x: number; readonly y: number };
  readonly petBottomOffset?: number;
}): { readonly x: number; readonly y: number } {
  const petWidth = Math.max(1, Math.round(input.petSize.width));
  const windowWidth = Math.max(1, Math.round(input.windowSize.width));
  const windowHeight = Math.max(1, Math.round(input.windowSize.height));
  const bottomOffset = Math.max(0, Math.round(input.petBottomOffset ?? 0));
  const area = input.workArea;

  if (input.dock === 'right') {
    return {
      x: Math.round(area.x + area.width - petWidth - (windowWidth - petWidth) / 2),
      // 纵向不动，只保证窗口顶不越界（宠物整只仍在工作区内由 WindowManager 收敛）
      y: Math.round(input.current.y),
    };
  }

  // 贴下：宠物下边缘贴住工作区下边缘 -> 反算窗口 y
  return {
    x: Math.round(input.current.x),
    y: Math.round(area.y + area.height + bottomOffset - windowHeight),
  };
}

/**
 * 收起状态下拖动时，是否已经拖离边缘（该展开）。
 *
 * @param distance 拖离阈值（默认 `UNDOCK_DISTANCE_PX`）
 */
export function shouldUndock(
  dock: PetDock,
  pet: Rect,
  workArea: Rect,
  distance = UNDOCK_DISTANCE_PX,
): boolean {
  if (dock === 'free') return false;
  const { rightGap, bottomGap } = evaluateDock(pet, workArea, 0);
  if (dock === 'right') return rightGap > distance;
  return bottomGap > distance;
}

/** 贴边方向的中文标签（托盘菜单 / 日志）。 */
export function dockLabel(dock: PetDock): string {
  if (dock === 'right') return '右侧收起';
  if (dock === 'bottom') return '下方收起';
  return '正常';
}

/**
 * 没有"上次自由位置"可回退时（例如启动即收起）的兜底：把她从贴边位置往里挪一点。
 *
 * 只挪贴边的那条轴，往屏幕内侧移动 `distance` 像素 ——
 * 这样她一定完全可见，也不会因为"挪一下又贴上了"来回抖。
 */
export function nudgeInward(
  dock: Exclude<PetDock, 'free'>,
  current: { readonly x: number; readonly y: number },
  distance = UNDOCK_DISTANCE_PX + DOCK_EDGE_THRESHOLD_PX,
): { readonly x: number; readonly y: number } {
  if (dock === 'right') return { x: Math.round(current.x - distance), y: Math.round(current.y) };
  return { x: Math.round(current.x), y: Math.round(current.y - distance) };
}
