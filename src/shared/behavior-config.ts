/**
 * 显示状态与随机动画池（`assets/config/behavior.json`）。
 *
 * 为什么单独一份配置：动画清单（animations.json）只回答"这条动画怎么播"，
 * 而"**在什么状态下、多久、从哪些动画里随机挑一个自己播**"是行为策略 ——
 * 需求明确要求"动画需要保证可扩展性，后续可能增加其它动画"，
 * 因此状态、池、间隔全部放在数据里，新增动画只需要改 JSON：
 *
 * ```jsonc
 * {
 *   "states": {
 *     "normal": { "defaultAnimation": "idle", "pools": ["normal-random"] },
 *     "docked-bottom": {
 *       "defaultAnimation": "sleep",
 *       "pools": [],
 *       "fidget": { "animations": ["lie"], "intervalMs": [180000, 480000] }
 *     },
 *     ...
 *   },
 *   "pools": {
 *     "normal-random": { "animations": ["roll", "hot", ...], "intervalMs": [25000, 60000] }
 *   },
 *   "sadPool": { "enabled": true, "moodBelow": 25, "animation": "sad" }
 * }
 * ```
 *
 * 纯函数 + 纯数据，Renderer 与验收脚本共用同一套规则（不做任何 DOM / IPC 访问）。
 */

import type { AnimationCategory } from './animation-types';

/* -------------------------------------------------------------------------- */
/* 一、显示状态                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 显示状态 id。
 *
 * - `normal`        正常：站在桌面上，兜底动画是 idle
 * - `docked-bottom` 下方收起：贴屏幕下边缘，兜底躺下睡觉（sleep）
 * - `docked-right`  右侧收起：贴屏幕右边缘，兜底偷看（watch）
 * - `hidden`        隐藏：完全不显示
 *
 * 新增状态（例如"贴左边缘"）只需要：这里加一个 id + behavior.json 里加一条。
 */
export type DisplayStateId = 'normal' | 'docked-bottom' | 'docked-right' | 'hidden';

export const DISPLAY_STATE_IDS: readonly DisplayStateId[] = [
  'normal',
  'docked-bottom',
  'docked-right',
  'hidden',
];

/** 贴边的方向（`free` = 没贴边）。 */
export type PetDock = 'free' | 'bottom' | 'right';

/** 主进程 -> 渲染层的显示状态广播。 */
export interface PetDisplayState {
  readonly dock: PetDock;
  readonly hidden: boolean;
}

/** 把（贴边方向 + 是否隐藏）收敛成一个显示状态 id。 */
export function resolveDisplayState(input: PetDisplayState): DisplayStateId {
  if (input.hidden) return 'hidden';
  if (input.dock === 'bottom') return 'docked-bottom';
  if (input.dock === 'right') return 'docked-right';
  return 'normal';
}

export const DEFAULT_DISPLAY_STATE: PetDisplayState = { dock: 'free', hidden: false };

/**
 * 收起（贴边）或隐藏 = **安静模式**：她不开口说话。
 *
 * 用户要求原文："收起时不应该发生对话"。
 * 为什么当成一条**纯函数**而不是散在几处 if 里：
 *   - 收起/隐藏这两个状态是"别打扰我"的意思，判定只有一处才不会漏
 *     （感知干预、AI 主动搭话、日记提醒、聊天回复的气泡都要问它）；
 *   - 验收能逐条钉死（`dock: free` 才允许开口，其余三种一律安静）。
 *
 * ⚠️ 注意这与"能不能被点击"无关：收起时点她仍然照常展开（那是用户主动的动作）。
 * 安静模式管的是**她主动出声**。
 */
export function isQuietDisplay(display: PetDisplayState): boolean {
  return display.hidden || display.dock !== 'free';
}

/* -------------------------------------------------------------------------- */
/* 二、配置结构                                                                */
/* -------------------------------------------------------------------------- */

