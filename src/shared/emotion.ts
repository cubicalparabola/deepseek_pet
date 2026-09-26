/**
 * 情绪系统模型（2.3）—— **纯函数**，不碰 IO、不碰时间（时间由调用方传入）。
 *
 * 为什么坚持纯函数：
 * - 情绪是"内部状态"，它的每一条规则都值得被直接验证（验收脚本可以直接调它）；
 * - Main 只用它做状态转移，持久化与定时器都在 ai/emotion-service.ts 里。
 *
 * 两条独立的状态：
 * - `mood`（心情 0~100）：**互动增加、不互动随时间下降**，衰减速度取决于在场状态；
 * - `hunger`（饥饿 0~100）：**由 token 剩余量推导**，不做时间衰减
 *   （"饿"是"说不动话了"，不是"到点没吃"）。
 *
 * 这样设计的结果：同一句"你好"，在心情 90 与心情 20 时会得到完全不同的回复 ——
 * 因为 prompt 里注入的情绪描述不同（见 describeEmotionForPrompt）。
 */

import type { EmotionSignals, EmotionState, InteractionKind, PetPresence } from './ai-types';

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** 情绪模型常量（全部集中在这里，便于调参和验收断言）。 */
export const EMOTION = {
  /** 心情上下限。 */
  min: 0,
  max: 100,
  /** 初始心情（刚装上桌宠时的"平常心"）。 */
  initial: 62,
  /** 各互动带来的心情增量。 */
  gain: {
    click: 5,
    doubleclick: 7,
    drag: 3,
    chat: 9,
    diary: 6,
    gift: 12,
  } satisfies Record<InteractionKind, number>,
  /**
   * 每分钟自然衰减（点了不看 / 收起 / 隐藏 三档）。
   *
   * 数值取"可见时约 3 小时从 100 掉到 30"的量级：
   * 太慢则情绪没存在感，太快则用户离开一会儿回来就看到她在难过。
   */
  decayPerMinute: {
    visible: 0.4,
    collapsed: 1.0,
    hidden: 2.2,
  } satisfies Record<PetPresence, number>,
  /**
   * 互动后的"免衰减"宽限期（分钟）。
   *
   * 没有它的话，一次互动 +9 会被随后几分钟的衰减吃回去，
   * 用户会觉得"摸她没用"。宽限期内只涨不跌，之后才开始掉。
   */
  graceMinutes: 3,
  /** 衰减计算的时间步上限（分钟）：程序关掉一整夜再打开不能一次性掉光。 */
  maxDecayMinutes: 120,
} as const;

/* -------------------------------------------------------------------------- */
/* 基础工具                                                                    */
/* -------------------------------------------------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 心情取整并夹到 [0,100]。 */
export function clampMood(mood: number): number {
  return Math.round(clamp(mood, EMOTION.min, EMOTION.max));
}

