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
  /** 播放中是否允许被“更高优先级”动画打断。默认 true。 */
  readonly interruptible?: boolean;
  /** 冷却时间（毫秒），防止同一个动画被高频重复触发。默认 0。 */
  readonly cooldown?: number;
  /** 标签，便于按标签筛选（例如 ["idle","loop"] / ["reaction","touch"]）。 */
  readonly tags?: readonly string[];
  /** 人类可读名称（未来设置界面 / 调试面板使用）。 */
  readonly label?: string;
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
}

/** 持续动画当前处于哪一段（供调试与自动化验收查询）。 */
export type PersistentPhase = 'start' | 'loop' | 'end';

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

/** 归一化后的动画定义（所有可选字段都已填好默认值）。 */
export type ResolvedAnimation = Required<
  Pick<AnimationDefinition, 'id' | 'type' | 'source' | 'loop' | 'priority' | 'interruptible' | 'cooldown' | 'kind'>
> &
  Omit<AnimationDefinition, 'loop' | 'priority' | 'interruptible' | 'cooldown' | 'kind'>;

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
  /** 播完后是否回到 fallback 动画（默认 true）。 */
  readonly returnToFallback?: boolean;
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