/** 一个随机动画池：到点了就从 `animations` 里随机挑一个播。 */
export interface BehaviorPool {
  readonly id: string;
  /** 池里的动画 id（不存在的会被丢弃并记 issue）。 */
  readonly animations: readonly string[];
  /** 触发间隔（毫秒），实际间隔在 [min, max] 之间随机。 */
  readonly intervalMs: readonly [number, number];
  /** 首次延迟（毫秒）。省略 = 用 intervalMs 的下限。 */
  readonly initialDelayMs?: number;
  /** 触发后的全局冷却（毫秒）：这段时间内不让别的池也触发。 */
  readonly cooldownMs?: number;
  /** 权重（同池内挑动画时用；省略 = 等概率）。预留给"某个动作更常见"。 */
  readonly weights?: Readonly<Record<string, number>>;
  /** 是否只在"没有交互 / 没在播音视频"时触发。默认 true。 */
  readonly onlyWhenIdle?: boolean;
  /**
   * **这个池**里的三段式动画每次播几轮（一/两轮就收尾）。
   *
   * 为什么池要管这件事：同一条三段式动画在别处可能有完全不同的用法 ——
   * `sleep` 是"下方收起"的默认姿势，要**永远循环**（渲染层 `playDisplayDefault()`
   * 传 `loopCountRange: 'forever'` 覆盖）；而同一条 `lie` 作为"下方收起时的随机小动作"
   * 只该趴一两轮就自己爬起来（见 `FidgetConfig.loopCountRange`）。
   * 定义里写不下两种意图，所以由**播放参数**决定（见 `PlayOptions.loopCountRange`）。
   * 一次性动画忽略这个字段。
   */
  readonly persistentLoopCountRange?: readonly [number, number];
  /** 人类可读名称（托盘 / 调试面板）。 */
  readonly label?: string;
}

/**
 * 一个显示状态的**随机小动作**（fidget）。
 *
 * 与"随机池"是两种不同的东西，别混：
 * - **随机池**：在她**空闲**（没有动画在播）时挑一条自己播，播完回默认；
 * - **随机小动作**：在**默认姿势正在循环**的过程中，随机挑一个时刻打断它 ——
 *   先让它把收尾段播完（三段式语义），再播 N 轮小动作，然后**回到同一个默认姿势**。
 *
 * 为什么单独一套而不是继续用池：池的 `onlyWhenIdle` 要求 `IDLE` 状态，
 * 而收起时的默认姿势 `sleep` 会把状态机置成 `SLEEPING`（`watch` 则是 `PLAYING`），
 * 用池去表达就会变成"要靠状态机巧合"的隐式规则。这里的门槛写得明明白白：
 * **当前播的就是这个状态的默认动画、且已经在 loop 段**。
 *
 * 现状映射（需求）：`lie` 在 `sleep` 过程中触发、`peek` 只在 `watch` 阶段触发。
 */
export interface FidgetConfig {
  /** 可挑的小动作 id（不存在的会被丢弃并记 issue）。 */
  readonly animations: readonly string[];
  /** 触发间隔（毫秒）：进入默认姿势的 loop 段后，在 [min, max] 之间随机一个时刻触发。 */
  readonly intervalMs: readonly [number, number];
  /**
   * 这次小动作播几轮（三段式动画）。
   * 省略 = 用动画定义里的 `segments.loopCountRange`。
   */
  readonly loopCountRange?: readonly [number, number];
}

/** 一个显示状态的默认动画与随机池。 */
export interface DisplayStateDefinition {
  readonly id: DisplayStateId;
  /** 该状态下的兜底（默认）动画；`null` = 不播任何动画（隐藏）。 */
  readonly defaultAnimation: string | null;
  /** 参与该状态的随机池 id。 */
  readonly pools: readonly string[];
  /** 该状态默认姿势里的随机小动作（省略 = 没有）。 */
  readonly fidget?: FidgetConfig;
  readonly label?: string;
}

