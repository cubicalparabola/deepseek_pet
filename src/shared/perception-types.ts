/**
 * 环境与用户感知系统（3.1~3.6）的跨进程契约。
 *
 * 需求四条落点：
 * - 3.1 屏幕感知：周期性截图 + 视觉模型 -> 判断"在写代码/读论文/看视频/打游戏/长时间没动"
 * - 3.2 按需看屏幕：手动问一次"我在做什么"（只做场景分类；读文字/总结/看报错/看代码
 *   这四个内容理解动作在 v1 里**已删除**，用户明确只要场景）
 * - 3.4 用户行为观察：活跃窗口、切换频率、连续使用时长、深夜在线、敏感内容回避
 * - 3.5 摄像头感知：是否在电脑前 / 表情 / 久坐 / 离开 / 陌生人
 * - 3.6 用户习惯学习：按小时聚合行为，预测下一阶段并做时间对比提醒
 *
 * 三条隐私底线（贯穿全模块，逐条都有代码落点）：
 * 1. **图像永不落盘**：截图与摄像头帧只在内存里存在一次调用；磁盘上只存文本观察记录。
 * 2. **一键停**：`privacyMode` 打开时立即停止一切采集（截图、摄像头、行为采样）。
 * 3. **摄像头必须显式授权**：`cameraAuthorized` 默认 false，只有用户在界面上点过
 *    "授权并使用摄像头"之后才会取帧。
 */

/* -------------------------------------------------------------------------- */
/* 一、开关与配置（默认全开，隐私相关的两项见上）                                  */
/* -------------------------------------------------------------------------- */

/**
 * 场景分类（视觉模型输出的**受控词表**）。
 *
 * 为什么要固定词表而不是让模型自由发挥：习惯学习需要**可聚合**的标签，
 * 每次都是"VS Code 里写 Rust"这种自由文本就统计不出"10 点通常在写代码"。
 */
export type SceneKind =
  | 'coding'    // 写代码
  | 'reading'   // 读论文/文档
  | 'video'     // 看视频
  | 'gaming'    // 打游戏
  | 'meeting'   // 开会/语音
  | 'browsing'  // 浏览网页
  | 'chatting'  // 聊天/社交
  | 'writing'   // 写文档/邮件
  | 'terminal'  // 命令行/运维
  | 'idle'      // 屏幕没变化/人不在
  | 'sensitive' // 识别为私人内容（宠物会捂眼睛躲起来）
  | 'other';

/** 由行为信号推测的用户状态。 */
export type UserState = 'deep' | 'shallow' | 'idle' | 'away' | 'unknown';

