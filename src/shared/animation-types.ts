/**
 * 动画领域模型（Main / Renderer / Plugin 共用）。
 *
 * 关键设计：动画信息完全不写死在 TypeScript 里，全部来自
 * `assets/config/animations.json`（Manifest）。
 * 新增动画 = 新增 WebM/PNG + 改 Manifest，核心代码零修改。
 *
 * 第一版只实现 `video`(WebM) 与 `image`(PNG) 两种类型，
 * 但 `type` 是可扩展的判别字段，未来可加入 gif / sprite / spine 等。
 */

/** 第一版支持的动画载体类型。 */
export type AnimationType = 'video' | 'image';

/**
 * 动画**用途分类**（需求 6.2 的四类）。
 *
 * 分类只描述"这条动画由谁来播"，播放机制完全一样 ——
 * 具体行为（默认动画 / 随机池 / 间隔）在 `assets/config/behavior.json` 里配置。
 *
 * - `state`   状态动画：某个显示状态下的默认循环（idle / lie / watch）
 * - `random`  随机动画：无人打扰时自己随机播
 * - `trigger` 触发动画：由某个事件触发（心情低 / 私密内容 / 没网 / 感知到工作…）
 * - `click`   点击动画：用户点击的反应，**不可打断**（必须播完才能再点）
 */
export type AnimationCategory = 'state' | 'random' | 'trigger' | 'click';

/** 合法分类清单（校验与面板共用；新增分类只改这一处 + 类型）。 */
export const ANIMATION_CATEGORIES: readonly AnimationCategory[] = ['state', 'random', 'trigger', 'click'];

/**
 * 未来扩展类型占位（当前未实现，仅用于类型层预留，避免未来破坏 API）。
 * 运行时遇到未实现类型会抛出 ANIMATION_UNSUPPORTED_TYPE 并降级到 idle。
 */
export type AnimationTypeFuture = 'gif' | 'sprite' | 'spine' | 'lottie';

/**
 * 动画定义。
 * 除 `id` / `type` / `source` 外全部可选，保证 Manifest 可以写得很短。
 */
export interface AnimationDefinition {
  /** 唯一 ID，重复注册会抛 DUPLICATE_ID。 */
  readonly id: string;
  /** 载体类型。 */
  readonly type: AnimationType;
  /** 相对 assets/ 的路径，例如 "animations/sleep.webm" 或 "idle/open.png"。 */
  readonly source: string;
  /** 是否循环播放。默认 video=false / image=true。 */
  readonly loop?: boolean;
  /** 优先级，越大越优先。默认 10。 */
  readonly priority?: number;
  /**
   * 播放中是否允许被打断。默认 true。
   *
   * ⚠️ `false` 是**硬锁**：不仅自动来源（行为 / 插件 / AI）抢不动它，
   * 连 `interrupt: 'force'` 也不行（`force` 只绕过优先级比较，不绕过这条）。
   * 点击动画（cute / fawning / stroke）用的就是它 —— 需求明确要求
   * "点击动画不可被打断，必须等待播放结束后才能继续点击"。
   */
  readonly interruptible?: boolean;
  /** 冷却时间（毫秒），防止同一个动画被高频重复触发。默认 0。 */
  readonly cooldown?: number;
  /** 标签，便于按标签筛选（例如 ["idle","loop"] / ["reaction","touch"]）。 */
  readonly tags?: readonly string[];
  /** 人类可读名称（未来设置界面 / 调试面板使用）。 */
  readonly label?: string;
  /**
   * 用途分类（状态 / 随机 / 触发 / 点击）。
   *
   * 省略时按 tags 推断（`tags` 里有 state/random/click 就用它），
   * 推断不出来算 `trigger` —— 保证旧清单不加字段也能跑。
   */
  readonly category?: AnimationCategory;
  /** 可选的逐动画表现参数（渲染层可读，核心不解释其业务含义）。 */
  readonly render?: AnimationRenderOptions;
  /** 是否为该状态机状态下的默认兜底动画（通常只有 idle 为 true）。 */
  readonly fallback?: boolean;
  /**
   * **持续动画**的分段配置。
   *
   * 写法：
   * ```jsonc
   * "segments": {
   *   "start":     "animations/read-start.webm",
   *   "loop":      "animations/read-loop.webm",
   *   "end":       "animations/read-end.webm",
   *   "loopCount": 3
   * }
   * ```
   *
   * 播放流程：
   * ```text
   * start 播一次 -> loop 重复 loopCount 次 -> end 播一次 -> 动画结束
   *                     ↑
   *               中途被打断也转去播 end
   * ```
   * 只要写了 `segments`，该动画就是持续动画（`kind: 'persistent'`）。
   */
  readonly segments?: PersistentSegments;
  /**
   * 显式指定形态。一般不用写 —— 默认规则：
   * 有 `segments` 就是 `persistent`，否则 `one-shot`。
   */
  readonly kind?: AnimationKind;
}

