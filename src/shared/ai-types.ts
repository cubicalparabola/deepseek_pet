/**
 * AI 认知与人格系统的跨进程契约（Main / Preload / 桌宠窗口 / 设置窗口 / 聊天窗口共用）。
 *
 * 设计要点：
 * 1. **默认全部关闭**。AI、记忆、情绪、日记四个开关默认 false，
 *    没配密钥、没联网时桌宠与第一版完全一致（纯本地兜底）。
 * 2. **密钥不出主进程**。`AISettings` 里的 `provider.apiKey` 只在 Main 侧存在；
 *    任何回传渲染层的地方都换成 `AISettingsView`（掩码 + 是否已设置）。
 * 3. **配置落在 userData，不落仓库**。`assets/config/` 在仓库里，
 *    密钥写进去会被 git 带走，因此 AI 配置存 `%APPDATA%\DesktopPet\ai-settings.json`
 *    （见 main/ai/ai-config-store.ts）。
 * 4. 情绪/记忆/日记的数据结构也在这里，它们是 Main 产出、UI 只读的快照。
 */

/* -------------------------------------------------------------------------- */
/* 一、AI 配置（2.1 大模型能力 + 总开关）                                        */
/* -------------------------------------------------------------------------- */

/** 大模型服务商类型。两者都用 `fetch` 直接调 HTTP，不引入 SDK。 */
export type AIProviderKind = 'openai' | 'anthropic';

/**
 * 服务商连接配置。
 *
 * `baseUrl` 允许指向任何 **OpenAI 兼容** 的网关（one-api / vLLM / Ollama / DeepSeek…），
 * 这是"可配置"的关键：不绑死某一家。
 */
export interface AIProviderConfig {
  readonly kind: AIProviderKind;
  /** 接口根地址，不含具体路径。OpenAI 兼容：`https://api.openai.com/v1`。 */
  readonly baseUrl: string;
  /** 模型名，例如 `gpt-4o-mini` / `claude-3-5-haiku-latest` / `deepseek-chat`。 */
  readonly model: string;
  /** API Key。**只在 Main 进程存在**，回传渲染层时一律掩码。 */
  readonly apiKey: string;
  /** 采样温度（0~2）。 */
  readonly temperature: number;
  /** 单次回复的最大 token 数。 */
  readonly maxTokens: number;
  /** 单次请求超时（毫秒）。 */
  readonly timeoutMs: number;
}

/** Token 预算：情绪系统里"饿"的来源（饿 = 预算用光的比例）。 */
export interface AITokenBudget {
  /** 预算总量（token）。0 表示不限制（此时 satiety 恒为 100 = 一直很饱）。 */
  readonly budget: number;
  /** 已消耗（token，累计）。 */
  readonly used: number;
  /** 上次重置时间（ISO 字符串，仅用于展示）。 */
  readonly resetAt: string;
}

/**
 * 余额查询设置。
 *
 * DeepSeek 官方只有"查余额"这一个额度接口（`GET /user/balance`），
 * 没有 token 用量接口 —— 所以"还剩多少额度"以**余额**为准，
 * 本地累计 token 只在查不到余额时兜底。
 *
 * 用户要求（本轮）："删掉余额计算选项（默认开启）" —— 原先那个
 * `enabled` 开关已删除：**查询永远是开的**，只在非 DeepSeek 官方域名下
 * 自动跳过（那里根本没有这个接口，见 `supportsBalanceQuery`）。
 */
export interface AIBalanceSettings {
  /** 查询间隔（毫秒，默认 30 分钟）。 */
  readonly intervalMs: number;
  /** 余额低于这个金额算"见底"（对应 satiety=0，饿得说不动话）。 */
  readonly lowBalance: number;
  /** 余额高于这个金额算"额度充足"（对应 satiety=100，很饱）。 */
  readonly fullBalance: number;
}

/** 余额快照（设置面板展示 + 驱动"饱腹"/"掉线"）。 */
export interface AIBalanceState {
  readonly isAvailable: boolean;
  readonly currency: string;
  readonly totalBalance: number;
  readonly grantedBalance: number;
  readonly toppedUpBalance: number;
  readonly fetchedAt: string;
  /** true = 这次"饱腹"是余额算出来的；false = 用的是本地累计 token。 */
  readonly drivesSatiety: boolean;
}