export interface PerceptionSettings {
  /** 3.1 屏幕感知总开关。 */
  readonly screen: boolean;
  /** 3.4 用户行为观察（空闲、连续使用、切换频率、深夜）。 */
  readonly behavior: boolean;
  /** 3.5 摄像头感知（还需 `cameraAuthorized` 才会真的取帧）。 */
  readonly camera: boolean;
  /** 3.6 用户习惯学习（按小时建模 + 预测）。 */
  readonly habits: boolean;
  /** 隐私模式：一键停止一切采集（不改其它开关的值，退出后恢复原状）。 */
  readonly privacyMode: boolean;
  /** 桌宠自己是否对截屏/录屏隐藏（避免她出现在自己的感知画面与别人的录屏里）。 */
  readonly hideFromCapture: boolean;
  /** 屏幕采样间隔（毫秒）。 */
  readonly captureIntervalMs: number;
  /** 截图宽度（高按屏幕比例），越小越省 token。 */
  readonly captureWidth: number;
  /**
   * 是否额外截一条**地址栏横条**并让模型读出网址。
   *
   * 为什么需要：整屏缩到 640 宽时地址栏文字只有几像素，模型读不出来；
   * 单独把屏幕顶部那条按较大宽度截下来，网址就可读了。
   * 网址是判断"浏览网页 / 看视频 / 读论文"最可靠的线索（比像素和窗口标题都准）。
   */
  readonly captureUrl: boolean;
  /** 地址栏横条的截取宽度（越大越清楚、越费一点 token；默认 1280）。 */
  readonly urlCaptureWidth: number;
  /**
   * 是否把**完整网址**（含路径与查询串）写进观察记录。
   *
   * 默认 false：只存域名（`github.com`）。查询串里常有搜索词等私人信息（
   * `google.com/search?q=...`），而分类只需要域名 —— 少存一点，隐私就多一分。
   */
  readonly storeFullUrl: boolean;
  /**
   * 是否把"现在开着哪些窗口 + 最上层窗口"作为判断依据。
   *
   * 这是几路证据里**最具体**的一路：进程名说清"用的什么软件"
   * （`Typora` / `Code` / `msedge`），标题说清"在看什么"（`论文.pdf`、`桌面宠物.md`）。
   * 实测一次 PowerShell `EnumWindows` 能拿到 29 个可见窗口 + 进程名 + 前台标记（~500ms），
   * 比逐像素猜准得多。
   */
  readonly windowContext: boolean;
  /** 窗口列表最多给模型看几条（越多越费 token，默认 12）。 */
  readonly windowListLimit: number;
  /** 窗口上下文的缓存时长（毫秒，默认 25000）。 */
  readonly windowProbeTtlMs: number;
  /**
   * 是否读**最上层终端窗口里的文本**作为判断依据。
   *
   * 为什么值得单独做一路：终端整屏都是文字，整屏缩到 640 宽后字符只有几像素，
   * 视觉模型读不出来就只能顺着"黑底白字像代码"猜（用户实测的误判）。
   * 而终端缓冲区文本**拿得到**（探针 `tools/probe-terminal-text.ps1`：Windows Terminal
   * 把它暴露在子元素的 `TextPattern` 上，一个窗口能取到 46 万字符）。
   *
   * 隐私约束（每一条都有代码落点，见 `src/main/perception/terminal-text.ts`）：
   * 只读**最上层**那个终端、只取**尾部**约 20 行、先去 ANSI 再给密钥打码、
   * **绝不落盘**、命中敏感词就整段不发。
   */
  readonly terminalText: boolean;
  /** 摄像头采样间隔（毫秒）—— 比屏幕采样更稀，省电也省 token。 */
  readonly cameraIntervalMs: number;
  /** 用户是否已显式授权摄像头（默认 false，只能由界面上的按钮置为 true）。 */
  readonly cameraAuthorized: boolean;
  /** 主动打扰的最小间隔（毫秒）—— 3.4 的"避免过度打扰"由它兜底。 */
  readonly proactiveMinIntervalMs: number;
  /** 每小时主动打扰次数上限。 */
  readonly proactiveMaxPerHour: number;
  /** 免打扰时段（0~23，含 start 不含 end；跨零点用 start > end 表示）。 */
  readonly quietHours: { readonly start: number; readonly end: number };
  /** 连续使用多久提醒起来活动（分钟）。 */
  readonly longSessionMinutes: number;
  /** 深夜提醒的起点小时（默认 1 点）。 */
  readonly lateNightHour: number;
  /** 敏感内容关键词（匹配模型给出的 app/activity/summary，命中则按敏感处理）。 */
  readonly sensitivityKeywords: readonly string[];
  /**
   * 用户自定义的**场景纠正**规则（每行 `关键词=场景`，例如 `Chrome=browsing`）。
   *
   * 为什么需要：视觉模型会稳定地把某类画面判错（用户实测："浏览网页总是被识别成
   * 笔记软件记笔记"）。代码里已经按应用名做了一轮确定性纠正，
   * 但总会有它认不出的应用 —— 这时给用户一个"我说了算"的口子，
   * 比让他反复看到同一个错误要好。
   */
  readonly sceneFixes: readonly string[];
}

export const DEFAULT_PERCEPTION_SETTINGS: PerceptionSettings = {
  // 需求：「默认模式全开」
  screen: true,
  behavior: true,
  camera: true,
  habits: true,
  privacyMode: false,
  hideFromCapture: true,
  captureIntervalMs: 30000,
  captureWidth: 640,
  // 地址栏横条：默认开。它是"浏览网页被认成记笔记"这类误判最有效的解药，
  // 而代价只是每轮多一张几十 KB 的小图（且用完即弃，不落盘）。
  captureUrl: true,
  urlCaptureWidth: 1280,
  // 默认只留域名：查询串里可能是搜索词、token 等私人信息
  storeFullUrl: false,
  // 窗口上下文：默认开。一次 EnumWindows 就能拿到"开着什么、最上层是哪个"，
  // 是判断"在用哪个应用"最具体的一路证据。
  windowContext: true,
  windowListLimit: 12,
  windowProbeTtlMs: 25000,
  // 终端文本：默认开（用户明确要求"能拿到就用它辅助"）。它把"终端里到底在跑什么"
  // 从猜测变成证据，而代价只有尾部约 20 行、且绝不落盘。
  terminalText: true,
  cameraIntervalMs: 60000,
  // 唯一默认关闭的一项：摄像头必须用户显式授权（需求 3.5 原文）
  cameraAuthorized: false,
  proactiveMinIntervalMs: 10 * 60000,
  proactiveMaxPerHour: 4,
  quietHours: { start: 23, end: 8 },
  longSessionMinutes: 120,
  lateNightHour: 1,
  sensitivityKeywords: ['密码', '银行', '支付', '身份证', '私密', 'password', 'bank', 'paypal', '1password'],
  /**
   * 默认给两条**最常见**的纠正（浏览器 → 浏览网页），开箱即用；
   * 用户可以在设置里改/加（空串表示不用这一条）。
   */
  sceneFixes: ['Chrome=browsing', 'Edge=browsing'],
};

