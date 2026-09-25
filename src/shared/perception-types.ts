/**
 * 环境与用户感知系统（3.1~3.6）的跨进程契约。
 *
 * 需求四条落点：
 * - 3.1 屏幕感知：周期性截图 + 视觉模型 -> 判断"在写代码/读论文/看视频/打游戏/长时间没动"
 * - 3.2 OCR 与内容理解：按需"看屏幕"做 OCR / 读网页 / 总结 PDF / 分析报错
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
  /** 3.2 多模态内容理解（OCR/总结/报错分析）；关掉后只能拿到"场景分类"。 */
  readonly vision: boolean;
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
}

export const DEFAULT_PERCEPTION_SETTINGS: PerceptionSettings = {
  // 需求：「默认模式全开」
  screen: true,
  vision: true,
  behavior: true,
  camera: true,
  habits: true,
  privacyMode: false,
  hideFromCapture: true,
  captureIntervalMs: 30000,
  captureWidth: 640,
  cameraIntervalMs: 60000,
  // 唯一默认关闭的一项：摄像头必须用户显式授权（需求 3.5 原文）
  cameraAuthorized: false,
  proactiveMinIntervalMs: 10 * 60000,
  proactiveMaxPerHour: 4,
  quietHours: { start: 23, end: 8 },
  longSessionMinutes: 120,
  lateNightHour: 1,
  sensitivityKeywords: ['密码', '银行', '支付', '身份证', '私密', 'password', 'bank', 'paypal', '1password'],
};

/** 设置补丁（部分字段）。 */
export interface PerceptionSettingsPatch {
  readonly screen?: boolean;
  readonly vision?: boolean;
  readonly behavior?: boolean;
  readonly camera?: boolean;
  readonly habits?: boolean;
  readonly privacyMode?: boolean;
  readonly hideFromCapture?: boolean;
  readonly captureIntervalMs?: number;
  readonly captureWidth?: number;
  readonly cameraIntervalMs?: number;
  readonly cameraAuthorized?: boolean;
  readonly proactiveMinIntervalMs?: number;
  readonly proactiveMaxPerHour?: number;
  readonly quietHours?: { readonly start?: number; readonly end?: number };
  readonly longSessionMinutes?: number;
  readonly lateNightHour?: number;
  readonly sensitivityKeywords?: readonly string[];
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

/** 3.2 按需"看屏幕"的动作。 */
export type PerceptionViewMode = 'scene' | 'ocr' | 'summarize' | 'error' | 'code';

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

  return {
    screen: bool(record.screen, fallback.screen),
    vision: bool(record.vision, fallback.vision),
    behavior: bool(record.behavior, fallback.behavior),
    camera: bool(record.camera, fallback.camera),
    habits: bool(record.habits, fallback.habits),
    privacyMode: bool(record.privacyMode, fallback.privacyMode),
    hideFromCapture: bool(record.hideFromCapture, fallback.hideFromCapture),
    captureIntervalMs: num(record.captureIntervalMs, fallback.captureIntervalMs, 5000, 3600000),
    captureWidth: num(record.captureWidth, fallback.captureWidth, 160, 1920),
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

