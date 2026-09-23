/**
 * BehaviorManager —— 自动行为系统。
 *
 * 关键约束（需求明确要求）：
 * BehaviorManager **不直接播放视频**，它只产生 Action Request：
 *
 *   { type: 'animation', animationId: 'lie', priority: 10, reason: 'random-idle-action' }
 *
 * 然后交给 Action Pipeline -> StateMachine -> AnimationManager。
 *
 * 负责：
 * - 随机动作（从配置的候选动画里按权重抽一个）
 * - idle timeout（长时间无互动 -> 睡觉）
 * - 行为冷却（每个行为独立的 minInterval/maxInterval + 全局冷却）
 */

import type { PetAction } from '../../shared/action-types';
import { PetEvents } from '../../shared/events';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import type { EventBus } from './event-bus';

export interface BehaviorDefinition {
  readonly id: string;
  readonly kind: 'animation' | 'sleep';
  readonly enabled: boolean;
  /** 触发间隔（毫秒），实际间隔在 min/max 之间随机。 */
  readonly minIntervalMs: number;
  readonly maxIntervalMs: number;
  /** 首次触发的延迟（毫秒），避免启动瞬间就动画。 */
  readonly initialDelayMs?: number;
  /** 该行为要求的动画 id（sleep 行为可省略）。 */
  readonly animationId?: string;
  readonly priority?: number;
  /** 是否只在 IDLE 状态触发。 */
  readonly onlyWhenIdle?: boolean;
  /** 冷却时间（毫秒）：触发后多久内不允许任何其它自动行为。 */
  readonly cooldownMs?: number;
}

export interface BehaviorManagerOptions {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  /** 把 Action 投递到 Pipeline。 */
  readonly dispatch: (action: PetAction) => void;
  /** 当前状态（用于 onlyWhenIdle 判定）。 */
  readonly getState: () => string;
  readonly behaviors?: readonly BehaviorDefinition[];
  /** 调度精度（毫秒），默认 1000。 */
  readonly tickMs?: number;
}

/**
 * 默认行为配置。
 *
 * ⚠️ 当前阶段的范围约定（按需求）：
 * **只做 idle 循环 + 点击反应动画**。其他会「自动播放动画」的行为
 * （随机小动作 / 趴下 / 工作 / idle 超时睡觉）一律不启用，
 * 因此桌宠平时只会循环播放 idle，只有用户点击时才播放反应动画。
 *
 * 想启用某个自动行为：把对应条目的 `enabled` 改成 true 即可（调度与冷却逻辑都保留着）。
 */
export const DEFAULT_BEHAVIORS: readonly BehaviorDefinition[] = [
  /* ---------------- 以下「自动播放动画」当前阶段全部不启用 ---------------- */
  {
    id: 'idle-fidget',
    kind: 'animation',
    enabled: false,
    minIntervalMs: 22000,
    maxIntervalMs: 48000,
    initialDelayMs: 12000,
    animationId: 'cute',
    priority: 50,
    onlyWhenIdle: true,
    cooldownMs: 6000,
  },
  {
    id: 'idle-lie',
    kind: 'animation',
    enabled: false,
    minIntervalMs: 60000,
    maxIntervalMs: 150000,
    initialDelayMs: 45000,
    animationId: 'lie',
    priority: 10,
    onlyWhenIdle: true,
    cooldownMs: 30000,
  },
  {
    id: 'idle-work',
    kind: 'animation',
    enabled: false,
    minIntervalMs: 90000,
    maxIntervalMs: 200000,
    initialDelayMs: 70000,
    animationId: 'work',
    priority: 30,
    onlyWhenIdle: true,
    cooldownMs: 30000,
  },
  {
    id: 'idle-timeout-sleep',
    kind: 'sleep',
    enabled: false,
    // 5 分钟没有用户互动 -> 睡觉（当前阶段关闭）
    minIntervalMs: 300000,
    maxIntervalMs: 300000,
    animationId: 'sleep',
    priority: 20,
    onlyWhenIdle: true,
  },
];

interface BehaviorRuntime {
  definition: BehaviorDefinition;
  nextAt: number;
}

export class BehaviorManager {
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly dispatch: (action: PetAction) => void;
  private readonly getState: () => string;
  private readonly runtimes: BehaviorRuntime[];
  private readonly tickMs: number;
  private timer: number | null = null;
  private paused = false;
  private lastInteractionAt = Date.now();
  private lastGlobalTriggerAt = 0;