/** 动画形态：一次性 / 持续。由 `segments` 是否存在推导。 */
export type AnimationKind = 'one-shot' | 'persistent';

/**
 * 持续动画的三段素材（start / loop / end）。
 *
 * 各段都可以省略，语义：
 * - 没有 `start`：直接进入循环；
 * - 没有 `loop`：退化为"一次性的 start -> end"；
 * - 没有 `end`：循环次数用完或被打断时直接结束，不播收尾。
 */
export interface PersistentSegments {
  /** 开场段：播一次。相对 assets/ 的路径。 */
  readonly start?: string;
  /** 循环段：重复播放。相对 assets/ 的路径。 */
  readonly loop?: string;
  /** 收尾段：播一次。相对 assets/ 的路径。 */
  readonly end?: string;
  /**
   * 循环段播放次数，播够后自动转去播收尾段。
   *
   * - 正整数：例如 `3` = 循环 3 遍后播 end；
   * - `0` 或省略：**无限循环**，只在中途被打断时才播收尾。
   */
  readonly loopCount?: number;
  /**
   * 循环段播放**随机次数**（每次播放时在 `[min, max]` 里随机取一个整数）。
   *
   * 需求："loop 需要循环随机次" —— 固定 `loopCount` 每次看到的一模一样，
   * 随机次数让"她又开始发呆了"这件事不显得像定时器。
   *
   * 与 `loopCount` 同时存在时以本字段为准（校验会给出 warn 提醒）；
   * 省略则退化成 `loopCount`（省略 = 无限循环）的旧行为。
   */
  readonly loopCountRange?: readonly [number, number];
}

/** 持续动画当前处于哪一段（供调试与自动化验收查询）。 */
export type PersistentPhase = 'start' | 'loop' | 'end';

/**
 * 这次播放实际要循环几轮（纯函数，可单测）。
 *
 * - 配了 `loopCountRange`：在 `[min, max]` 内随机取整数（含两端）；
 * - 否则用固定 `loopCount`；
 * - `0` / 缺省 / 非法 = **无限循环**（只在中途被打断时才进收尾段）。
 *
 * @param random 注入随机源，便于验收断言"范围真的被用到了"
 */
export function resolveLoopCount(
  segments: PersistentSegments | undefined,
  random: () => number = Math.random,
): number {
  if (!segments) return 0;
  return loopCountFrom(segments.loopCountRange, segments.loopCount, random);
}

/**
 * 解析"这次要循环几轮"的共用实现（定义里的 range / 固定值 / 按次覆盖都走这里）。
 *
 * @param override `'forever'` = 无限循环；`[min,max]` = 随机；`undefined` = 用定义值
 */
export function resolvePlayLoopCount(
  segments: PersistentSegments | undefined,
  override: readonly [number, number] | 'forever' | undefined,
  random: () => number = Math.random,
): number {
  if (override === 'forever') return 0;
  if (Array.isArray(override)) {
    return loopCountFrom([override[0], override[1]], undefined, random);
  }
  return resolveLoopCount(segments, random);
}

