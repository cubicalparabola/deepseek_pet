/**
 * StateMachine —— 桌宠状态机。
 *
 * 严格职责边界：
 * - StateMachine 只回答：当前状态 / 是否允许迁移 / 进入与退出时做什么；
 * - StateMachine **不播放任何视频**（那是 AnimationManager 的职责）；
 * - AnimationManager **不决定业务状态**（那是本类的职责）。
 *
 * 第一版状态：IDLE / PLAYING / SLEEPING / BUSY
 * 迁移规则集中在 DEFAULT_STATES，可被 registerState 扩展（未来任务系统/AI 接管时很有用）。
 */

import type {
  PetState,
  StateDefinition,
  StateTransitionContext,
  StateTransitionResult,
} from '../../shared/state-types';
import type { StateChangeEvent } from '../../shared/state-types';
import { PetEvents } from '../../shared/events';
import type { Logger } from '../../shared/logger';
import type { EventBus } from './event-bus';

export interface StateMachineOptions {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly initial?: PetState;
}

/** 第一版内置状态定义（白名单式迁移，杜绝非法跳转）。 */
export const DEFAULT_STATES: readonly StateDefinition[] = [
  {
    name: 'IDLE',
    idle: true,
    transitions: ['PLAYING', 'SLEEPING', 'BUSY'],
  },
  {
    name: 'PLAYING',
    // 播放中可以直接入睡（sleep 动画结束会回到 IDLE），也可以被强制中断回到 IDLE
    transitions: ['IDLE', 'SLEEPING', 'BUSY'],
    onEnter: () => undefined,
  },
  {
    name: 'SLEEPING',
    idle: true,
    // 被用户/插件/AI 唤醒时需要进入 PLAYING（例如播放互动反应动画）
    transitions: ['IDLE', 'PLAYING', 'BUSY'],
  },
  {
    name: 'BUSY',
    transitions: ['IDLE', 'PLAYING', 'SLEEPING'],
  },
];

export class StateMachine {
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly states = new Map<PetState, StateDefinition>();
  private current: PetState;
  private readonly history: StateChangeEvent[] = [];

  public constructor(options: StateMachineOptions) {
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.current = options.initial ?? 'IDLE';
    for (const definition of DEFAULT_STATES) this.states.set(definition.name, definition);
    this.logger.info('state machine initialized', { data: { initial: this.current } });
  }

  /* ------------------------------------------------------------------ */
  /* 查询                                                                */
  /* ------------------------------------------------------------------ */

  public get(): PetState {
    return this.current;
  }

  public is(state: PetState): boolean {
    return this.current === state;
  }

  public isIdle(): boolean {
    return this.states.get(this.current)?.idle === true;
  }

  public list(): readonly PetState[] {
    return [...this.states.keys()];
  }

  public allowedTransitions(): readonly PetState[] {
    return this.states.get(this.current)?.transitions ?? [];
  }

  public getHistory(limit = 20): readonly StateChangeEvent[] {
    return this.history.slice(-limit);
  }

  /* ------------------------------------------------------------------ */
  /* 扩展                                                                */
  /* ------------------------------------------------------------------ */

  /** 注册/覆盖状态定义（第一版内部使用，未来供插件或 AI 扩展状态）。 */
  public registerState(definition: StateDefinition): void {
    this.states.set(definition.name, definition);
    this.logger.debug('state registered', { data: { name: definition.name } });
  }

  /* ------------------------------------------------------------------ */
  /* 迁移                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 请求迁移。永不抛异常：不允许的迁移返回 accepted=false，并发布 state:rejected。
   */
  public request(
    target: PetState,
    reason: string,
    source = 'system',
  ): StateTransitionResult {
    if (target === this.current) {
      return { accepted: false, from: this.current, to: target, reason: 'same-state' };
    }

    const definition = this.states.get(this.current);
    if (!definition) {
      this.logger.error('current state has no definition; transition rejected', { data: { current: this.current } });
      return { accepted: false, from: this.current, to: target, reason: 'no-definition' };
    }

    if (!this.states.has(target)) {
      this.logger.warn('target state not registered', { data: { target } });
      return { accepted: false, from: this.current, to: target, reason: 'no-definition' };
    }

    if (!definition.transitions.includes(target)) {
      this.logger.debug('transition not allowed; rejected', {
        data: { from: this.current, to: target, allowed: definition.transitions.join(',') },
      });
      this.eventBus.emit('state:rejected', { from: this.current, to: target, reason });
      return { accepted: false, from: this.current, to: target, reason: 'not-allowed' };
    }

    const from = this.current;
    const context: StateTransitionContext = { from, to: target, reason, source };

    try {
      definition.onExit?.(context);
    } catch (error) {
      this.logger.error('onExit threw (ignored)', { error, data: { from, to: target } });
    }

    this.current = target;

    try {
      this.states.get(target)?.onEnter?.(context);
    } catch (error) {
      this.logger.error('onEnter threw (ignored)', { error, data: { from, to: target } });
    }

    const event: StateChangeEvent = { from, to: target, reason, source, at: Date.now() };
    this.history.push(event);
    if (this.history.length > 100) this.history.shift();

    this.logger.info(`${from} -> ${target}`, { data: { reason, source } });
    this.eventBus.emit(PetEvents.StateChange, event);

    return { accepted: true, from, to: target };
  }

  /** 强制设置状态（初始化/恢复时使用，不走白名单）。 */
  public reset(state: PetState, reason = 'reset'): void {
    const from = this.current;
    this.current = state;
    const event: StateChangeEvent = { from, to: state, reason, source: 'system', at: Date.now() };
    this.history.push(event);
    this.logger.info(`${from} -> ${state}`, { data: { reason, forced: true } });
    this.eventBus.emit(PetEvents.StateChange, event);
  }
}