  public constructor(options: BehaviorManagerOptions) {
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.dispatch = options.dispatch;
    this.getState = options.getState;
    this.tickMs = options.tickMs ?? 1000;
    const behaviors = options.behaviors ?? DEFAULT_BEHAVIORS;
    const now = Date.now();
    this.runtimes = behaviors
      .filter((behavior) => behavior.enabled)
      .map((definition) => ({
        definition,
        nextAt: now + (definition.initialDelayMs ?? definition.minIntervalMs),
      }));
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  public start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        // 行为调度异常不能影响桌宠主体
        this.logger.error('behavior scheduling error', { error: describeError(error) });
      }
    }, this.tickMs);
    this.logger.info('behavior system started', { data: { behaviors: this.runtimes.map((r) => r.definition.id).join(',') } });
  }

  public stop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
    this.logger.info('behavior system stopped');
  }

  public pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.eventBus.emit(PetEvents.BehaviorPaused, { paused: true });
    this.logger.info('behaviors paused');
  }

  public resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const now = Date.now();
    // 恢复后重新排期，避免“暂停期间积累”导致瞬间连续触发
    for (const runtime of this.runtimes) {
      runtime.nextAt = now + randomBetween(
        runtime.definition.minIntervalMs,
        runtime.definition.maxIntervalMs,
      );
    }
    this.eventBus.emit(PetEvents.BehaviorPaused, { paused: false });
    this.logger.info('behaviors resumed');
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public toggle(): boolean {
    if (this.paused) this.resume();
    else this.pause();
    return this.paused;
  }

  /** 用户交互后调用：重置 idle timeout。 */
  public notifyInteraction(): void {
    this.lastInteractionAt = Date.now();
  }

  public getBehaviors(): readonly BehaviorDefinition[] {
    return this.runtimes.map((runtime) => runtime.definition);
  }

  /* ------------------------------------------------------------------ */
  /* 调度                                                                */
  /* ------------------------------------------------------------------ */

  private tick(): void {
    if (this.paused) return;
    const now = Date.now();
    const state = this.getState();

    for (const runtime of this.runtimes) {
      const { definition } = runtime;
      if (now < runtime.nextAt) continue;
      if (definition.onlyWhenIdle !== false && state !== 'IDLE') {
        // 不满足条件时顺延一个周期，避免每秒重复判定
        runtime.nextAt = now + 2000;
        continue;
      }

      // idle timeout 行为：必须有足够的“无互动”时长
      if (definition.kind === 'sleep') {
        const idleFor = now - this.lastInteractionAt;
        const required = definition.minIntervalMs;
        if (idleFor < required) {
          runtime.nextAt = this.lastInteractionAt + required;
          continue;
        }
      }

      // 全局冷却：避免多个行为同时触发造成动画互相抢占
      const cooldown = definition.cooldownMs ?? 0;
      if (cooldown > 0 && now - this.lastGlobalTriggerAt < cooldown) {
        this.logger.debug('behavior in global cooldown; deferred', { data: { behaviorId: definition.id } });
        continue;
      }

      this.trigger(runtime, now);
    }
  }

  private trigger(runtime: BehaviorRuntime, now: number): void {
    const { definition } = runtime;
    runtime.nextAt = now + randomBetween(definition.minIntervalMs, definition.maxIntervalMs);
    this.lastGlobalTriggerAt = now;

    const animationId = definition.animationId;
    if (!animationId) {
      this.logger.warn('behavior without animationId skipped', { data: { behaviorId: definition.id } });
      return;
    }

    const reason = definition.kind === 'sleep' ? 'idle-timeout' : `random-idle-action:${definition.id}`;
    const action: PetAction = {
      type: 'animation',
      animationId,
      ...(definition.priority !== undefined ? { priority: definition.priority } : {}),
      source: 'behavior',
      reason,
      metadata: { behaviorId: definition.id, elapsedSinceInteractionMs: now - this.lastInteractionAt },
    };

    this.logger.info(`behavior triggered ${definition.id}`, { data: { animationId, reason } });
    this.eventBus.emit(PetEvents.BehaviorTriggered, { animationId, reason });
    this.dispatch(action);
  }

  public describe(): readonly { readonly id: string; readonly nextInMs: number }[] {
    const now = Date.now();
    return this.runtimes.map((runtime) => ({
      id: runtime.definition.id,
      nextInMs: Math.max(0, runtime.nextAt - now),
    }));
  }
}

function randomBetween(min: number, max: number): number {
  if (!Number.isFinite(min)) return 1000;
  if (!Number.isFinite(max) || max <= min) return min;
  return Math.round(min + Math.random() * (max - min));
}