/** AI 总配置（持久化到 userData/ai-settings.json）。 */
export interface AISettings {
  /** 总开关：关掉时下面四个子系统全部不生效。 */
  readonly enabled: boolean;
  /** 2.1 对话（自然语言理解与生成）。 */
  readonly chat: boolean;
  /** 2.2 用户记忆（记忆日志 + 长期上下文）。 */
  readonly memory: boolean;
  /** 2.3 情绪系统（mood / satiety）。 */
  readonly emotion: boolean;
  /** 2.4 日记系统。 */
  readonly diary: boolean;
  /** 宠物人格设定（system prompt 的主体）。 */
  readonly persona: string;
  /** 宠物自称（默认"鲸鱼娘"）。 */
  readonly petName: string;
  /** 主人的称呼（记忆系统可以自动补全）。 */
  readonly userName: string;
  /** 每天几点写日记（0~23）。 */
  readonly diaryHour: number;
  /** 每 N 轮对话整理一次长期记忆（0 = 不自动整理，只靠日记时整理）。 */
  readonly consolidateEvery: number;
  readonly provider: AIProviderConfig;
  readonly budget: AITokenBudget;
  readonly balance: AIBalanceSettings;
}

/** 默认人格设定（用户可在设置窗口里改）。 */
export const DEFAULT_PERSONA = [
  '你是一只住在 Windows 桌面上的鲸鱼娘桌宠，名字叫「鲸鱼娘」。',
  '你说话简短、口语化、有一点黏人，喜欢用「主人」称呼对方。',
  '你只能输出 1~3 句中文，不要用列表、不要用 Markdown、不要解释自己是 AI。',
  '你记得和主人聊过的事情，会在合适的时候自然提起，不要生硬复述。',
].join('\n');

/**
 * 默认配置：**全部打开**（需求："默认模式全开"）。
 *
 * 为什么敢默认打开：没配密钥时 `usable=false`，聊天走本地兜底——
 * 记忆、情绪、日记、习惯这些**本地能力**不依赖大模型，默认开着才有陪伴感。
 * 隐私相关的两处例外（见感知模块）：摄像头必须**用户显式授权**后才采集，
 * 「隐私模式」默认关闭但一键可停一切感知。
 */
export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: true,
  chat: true,
  memory: true,
  emotion: true,
  diary: true,
  persona: DEFAULT_PERSONA,
  petName: '鲸鱼娘',
  userName: '',
  diaryHour: 22,
  consolidateEvery: 6,
  provider: {
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    temperature: 0.8,
    maxTokens: 220,
    timeoutMs: 20000,
  },
  budget: {
    budget: 200000,
    used: 0,
    resetAt: '',
  },
  // 余额查询永远开着（用户要求删掉那个默认开启的开关），
  // 但只在 DeepSeek 官方域名下真的会发请求（见 supportsBalanceQuery）
  balance: {
    intervalMs: 30 * 60000,
    lowBalance: 2,
    fullBalance: 20,
  },
};

/** 设置窗口写入 AI 配置时的补丁（`apiKey` 省略 = 不改动已存的密钥）。 */
export interface AISettingsPatch {
  readonly enabled?: boolean;
  readonly chat?: boolean;
  readonly memory?: boolean;
  readonly emotion?: boolean;
  readonly diary?: boolean;
  readonly persona?: string;
  readonly petName?: string;
  readonly userName?: string;
  readonly diaryHour?: number;
  readonly consolidateEvery?: number;
  readonly provider?: Partial<AIProviderConfig>;
  readonly budget?: Partial<AITokenBudget>;
  readonly balance?: Partial<AIBalanceSettings>;
  /** 清空密钥（设置界面「清除」按钮）。 */
  readonly clearApiKey?: boolean;
  /** 重置 token 用量（同时把 mood 的"饿"清零）。 */
  readonly resetUsage?: boolean;
}

/** 回传渲染层的配置视图：**不含明文密钥**。 */
export interface AIProviderView extends Omit<AIProviderConfig, 'apiKey'> {
  /** 掩码后的密钥（如 `sk-…8f3a`）；未设置时为空串。 */
  readonly apiKeyMasked: string;
  /** 是否已经配置密钥。 */
  readonly apiKeySet: boolean;
}

