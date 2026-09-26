/**
 * ActionManager —— 统一 Action Pipeline。项目最核心的架构之一。
 *
 * 所有行为来源（用户点击 / 插件 / 定时器 / BehaviorManager / 未来 AI Agent）
 * 都必须把意图包装成 PetAction 投递到这里，不允许各自直接操作动画或 DOM：
 *
 *   用户点击 ┐
 *   插件     ├─> Action Pipeline ─> StateMachine 守卫 ─> AnimationManager ─> WebM
 *   定时器   │
 *   Behavior │
 *   AI Agent ┘
 *
 * 本类同时是「业务代码里判断优先级」的唯一替代品：
 * 调用方只描述意图（type/target/priority/source/reason），
 * 剩下的校验、守卫、优先级、状态衔接全部在这里与 AnimationManager 内完成。
 */

import type {
  ActionGuard,
  ActionRejectionReason,
  AnimationAction,
  EventAction,
  PetAction,
  StateAction,
} from '../../shared/action-types';
import type { PetState } from '../../shared/state-types';
import { ActionError, describeError } from '../../shared/errors';
import { PetEvents } from '../../shared/events';
import type { Logger } from '../../shared/logger';
import type { AnimationManager } from './animation-manager';
import type { EventBus } from './event-bus';
import type { StateMachine } from './state-machine';
import { isPetState } from './state-utils';

export interface ActionPipelineStatus {
  readonly paused: boolean;
}

export interface ActionManagerOptions {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly stateMachine: StateMachine;
  readonly animationManager: AnimationManager;
  readonly status: ActionPipelineStatus;
}

interface ActionOutcome {
  readonly accepted: boolean;
  readonly type: PetAction['type'];
  readonly rejection?: ActionRejectionReason;
  readonly animationId?: string;
  readonly state?: PetState;
  readonly detail?: string;
}

/** 动画 ID -> 期望状态（例如 sleep 动画对应 SLEEPING 状态）。 */
const ANIMATION_STATE_HINTS: Readonly<Record<string, PetState>> = {
  sleep: 'SLEEPING',
};

export class ActionManager {
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly stateMachine: StateMachine;
  private readonly animationManager: AnimationManager;
  private readonly status: ActionPipelineStatus;
  private readonly guards = new Set<ActionGuard>();

  public constructor(options: ActionManagerOptions) {
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.stateMachine = options.stateMachine;
    this.animationManager = options.animationManager;
    this.status = options.status;
  }

  /** 注册守卫（未来 AI/插件可插入裁决逻辑）。 */
  public addGuard(guard: ActionGuard): () => void {
    this.guards.add(guard);
    return () => {
      this.guards.delete(guard);
    };
  }

  /**
   * 执行一个 Action。永不抛异常：结果通过返回值 + action:rejected 事件表达。
   */
  public async execute(action: PetAction): Promise<ActionOutcome> {
    const normalized = this.normalize(action);
    if (!normalized) {
      return this.rejectAction(action, 'invalid-action', 'Action 结构非法');
    }

    this.eventBus.emit(PetEvents.ActionReceived, {
      type: normalized.type,
      source: normalized.source,
      ...(normalized.target !== undefined ? { target: normalized.target } : {}),
      ...(normalized.priority !== undefined ? { priority: normalized.priority } : {}),
      ...(normalized.reason !== undefined ? { reason: normalized.reason } : {}),
      ...(normalized.metadata !== undefined ? { metadata: normalized.metadata } : {}),
    });

    // 暂停行为时：只放行用户与系统动作（保证用户仍能手动互动/托盘仍可用）
    if (this.status.paused && normalized.source !== 'user' && normalized.source !== 'system') {
      return this.rejectAction(normalized, 'behaviour-paused', '行为已暂停（仅放行用户与系统动作）');
    }

    // 守卫链
    for (const guard of this.guards) {
      try {
        const verdict = guard(normalized);
        const allowed = typeof verdict === 'boolean' ? verdict : verdict.allow;
        if (!allowed) {
          const reason = typeof verdict === 'boolean' ? 'blocked-by-guard' : (verdict.reason ?? 'blocked-by-guard');
          return this.rejectAction(normalized, 'blocked-by-guard', reason);
        }
      } catch (error) {
        this.logger.error('action guard threw (guard ignored)', { error, data: { type: normalized.type } });
      }
    }

    try {
      switch (normalized.type) {
        case 'animation':
          return await this.handleAnimation(normalized);
        case 'state':
          return this.handleState(normalized);
        case 'event':
          return this.handleEvent(normalized);
        default:
          return this.rejectAction(normalized, 'unknown-action-type', '未知 Action 类型');
      }
    } catch (error) {
      // Pipeline 自身异常绝不能冒泡到 renderer 顶层
      this.logger.error('action execution failed', { error, data: { type: normalized.type } });
      return this.rejectAction(normalized, 'invalid-action', describeError(error));
    }
  }

  /* ------------------------------------------------------------------ */
  /* 各类 Action 处理                                                    */
  /* ------------------------------------------------------------------ */