/**
 * 心情过低时"随机池一律换成同一条动画"的规则（需求原文：
 * "在心情低于阈值的时候，所有随机池的动画都变成 sad，高于阈值再变回来，
 * 收起状态的动画不受影响"）。
 *
 * 三个关键语义，都在这里说清楚，免得以后被"顺手扩大"：
 *  1. 只管**随机池**（`pools`）—— 池里挑出来的那条会被换成 `animation`；
 *     间隔、冷却、`onlyWhenIdle` 全部照旧，所以"多久自己动一次"没有变化；
 *  2. **不碰"随机小动作"**（`fidget`）与**默认姿势**（`defaultAnimation`）——
 *     收起状态的 `sleep` / `watch` 以及 `lie` / `peek` 完全不受影响
 *     （收起状态本来也没有池，这条规则对它是空操作）；
 *  3. 阈值只有**一个**：`心情 <= moodBelow` 就换，`> moodBelow` 立刻换回来
 *     （不做迟滞）。池本身 25~60 秒才触发一次，来回抖动没有实际影响。
 */
export interface SadPoolConfig {
  /** 关掉就完全按原池随机。 */
  readonly enabled: boolean;
  /** 心情 `<=` 这个值走 sad；`>` 就恢复原池。 */
  readonly moodBelow: number;
  /** 全池替换成哪一条动画（清单里不存在时这条规则自动失效并记日志）。 */
  readonly animation: string;
}

export interface BehaviorConfig {
  /** 配置版本，便于以后迁移。 */
  readonly version: number;
  readonly states: Readonly<Record<DisplayStateId, DisplayStateDefinition>>;
  readonly pools: Readonly<Record<string, BehaviorPool>>;
  /** 心情过低时把随机池换掉（省略 = 不启用）。 */
  readonly sadPool?: SadPoolConfig;
}

/* -------------------------------------------------------------------------- */
/* 三、默认值（与需求 6.2 一一对应）                                            */
/* -------------------------------------------------------------------------- */

/**
 * 需求给定的间隔：正常状态活跃，收起状态"随机小动作只有一个、时间明显更长"。
 * 收起用 3–8 分钟，是正常状态（25–60 秒）的 5~10 倍。
 */
export const NORMAL_RANDOM_INTERVAL_MS: readonly [number, number] = [25_000, 60_000];
/** 收起时"随机小动作"的间隔（3–8 分钟）。 */
export const DOCKED_FIDGET_INTERVAL_MS: readonly [number, number] = [180_000, 480_000];

/**
 * 「心情过低 -> 随机池全变 sad」的默认阈值。
 *
 * 与 `pet-triggers.ts` 的 `SAD_MOOD_THRESHOLD` 取同一个数（25，即 `moodLabel()`
 * 里"很难过"那一档），两处不一致会出现"UI 说她很难过、随机动作却还在打滚"。
 */
export const SAD_POOL_MOOD_BELOW = 25;

/** 心情过低时全池替换成哪一条动画。 */
export const SAD_POOL_ANIMATION = 'sad';

/** 随机池的默认配置（behavior.json 缺失/损坏时的兜底）。 */
export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  version: 1,
  states: {
    normal: { id: 'normal', defaultAnimation: 'idle', pools: ['normal-random'], label: '正常' },
    /*
     * 收起状态**没有随机池**：她安静地维持默认姿势（sleep / watch），
     * 只在默认姿势里按 `fidget` 随机插一小段（lie / peek），播完回到默认。
     */
    'docked-bottom': {
      id: 'docked-bottom',
      defaultAnimation: 'sleep',
      pools: [],
      fidget: { animations: ['lie'], intervalMs: DOCKED_FIDGET_INTERVAL_MS, loopCountRange: [1, 3] },
      label: '下方收起',
    },
    'docked-right': {
      id: 'docked-right',
      defaultAnimation: 'watch',
      pools: [],
      fidget: { animations: ['peek'], intervalMs: DOCKED_FIDGET_INTERVAL_MS, loopCountRange: [1, 2] },
      label: '右侧收起',
    },
    hidden: { id: 'hidden', defaultAnimation: null, pools: [], label: '隐藏' },
  },
  pools: {
    'normal-random': {
      id: 'normal-random',
      // 注意 `lie` **不在**这里：它现在只由"下方收起时的随机小动作"触发
      animations: ['roll', 'hot', 'bomb', 'play', 'play_tail', 'shake', 'sing', 'spin', 'swim'],
      intervalMs: NORMAL_RANDOM_INTERVAL_MS,
      initialDelayMs: 15_000,
      cooldownMs: 8_000,
      persistentLoopCountRange: [1, 2],
      onlyWhenIdle: true,
      label: '随机小动作',
    },
  },
  // 心情 <= 25（"很难过"那一档）时，上面池子里挑出来的那条一律换成 sad
  sadPool: { enabled: true, moodBelow: SAD_POOL_MOOD_BELOW, animation: SAD_POOL_ANIMATION },
};