function loopCountFrom(
  range: readonly [number, number] | undefined,
  fixed: number | undefined,
  random: () => number,
): number {
  if (range && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
    const min = Math.max(1, Math.floor(Math.min(range[0], range[1])));
    const max = Math.max(min, Math.floor(Math.max(range[0], range[1])));
    return min + Math.floor(random() * (max - min + 1));
  }
  return typeof fixed === 'number' && Number.isFinite(fixed) && fixed > 0 ? Math.floor(fixed) : 0;
}

/**
 * 动画的渲染微调。
 *
 * 素材本身已由 `tools/convert-alpha.mjs` 离线烘焙成**带 alpha 通道的 VP9 WebM**，
 * 运行时直接交给 <video> 播放即可，不需要任何逐帧像素处理。
 * 这里只保留“个别素材对位微调”的能力。
 */
export interface AnimationRenderOptions {
  /** 附加到 <video>/<img> 的 CSS 类名，便于用 CSS 调整滤镜/混合模式。 */
  readonly className?: string;
  /** 相对舞台的偏移（百分比，默认 0）。用于微调个别素材的对位。 */
  readonly offsetXPercent?: number;
  readonly offsetYPercent?: number;
}

/** 默认值集中在一处，避免各模块各写一套魔法数字。 */
export const ANIMATION_DEFAULTS = {
  priority: 10,
  interruptible: true,
  cooldown: 0,
  videoLoop: false,
  imageLoop: true,
} as const;

/** 优先级语义（仅作约定，不做强校验；Manifest 可自由使用 0-1000）。 */
export const AnimationPriority = {
  AMBIENT: 0,
  BACKGROUND: 10,
  IDLE_LIKE: 20,
  ROUTINE: 30,
  INTERACTION: 40,
  REACTION: 50,
  OVERRIDE: 70,
  CRITICAL: 100,
} as const;

/**
 * 推断动画分类（清单没写 `category` 时的兜底，兼容旧清单与插件临时注册）。
 *
 * 规则：显式合法值优先 -> tags 里 click/touch、random、state/idle -> 否则 `trigger`。
 */
export function inferAnimationCategory(entry: {
  readonly category?: unknown;
  readonly tags?: readonly string[];
}): AnimationCategory {
  if (ANIMATION_CATEGORIES.includes(entry.category as AnimationCategory)) {
    return entry.category as AnimationCategory;
  }
  const tags = entry.tags ?? [];
  if (tags.includes('click') || tags.includes('touch')) return 'click';
  if (tags.includes('random')) return 'random';
  if (tags.includes('state') || tags.includes('idle')) return 'state';
  return 'trigger';
}

/** 归一化后的动画定义（所有可选字段都已填好默认值）。 */
export type ResolvedAnimation = Required<
  Pick<AnimationDefinition, 'id' | 'type' | 'source' | 'loop' | 'priority' | 'interruptible' | 'cooldown' | 'kind' | 'category'>
> &
  Omit<AnimationDefinition, 'loop' | 'priority' | 'interruptible' | 'cooldown' | 'kind' | 'category'>;