export interface AISettingsView extends Omit<AISettings, 'provider'> {
  readonly provider: AIProviderView;
}

/** AI 运行状态（托盘菜单与设置界面展示用）。 */
export interface AIStatusView {
  readonly settings: AISettingsView;
  /** AI 是否真的可用（总开关 + 对话开关 + 密钥 + 地址齐备）。 */
  readonly usable: boolean;
  /** 当前是走真实大模型还是本地兜底。 */
  readonly mode: 'llm' | 'local';
  /** 最近一次调用的错误（人类可读，成功时为空）。 */
  readonly lastError: string;
  /** 最近一次调用是否进行中。 */
  readonly busy: boolean;
  /** 累计调用次数 / 累计 token。 */
  readonly calls: number;
  readonly tokensUsed: number;
  /** 数据目录（记忆日志、日记都在里面）。 */
  readonly dataDir: string;
  /** 情绪快照（2.3）。情绪开关关闭时 `mood` 仍给出中性值。 */
  readonly emotion: EmotionState;
  /** 宠物在不在场（影响情绪衰减速度）。 */
  readonly presence: PetPresence;
  /** 余额快照（DeepSeek `GET /user/balance`）；没查过或查不到时为 null。 */
  readonly balance: AIBalanceState | null;
  /** 最近一次余额查询的错误（人类可读，成功时为空）。 */
  readonly balanceError: string;
}

/* -------------------------------------------------------------------------- */
/* 二、情绪系统（2.3）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 桌宠"在不在场"。
 *
 * 语义（与用户描述的三档衰减一一对应）：
 * - `visible`   正常可见 → 不互动时自然衰减（最慢）；
 * - `collapsed` **收起**：她还在，但安静待着不打扰（点击穿透、不播动画）
 *               → 衰减更快；
 * - `hidden`    **隐藏**：窗口都收起来了 → 衰减最快。
 */
export type PetPresence = 'visible' | 'collapsed' | 'hidden';

/** 情绪状态（持久化 + 注入 prompt）。 */
export interface EmotionState {
  /** 心情 0~100（0 = 很难过，100 = 很开心）。 */
  readonly mood: number;
  /** 饱腹 0~100（100 = 很饱，0 = 饿得说不动话）。**由额度剩余量推导**，不做时间衰减。 */
  readonly satiety: number;
  /** 最近一次互动时间（epoch ms）。 */
  readonly lastInteractionAt: number;
  /** 最近一次结算时间（epoch ms），用于计算衰减经过了多少时间。 */
  readonly lastUpdateAt: number;
  /** 人类可读的更新时间（ISO）。 */
  readonly updatedAt: string;
}

/** 一次互动的种类（决定 mood 增量）。 */
export type InteractionKind = 'click' | 'doubleclick' | 'drag' | 'chat' | 'diary' | 'gift';

/** 情绪结算的输入信号（纯函数，便于验收直接测）。 */
export interface EmotionSignals {
  /** 当前在场状态。 */
  readonly presence: PetPresence;
  /** 当前时间（epoch ms）。 */
  readonly now: number;
  /** token 剩余比例 0~1（1 = 满预算）。预算不限制时传 1。 */
  readonly tokensRemainingRatio: number;
}

/* -------------------------------------------------------------------------- */
/* 三、记忆系统（2.2）                                                          */
/* -------------------------------------------------------------------------- */

/** 长期记忆里的一条"事实"。 */
export type MemoryFactKey =
  | 'name'        // 主人叫什么
  | 'interest'    // 兴趣爱好
  | 'routine'     // 日常作息
  | 'activity'    // 常见活动
  | 'project'     // 当前进行的项目
  | 'preference'  // 口味/偏好（喜欢什么、讨厌什么）
  | 'relation'    // 人际关系（提到的人）
  | 'note';       // 其它值得记住的事

export interface MemoryFact {
  readonly key: MemoryFactKey;
  readonly value: string;
  /** 置信度 0~1（规则抽取 0.6，模型整理 0.9）。 */
  readonly confidence: number;
  readonly source: 'heuristic' | 'llm' | 'manual';
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** 被提到过几次（合并同义事实时累加）。 */
  readonly hits: number;
}