/* -------------------------------------------------------------------------- */
/* 四、校验 / 归一化                                                           */
/* -------------------------------------------------------------------------- */

export interface BehaviorConfigIssue {
  readonly level: 'warn' | 'error';
  readonly message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 归一化 `[min, max]`：顺序写反自动纠正，非法值退回默认。 */
function interval(value: unknown, fallback: readonly [number, number]): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const a = value[0];
  const b = value[1];
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    return fallback;
  }
  const min = num(Math.min(a, b), fallback[0], 1_000, 24 * 3600_000);
  const max = num(Math.max(a, b), fallback[1], min, 24 * 3600_000);
  return [min, max];
}

/** 归一化单个池。 */
function normalizePool(id: string, raw: unknown, issues: BehaviorConfigIssue[]): BehaviorPool | null {
  if (!isPlainObject(raw)) {
    issues.push({ level: 'error', message: `池 "${id}" 必须是对象，已忽略` });
    return null;
  }
  const animations = Array.isArray(raw.animations)
    ? raw.animations.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  if (animations.length === 0) {
    issues.push({ level: 'warn', message: `池 "${id}" 没有可用的动画 id，已忽略` });
    return null;
  }
  const intervalMs = interval(raw.intervalMs, NORMAL_RANDOM_INTERVAL_MS);
  const initialDelayMs = typeof raw.initialDelayMs === 'number' && Number.isFinite(raw.initialDelayMs)
    ? Math.max(0, Math.round(raw.initialDelayMs))
    : intervalMs[0];
  const weightsRaw = isPlainObject(raw.weights) ? raw.weights : null;
  const weights: Record<string, number> = {};
  if (weightsRaw) {
    for (const [key, value] of Object.entries(weightsRaw)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) weights[key] = value;
    }
  }

  return {
    id,
    animations,
    intervalMs,
    initialDelayMs,
    cooldownMs: num(raw.cooldownMs, 0, 0, 3600_000),
    // 池里的三段式成员默认"播一两轮"就收尾（不写 = 沿用定义里的轮数）
    // 注意同样是**轮数**，用 countRange 而不是 interval（后者下限是 1000 毫秒）
    persistentLoopCountRange: countRange(raw.persistentLoopCountRange, [1, 2]),
    ...(Object.keys(weights).length > 0 ? { weights } : {}),
    onlyWhenIdle: raw.onlyWhenIdle !== false,
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
  };
}

/** 归一化一个状态的"随机小动作"。@returns null = 没配置 / 配置不可用 */
function normalizeFidget(raw: unknown, state: DisplayStateId, issues: BehaviorConfigIssue[]): FidgetConfig | null {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) {
    issues.push({ level: 'warn', message: `状态 "${state}" 的 fidget 必须是对象，已忽略` });
    return null;
  }
  const animations = Array.isArray(raw.animations)
    ? raw.animations.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  if (animations.length === 0) {
    issues.push({ level: 'warn', message: `状态 "${state}" 的 fidget 没有动画 id，已忽略` });
    return null;
  }
  return {
    animations,
    intervalMs: interval(raw.intervalMs, DOCKED_FIDGET_INTERVAL_MS),
    /*
     * ⚠️ 这里必须用**轮数**的夹取（1~20），不能复用 `interval()` ——
     * 那个函数的下限是 1000（它是给毫秒用的），会让 `[1,3]` 变成 `[1000,1000]`：
     * 小动作一次要循环 1000 轮（`lie` 每轮 5 秒 ≈ 85 分钟），
     * 画面上就是"她趴下去起不来了"。实测被 `tools/diag-anim-system.cjs` 抓到。
     */
    ...(Array.isArray(raw.loopCountRange)
      ? { loopCountRange: countRange(raw.loopCountRange, [1, 2]) }
      : {}),
  };
}

