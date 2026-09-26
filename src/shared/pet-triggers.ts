/**
 * 触发动画的**判定规则**（纯函数）—— 需求 6.2 的"触发动画"那一类。
 *
 * 为什么单独一个模块：这些规则全是"某个数值越过阈值就演一次动画"，
 * 但它们最容易出错的不是"会不会触发"，而是**会不会反复触发**：
 * 心情一直在 20 徘徊、GPU 一直在 82 度、鼠标一直贴在她下面 ——
 * 如果没有"重新武装（re-arm）"这一层，动画就会每隔几秒重复一次。
 *
 * 因此每个规则都写成 `(当前值, 是否已武装) -> (要不要触发, 下次是否武装)`：
 * 触发一次后自动解除武装，只有回到"明显恢复正常"的区间才重新武装。
 * 全部是纯函数，验收可以逐条钉死。
 */

import type { AnimationCategory } from './animation-types';
import type { SceneKind } from './perception-types';

/** 触发动画的 id（与清单里的 category: 'trigger' 对应）。 */
export type TriggerAnimationId =
  | 'catch_down'
  | 'catch_right'
  | 'hungry'
  | 'remind'
  | 'talk'
  | 'sad'
  | 'shy'
  | 'offline'
  | 'overheat'
  | 'work'
  | 'read';

/** 判定结果：触发哪条动画 + 下次是否还"武装着"。 */
export interface TriggerDecision {
  readonly animationId: TriggerAnimationId | null;
  readonly armed: boolean;
}

/* -------------------------------------------------------------------------- */
/* 一、鼠标靠近（catch_down / catch_right）                                     */
/* -------------------------------------------------------------------------- */

/** 光标进入这个半径内算"靠近了"。 */
export const APPROACH_RADIUS_PX = 150;
/** 离开半径的多少倍才算"走开了"，重新武装（防止在边界上抖动）。 */
export const APPROACH_REARM_FACTOR = 1.4;

/**
 * 光标相对宠物中心的偏移 -> 该演哪条"接住"动画。
 *
 * 需求：`catch_down`（鼠标下方靠近）、`catch_right`（鼠标右方靠近）。
 * 只有这两条素材，因此从上方/左侧靠近时**不演**（宁可不演，也不要演错方向）。
 *
 * @param dx 光标 x - 宠物中心 x（正 = 光标在右边）
 * @param dy 光标 y - 宠物中心 y（正 = 光标在下边）
 * @param armed 是否"还没为这次靠近演过"
 */
export function classifyApproach(
  offset: { readonly dx: number; readonly dy: number },
  armed: boolean,
  options: { readonly radius?: number; readonly rearmFactor?: number } = {},
): TriggerDecision {
  const radius = options.radius ?? APPROACH_RADIUS_PX;
  const rearmFactor = options.rearmFactor ?? APPROACH_REARM_FACTOR;
  const distance = Math.hypot(offset.dx, offset.dy);

  // 走远了 -> 重新武装（等待下一次靠近）
  if (distance > radius * rearmFactor) return { animationId: null, armed: true };
  if (!armed || distance > radius) return { animationId: null, armed };

  /*
   * 只有"主要来自下方 / 右侧"才算：用 `>=` 比较两个分量的绝对值。
   *
   * 为什么不能只判断 `dx > 0`：光标在她**正上方偏右**时 `dx` 也是正的，
   * 那样会演成 `catch_right`（"从右边接住"），而她其实是低头看着你 ——
   * 演错方向比不演更奇怪。所以两条都要"该方向占主导"。
   */
  const horizontal = Math.abs(offset.dx);
  const vertical = Math.abs(offset.dy);
  if (offset.dy > 0 && vertical >= horizontal) return { animationId: 'catch_down', armed: false };
  if (offset.dx > 0 && horizontal >= vertical) return { animationId: 'catch_right', armed: false };
  return { animationId: null, armed };
}

/* -------------------------------------------------------------------------- */
/* 二、GPU 温度（overheat）                                                     */
/* -------------------------------------------------------------------------- */

/** 达到这个温度算过热（摄氏度）。 */
export const OVERHEAT_TEMP_C = 80;
/** 降回「阈值 - 回差」以下才重新武装（避免在阈值附近反复触发）。 */
export const OVERHEAT_HYSTERESIS_C = 5;

/**
 * GPU 温度 -> 要不要演过热动画。
 *
 * `tempC === null` = 读不到温度（没有 N 卡 / 没有 nvidia-smi）：
 * **一律不触发**，也不改变武装状态 —— 宁可什么都不演，也不要瞎报过热。
 */
export function evaluateOverheat(
  tempC: number | null,
  armed: boolean,
  options: { readonly threshold?: number; readonly hysteresis?: number } = {},
): TriggerDecision {
  if (tempC === null || !Number.isFinite(tempC)) return { animationId: null, armed };
  const threshold = options.threshold ?? OVERHEAT_TEMP_C;
  const hysteresis = options.hysteresis ?? OVERHEAT_HYSTERESIS_C;
  if (tempC >= threshold && armed) return { animationId: 'overheat', armed: false };
  if (tempC <= threshold - hysteresis) return { animationId: null, armed: true };
  return { animationId: null, armed };
}

