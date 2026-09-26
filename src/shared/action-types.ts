/**
 * Action Pipeline 模型（项目最核心的架构之一）。
 *
 * 统一入口：用户点击 / 插件 / 定时器 / BehaviorManager / 未来 AI Agent
 * 全部把自己的意图包装成 `PetAction` 投递到 ActionManager，
 * 由 ActionManager 依次完成：
 *
 *   Action -> 校验 -> StateMachine 守卫 -> AnimationManager -> WebM
 *
 * 任何行为来源都不允许直接操作 DOM / video / BrowserWindow。
 */

import type { InterruptPolicy } from './animation-types';
import type { PetState } from './state-types';

/** 行为来源，用于日志、优先级策略与“谁在控制桌宠”的审计。 */
export type ActionSource =
  | 'user'
  | 'behavior'
  | 'system'
  | 'ai-agent'
  | 'plugin'
  | `plugin:${string}`
  | (string & {});

/** Action 类型。 */
export type ActionType = 'animation' | 'state' | 'event';

/** `type: "animation"` 的目标动画 ID 字段名（与 target 二选一，animationId 优先）。 */
export interface PetActionBase {
  readonly type: ActionType;
  /** 通用目标：state 名 / event 名 / animationId。 */
  readonly target?: string;
  readonly priority?: number;
  readonly source?: ActionSource;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AnimationAction extends PetActionBase {
  readonly type: 'animation';
  readonly animationId?: string;
  readonly interrupt?: InterruptPolicy;
  /**
   * 是否忽略冷却（默认 false）。仅限**用户显式手动播放**使用，
   * 见 `PlayOptions.bypassCooldown`：自动化来源不得传 true。
   */
  readonly bypassCooldown?: boolean;
  /**
   * 这次播放的"循环几轮"覆盖（只对三段式动画有意义；见 `PlayOptions.loopCountRange`）。
   *
   * 随机池用它把池里的三段式动画压成"一两轮"（正常状态下趴下休息一会儿就自己起来），
   * 而"状态默认动画"用 `'forever'` 保持姿势、只在离开该状态时才播收尾。
   */
  readonly loopCountRange?: readonly [number, number] | 'forever';
}

export interface StateAction extends PetActionBase {
  readonly type: 'state';
  readonly target: PetState | (string & {});
}

export interface EventAction extends PetActionBase {
  readonly type: 'event';
  readonly target: string;
  readonly payload?: unknown;
}

/**
 * 统一 Action。使用可辨识联合，避免 `any`。
 * 示例：
 *   { type: 'animation', animationId: 'coffee', priority: 30, reason: 'random-idle-action' }
 *   { type: 'state', target: 'SLEEPING' }
 *   { type: 'event', target: 'custom:ping' }
 */
export type PetAction = AnimationAction | StateAction | EventAction;

/** Action 执行结果。 */
export interface ActionResult {
  readonly accepted: boolean;
  readonly type: ActionType;
  /** 拒绝原因（accepted=false 时存在）。 */
  readonly rejection?: ActionRejectionReason;
  /** 实际播放的动画 ID（animation action）。 */
  readonly animationId?: string;
  /** 实际迁移到的状态（state action）。 */
  readonly state?: PetState;
  readonly detail?: string;
}

export type ActionRejectionReason =
  | 'invalid-action'
  | 'unknown-action-type'
  | 'missing-target'
  | 'animation-not-found'
  | 'state-transition-rejected'
  | 'blocked-by-guard'
  | 'behaviour-paused';

/**
 * Action 守卫：允许模块（或未来 AI/插件）在 Pipeline 中插入裁决逻辑。
 * 返回 `false` 或 `{ allow: false }` 即拒绝该 Action。
 */
export type ActionGuard = (
  action: Readonly<PetAction>,
) => boolean | { readonly allow: boolean; readonly reason?: string };