/** 归一化"循环几轮"：下限 1、上限 20（与毫秒区间区分开）。 */
function countRange(value: unknown, fallback: readonly [number, number]): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const a = value[0];
  const b = value[1];
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    return fallback;
  }
  const min = num(Math.min(a, b), fallback[0], 1, 20);
  const max = num(Math.max(a, b), fallback[1], min, 20);
  return [min, max];
}

/**
 * 归一化"心情过低换池"规则。
 *
 * 缺省 = 用内置默认；显式 `enabled: false` = 关掉（返回 undefined，表示"没有这条规则"）。
 * `animation` 是空的就当没配（宁可退回默认，也不要让池子里出现一条空 id）。
 */
function normalizeSadPool(raw: unknown, issues: BehaviorConfigIssue[]): SadPoolConfig | undefined {
  const fallback = DEFAULT_BEHAVIOR_CONFIG.sadPool;
  if (raw === undefined) return fallback;
  if (raw === null) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({ level: 'warn', message: 'sadPool 必须是对象，已忽略' });
    return fallback;
  }
  if (raw.enabled === false) return undefined;
  /*
   * `animation` 缺失（没写这个键）= 用内置默认 `sad`；
   * 写了但**是空的**（`""` / 非字符串）= 配置写错了 —— 这时宁可整条规则不生效，
   * 也不要"猜一个"：猜错会让她在难过时演一条用户根本没指定的动画。
   */
  let animation: string;
  if (raw.animation === undefined) {
    if (!fallback?.animation) return undefined;
    animation = fallback.animation;
  } else if (typeof raw.animation === 'string' && raw.animation.trim() !== '') {
    animation = raw.animation.trim();
  } else {
    issues.push({ level: 'warn', message: 'sadPool.animation 不是非空字符串，该规则已忽略' });
    return undefined;
  }
  return {
    enabled: true,
    moodBelow: num(raw.moodBelow, fallback?.moodBelow ?? SAD_POOL_MOOD_BELOW, 0, 100),
    animation,
  };
}

/**
 * 解析 `behavior.json`。
 *
 * 永不抛异常（坏配置退回默认值）：这份配置缺失时桌宠仍然要能跑，
 * 只是退回内置默认（与需求给定的池/间隔完全一致）。
 */
export function parseBehaviorConfig(raw: unknown): { config: BehaviorConfig; issues: BehaviorConfigIssue[] } {
  const issues: BehaviorConfigIssue[] = [];
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null) {
      issues.push({ level: 'error', message: 'behavior.json 顶层必须是对象，已使用默认配置' });
    }
    return { config: DEFAULT_BEHAVIOR_CONFIG, issues };
  }

  const poolsRaw = isPlainObject(raw.pools) ? raw.pools : {};
  const pools: Record<string, BehaviorPool> = {};
  for (const [id, value] of Object.entries(poolsRaw)) {
    const pool = normalizePool(id, value, issues);
    if (pool) pools[id] = pool;
  }

  const statesRaw = isPlainObject(raw.states) ? raw.states : {};
  const states = {} as Record<DisplayStateId, DisplayStateDefinition>;
  for (const id of DISPLAY_STATE_IDS) {
    const fallback = DEFAULT_BEHAVIOR_CONFIG.states[id];
    const entry = isPlainObject(statesRaw[id]) ? statesRaw[id] : null;
    if (!entry) {
      states[id] = fallback;
      continue;
    }
    const defaultAnimation = typeof entry.defaultAnimation === 'string' && entry.defaultAnimation.trim() !== ''
      ? entry.defaultAnimation.trim()
      : entry.defaultAnimation === null
        ? null
        : fallback.defaultAnimation;
    const poolIds = Array.isArray(entry.pools)
      ? entry.pools.filter((item): item is string => typeof item === 'string')
      : fallback.pools;
    for (const poolId of poolIds) {
      if (!(poolId in pools)) {
        issues.push({ level: 'warn', message: `状态 "${id}" 引用了不存在的池 "${poolId}"` });
      }
    }
    const fidget = normalizeFidget(entry.fidget, id, issues);
    states[id] = {
      id,
      defaultAnimation,
      pools: poolIds.filter((poolId) => poolId in pools),
      ...(fidget ? { fidget } : {}),
      ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
    };
  }

  const sadPool = normalizeSadPool(raw.sadPool, issues);

  // 没有配置任何池时退回默认，避免"随机动画全没了"这种静默失败
  if (Object.keys(pools).length === 0) {
    issues.push({ level: 'warn', message: 'behavior.json 里没有任何有效池，已使用默认池' });
    return {
      config: {
        version: 1,
        states,
        pools: DEFAULT_BEHAVIOR_CONFIG.pools,
        ...(sadPool ? { sadPool } : {}),
      },
      issues,
    };
  }

  return {
    config: {
      version: num(raw.version, 1, 1, 1000),
      states,
      pools,
      ...(sadPool ? { sadPool } : {}),
    },
    issues,
  };
}

