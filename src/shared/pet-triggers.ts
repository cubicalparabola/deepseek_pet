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
 * 两次"接住"之间的**最短间隔**。
 *
 * 为什么光有"重新武装"不够（用户实测反馈："鼠标靠近的动画需要有一段时间的冷却，
 * 不能连续触发"）：武装只要求光标离开 210px 再回来 —— 手在桌面上划来划去时
 * 一秒钟就能进出几个来回，于是她一路 catch_down / catch_right 停不下来。
 * 冷却把"离开再回来"这条捷径也挡住：一分钟内最多接住一次。
 *
 * 冷却结束时光标若还停在附近，会补演一次（不是白等）。
 */
export const APPROACH_COOLDOWN_MS = 60_000;

/**
 * 光标相对宠物中心的偏移 -> 该演哪条"接住"动画。
 *
 * 需求：`catch_down`（鼠标下方靠近）、`catch_right`（鼠标右方靠近）。
 * 只有这两条素材，因此从上方/左侧靠近时**不演**（宁可不演，也不要演错方向）。
 *
 * @param dx 光标 x - 宠物中心 x（正 = 光标在右边）
 * @param dy 光标 y - 宠物中心 y（正 = 光标在下边）
 * @param armed 是否"还没为这次靠近演过"
 * @param options.sinceLastTriggerMs 距上次"接住"过了多久（缺省 = 很久以前，不冷却）
 */
export function classifyApproach(
  offset: { readonly dx: number; readonly dy: number },
  armed: boolean,
  options: {
    readonly radius?: number;
    readonly rearmFactor?: number;
    readonly cooldownMs?: number;
    readonly sinceLastTriggerMs?: number;
  } = {},
): TriggerDecision {
  const radius = options.radius ?? APPROACH_RADIUS_PX;
  const rearmFactor = options.rearmFactor ?? APPROACH_REARM_FACTOR;
  const distance = Math.hypot(offset.dx, offset.dy);

  // 走远了 -> 重新武装（等待下一次靠近）
  if (distance > radius * rearmFactor) return { animationId: null, armed: true };
  if (!armed || distance > radius) return { animationId: null, armed };

  /*
   * 冷却中：这一次不演，但**保持武装** —— 冷却一过、如果光标还在附近就补演一次。
   * 若这里把 armed 置为 false，站着不动的用户就再也等不到"接住"了。
   */
  const cooldownMs = options.cooldownMs ?? APPROACH_COOLDOWN_MS;
  const sinceLast = options.sinceLastTriggerMs ?? Number.POSITIVE_INFINITY;
  if (sinceLast < cooldownMs) return { animationId: null, armed: true };

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
 * 四种原因（需求："没用配置 API 或 API 无效"，外加"网断了"）：
 *   - `no-key`      还没填密钥
 *   - `network`     断网（系统层面没网，或最近一次请求连不上）
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

/**
 * 「现在算不算掉线、算哪种」——**纯函数**，输入全是已经取好的事实。
 *
 * 为什么从 AIService 里抽出来：这段规则原来长在 `AIService.offlineReason()` 里，
 * 于是"断网该算掉线"这条判断只能靠真的拔网线才能验。
 * 抽成纯函数之后，主进程只负责取事实（`net.isOnline()`、余额、错误文案），
 * 规则本身可以被逐条钉死（见 tools/acceptance.cjs 的"掉线判定"那一组）。
 *
 * 判定顺序是有意的：
 *   1. 总开关关着 -> 不算掉线（用户自己关的，不该报故障）；
 *   2. 没配密钥 -> `no-key`（这条最该先告诉用户，也最好修）；
 *   3. 系统没网 -> `network`；
 *   4. 余额明确不可用 -> `no-balance`；
 *   5. 401/403 -> `invalid-key`；
 *   6. 最近一次请求是网络层面失败 -> `network`。
 *
 * ⚠️ **超时不算断网**：模型慢和网线被拔是两件事，
 * 前者报"掉线"会让人去查路由器。
 */
export function classifyOffline(input: {
  /** AI 总开关。 */
  readonly enabled: boolean;
  /** 是否配了密钥。 */
  readonly hasKey: boolean;
  /** 系统层面是否有网络连接（主进程用 `net.isOnline()` 取）。 */
  readonly networkOnline: boolean;
  /** 官方余额接口是否明确说"不可用"（没查过 = true）。 */
  readonly balanceAvailable: boolean;
  /** 最近一次余额查询的错误文案。 */
  readonly balanceError: string;
  /** 最近一次调用的错误文案。 */
  readonly lastError: string;
}): string {
  if (!input.enabled) return '';
  if (!input.hasKey) return 'no-key';
  if (!input.networkOnline) return 'network';
  if (!input.balanceAvailable) return 'no-balance';
  if (isInvalidKeyError(input.balanceError) || isInvalidKeyError(input.lastError)) return 'invalid-key';
  if (isNetworkFailure(input.balanceError) || isNetworkFailure(input.lastError)) return 'network';
  return '';
}

/** 密钥无效（401/403）的文案特征 —— 与 `LLMClient.httpError` 的输出对应。 */
function isInvalidKeyError(message: string): boolean {
  return /HTTP 401|HTTP 403|API Key 无效/.test(message);
}

/**
 * 这条错误文案是不是"网络层面失败"。
 *
 * 判定依据是 `LLMClient.normalizeError` 里 NETWORK 分支的固定前缀
 * （`网络请求失败：`），而不是猜关键词 —— 超时（`请求超时`）**不算**断网。
 */
function isNetworkFailure(message: string): boolean {
  return message.includes('网络请求失败');
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