/** play() 的选项。 */
export interface PlayOptions {
  /** 优先级覆盖。不传则使用定义中的 priority。 */
  readonly priority?: number;
  /**
   * 打断策略：
   * - `auto`（默认）：按优先级 + interruptible 规则自动裁决；
   * - `force`：强制抢占（仍然无法打断 interruptible=false 的动画）；
   * - `queue`：当前动画结束后再播放。
   */
  readonly interrupt?: InterruptPolicy;
  /** 触发原因，用于日志与调试（例如 "random-idle-action" / "ai-agent"）。 */
  readonly reason?: string;
  /** 触发来源（"user" | "behavior" | "plugin:<id>" | "ai-agent" | "system"）。 */
  readonly source?: string;
  /**
   * 是否允许"重新开始正在播的同一条动画"（默认 false）。
   *
   * ⚠️ 默认 false 是一条**硬规则**：请求正在播放的那条动画一律按
   * `same-animation` 忽略 —— **即使 `interrupt: 'force'`**。
   *
   * 为什么必须这样（实测真 bug）：三段式动画"正在 loop 时被请求"会走
   * "先播 end 再播这条请求"，于是"重复请求当前动画"就变成
   * `end -> start -> end -> start ...` 的死循环 —— 画面上就是**end 一直在循环、
   * 永远回不到 idle**（自愈链路 `playFallback()` 每次心跳都请求 idle，
   * 正好是这种重复请求）。想重播请显式传 `restart: true`（目前没有业务需要）。
   */
  readonly restart?: boolean;
  /** 播完后是否回到 fallback 动画（默认 true）。 */
  readonly returnToFallback?: boolean;
  /**
   * 覆盖定义里的 `loop`（默认不覆盖）。
   *
   * 用途：**状态的默认动画**要把一条一次性素材循环起来。例如 `lie`（趴下）
   * 在"下方收起"状态下是默认姿势，需要一直循环；而它同时又在正常状态的
   * 随机池里，那时只该播一遍。用定义区分就得复制两个 id，
   * 用播放参数区分则一条素材两种用法都成立。
   */
  readonly loop?: boolean;
  /**
   * 覆盖这次播放的"循环几轮"（只对**三段式**动画有意义）。
   *
   * 为什么需要按次覆盖：同一个三段式动画在不同场合要的持续时间完全不同 ——
   *   - 它作为**状态的默认动画**时（收起的 watch / lie）要 `'forever'`：一直保持姿势，
   *     只在离开这个状态时才播 end；
   *   - 它作为**随机池成员**时（正常状态的 lie）只该播一两轮就自己爬起来；
   *   - 它被**触发**时（"主人不在呀"演一次 lie）用定义里的默认轮数。
   * 定义里只能写一个值，所以把"这次循环几轮"交给播放参数决定。
   */
  readonly loopCountRange?: readonly [number, number] | 'forever';
  /**
   * 是否忽略该动画的 `cooldown`（默认 false）。
   *
   * **只给"用户显式手动播放"用**（托盘 / 右键菜单的「播放动画（测试）」）：
   * 冷却的本意是防止插件 / 行为 / AI 等自动化来源高频刷同一个动画，
   * 而不是吞掉用户的主动点击。例如 bomb 的 cooldown 是 300000ms，
   * 被冷却挡住时用户点第二次完全没反应，看起来就是"这个动画只能播一次"。
   *
   * 自动化来源必须保持默认 false，否则防刷屏形同虚设。
   */
  readonly bypassCooldown?: boolean;
}

export type InterruptPolicy = 'auto' | 'force' | 'queue';

/** 播放请求被拒绝的原因（用于日志与事件负载，不抛异常给调用方）。 */
export type PlayRejectionReason =
  | 'not-registered'
  | 'unsupported-type'
  | 'cooldown'
  | 'lower-priority'
  | 'equal-priority'
  | 'not-interruptible'
  | 'same-animation'
  /** 桌宠处于"收起（贴边）"状态：只允许它自己的默认姿势，其它自动来源一律拒绝。 */
  | 'docked'
  | 'load-failed';

/** 播放请求的裁决结果。 */
export interface PlayResult {
  readonly accepted: boolean;
  readonly animationId: string;
  readonly reason?: PlayRejectionReason;
  /** 如果请求被接受但需要排队，则为 true。 */
  readonly queued?: boolean;
}

/** Manifest 文件结构：{ "coffee": { ...definition } }。 */
export type AnimationManifest = Readonly<Record<string, AnimationManifestEntry>>;

/** Manifest 中的单条记录：允许省略 id（用 key 作为 id）。 */
export type AnimationManifestEntry = Omit<AnimationDefinition, 'id'> & { readonly id?: string };