/* -------------------------------------------------------------------------- */
/* 五、查询辅助                                                                */
/* -------------------------------------------------------------------------- */

/** 某个状态下的兜底动画 id（没有 = null，表示该状态不播动画）。 */
export function defaultAnimationFor(config: BehaviorConfig, state: DisplayStateId): string | null {
  return config.states[state]?.defaultAnimation ?? null;
}

/** 某个状态下启用（且引用存在）的池。 */
export function poolsFor(config: BehaviorConfig, state: DisplayStateId): readonly BehaviorPool[] {
  const ids = config.states[state]?.pools ?? [];
  return ids.map((id) => config.pools[id]).filter((pool): pool is BehaviorPool => pool !== undefined);
}

/** 某个状态的"随机小动作"配置（没有 = null）。 */
export function fidgetFor(config: BehaviorConfig, state: DisplayStateId): FidgetConfig | null {
  return config.states[state]?.fidget ?? null;
}

/** 小动作列表里，哪些 id 在"清单里真的存在"（丢弃不存在的，返回可播的）。 */
export function availableFidgetAnimations(
  fidget: FidgetConfig,
  known: ReadonlySet<string>,
): readonly string[] {
  return fidget.animations.filter((id) => known.has(id));
}

/**
 * 从池里随机挑一个动画（按 `weights` 加权，缺省等概率）。
 *
 * @param random 注入随机源，便于验收断言分布/边界
 */
export function pickPoolAnimation(pool: BehaviorPool, random: () => number = Math.random): string | null {
  if (pool.animations.length === 0) return null;
  const weights = pool.weights;
  if (!weights) {
    const index = Math.min(pool.animations.length - 1, Math.floor(random() * pool.animations.length));
    return pool.animations[index] ?? null;
  }
  const entries = pool.animations.map((id) => [id, weights[id] ?? 1] as const);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) return pool.animations[0] ?? null;
  let threshold = random() * total;
  for (const [id, weight] of entries) {
    threshold -= weight;
    if (threshold <= 0) return id;
  }
  return entries[entries.length - 1]?.[0] ?? null;
}

/** 池的动画列表里，哪些 id 在"清单里真的存在"（丢弃不存在的，返回可播的）。 */
export function availablePoolAnimations(
  pool: BehaviorPool,
  known: ReadonlySet<string>,
): readonly string[] {
  return pool.animations.filter((id) => known.has(id));
}

/**
 * 心情过低时随机池该换成哪一条动画（不需要换 = null）。
 *
 * 纯函数：只回答"规则是否命中"，不关心池子里有什么、也不碰 fidget。
 * 判定是**单一阈值**（`心情 <= moodBelow`）——需求原文就是"低于阈值……高于阈值再变回来"。
 */
export function sadPoolAnimation(config: BehaviorConfig, mood: number): string | null {
  const rule = config.sadPool;
  if (!rule || !rule.enabled) return null;
  if (typeof mood !== 'number' || !Number.isFinite(mood)) return null;
  return mood <= rule.moodBelow ? rule.animation : null;
}

/** 分类 -> 说明（托盘 / 设置面板展示用）。 */
export const ANIMATION_CATEGORY_LABELS: Readonly<Record<AnimationCategory, string>> = {
  state: '状态动画',
  random: '随机动画',
  trigger: '触发动画',
  click: '点击动画',
};