/** 记忆事件（原始流水，逐行追加到当天的 JSONL）。 */
export type MemoryEventKind =
  | 'interaction' // 点击/拖动等互动
  | 'chat'        // 一次对话
  | 'presence'    // 显示/收起/隐藏
  | 'emotion'     // 情绪突变（例如"心情掉到 20 以下"）
  | 'diary'       // 写了日记
  | 'system';     // 系统事件（开关、错误）

export interface MemoryEvent {
  readonly at: string;
  readonly kind: MemoryEventKind;
  readonly text: string;
  readonly data?: Record<string, unknown>;
}

/** 一轮对话（宠物第一视角记录）。 */
export interface ChatTurn {
  readonly at: string;
  readonly role: 'user' | 'pet';
  readonly text: string;
  /** 该轮消耗的 token（宠物侧回复才有）。 */
  readonly tokens?: number;
}

/** 记忆画像（长期事实集合）。 */
export interface MemoryProfile {
  readonly userName: string;
  readonly petName: string;
  readonly facts: readonly MemoryFact[];
  /** 记忆摘要（**滚动前情**：更早的对话被压成这一段，供 prompt 用；没有则为空串）。 */
  readonly summary: string;
  /** 摘要最后更新的时间（ISO；没写过为空串）。 */
  readonly summaryUpdatedAt?: string;
  /** 摘要已经覆盖了多少轮对话（下次只并入比它更新的轮次）。 */
  readonly summaryTurns?: number;
  readonly updatedAt: string;
}

/** 渲染层/设置界面看到的记忆快照。 */
export interface MemorySnapshot {
  readonly profile: MemoryProfile;
  /** 今天的事件（倒序，最多 50 条）。 */
  readonly todayEvents: readonly MemoryEvent[];
  /** 最近的对话（倒序，最多 20 轮）。 */
  readonly recentChat: readonly ChatTurn[];
  /** 记忆日志文件绝对路径（「打开记忆日志」用）。 */
  readonly logFile: string;
  readonly dataDir: string;
  /** 统计：事件总数 / 对话轮数 / 记住的事实数。 */
  readonly stats: { readonly events: number; readonly turns: number; readonly facts: number };
}

/* -------------------------------------------------------------------------- */
/* 四、日记系统（2.4）                                                          */
/* -------------------------------------------------------------------------- */

/** 一篇日记（宠物第一视角）。 */
export interface DiaryEntry {
  /** 日期 `YYYY-MM-DD`。 */
  readonly date: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  /** 由大模型生成还是本地模板兜底。 */
  readonly source: 'llm' | 'template';
  /** 当天情绪曲线（用于列表上的小标签）。 */
  readonly mood: { readonly start: number; readonly end: number; readonly low: number };
  readonly tokens: number;
  /** 当天的高光片段（提取出来的事件摘要）。 */
  readonly highlights: readonly string[];
}

/** 日记列表项。 */
export interface DiaryIndexItem {
  readonly date: string;
  readonly title: string;
  readonly preview: string;
  readonly source: DiaryEntry['source'];
  readonly mood: DiaryEntry['mood'];
}

export interface DiarySnapshot {
  readonly items: readonly DiaryIndexItem[];
  readonly dataDir: string;
  /** 今天是否已经写过。 */
  readonly todayWritten: boolean;
  /** 每天几点自动写。 */
  readonly diaryHour: number;
}

/* -------------------------------------------------------------------------- */
/* 五、对话（2.1）                                                              */
/* -------------------------------------------------------------------------- */

/** 渲染层/聊天窗口发来的一句话。 */
export interface AIChatRequest {
  readonly text: string;
  /** 触发来源：聊天窗口 / 托盘菜单 / 插件。 */
  readonly source?: 'chat-window' | 'tray' | 'plugin' | 'system';
}

/** 一次对话的结果（同步返回给聊天窗口）。 */
export interface AIChatReply {
  readonly ok: boolean;
  readonly reply: string;
  /** 真实走的是大模型还是本地兜底。 */
  readonly mode: 'llm' | 'local';
  /** 本次消耗的 token（本地兜底为 0）。 */
  readonly tokens: number;
  /** 失败原因（ok=false 时）。 */
  readonly error?: string;
  /** 这次回复让桌宠播了什么动画（便于验收）。 */
  readonly animation?: string;
  readonly mood: number;
  readonly satiety: number;
}