/** 一个"平常心"的初始情绪状态。 */
export function initialEmotion(now: number = Date.now()): EmotionState {
  return {
    mood: EMOTION.initial,
    hunger: 0,
    lastInteractionAt: now,
    lastUpdateAt: now,
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * token 剩余比例 -> 饥饿值。
 *
 * `budget <= 0` 视为"不限额"（hunger 恒为 0）—— 用户没设预算就不该被"饿"打断。
 */
export function hungerFromTokens(tokensRemainingRatio: number): number {
  const ratio = clamp(tokensRemainingRatio, 0, 1);
  return clampMood((1 - ratio) * 100);
}

/** 由"预算 + 已用"算剩余比例；不限额时返回 1。 */
export function tokensRemainingRatio(budget: { readonly budget: number; readonly used: number }): number {
  if (!Number.isFinite(budget.budget) || budget.budget <= 0) return 1;
  const used = Number.isFinite(budget.used) ? Math.max(0, budget.used) : 0;
  return clamp((budget.budget - used) / budget.budget, 0, 1);
}

/** 余额 -> 饥饿度的默认口径：<= 2 元算见底，>= 20 元算充足。 */
export const BALANCE_LOW_DEFAULT = 2;
export const BALANCE_FULL_DEFAULT = 20;

/**
 * 把**账号余额**映射成饥饿度（0~100）；`null` = 没有余额信息，调用方退回本地预算。
 *
 * 为什么需要它（用户明确要求"余额优先于本地预算"）：
 * 本地累计 token 只统计这台机器上我们自己发出去的请求，而余额才是
 * "账号还剩多少额度"的真相（换台机器、别的程序也在用同一个 key）。
 *
 * 口径（线性，两端夹住）：
 *   total <= low   -> 100（很饿）
 *   total >= full  -> 0（不饿）
 *   中间           -> 从 100 线性降到 0
 *
 * 两个数写反（`low > full`）时不做"余额越多越饿"这种反直觉计算，直接给 0。
 */
export function hungerFromBalance(
  total: number | null,
  options: { readonly low?: number; readonly full?: number } = {},
): number | null {
  if (total === null || !Number.isFinite(total)) return null;
  const low = Number.isFinite(options.low) ? (options.low as number) : BALANCE_LOW_DEFAULT;
  const full = Number.isFinite(options.full) ? (options.full as number) : BALANCE_FULL_DEFAULT;
  // 两个数写反：配置笔误不该让她"越有钱越饿"，保守地当作"不饿"
  if (full <= low) return 0;
  if (total <= low) return 100;
  if (total >= full) return 0;
  return clampMood(Math.round(((full - total) / (full - low)) * 100));
}

/* -------------------------------------------------------------------------- */
/* 状态转移                                                                    */
/* -------------------------------------------------------------------------- */

/** 互动：心情上涨，并刷新"最近互动时间"（记下时间点，之后才开始衰减）。 */
export function applyInteraction(
  state: EmotionState,
  kind: InteractionKind,
  now: number = Date.now(),
): EmotionState {
  const gain = EMOTION.gain[kind] ?? 0;
  return {
    ...state,
    mood: clampMood(state.mood + gain),
    lastInteractionAt: now,
    lastUpdateAt: Math.max(state.lastUpdateAt, 0) === 0 ? now : state.lastUpdateAt,
    updatedAt: new Date(now).toISOString(),
  };
}

/** 重新计算饥饿（token 用量变化后调用）。 */
export function applyTokens(state: EmotionState, tokensRemaining: number, now: number = Date.now()): EmotionState {
  return {
    ...state,
    hunger: hungerFromTokens(tokensRemaining),
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * 时间流逝结算：**不互动就慢慢掉心情**，衰减速度由在场状态决定。
 *
 * 注意 `lastUpdateAt` 一定会推进（哪怕这轮没掉），否则"连续调用"会把
 * 同一段时间重复扣掉，心跳越勤掉得越快 —— 这是最容易写错的地方。
 */
export function decayEmotion(state: EmotionState, signals: EmotionSignals): EmotionState {
  const now = signals.now;
  const elapsedMs = Math.max(0, now - state.lastUpdateAt);
  const elapsedMinutes = elapsedMs / 60000;

  // 互动宽限期：刚被摸过的一小段时间只涨不跌
  const sinceInteractionMinutes = Math.max(0, now - state.lastInteractionAt) / 60000;
  const effectiveMinutes =
    sinceInteractionMinutes < EMOTION.graceMinutes
      ? 0
      : Math.min(elapsedMinutes, EMOTION.maxDecayMinutes);

  const rate = EMOTION.decayPerMinute[signals.presence] ?? EMOTION.decayPerMinute.visible;
  const mood = clampMood(state.mood - effectiveMinutes * rate);

  return {
    ...state,
    mood,
    hunger: hungerFromTokens(signals.tokensRemainingRatio),
    lastUpdateAt: now,
    updatedAt: new Date(now).toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* 展示 / Prompt                                                               */
/* -------------------------------------------------------------------------- */

export interface MoodLabel {
  /** 机器可读的档位。 */
  readonly key: 'great' | 'good' | 'calm' | 'lonely' | 'sad';
  /** 中文标签（UI 展示）。 */
  readonly label: string;
  /** 表情（终端/日志里用）。 */
  readonly face: string;
}

/** 心情 -> 档位（UI 与 prompt 共用同一套分档，保证"说的"和"演的"一致）。 */
export function moodLabel(mood: number): MoodLabel {
  const value = clampMood(mood);
  if (value >= 80) return { key: 'great', label: '很开心', face: '(≧▽≦)' };
  if (value >= 60) return { key: 'good', label: '心情不错', face: '(・ω・)' };
  if (value >= 40) return { key: 'calm', label: '平静', face: '(・_・)' };
  if (value >= 20) return { key: 'lonely', label: '有点寂寞', face: '(´・ω・`)' };
  return { key: 'sad', label: '很难过', face: '(╥﹏╥)' };
}

/** 饥饿 -> 档位。 */
export function hungerLabel(hunger: number): { key: 'full' | 'ok' | 'hungry' | 'starving'; label: string } {
  const value = clampMood(hunger);
  if (value >= 85) return { key: 'starving', label: '饿得说不出话' };
  if (value >= 60) return { key: 'hungry', label: '有点饿' };
  if (value >= 30) return { key: 'ok', label: '还行' };
  return { key: 'full', label: '很饱' };
}

/**
 * 把当前情绪翻译成**注入 prompt 的一小段中文**。
 *
 * 用自然语言而不是 JSON：大模型对"你现在有点寂寞"这种描述的反应
 * 明显比 `{"mood":18}` 更符合人格设定。
 */
export function describeEmotionForPrompt(state: EmotionState, presence: PetPresence): string {
  const mood = moodLabel(state.mood);
  const hunger = hungerLabel(state.hunger);
  const presenceText =
    presence === 'visible' ? '主人就在你面前' : presence === 'collapsed' ? '你被收起来了，安静待着' : '你被藏起来了，看不到主人';
  const lines = [
    `当前心情：${mood.label}（${state.mood}/100），${presenceText}。`,
    `当前状态：${hunger.label}（饥饿 ${state.hunger}/100，100 表示 token 预算用尽说不动话）。`,
  ];
  if (state.mood < 30) lines.push('你有点委屈，可以轻轻抱怨一句主人很久没理你，但不要指责。');
  else if (state.mood >= 80) lines.push('你心情很好，语气可以活泼一点。');
  if (state.hunger >= 60) lines.push('你说话有点没力气，可以提一句"脑子空空的"（这是 token 快用完的比喻）。');
  return lines.join('\n');
}

/**
 * 根据情绪挑一个"表演"用的动画。
 *
 * 这是需求里"语言、行为和动画表现保持一致"的落点：
 * 心情好 → 卖萌/说话；心情差 → 躺着发呆/看书；饿 → 饿了的动画。
 *
 * @param available 当前 Manifest 里真实存在的动画 id（缺哪个就跳过哪个）
 */
export function preferredAnimation(
  state: EmotionState,
  kind: 'greeting' | 'reply' | 'idle-chat',
  available: readonly string[],
): string | null {
  const has = (id: string): boolean => available.includes(id);
  const pick = (candidates: readonly string[]): string | null => candidates.find(has) ?? null;

  // 饿的时候优先表达"饿"（也有对应动画，属于状态一致性的直观体现）
  if (state.hunger >= 70) {
    const hungry = pick(['hungry', 'remind', 'lie']);
    if (hungry) return hungry;
  }
  if (state.mood >= 75) {
    return pick(kind === 'greeting' ? ['cute', 'fawning', 'talk'] : ['talk', 'cute', 'fawning']);
  }
  if (state.mood >= 45) {
    return pick(kind === 'reply' ? ['talk', 'cute'] : ['cute', 'talk']);
  }
  if (state.mood >= 25) {
    return pick(kind === 'reply' ? ['read', 'talk'] : ['lie', 'read']);
  }
  return pick(['lie', 'sleep', 'read']);
}

/** 日志/UI 用的一行摘要。 */
export function formatEmotion(state: EmotionState, presence: PetPresence): string {
  const mood = moodLabel(state.mood);
  const hunger = hungerLabel(state.hunger);
  return `mood=${state.mood}(${mood.label}) hunger=${state.hunger}(${hunger.label}) presence=${presence}`;
}
