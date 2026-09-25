/**
 * 「每天在做什么」的时间线契约（3.1/3.6 的产物，也是成长模块的输入）。
 *
 * 由来：周期观察每 30 秒一条（`ScreenObservation`），但**观察不是记忆** ——
 * 用户要的是"今天 9:10–11:32 在写代码"这样的**区间**。所以这里定义：
 *
 * ```
 * 每 30s 的观察 ──appendObservation()──► ActivitySegment[]（合并/切分）──summarizeDay()──► 每日汇总
 *                                                                    └── 模型写一段叙述（可选）
 * ```
 *
 * 设计约束（与前几轮一致，别改）：
 * - **只存文本**：区间里只有场景名、进程名、起止时间，没有任何截图；
 * - **纯函数聚合**：合并/切分的规则全部在 `shared/timeline.ts`，可被验收逐条钉死；
 * - **日期用本地日**：跨零点切天按用户所在时区算，否则 UTC+8 的凌晨会被算到"昨天"。
 */

import type { SceneKind } from './perception-types';

/** 一段"一直在做同一件事"的时间区间（由周期观察聚合而来）。 */
export interface ActivitySegment {
  /** 这段的开始时刻（ISO）。 */
  readonly start: string;
  /** 这段的结束时刻（ISO）；仍在进行中的段 = 最后一次观察时间。 */
  readonly end: string;
  readonly scene: SceneKind;
  /** 这段时间里的应用名（进程名或模型给的 app）。 */
  readonly app: string;
  /** 这段由几条观察合并而来（用于判断可信度：1 条 = 只有半分钟）。 */
  readonly samples: number;
  /** 时长（分钟，保留 1 位小数）。 */
  readonly minutes: number;
}

/** 一天的汇总（纯统计，不含模型的措辞）。 */
export interface TimelineTotals {
  /** "在使用电脑"的总时长（分钟）——不含 idle（人不在/屏幕没动）。 */
  readonly activeMinutes: number;
  /** 判定为 idle/离开的总时长（分钟）。 */
  readonly idleMinutes: number;
  /** 按场景的时长（降序）；`share` 是占 activeMinutes 的比例（0~1）。 */
  readonly byScene: readonly { readonly scene: SceneKind; readonly minutes: number; readonly share: number }[];
  /** 按程序的时长（降序，最多 5 条）。 */
  readonly byApp: readonly { readonly app: string; readonly minutes: number }[];
  /** 今天第一次/最后一次观察的时刻（空串 = 今天还没有观察）。 */
  readonly firstAt: string;
  readonly lastAt: string;
}

/** 一天的时间线（落盘单元）。 */
export interface DayTimeline {
  /** 本地日期 `YYYY-MM-DD`。 */
  readonly date: string;
  readonly segments: readonly ActivitySegment[];
  readonly totals: TimelineTotals;
  /** 模型写的那段"今天你在做什么"（可能为空：没模型/没生成过）。 */
  readonly narrative: string;
  /** 这份记录最后一次更新的时间（ISO）。 */
  readonly updatedAt: string;
}

/**
 * 面板/状态里用的**精简**时间线（不把一整天的所有区间都推进 IPC 推送里）。
 */
export interface TimelineStatusView {
  readonly date: string;
  readonly activeMinutes: number;
  readonly idleMinutes: number;
  readonly byScene: readonly { readonly scene: SceneKind; readonly minutes: number; readonly share: number }[];
  readonly byApp: readonly { readonly app: string; readonly minutes: number }[];
  /** 最近几段（新的在后）。 */
  readonly recent: readonly ActivitySegment[];
  /** 模型写的叙述（空串 = 还没生成）。 */
  readonly narrative: string;
}

/** 给聊天/日记/面板用的一段紧凑文本（`text()` 的返回）。 */
export interface TimelineTextResult {
  readonly date: string;
  readonly text: string;
  readonly narrative: string;
  readonly hasData: boolean;
}