/* -------------------------------------------------------------------------- */
/* 三、心情过低（sad）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 心情低于这个值算"很难过" —— 与 `moodLabel()` 里 `sad` 档的阈值保持一致
 * （两处不一致的话，UI 显示"很难过"而她却不难过，排查起来很费劲）。
 */
export const SAD_MOOD_THRESHOLD = 25;
/** 心情回到这个值以上才重新武装。 */
export const SAD_REARM_MOOD = 40;

export function evaluateSad(
  mood: number,
  armed: boolean,
  options: { readonly threshold?: number; readonly rearm?: number } = {},
): TriggerDecision {
  if (!Number.isFinite(mood)) return { animationId: null, armed };
  const threshold = options.threshold ?? SAD_MOOD_THRESHOLD;
  const rearm = options.rearm ?? SAD_REARM_MOOD;
  if (mood <= threshold && armed) return { animationId: 'sad', armed: false };
  if (mood >= rearm) return { animationId: null, armed: true };
  return { animationId: null, armed };
}

/* -------------------------------------------------------------------------- */
/* 四、饿（hungry）                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 饥饿度阈值：与 `hungerLabel()` 的 `hungry`（>=60）保持一致；
 * 回到 40 以下重新武装。
 */
export const HUNGRY_THRESHOLD = 60;
export const HUNGRY_REARM = 40;

export function evaluateHungry(
  hunger: number,
  armed: boolean,
  options: { readonly threshold?: number; readonly rearm?: number } = {},
): TriggerDecision {
  if (!Number.isFinite(hunger)) return { animationId: null, armed };
  const threshold = options.threshold ?? HUNGRY_THRESHOLD;
  const rearm = options.rearm ?? HUNGRY_REARM;
  if (hunger >= threshold && armed) return { animationId: 'hungry', armed: false };
  if (hunger <= rearm) return { animationId: null, armed: true };
  return { animationId: null, armed };
}

/* -------------------------------------------------------------------------- */
/* 五、掉线（offline）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 掉线原因 -> 要不要演 offline。
 *
 * 四种原因（需求："没用配置 API 或 API 无效"）：
 *   - `no-key`      还没填密钥
 *   - `invalid-key` 密钥无效（接口 401/403）
 *   - `no-balance`  余额不足（官方 `is_available = false`）
 *   - `''`          正常
 *
 * 掉线是**持续状态**而不是事件：这里在"状态发生变化"时演一次
 * （`armed` 由调用方在首次检测时置为 true），恢复正常后重新武装。
 */
export function evaluateOffline(reason: string, armed: boolean): TriggerDecision {
  if (reason !== '') {
    if (armed) return { animationId: 'offline', armed: false };
    return { animationId: null, armed: false };
  }
  return { animationId: null, armed: true };
}

/* -------------------------------------------------------------------------- */
/* 六、感知到在工作 / 在阅读（work / read）                                      */
/* -------------------------------------------------------------------------- */

/** 场景需要连续稳定这么久才触发（避免窗口一切就演一次）。 */
export const SCENE_TRIGGER_STABLE_MS = 90_000;

/** 哪些场景算"在工作"。 */
const WORK_SCENES: readonly SceneKind[] = ['coding', 'writing', 'terminal'];

/** 场景 id -> 该演的触发动画。 */
export function sceneTriggerAnimation(scene: SceneKind): TriggerAnimationId | null {
  if (scene === 'reading') return 'read';
  if (WORK_SCENES.includes(scene)) return 'work';
  return null;
}

/**
 * 场景触发的完整判定（在"稳定 + 不是频繁切换"的前提下才演）。
 *
 * 为什么要求稳定：`coding -> browser -> coding` 这种来回切是常态，
 * 一有观察结果就演 work 会变成"每隔 30 秒突然开始工作"。
 *
 * @param stableMs 当前场景已经持续多久
 * @param switching 是否处于"频繁切换"状态（感知层已经在算）
 * @param sinceLastTriggerMs 距离上次同类触发过了多久
 */
export function evaluateSceneTrigger(input: {
  readonly scene: SceneKind;
  readonly stableMs: number;
  readonly switching: boolean;
  readonly sinceLastTriggerMs: number;
  readonly cooldownMs?: number;
  readonly stableRequiredMs?: number;
}): TriggerAnimationId | null {
  const animationId = sceneTriggerAnimation(input.scene);
  if (animationId === null) return null;
  if (input.switching) return null;
  const stable = input.stableRequiredMs ?? SCENE_TRIGGER_STABLE_MS;
  if (input.stableMs < stable) return null;
  const cooldown = input.cooldownMs ?? 20 * 60_000;
  if (input.sinceLastTriggerMs < cooldown) return null;
  return animationId;
}

/** 分类标签（托盘/面板展示"这条动画属于哪一类"）。 */
export const TRIGGER_CATEGORY: AnimationCategory = 'trigger';