  private async handleAnimation(action: AnimationAction): Promise<ActionOutcome> {
    const animationId = action.animationId ?? action.target;
    if (!animationId) {
      return this.rejectAction(action, 'missing-target', 'animation action 缺少 animationId');
    }
    if (!this.animationManager.getDefinition(animationId)) {
      return this.rejectAction(action, 'animation-not-found', `动画未注册: ${animationId}`);
    }

    // 睡眠中被打断：先让状态机回到 IDLE，再播放反应动画（否则动画会被 sleep 的不可打断规则挡住）
    this.wakeIfSleeping(action.source ?? 'system', action.reason);

    const hint = action.metadata?.stateHint;
    const stateHint = typeof hint === 'string' && isPetState(hint)
      ? hint
      : ANIMATION_STATE_HINTS[animationId];

    const result = await this.animationManager.requestAnimation(animationId, {
      ...(action.priority !== undefined ? { priority: action.priority } : {}),
      ...(action.interrupt !== undefined ? { interrupt: action.interrupt } : {}),
      ...(action.bypassCooldown === true ? { bypassCooldown: true } : {}),
      ...(action.loopCountRange !== undefined ? { loopCountRange: action.loopCountRange } : {}),
      ...(action.reason !== undefined ? { reason: action.reason } : {}),
      source: action.source,
    });

    if (!result.accepted) {
      return this.rejectAction(action, 'animation-not-found', `动画请求被 AnimationManager 拒绝: ${result.reason ?? 'unknown'}`);
    }

    // 动画已开始；如需特定状态（如 sleep -> SLEEPING），在这里衔接
    if (stateHint && !this.stateMachine.is(stateHint)) {
      this.stateMachine.request(stateHint, `animation:${animationId}`, action.source ?? 'system');
    }

    return {
      accepted: true,
      type: 'animation',
      animationId,
      detail: action.reason,
    };
  }

  private handleState(action: StateAction): ActionOutcome {
    const target = action.target;
    if (!target) {
      return this.rejectAction(action, 'missing-target', 'state action 缺少 target');
    }
    if (!isPetState(target)) {
      return this.rejectAction(action, 'state-transition-rejected', `未知状态: ${target}`);
    }
    const result = this.stateMachine.request(target, action.reason ?? 'action-pipeline', action.source ?? 'system');
    if (!result.accepted) {
      return this.rejectAction(action, 'state-transition-rejected', `状态迁移被拒绝: ${result.reason ?? 'unknown'}`);
    }
    return { accepted: true, type: 'state', state: target, detail: action.reason };
  }

  private handleEvent(action: EventAction): ActionOutcome {
    const target = action.target;
    if (!target || target.trim() === '') {
      return this.rejectAction(action, 'missing-target', 'event action 缺少 target');
    }
    this.eventBus.emit(target, {
      source: action.source ?? 'system',
      ...(action.reason !== undefined ? { reason: action.reason } : {}),
      ...(action.payload !== undefined ? { payload: action.payload } : {}),
      ...(action.metadata !== undefined ? { metadata: action.metadata } : {}),
    });
    return { accepted: true, type: 'event', detail: target };
  }

  /* ------------------------------------------------------------------ */
  /* 内部工具                                                            */
  /* ------------------------------------------------------------------ */

  /** 结构校验：把任意输入收敛成合法的 PetAction（避免 any 与非法字段）。 */
  private normalize(action: PetAction): PetAction | null {
    if (typeof action !== 'object' || action === null) return null;
    const type = action.type;
    if (type !== 'animation' && type !== 'state' && type !== 'event') return null;
    const source = typeof action.source === 'string' && action.source.trim() !== ''
      ? action.source
      : 'system';
    const base = {
      ...(action.target !== undefined ? { target: action.target } : {}),
      ...(typeof action.priority === 'number' && Number.isFinite(action.priority)
        ? { priority: action.priority }
        : {}),
      source,
      ...(action.reason !== undefined ? { reason: action.reason } : {}),
      ...(action.metadata !== undefined ? { metadata: action.metadata } : {}),
    };

    if (type === 'animation') {
      return {
        type: 'animation',
        ...base,
        ...(action.animationId !== undefined ? { animationId: action.animationId } : {}),
        ...(action.interrupt !== undefined ? { interrupt: action.interrupt } : {}),
        ...(action.bypassCooldown === true ? { bypassCooldown: true } : {}),
        ...(action.loopCountRange !== undefined ? { loopCountRange: action.loopCountRange } : {}),
      };
    }
    return { type, ...base } as PetAction;
  }

  private rejectAction(action: PetAction, rejection: ActionRejectionReason, detail: string): ActionOutcome {
    const type: PetAction['type'] = action?.type === 'state' || action?.type === 'event' || action?.type === 'animation'
      ? action.type
      : 'event';
    const source = typeof action?.source === 'string' ? action.source : 'system';
    this.logger.info(`action rejected: ${type}`, { data: { rejection, detail, source } });
    this.eventBus.emit(PetEvents.ActionRejected, {
      type,
      source,
      ...(action?.target !== undefined ? { target: action.target } : {}),
      ...(action?.reason !== undefined ? { reason: action.reason } : {}),
      rejection,
    });
    return { accepted: false, type, rejection, detail };
  }

  /** 睡眠/不可打断动画被用户或外部打断时，先把状态拉回 IDLE。 */
  private wakeIfSleeping(source: string, reason?: string): void {
    if (!this.stateMachine.is('SLEEPING')) return;
    this.logger.info('waking from sleep', { data: { source, reason: reason ?? '' } });
    this.stateMachine.request('IDLE', reason ? `wake:${reason}` : 'wake-on-interaction', source);
  }

  /** 供未来 AI Agent / 插件查询当前 Pipeline 状态。 */
  public describe(): { readonly paused: boolean; readonly guards: number; readonly state: PetState } {
    return { paused: this.status.paused, guards: this.guards.size, state: this.stateMachine.get() };
  }
}

export { ActionError };