/** Main -> 聊天窗口推送的一条消息（用于主动说话/日记提醒）。 */
export interface ChatMessagePush {
  readonly role: 'user' | 'pet' | 'system';
  readonly text: string;
  readonly at: string;
  /** system 消息的语气：普通 / 错误 / 提示。 */
  readonly level?: 'info' | 'warn' | 'error';
}

/* -------------------------------------------------------------------------- */
/* 六、连通性自检                                                              */
/* -------------------------------------------------------------------------- */

/** 设置界面里「测试连接」的结果。 */
export interface AITestResult {
  readonly ok: boolean;
  readonly mode: 'llm' | 'local';
  readonly latencyMs: number;
  /** 模型原样返回的一句话（成功时）。 */
  readonly sample: string;
  readonly error: string;
  readonly tokens: number;
}

/* -------------------------------------------------------------------------- */
/* 七、纯函数：清洗 / 掩码 / 视图 / 可用性                                        */
/* -------------------------------------------------------------------------- */

/**
 * 密钥掩码。
 *
 * 只保留头 3 位与尾 4 位 —— 足够让用户确认"是不是我那一把"，
 * 又不足以被拿去用。渲染层任何地方都只能看到这个。
 */
export function maskApiKey(apiKey: string): string {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key === '') return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** 配置是否有问题（决定走大模型还是本地兜底）。 */
export function evaluateAIUsability(settings: AISettings): { usable: boolean; reason: string } {
  if (!settings.enabled) return { usable: false, reason: '总开关未打开' };
  if (!settings.chat) return { usable: false, reason: '对话开关未打开' };
  if (settings.provider.apiKey.trim() === '') return { usable: false, reason: '未配置 API Key' };
  if (settings.provider.baseUrl.trim() === '') return { usable: false, reason: '未配置接口地址' };
  if (settings.provider.model.trim() === '') return { usable: false, reason: '未配置模型名' };
  return { usable: true, reason: '' };
}

/** 去掉明文密钥，得到可以回传渲染层的视图。 */
export function toAISettingsView(settings: AISettings): AISettingsView {
  const { apiKey, ...rest } = settings.provider;
  return {
    ...settings,
    provider: {
      ...rest,
      apiKeyMasked: maskApiKey(apiKey),
      apiKeySet: apiKey.trim() !== '',
    },
  };
}

/** 单个字段的数字夹取。 */
function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function str(value: unknown, fallback: string, maxLength = 4000): string {
  if (typeof value !== 'string') return fallback;
  return value.slice(0, maxLength);
}

/**
 * 把任意来源的 JSON 清洗成合法配置。
 *
 * 原则与 settings-store 一致：**读不出来就用默认值**，绝不让桌宠因为
 * 一个坏字段起不来；数值一律夹到合法区间（温度、超时、预算都可能被手改成负数）。
 */
