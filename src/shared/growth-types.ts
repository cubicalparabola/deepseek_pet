/**
 * 成长、记忆与反思系统（4.1 / 4.2）的跨进程契约。
 *
 * 两条需求：
 * - **4.1 长期记忆可视化**："🧠 宠物记忆宫殿" —— 把重要经历沉淀成**独立记忆节点**，
 *   按时间轴组织，让用户直观看到"原来我们已经一起经历了这么多"；
 * - **4.2 AI 自我反思**：每天回顾自己的行为与用户反馈，并把结论落成**行为策略调整**
 *   （Interaction -> Memory -> Reflection -> Behavior Update）。
 *
 * 三条设计底线：
 * 1. **只记值得记的**：节点有明确种类（第一次见面/里程碑/生日/熬夜/项目…），
 *    不做"什么都往时间轴上塞"的流水账 —— 那就不是记忆宫殿，而是日志。
 * 2. **反思只能让她更克制**：策略调整的乘数被封在 [0.25, 1]，
 *    即"最多把打扰频率降到四分之一"，**永远不能超过用户自己设的上限**。
 *    一个会自己变得更烦人的桌宠是不可接受的（也解释了为什么这里的 API 是单向收紧的）。
 * 3. **可审计、可回退**：每次策略调整都写在 `reflection/policy-log.md` 里，
 *    界面上有"重置策略"一键回到用户原始设置。
 */

/* -------------------------------------------------------------------------- */
/* 一、开关（默认全开，与 2.x / 3.x 一致）                                        */
/* -------------------------------------------------------------------------- */

export interface GrowthSettings {
  /** 4.1 记忆宫殿：把重要经历沉淀成节点（不做自动整理时，已有节点仍然保留）。 */
  readonly palace: boolean;
  /** 4.2 每天做一次自我反思。 */
  readonly reflection: boolean;
  /**
   * 4.2 允许反思结果**调整行为策略**（关掉 = 只写反思、不动行为）。
   *
   * 单独一个开关的意义：有人接受"她写点感想"，但不接受"她偷偷改自己的行为"。
   */
  readonly policyAdapt: boolean;
  /** 自动反思时刻（0~23，默认 23 点，晚于日记的 22 点：先写日记再反思）。 */
  readonly reflectionHour: number;
  /** 首次见面节点的日期（ISO）—— 用户第一次装上她那天，可手动改。 */
  readonly firstMeetAt: string;
  /** 反思保留天数（默认 180 天，之后归档进 palace 不再进 prompt）。 */
  readonly keepReflectionDays: number;
  /**
   * 记忆宫殿的**压缩阈值（月）**：比它更早、且**同种类同标题**的多个节点会被折成一条
   * （标题不变、detail 写上"共 N 次 + 日期列表"、hits 累加），原始节点进
   * `memory/archive/palace-<年>.json` 留档。**0 = 不压缩**（默认 6 个月）。
   *
   * 为什么需要：时间轴只会越拉越长（每次熬夜/每个项目都是一条）。
   * 压缩只动"同一种反复发生的事"，且钉住的一律不动 —— 记忆被折起来，但没有被丢掉。
   */
  readonly palaceCompressMonths: number;
}

export const DEFAULT_GROWTH_SETTINGS: GrowthSettings = {
  palace: true,
  reflection: true,
  policyAdapt: true,
  reflectionHour: 23,
  firstMeetAt: '',
  keepReflectionDays: 180,
  palaceCompressMonths: 6,
};

export interface GrowthSettingsPatch {
  readonly palace?: boolean;
  readonly reflection?: boolean;
  readonly policyAdapt?: boolean;
  readonly reflectionHour?: number;
  readonly firstMeetAt?: string;
  readonly keepReflectionDays?: number;
  readonly palaceCompressMonths?: number;
}

/* -------------------------------------------------------------------------- */
/* 二、4.1 记忆节点（记忆宫殿）                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 记忆节点的种类。
 *
 * 每一种都对应需求里给的例子，并配一个 emoji —— 时间轴上靠它一眼分辨类型。
 */
export type MemoryNodeKind =
  | 'first-meet' // 📅 我们第一次见面
  | 'milestone'  // 🎓 重要里程碑（开始研究 AI、第一次完成大型项目）
  | 'birthday'   // 🎂 一起度过生日
  | 'late-night' // 📚 一起熬夜赶论文
  | 'project'    // 💻 一起做过的项目
  | 'habit'      // 🔁 养成的习惯（作息/常用工具）
  | 'emotion'    // 💗 情绪时刻
  | 'trip'       // ✈️ 出门/离开一段时间
  | 'manual';    // ✍️ 用户手动记下的一笔

/** 节点种类 -> emoji 与中文标签。 */
export const NODE_KINDS: Readonly<Record<MemoryNodeKind, { emoji: string; label: string }>> = {
  'first-meet': { emoji: '📅', label: '我们第一次见面' },
  milestone: { emoji: '🎓', label: '里程碑' },
  birthday: { emoji: '🎂', label: '生日' },
  'late-night': { emoji: '📚', label: '熬夜' },
  project: { emoji: '💻', label: '一起做的事' },
  habit: { emoji: '🔁', label: '养成的习惯' },
  emotion: { emoji: '💗', label: '情绪时刻' },
  trip: { emoji: '✈️', label: '离开与回来' },
  manual: { emoji: '✍️', label: '手记' },
};