/** 设置补丁（部分字段）。 */
export interface PerceptionSettingsPatch {
  readonly screen?: boolean;
  readonly behavior?: boolean;
  readonly camera?: boolean;
  readonly habits?: boolean;
  readonly privacyMode?: boolean;
  readonly hideFromCapture?: boolean;
  readonly captureIntervalMs?: number;
  readonly captureWidth?: number;
  readonly captureUrl?: boolean;
  readonly urlCaptureWidth?: number;
  readonly storeFullUrl?: boolean;
  readonly windowContext?: boolean;
  readonly windowListLimit?: number;
  readonly windowProbeTtlMs?: number;
  readonly terminalText?: boolean;
  readonly cameraIntervalMs?: number;
  readonly cameraAuthorized?: boolean;
  readonly proactiveMinIntervalMs?: number;
  readonly proactiveMaxPerHour?: number;
  readonly quietHours?: { readonly start?: number; readonly end?: number };
  readonly longSessionMinutes?: number;
  readonly lateNightHour?: number;
  readonly sensitivityKeywords?: readonly string[];
  readonly sceneFixes?: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* 二、观察结果                                                                */
/* -------------------------------------------------------------------------- */

/** 一次屏幕观察（**只有文本**，图像不落盘）。 */
export interface ScreenObservation {
  readonly at: string;
  readonly scene: SceneKind;
  /** 模型判定的应用名（用于习惯统计与敏感词匹配）。 */
  readonly app: string;
  /** 一句话在做什么。 */
  readonly activity: string;
  /**
   * 当前网页的网址（默认**只存域名**，如 `github.com`；`storeFullUrl` 打开时才存完整地址）。
   *
   * 来源：模型读地址栏横条。它是"网页里到底在干什么"最可靠的线索，
   * 也让"浏览网页 vs 记笔记"这类判断有了确定性的第二道依据（见 `refineSceneByUrl`）。
   */
  readonly url?: string;
  /**
   * 最上层窗口的标题（**只存这一条**，不存整份窗口列表）。
   *
   * 为什么只存最上层：窗口列表是"当下环境"的临时上下文（进提示词就够了），
   * 整份列表落盘会越积越多、也越来越像一份使用记录；而"最上层那个窗口"
   * 对复盘"她当时凭什么这么判断"最有价值。
   */
  readonly windowTitle?: string;
  /** 是否判定为私人/敏感内容。 */
  readonly sensitive: boolean;
  /** 专注度：deep = 长时间同一件事，shallow = 频繁切换。 */
  readonly focus: 'deep' | 'shallow' | 'unknown';
  /** 屏幕内容摘要（3.2 开启时才有）。 */
  readonly summary: string;
  /** 建议（可为空）。 */
  readonly suggestion: string;
  /** 这次观察是否真的调用了模型。 */
  readonly mode: 'llm' | 'local';
  readonly tokens: number;
}

/** 行为快照（不依赖像素，随时可算）。 */
export interface BehaviorSnapshot {
  /** 系统级空闲秒数（键盘鼠标都没动）。 */
  readonly idleSeconds: number;
  /** 本次连续使用电脑的时长（分钟）。 */
  readonly sessionMinutes: number;
  /** 最近一小时窗口/场景切换次数（粗粒度：来自采样序列）。 */
  readonly switchesLastHour: number;
  /** 当前小时（0~23）。 */
  readonly hour: number;
  /** 是否处于深夜。 */
  readonly lateNight: boolean;
  /** 推测的用户状态。 */
  readonly userState: UserState;
}

/** 在场状态（摄像头优先，退化到空闲时间推断）。 */
export interface PresenceState {
  readonly present: boolean;
  readonly source: 'camera' | 'idle' | 'unknown';
  readonly at: string;
  /** 摄像头可用时的可选信息。 */
  readonly expression?: string;
  /** 陌生人告警。 */
  readonly stranger?: boolean;
}

/** 3.6 习惯画像（按小时统计场景分布）。 */
export interface HabitProfile {
  /** `hour(0~23) -> scene -> 次数`。 */
  readonly hours: Record<string, Record<string, number>>;
  /** 有数据的小时数（用于"学得够不够"）。 */
  readonly observedHours: number;
  /** 采样总数。 */
  readonly samples: number;
  /** 有记录的天数。 */
  readonly activeDays: number;
  /** 学到的"通常几点还在"（最晚有活动的整点）。 */
  readonly latestActiveHour: number | null;
  /** 学到的"通常几点开始用电脑"。 */
  readonly earliestActiveHour: number | null;
  /** 最近活跃日期（YYYY-MM-DD，用于算 activeDays）。 */
  readonly lastActiveDate: string;
  readonly updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* 三、对外状态与动作                                                          */
/* -------------------------------------------------------------------------- */

/** 一次主动干预的记录（用于"为什么她要说话"的审计与频率控制）。 */
export interface InterventionRecord {
  readonly at: string;
  readonly kind:
    | 'greeting'
    | 'long-session'
    | 'late-night'
    | 'scene-change'
    | 'sensitive'
    | 'presence'
    | 'stranger'
    | 'habit'
    | 'error-help';
  readonly reason: string;
  readonly text: string;
}

export interface PerceptionStatus {
  readonly settings: PerceptionSettings;
  /** 当前是否**真的**在采集（隐私模式、开关、空闲都会影响）。 */
  readonly capturing: boolean;
  /** 不采集时的人类可读原因。 */
  readonly pausedReason: string;
  readonly lastObservation: ScreenObservation | null;
  readonly behavior: BehaviorSnapshot;
  readonly presence: PresenceState;
  readonly habits: {
    readonly samples: number;
    readonly activeDays: number;
    readonly latestActiveHour: number | null;
    readonly earliestActiveHour: number | null;
    /** 当前小时最常做的事（学出来的）。 */
    readonly typicalNow: SceneKind | null;
  };
  readonly lastIntervention: InterventionRecord | null;
  readonly interventionsToday: number;
  /** 摄像头是否已授权且渲染层已就绪。 */
  readonly cameraReady: boolean;
  /** 窗口上下文（"开着什么 / 最上层是哪个"）——面板展示与排错用。 */
  readonly windowContext: {
    /** 最近一次枚举到的窗口条数。 */
    readonly count: number;
    readonly foregroundTitle: string;
    readonly foregroundProcess: string;
    /** 前几条窗口标题（预览，最多 5 条）。 */
    readonly sample: readonly string[];
    /** 探测是否处于失败退避（没有 PowerShell 等情况）。 */
    readonly backingOff: boolean;
  };
  /**
   * 终端文本这一路的可审计状态（"她到底读到没有 / 读到了多少 / 为什么没发"）。
   *
   * 为什么要在状态里留它：这一路只在"前台正好是终端"时才动，平时完全静默；
   * 有了这条读数，用户与验收都能回答"她有没有真的读到终端、是不是被敏感词拦下了"，
   * 而不用去猜（终端文本本身仍然一个字节都不落盘）。
   */
  readonly terminalText: {
    readonly state: 'idle' | 'non-terminal' | 'no-text' | 'captured' | 'withheld' | 'backing-off';
    /** 最近一次真的读到文本的进程名（没读到过就是空串）。 */
    readonly process: string;
    /** 缓冲区原始长度（说明"确实读到了东西"，但不落盘）。 */
    readonly rawLength: number;
    /** 实际留给模型的字符数（尾部截断 + 打码之后）。 */
    readonly keptChars: number;
    /** 最近一次读到的时间（ISO；没读到过就是空串）。 */
    readonly at: string;
  };
  /** 数据目录（观察记录与习惯画像都在里面）。 */
  readonly dataDir: string;
  readonly lastError: string;
}

/** 感知日志（可审计：她到底看见了什么、为什么开口）。 */
export interface PerceptionLogItem {
  readonly at: string;
  readonly kind: 'observation' | 'intervention' | 'presence' | 'privacy' | 'habits' | 'camera' | 'system';
  readonly text: string;
}

/**
 * 3.2 按需"看屏幕"的动作。
 *
 * 只剩一个值，但仍然保留这个类型：`viewNow` 的入参、日志与结果里都要写明"这是哪次动作"，
 * 而 IPC 白名单也靠它做校验（见 ipc-manager）。
 */
export type PerceptionViewMode = 'scene';

export interface PerceptionViewResult {
  readonly ok: boolean;
  readonly mode: PerceptionViewMode;
  /** 给用户看的文字（进气泡/聊天窗口）。 */
  readonly text: string;
  readonly scene: SceneKind;
  readonly sensitive: boolean;
  readonly tokens: number;
  readonly error: string;
}

/** 摄像头一帧的分析结果。 */
export interface CameraFrameResult {
  readonly ok: boolean;
  readonly present: boolean;
  readonly expression: string;
  readonly stranger: boolean;
  readonly posture: string;
  readonly mode: 'llm' | 'local';
  readonly error: string;
}

/* -------------------------------------------------------------------------- */
/* 四、纯函数：清洗配置                                                        */
/* -------------------------------------------------------------------------- */

function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 把任意来源的 JSON 清洗成合法感知配置（坏字段一律回落默认值）。 */
export function sanitizePerceptionSettings(
  raw: unknown,
  fallback: PerceptionSettings = DEFAULT_PERCEPTION_SETTINGS,
): PerceptionSettings {
  if (typeof raw !== 'object' || raw === null) return { ...fallback };
  const record = raw as Record<string, unknown>;
  const quietRaw = (typeof record.quietHours === 'object' && record.quietHours !== null
    ? record.quietHours
    : {}) as Record<string, unknown>;
  const keywords = Array.isArray(record.sensitivityKeywords)
    ? (record.sensitivityKeywords as unknown[])
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim().slice(0, 40))
        .slice(0, 100)
    : fallback.sensitivityKeywords;
  const fixes = Array.isArray(record.sceneFixes)
    ? (record.sceneFixes as unknown[])
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim().slice(0, 60))
        .slice(0, 100)
    : fallback.sceneFixes;

