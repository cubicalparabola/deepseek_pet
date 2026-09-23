/**
 * 状态机模型（Renderer 主用，插件通过 StateAPI 只读访问）。
 *
 * 职责边界（非常重要）：
 * - StateMachine 只回答“现在是什么状态 / 能不能迁移 / 迁移前后做什么”；
 * - StateMachine 不播放任何视频；
 * - AnimationManager 只回答“怎么播这个动画”，不决定业务状态。
 */

/** 第一版必须包含的状态。 */
export type PetState = 'IDLE' | 'PLAYING' | 'SLEEPING' | 'BUSY';

export const PET_STATES: readonly PetState[] = ['IDLE', 'PLAYING', 'SLEEPING', 'BUSY'];

/** 状态迁移事件。 */
export interface StateChangeEvent {
  readonly from: PetState;
  readonly to: PetState;
  /** 迁移原因（例如 "animation-start:coffee" / "idle-timeout" / "user-interaction"）。 */
  readonly reason: string;
  /** 触发者（"user" | "behavior" | "plugin:<id>" | "ai-agent" | "system"）。 */
  readonly source?: string;
  readonly at: number;
}

/** 状态进入/退出的上下文。 */
export interface StateTransitionContext {
  readonly from: PetState;
  readonly to: PetState;
  readonly reason: string;
  readonly source?: string;
}

/** 状态定义（由 StateMachine 统一管理，允许外部注册新状态以扩展）。 */
export interface StateDefinition {
  readonly name: PetState;
  /** 允许从该状态迁移到的状态白名单。 */
  readonly transitions: readonly PetState[];
  readonly onEnter?: (context: StateTransitionContext) => void;
  readonly onExit?: (context: StateTransitionContext) => void;
  /** 该状态是否“空闲”，用于 idle timeout 判定。 */
  readonly idle?: boolean;
}

/** 状态迁移请求的裁决结果。 */
export interface StateTransitionResult {
  readonly accepted: boolean;
  readonly from: PetState;
  readonly to: PetState;
  readonly reason?: 'no-definition' | 'not-allowed' | 'same-state';
}