/** 一个记忆节点（时间轴上的一段重要经历）。 */
export interface MemoryNode {
  readonly id: string;
  readonly kind: MemoryNodeKind;
  /** 短标题（时间轴上的主文案），例如"开始研究 AI"。 */
  readonly title: string;
  /** 一两句细节（她自己的口吻）。 */
  readonly detail: string;
  /** 发生时间（ISO）。 */
  readonly at: string;
  readonly source: 'auto' | 'llm' | 'manual';
  /** 支撑这个节点的原始证据（对话片段/事件），便于用户核查"她凭什么记这个"。 */
  readonly evidence: readonly string[];
  /** 同类节点被反复提到时的次数。 */
  readonly hits: number;
  /** 用户是否把它钉在时间轴顶部（"这段很重要"）。 */
  readonly pinned: boolean;
}

/** 记忆宫殿快照。 */
export interface PalaceSnapshot {
  readonly nodes: readonly MemoryNode[];
  /** 按年 -> 月分组的数量（UI 画时间轴用）。 */
  readonly byMonth: readonly { readonly month: string; readonly count: number }[];
  readonly updatedAt: string;
  readonly dataDir: string;
  /** 可读镜像文件（`memory/palace.md`）。 */
  readonly markdownFile: string;
  readonly stats: {
    readonly total: number;
    /** 从第一次见面到今天的天数。 */
    readonly daysTogether: number;
    /** 第一个节点的日期（没有则为空串）。 */
    readonly since: string;
  };
}

export interface MemoryNodeDraft {
  readonly kind: MemoryNodeKind;
  readonly title: string;
  readonly detail: string;
  readonly at: string;
  readonly source: MemoryNode['source'];
  readonly evidence: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* 三、4.2 反思与策略                                                          */
/* -------------------------------------------------------------------------- */

/** 一次主动干预的反馈记录（"我说了这句话，主人有没有理我"）。 */
export interface InterventionFeedback {
  readonly at: string;
  readonly kind: string;
  readonly text: string;
  /** 当时的场景（用于按场景学习"什么时候该闭嘴"）。 */
  readonly scene: string;
  /** 用户是否在窗口期内回应过（互动或对话）。 */
  readonly responded: boolean;
  /** 回应发生在多少秒之后（未回应为 null）。 */
  readonly responseSeconds: number | null;
}

/** 反思得出的单条洞见（可直接翻译成策略动作）。 */
export interface ReflectionInsight {
  /** 针对哪个场景（空串 = 全局）。 */
  readonly scene: string;
  /** 建议的动作：安静一点 / 保持 / 可以多说话。 */
  readonly action: 'quiet-down' | 'keep' | 'speak-up';
  readonly reason: string;
}

/** 一天的反思结果。 */
export interface ReflectionEntry {
  readonly date: string;
  /** 第一视角的反思正文（几段话）。 */
  readonly body: string;
  readonly insights: readonly ReflectionInsight[];
  readonly source: 'llm' | 'template';
  readonly tokens: number;
  readonly createdAt: string;
  /** 当天数据摘要（写进正文之前先留一份，便于核对）。 */
  readonly stats: {
    readonly interventions: number;
    readonly responded: number;
    readonly turnCount: number;
    readonly moodStart: number;
    readonly moodEnd: number;
  };
}

/**
 * 行为策略叠加层（**只能收紧**）。
 *
 * 全部是乘数，作用在用户自己的设置上，并被 `clampOverlay` 夹在 [minFactor, 1]：
 * - `minIntervalFactor` 越大 -> 两次主动开口的间隔越长；
 * - `maxPerHourFactor` 越小 -> 每小时允许的打扰次数越少；
 * - `sceneFactors[scene]` 针对具体场景（例如写代码时 0.5 = 打扰间隔翻倍）。
 */
export interface PolicyOverlay {
  readonly minIntervalFactor: number;
  readonly maxPerHourFactor: number;
  readonly sceneFactors: Readonly<Record<string, number>>;
  readonly updatedAt: string;
  /** 最近一次调整的原因（UI 上要能解释"她为什么变安静了"）。 */
  readonly reason: string;
  /** 累计调整次数（用于展示与排错）。 */
  readonly adjustments: number;
}

/** 策略叠加层的收紧下限（0.25 = 最多把频率降到四分之一）。 */
export const POLICY_MIN_FACTOR = 0.25;

/** 成长与反思状态（UI/托盘共用的只读快照）。 */
export interface GrowthStatus {
  readonly settings: GrowthSettings;
  readonly palace: PalaceSnapshot;
  /** 今天的反思（没写过为 null）。 */
  readonly todayReflection: ReflectionEntry | null;
  /** 最近几条反思（倒序，最多 7 条）。 */
  readonly recentReflections: readonly ReflectionEntry[];
  /** 当前生效的策略叠加层。 */
  readonly policy: PolicyOverlay;
  /** 策略叠加层换算成"人话"的效果（例如"主动开口间隔 10 → 20 分钟"）。 */
  readonly policyEffect: string;
  /** 反馈统计：按场景的"回应率"（她据此决定要不要少说话）。 */
  readonly responseStats: readonly { readonly scene: string; readonly total: number; readonly responded: number; readonly rate: number }[];
  readonly dataDir: string;
  readonly lastError: string;
}