  return {
    screen: bool(record.screen, fallback.screen),
    behavior: bool(record.behavior, fallback.behavior),
    camera: bool(record.camera, fallback.camera),
    habits: bool(record.habits, fallback.habits),
    privacyMode: bool(record.privacyMode, fallback.privacyMode),
    hideFromCapture: bool(record.hideFromCapture, fallback.hideFromCapture),
    captureIntervalMs: num(record.captureIntervalMs, fallback.captureIntervalMs, 5000, 3600000),
    captureWidth: num(record.captureWidth, fallback.captureWidth, 160, 1920),
    captureUrl: bool(record.captureUrl, fallback.captureUrl),
    urlCaptureWidth: num(record.urlCaptureWidth, fallback.urlCaptureWidth, 640, 3840),
    storeFullUrl: bool(record.storeFullUrl, fallback.storeFullUrl),
    windowContext: bool(record.windowContext, fallback.windowContext),
    windowListLimit: num(record.windowListLimit, fallback.windowListLimit, 1, 24),
    windowProbeTtlMs: num(record.windowProbeTtlMs, fallback.windowProbeTtlMs, 5000, 600000),
    terminalText: bool(record.terminalText, fallback.terminalText),
    cameraIntervalMs: num(record.cameraIntervalMs, fallback.cameraIntervalMs, 10000, 3600000),
    cameraAuthorized: bool(record.cameraAuthorized, fallback.cameraAuthorized),
    proactiveMinIntervalMs: num(record.proactiveMinIntervalMs, fallback.proactiveMinIntervalMs, 60000, 86400000),
    proactiveMaxPerHour: num(record.proactiveMaxPerHour, fallback.proactiveMaxPerHour, 0, 60),
    quietHours: {
      start: num(quietRaw.start, fallback.quietHours.start, 0, 23),
      end: num(quietRaw.end, fallback.quietHours.end, 0, 23),
    },
    longSessionMinutes: num(record.longSessionMinutes, fallback.longSessionMinutes, 10, 1440),
    lateNightHour: num(record.lateNightHour, fallback.lateNightHour, 0, 6),
    sensitivityKeywords: keywords,
    sceneFixes: fixes,
  };
}

/** 应用补丁（未给出的字段保持原值）。 */
export function applyPerceptionPatch(
  current: PerceptionSettings,
  patch: PerceptionSettingsPatch,
): PerceptionSettings {
  const quiet = patch.quietHours
    ? { start: patch.quietHours.start ?? current.quietHours.start, end: patch.quietHours.end ?? current.quietHours.end }
    : current.quietHours;
  return sanitizePerceptionSettings({ ...current, ...patch, quietHours: quiet }, current);
}