export function sanitizeAISettings(raw: unknown, fallback: AISettings = DEFAULT_AI_SETTINGS): AISettings {
  if (typeof raw !== 'object' || raw === null) return { ...fallback };
  const record = raw as Record<string, unknown>;
  const providerRaw = (typeof record.provider === 'object' && record.provider !== null
    ? record.provider
    : {}) as Record<string, unknown>;
  const budgetRaw = (typeof record.budget === 'object' && record.budget !== null
    ? record.budget
    : {}) as Record<string, unknown>;
  const balanceRaw = (typeof record.balance === 'object' && record.balance !== null
    ? record.balance
    : {}) as Record<string, unknown>;
  const full = num(balanceRaw.fullBalance, fallback.balance.fullBalance, 0, 1_000_000);
  const low = num(balanceRaw.lowBalance, fallback.balance.lowBalance, 0, 1_000_000);
  const kind = providerRaw.kind === 'anthropic' ? 'anthropic' : providerRaw.kind === 'openai' ? 'openai' : fallback.provider.kind;

  return {
    enabled: bool(record.enabled, fallback.enabled),
    chat: bool(record.chat, fallback.chat),
    memory: bool(record.memory, fallback.memory),
    emotion: bool(record.emotion, fallback.emotion),
    diary: bool(record.diary, fallback.diary),
    persona: str(record.persona, fallback.persona, 8000),
    petName: str(record.petName, fallback.petName, 40),
    userName: str(record.userName, fallback.userName, 40),
    diaryHour: Math.round(num(record.diaryHour, fallback.diaryHour, 0, 23)),
    consolidateEvery: Math.round(num(record.consolidateEvery, fallback.consolidateEvery, 0, 100)),
    provider: {
      kind,
      baseUrl: str(providerRaw.baseUrl, fallback.provider.baseUrl, 400).trim(),
      model: str(providerRaw.model, fallback.provider.model, 120).trim(),
      apiKey: str(providerRaw.apiKey, fallback.provider.apiKey, 400).trim(),
      temperature: num(providerRaw.temperature, fallback.provider.temperature, 0, 2),
      maxTokens: Math.round(num(providerRaw.maxTokens, fallback.provider.maxTokens, 16, 8192)),
      timeoutMs: Math.round(num(providerRaw.timeoutMs, fallback.provider.timeoutMs, 1000, 120000)),
    },
    budget: {
      budget: Math.round(num(budgetRaw.budget, fallback.budget.budget, 0, 100_000_000)),
      used: Math.round(num(budgetRaw.used, fallback.budget.used, 0, 100_000_000)),
      resetAt: str(budgetRaw.resetAt, fallback.budget.resetAt, 40),
    },
    balance: {
      intervalMs: Math.round(num(balanceRaw.intervalMs, fallback.balance.intervalMs, 60_000, 24 * 3600_000)),
      // low 必须 <= full，否则"余额映射到饱腹度"会算出反的结果（写反了自动纠正）
      lowBalance: Math.min(low, full),
      fullBalance: full,
    },
  };
}

/**
 * 应用设置补丁。
 *
 * 三个"省略即保持原值"的约定，都是为了让设置界面不必持有密钥：
 * - `apiKey` 省略 → 不改动（界面只显示掩码，不回传明文）；
 * - `apiKey === ''` 且没有 `clearApiKey` → 视为"不改动"（空输入框不该清掉密钥）；
 * - `clearApiKey: true` → 显式清空。
 */
export function applyAISettingsPatch(
  current: AISettings,
  patch: AISettingsPatch,
  now: string = new Date().toISOString(),
): AISettings {
  const providerPatch = patch.provider ?? {};
  const budgetPatch = patch.budget ?? {};
  const balancePatch = patch.balance ?? {};
  const nextKey =
    patch.clearApiKey === true
      ? ''
      : typeof providerPatch.apiKey === 'string' && providerPatch.apiKey.trim() !== ''
        ? providerPatch.apiKey.trim()
        : current.provider.apiKey;

  return sanitizeAISettings(
    {
      ...current,
      ...patch,
      provider: {
        ...current.provider,
        ...providerPatch,
        apiKey: nextKey,
      },
      budget: {
        ...current.budget,
        ...(patch.resetUsage === true ? { used: 0, resetAt: now } : {}),
        ...budgetPatch,
        ...(patch.resetUsage === true ? { used: 0, resetAt: now } : {}),
      },
      balance: {
        ...current.balance,
        ...balancePatch,
        // 复核一次 low<=full：补丁可能只改其中一个，导致两个字段互相矛盾
        ...(balancePatch.lowBalance !== undefined || balancePatch.fullBalance !== undefined
          ? {
              lowBalance: Math.min(
                balancePatch.lowBalance ?? current.balance.lowBalance,
                balancePatch.fullBalance ?? current.balance.fullBalance,
              ),
              fullBalance: balancePatch.fullBalance ?? current.balance.fullBalance,
            }
          : {}),
      },
    },
    current,
  );
}

/** 预加载/极早阶段使用的"未初始化"状态（preload 的兜底值）。 */
export function createDefaultAIStatus(dataDir = ''): AIStatusView {
  const settings = DEFAULT_AI_SETTINGS;
  return {
    settings: toAISettingsView(settings),
    usable: false,
    mode: 'local',
    lastError: '',
    busy: false,
    calls: 0,
    tokensUsed: 0,
    dataDir,
    emotion: {
      mood: 62,
      satiety: 100,
      lastInteractionAt: 0,
      lastUpdateAt: 0,
      updatedAt: '',
    },
    presence: 'visible',
    balance: null,
    balanceError: '',
  };
}
