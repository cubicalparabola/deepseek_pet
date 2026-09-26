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
 *     "docked-bottom": { "defaultAnimation": "sleep", "pools": ["docked-bottom-random"] },
 *     ...
 *   },
 *   "pools": {
 *     "normal-random": { "animations": ["roll", "hot", ...], "intervalMs": [25000, 60000] }
 *   }
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
   * 池里的**三段式**动画每次播几轮（一/两轮就收尾）。
   *
   * 为什么池要管这件事：同一个三段式动画在别处可能有别的用法 ——
   * `sleep` 作为"下方收起"的默认姿势要永远循环，而 `lie` 作为随机动画
   * 只该趴一会儿就自己爬起来。定义里写不下两种意图，所以由**播放参数**决定
   * （见 `PlayOptions.loopCountRange`）。一次性动画忽略这个字段。
   */
  readonly persistentLoopCountRange?: readonly [number, number];
  /** 人类可读名称（托盘 / 调试面板）。 */
  readonly label?: string;
}

/** 一个显示状态的默认动画与随机池。 */
export interface DisplayStateDefinition {
  readonly id: DisplayStateId;
  /** 该状态下的兜底（默认）动画；`null` = 不播任何动画（隐藏）。 */
  readonly defaultAnimation: string | null;
  /** 参与该状态的随机池 id。 */
  readonly pools: readonly string[];
  readonly label?: string;
}

export interface BehaviorConfig {
  /** 配置版本，便于以后迁移。 */
  readonly version: number;
  readonly states: Readonly<Record<DisplayStateId, DisplayStateDefinition>>;
  readonly pools: Readonly<Record<string, BehaviorPool>>;
}

/* -------------------------------------------------------------------------- */
/* 三、默认值（与需求 6.2 一一对应）                                            */
/* -------------------------------------------------------------------------- */

/**
 * 需求给定的间隔：正常状态活跃，收起状态"随机动画只有一个、时间明显更长"。
 * 收起用 3–8 分钟，是正常状态（25–60 秒）的 5~10 倍。
 */
export const NORMAL_RANDOM_INTERVAL_MS: readonly [number, number] = [25_000, 60_000];
export const DOCKED_RANDOM_INTERVAL_MS: readonly [number, number] = [180_000, 480_000];

/** 随机池的默认配置（behavior.json 缺失/损坏时的兜底）。 */
export const DEFAULT_BEHAVIOR_CONFIG: BehaviorConfig = {
  version: 1,
  states: {
    normal: { id: 'normal', defaultAnimation: 'idle', pools: ['normal-random'], label: '正常' },
    // 下方收起的默认姿势是 sleep（躺下睡觉），随机动画是 lie（趴一会儿）
    'docked-bottom': { id: 'docked-bottom', defaultAnimation: 'sleep', pools: ['docked-bottom-random'], label: '下方收起' },
    'docked-right': { id: 'docked-right', defaultAnimation: 'watch', pools: ['docked-right-random'], label: '右侧收起' },
    hidden: { id: 'hidden', defaultAnimation: null, pools: [], label: '隐藏' },
  },
  pools: {
    'normal-random': {
      id: 'normal-random',
      animations: ['roll', 'hot', 'bomb', 'lie', 'play', 'shake', 'sing', 'spin', 'swim'],
      intervalMs: NORMAL_RANDOM_INTERVAL_MS,
      initialDelayMs: 15_000,
      cooldownMs: 8_000,
      // 池里的 lie 是三段式：趴下一两轮就自己爬起来（不是像收起时那样一直趴着）
      persistentLoopCountRange: [1, 2],
      onlyWhenIdle: true,
      label: '随机小动作',
    },
    'docked-bottom-random': {
      id: 'docked-bottom-random',
      // 下方收起的随机动画是 **lie**（与默认姿势 sleep 对调）
      animations: ['lie'],
      intervalMs: DOCKED_RANDOM_INTERVAL_MS,
      initialDelayMs: 60_000,
      cooldownMs: 30_000,
      persistentLoopCountRange: [1, 2],
      onlyWhenIdle: true,
      label: '收起时趴一会儿',
    },
    'docked-right-random': {
      id: 'docked-right-random',
      animations: ['peek'],
      intervalMs: DOCKED_RANDOM_INTERVAL_MS,
      initialDelayMs: 60_000,
      cooldownMs: 30_000,
      onlyWhenIdle: true,
      label: '收起时偷看',
    },
  },
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
    persistentLoopCountRange: interval(raw.persistentLoopCountRange, [1, 2]),
    ...(Object.keys(weights).length > 0 ? { weights } : {}),
    onlyWhenIdle: raw.onlyWhenIdle !== false,
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
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
    states[id] = {
      id,
      defaultAnimation,
      pools: poolIds.filter((poolId) => poolId in pools),
      ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
    };
  }

  // 没有配置任何池时退回默认，避免"随机动画全没了"这种静默失败
  if (Object.keys(pools).length === 0) {
    issues.push({ level: 'warn', message: 'behavior.json 里没有任何有效池，已使用默认池' });
    return { config: { version: 1, states, pools: DEFAULT_BEHAVIOR_CONFIG.pools }, issues };
  }

  return { config: { version: num(raw.version, 1, 1, 1000), states, pools }, issues };
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

/** 分类 -> 说明（托盘 / 设置面板展示用）。 */
export const ANIMATION_CATEGORY_LABELS: Readonly<Record<AnimationCategory, string>> = {
  state: '状态动画',
  random: '随机动画',
  trigger: '触发动画',
  click: '点击动画',
};