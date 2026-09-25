/**
 * 环境与用户感知系统的**纯函数模型**（3.1~3.6 里所有"判断"都在这儿）。
 *
 * 为什么把判断单独抽出来：
 * - 主动打扰的频率控制、习惯预测、深夜判定这些规则**必须可被直接断言**，
 *   否则只能靠"跑一天看看她烦不烦我"来验证；
 * - 感知的采样、截图、模型调用都是 IO，混在一起会让规则无法单独测试。
 *
 * 决策链（需求 3.4 原文的行为决策流程）：
 *
 *   环境观察（ScreenObservation / BehaviorSnapshot）
 *        ↓
 *   状态推测（inferUserState）
 *        ↓
 *   判断是否需要干预（planIntervention + 频率闸门）
 *        ↓
 *   选择合适的行为与表达（动画 + 台词，见 main/perception/intervention.ts）
 */

import type {
  BehaviorSnapshot,
  HabitProfile,
  PerceptionSettings,
  SceneKind,
  ScreenObservation,
  UserState,
} from './perception-types';

/* -------------------------------------------------------------------------- */
/* 一、词表与展示                                                              */
/* -------------------------------------------------------------------------- */

/** 场景 -> 中文标签（UI/台词共用）。 */
export const SCENE_LABELS: Readonly<Record<SceneKind, string>> = {
  coding: '写代码',
  reading: '读论文/文档',
  video: '看视频',
  gaming: '打游戏',
  meeting: '开会',
  browsing: '浏览网页',
  chatting: '聊天',
  writing: '写东西',
  terminal: '命令行',
  idle: '没在动',
  sensitive: '私人内容',
  other: '说不清',
};

/** 场景 -> 她开口时的说法（"主人开始写代码了"）。 */export const SCENE_OPENERS: Readonly<Record<SceneKind, string>> = {
  coding: '主人开始写代码了，加油！',
  reading: '在看论文呀，我陪你。',
  video: '在看视频呀，好看吗？',
  gaming: '打游戏啦？赢了要告诉我哦。',
  meeting: '在开会呀，我先安静一下。',
  browsing: '在翻网页呢。',
  chatting: '在和人聊天呀。',
  writing: '在写东西，好认真。',
  terminal: '在敲命令，别打错字哦。',
  idle: '屏幕好久没动了……主人还在吗？',
  sensitive: '唔……这个我不看，捂住眼睛。',
  other: '主人现在在忙什么呢？',
};

export function sceneLabel(scene: SceneKind): string {
  return SCENE_LABELS[scene] ?? '说不清';
}

/** 模型可能返回的近义词 -> 受控词表（脏数据不能进习惯统计）。 */
export function normalizeScene(raw: unknown): SceneKind {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === '') return 'other';
  const direct = Object.keys(SCENE_LABELS) as SceneKind[];
  if ((direct as string[]).includes(value)) return value as SceneKind;
  const map: Readonly<Record<string, SceneKind>> = {
    code: 'coding',
    coding: 'coding',
    programming: 'coding',
    ide: 'coding',
    develop: 'coding',
    reading: 'reading',
    paper: 'reading',
    pdf: 'reading',
    docs: 'reading',
    video: 'video',
    movie: 'video',
    youtube: 'video',
    bilibili: 'video',
    game: 'gaming',
    gaming: 'gaming',
    meeting: 'meeting',
    call: 'meeting',
    zoom: 'meeting',
    web: 'browsing',
    browser: 'browsing',
    browsing: 'browsing',
    social: 'chatting',
    chat: 'chatting',
    im: 'chatting',
    writing: 'writing',
    email: 'writing',
    word: 'writing',
    terminal: 'terminal',
    shell: 'terminal',
    console: 'terminal',
    idle: 'idle',
    away: 'idle',
    blank: 'idle',
    private: 'sensitive',
    sensitive: 'sensitive',
  };
  return map[value] ?? 'other';
}

/* -------------------------------------------------------------------------- */
/* 二、行为推测（3.4）                                                         */
/* -------------------------------------------------------------------------- */

/** 空闲/在场阈值（秒）。 */
export const IDLE_THRESHOLDS = {
  /** 多久没动算"走神"。 */
  idle: 120,
  /** 多久没动算"人不在"。 */
  away: 300,
  /** 一次会话超过这么久没动就重新开始计时。 */
  sessionBreak: 600,
} as const;

/** 由"系统空闲秒数"推测用户状态。 */
export function inferUserState(idleSeconds: number, switchesLastHour: number): UserState {
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return 'unknown';
  if (idleSeconds >= IDLE_THRESHOLDS.away) return 'away';
  if (idleSeconds >= IDLE_THRESHOLDS.idle) return 'idle';
  // 频繁切换 -> 注意力分散（浅层活跃）
  if (switchesLastHour >= 8) return 'shallow';
  return 'deep';
}

/**
 * 统计"最近一小时的场景切换次数"。
 *
 * 采样粒度就是屏幕采样间隔（默认 30s），所以这个数字是**粗粒度**的：
 * 它衡量的是"半小时里换了多少个不同场景"，而不是真实的窗口切换次数。
 * 这一点写在文档里 —— 不要假装它是精确的焦点日志。
 */
export function countSwitches(
  observations: readonly Pick<ScreenObservation, 'at' | 'scene'>[],
  now: number,
  windowMs = 3600000,
): number {
  const from = now - windowMs;
  let count = 0;
  let previous: string | null = null;
  for (const item of observations) {
    const at = Date.parse(item.at);
    if (!Number.isFinite(at) || at < from) continue;
    if (previous !== null && previous !== item.scene) count += 1;
    previous = item.scene;
  }
  return count;
}

/** 是否深夜（0 点后到凌晨，默认 1~5 点）。 */
export function isLateNight(hour: number, lateNightHour: number): boolean {
  return hour >= lateNightHour && hour < 5;
}

/** 免打扰时段判断（支持跨零点，例如 23 点到次日 8 点）。 */
export function isQuietHour(hour: number, quiet: { readonly start: number; readonly end: number }): boolean {
  const start = ((quiet.start % 24) + 24) % 24;
  const end = ((quiet.end % 24) + 24) % 24;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** 组装行为快照（纯计算，方便验收直接喂数据）。 */
export function buildBehaviorSnapshot(input: {
  readonly idleSeconds: number;
  readonly sessionStartedAt: number;
  readonly observations: readonly Pick<ScreenObservation, 'at' | 'scene'>[];
  readonly now: number;
  readonly settings: PerceptionSettings;
}): BehaviorSnapshot {
  const hour = new Date(input.now).getHours();
  const switchesLastHour = countSwitches(input.observations, input.now);
  const sessionMinutes = Math.max(0, Math.round((input.now - input.sessionStartedAt) / 60000));
  return {
    idleSeconds: Math.max(0, Math.round(input.idleSeconds)),
    sessionMinutes,
    switchesLastHour,
    hour,
    lateNight: isLateNight(hour, input.settings.lateNightHour),
    userState: inferUserState(input.idleSeconds, switchesLastHour),
  };
}

/* -------------------------------------------------------------------------- */
/* 二点五、场景纠正（"浏览器被认成笔记软件"这类误判的确定性补救）                    */
/* -------------------------------------------------------------------------- */

/**
 * 常见的**浏览器**应用名片段。
 *
 * 为什么需要一张表：视觉模型经常能正确读出应用名（"Chrome"），
 * 却把"浏览器里看一篇长文"判成 `writing`（写东西/记笔记）——
 * 用户实测反馈："浏览网页总是被识别成笔记软件记笔记"。
 * 只靠提示词说服模型不可靠，这里按**应用名**做一次确定性纠正。
 */
export const BROWSER_APPS: readonly string[] = [
  'chrome',
  'edge',
  'firefox',
  'brave',
  'vivaldi',
  'opera',
  'safari',
  'arc',
  '浏览器',
  '360se',
  'qqbrowser',
];

/** 笔记/文档编辑类应用（这些被判成 writing 才是对的）。 */
export const EDITOR_APPS: readonly string[] = [
  'obsidian',
  'notion',
  'logseq',
  'roam',
  'typora',
  'onenote',
  'evernote',
  'joplin',
  'word',
  'pages',
  'docs',
  '语雀',
  '印象笔记',
  '有道云',
  '为知',
  '备忘录',
  'notes',
  'ulysses',
  'scrivener',
];

/** 影音类应用。 */
export const VIDEO_APPS: readonly string[] = ['bilibili', 'youtube', 'netflix', 'potplayer', 'vlc', 'mpv', 'iqiyi', '腾讯视频', '爱奇艺', '斗鱼', 'twitch'];

/** 游戏平台（与"看视频"区分开）。 */
export const GAME_APPS: readonly string[] = ['steam', 'epic', 'battle.net', 'wegame', '原神', 'minecraft'];

/**
 * 应用名匹配（**短英文词按"词"匹配**）。
 *
 * 为什么不能一律用 `includes`：应用名表里有 `arc` / `edge` / `docs` / `notes` / `pages`
 * 这类短词，子串匹配会误伤一大片 —— 实测反例：
 *   - "Se**arc**h" 含 `arc`  -> 被判成浏览器；
 *   - "Knowl**edge**" 含 `edge` -> 被判成浏览器；
 *   - "WordPress" 含 `word` -> 被判成编辑器。
 * 因此短英文词要求前后不是字母/数字（词边界），中文词没有词边界概念，仍用子串匹配。
 * （这条是文档评审从代码里看出来的，属于"少一个反例就会一直误判"的典型。）
 */
export function matchesAppName(name: string, entry: string): boolean {
  const haystack = (name ?? '').toLowerCase();
  const needle = (entry ?? '').toLowerCase();
  if (needle === '' || haystack === '') return false;
  // 含非 ASCII（中文等）：直接子串
  if (!/^[\x20-\x7e]+$/.test(needle)) return haystack.includes(needle);
  // 短英文词：按词边界匹配，避免命中单词内部
  if (needle.length <= 5) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
  }
  return haystack.includes(needle);
}

export type AppKind = 'browser' | 'editor' | 'video' | 'game' | 'unknown';

/** 从应用名（模型给的，可能是"Google Chrome"这种）判断大致类别。 */
export function appKind(app: string): AppKind {
  const name = (app ?? '').toLowerCase();
  if (name.trim() === '') return 'unknown';
  if (VIDEO_APPS.some((item) => matchesAppName(name, item))) return 'video';
  if (GAME_APPS.some((item) => matchesAppName(name, item))) return 'game';
  if (EDITOR_APPS.some((item) => matchesAppName(name, item))) return 'editor';
  if (BROWSER_APPS.some((item) => matchesAppName(name, item))) return 'browser';
  return 'unknown';
}

/**
 * 解析用户自定义的纠正规则（每行 `关键词=场景`，例如 `Chrome=browsing`）。
 *
 * 词表与模型输出用的是同一套受控值，非法行直接忽略（宁可少纠正，不要乱纠正）。
 */
export function parseSceneFixes(lines: readonly string[]): { keyword: string; scene: SceneKind }[] {
  const out: { keyword: string; scene: SceneKind }[] = [];
  for (const line of lines) {
    const text = (line ?? '').trim();
    if (text === '' || text.startsWith('#')) continue;
    const separator = /[=＝:：]/.exec(text);
    if (!separator) continue;
    const keyword = text.slice(0, separator.index).trim().toLowerCase();
    const rawScene = text.slice(separator.index + 1).trim().toLowerCase();
    if (keyword === '') continue;
    const scene = normalizeScene(rawScene);
    // normalizeScene 会把不认识的值收敛成 'other'：显式写 'other' 才算数，否则视为无效行
    if (scene === 'other' && rawScene !== 'other') continue;
    out.push({ keyword: keyword.slice(0, 40), scene });
  }
  return out.slice(0, 100);
}

export interface SceneRefineInput {
  /** 模型给出的场景。 */
  readonly scene: SceneKind;
  /** 模型读到的应用名。 */
  readonly app: string;
  /** 模型是否看到浏览器界面（地址栏/标签页/书签栏）。 */
  readonly browserChrome?: boolean;
  /** 模型是否看到编辑器界面（光标、行号、笔记侧栏、编辑工具栏）。 */
  readonly editorChrome?: boolean;
  /** 用户自定义纠正规则。 */
  readonly fixes?: readonly string[];
}

/**
 * 对模型给出的场景做**确定性纠正**（纯函数，可被验收直接断言）。
 *
 * 规则优先级（越靠前越优先）：
 * 1. **用户自定义纠正**（`Chrome=browsing`）—— 用户说了算；
 * 2. **应用名判类**：
 *    - 浏览器/影音/游戏应用里出现 `writing`，一律纠正为 `browsing`
 *      （在浏览器里看文档不等于在写笔记 —— 这正是用户反馈的那个误判）；
 *    - 笔记/文档应用里出现 `browsing`/`other`，纠正为 `writing`；
 *    - 影音应用只把 `other`/`idle` 之外的"做事类"标签收敛到 `video`/`gaming` 时保守处理：
 *      仅纠正模型自相矛盾的组合（影音应用 + writing/reading/coding）。
 * 3. **界面线索**：只有"看到浏览器界面且没有编辑器界面"时才把 `writing` 拉回 `browsing`；
 *    两条线索同时缺失或同时存在时**不做纠正**（信息不足时保持模型判断）。
 *
 * 说明：这里刻意**不做**"看到代码就改成 coding"之类的猜测 —— 纠正必须能解释，
 * 否则只是把一种误判换成另一种。
 */
export function refineScene(input: SceneRefineInput): { scene: SceneKind; reason: string } {
  const rawScene = input.scene;
  const app = input.app ?? '';
  const kind = appKind(app);

  // 1) 用户自定义规则优先（关键词匹配应用名或场景名）
  const fixes = parseSceneFixes(input.fixes ?? []);
  const loweredApp = app.toLowerCase();
  for (const fix of fixes) {
    if (loweredApp.includes(fix.keyword)) {
      return { scene: fix.scene, reason: `用户规则「${fix.keyword}=${fix.scene}」` };
    }
  }

  // 2) 应用名判类
  if (kind === 'browser' && (rawScene === 'writing' || rawScene === 'terminal')) {
    return { scene: 'browsing', reason: `浏览器应用（${app.trim()}）里不算写笔记` };
  }
  if (kind === 'browser' && rawScene === 'other' && input.browserChrome === true && input.editorChrome !== true) {
    return { scene: 'browsing', reason: '看到浏览器界面且没有编辑器界面' };
  }
  if (kind === 'editor' && (rawScene === 'browsing' || rawScene === 'other')) {
    return { scene: 'writing', reason: `笔记/文档应用（${app.trim()}）` };
  }
  if (kind === 'video' && (rawScene === 'writing' || rawScene === 'reading' || rawScene === 'coding')) {
    return { scene: 'video', reason: `影音应用（${app.trim()}）` };
  }
  if (kind === 'game' && (rawScene === 'writing' || rawScene === 'reading' || rawScene === 'coding')) {
    return { scene: 'gaming', reason: `游戏应用（${app.trim()}）` };
  }

  // 3) 界面线索（信息不足时不纠正）
  if (rawScene === 'writing' && input.browserChrome === true && input.editorChrome !== true) {
    return { scene: 'browsing', reason: '看到浏览器界面（地址栏/标签页），没有编辑器界面' };
  }
  if (rawScene === 'browsing' && input.editorChrome === true && input.browserChrome !== true) {
    return { scene: 'writing', reason: '看到编辑器界面（光标/行号/笔记侧栏）' };
  }

  return { scene: rawScene, reason: '' };
}

/* -------------------------------------------------------------------------- */
/* 三、主动打扰闸门（3.4 的"重点控制主动交互频率"）                                */
/* -------------------------------------------------------------------------- */

export type InterventionKind =
  | 'greeting'
  | 'long-session'
  | 'late-night'
  | 'scene-change'
  | 'sensitive'
  | 'presence'
  | 'stranger'
  | 'habit'
  | 'error-help';

export interface InterventionGateInput {
  readonly now: number;
  readonly kind: InterventionKind;
  readonly settings: PerceptionSettings;
  /** 上次任何主动打扰的时间（0 = 从未）。 */
  readonly lastInterventionAt: number;
  /** 最近一小时已打扰次数。 */
  readonly lastHourCount: number;
  readonly behavior: BehaviorSnapshot;
}

export interface InterventionDecision {
  readonly allow: boolean;
  /** 允许/拒绝的**具体原因**（写进日志，用户能查到"她为什么没说话"）。 */
  readonly reason: string;
}

/** 情绪/紧急类干预不受频率闸门限制（例如敏感内容要立刻躲开、陌生人要提醒）。 */
const URGENT_KINDS: readonly InterventionKind[] = ['sensitive', 'stranger'];

/**
 * 频率闸门：决定"这次要不要开口"。
 *
 * 三档拦截（顺序即优先级）：
 * 1. 敏感内容等紧急行为不受限（但也不能刷屏，仍受 1 分钟硬下限约束）；
 * 2. 免打扰时段一律不主动出声；
 * 3. 最小间隔 + 每小时上限 —— 这是"避免过度打扰"的主要手段。
 */
export function gateIntervention(input: InterventionGateInput): InterventionDecision {
  const elapsed = input.now - input.lastInterventionAt;
  const urgent = URGENT_KINDS.includes(input.kind);

  // 硬下限：一分钟内绝不连说两次（紧急也一样，避免"躲"这个动作被刷）
  if (input.lastInterventionAt > 0 && elapsed < 60000) {
    return { allow: false, reason: `距上次打扰仅 ${Math.round(elapsed / 1000)}s（硬下限 60s）` };
  }
  if (urgent) return { allow: true, reason: '紧急行为（不受频率上限限制）' };

  const hour = new Date(input.now).getHours();
  if (isQuietHour(hour, input.settings.quietHours)) {
    return { allow: false, reason: `免打扰时段（${input.settings.quietHours.start}:00–${input.settings.quietHours.end}:00）` };
  }
  if (input.behavior.userState === 'away' || input.behavior.userState === 'idle') {
    return { allow: false, reason: `用户不在/空闲（state=${input.behavior.userState}）` };
  }
  if (input.lastHourCount >= input.settings.proactiveMaxPerHour) {
    return { allow: false, reason: `本小时已达上限（${input.lastHourCount}/${input.settings.proactiveMaxPerHour}）` };
  }
  if (input.lastInterventionAt > 0 && elapsed < input.settings.proactiveMinIntervalMs) {
    const remain = Math.round((input.settings.proactiveMinIntervalMs - elapsed) / 60000);
    return { allow: false, reason: `距上次打扰不足最小间隔（还剩约 ${remain} 分钟）` };
  }
  return { allow: true, reason: '通过频率闸门' };
}

/* -------------------------------------------------------------------------- */
/* 三点五、干预归属（哪一类干预归哪个开关管）                                      */
/* -------------------------------------------------------------------------- */

/**
 * 这一类干预是否属于"已打开的那个子系统"。
 *
 * 为什么需要它：只关掉"行为观察"、留着"习惯学习"时，久坐/深夜提醒如果照旧触发，
 * 用户会觉得开关是假的（文档评审抓到过这一条）。因此每一类干预都必须归属到具体开关：
 *
 * | 干预 | 归属开关 |
 * | --- | --- |
 * | 久坐 / 深夜 / 场景变化 | `behavior` |
 * | 习惯预测 | `habits` |
 * | 敏感内容 | `screen` 或 `camera`（要么没采，要么别提） |
 * | 在场 / 陌生人 | `camera` |
 */
export function isPlanEnabled(kind: InterventionKind, settings: PerceptionSettings): boolean {
  switch (kind) {
    case 'long-session':
    case 'late-night':
    case 'scene-change':
      return settings.behavior;
    case 'habit':
      return settings.habits;
    case 'sensitive':
      return settings.screen || settings.camera;
    case 'presence':
    case 'stranger':
      return settings.camera;
    default:
      return settings.behavior || settings.habits;
  }
}

/* -------------------------------------------------------------------------- */
/* 四、干预规划（3.4 的"判断是否需要干预"）                                       */
/* -------------------------------------------------------------------------- */

export interface InterventionPlan {
  readonly kind: InterventionKind;
  readonly text: string;
  /** 建议她演的动画（id 需真实存在，不存在的会被丢弃）。 */
  readonly animation: string | null;
  /** 是否需要"捂住眼睛躲起来"（敏感内容）。 */
  readonly hide: boolean;
}

/**
 * 根据观察结果规划一次干预；返回 null 表示"这次不需要打扰"。
 *
 * 优先级（高 -> 低）：
 *   敏感内容 > 深夜提醒 > 连续使用过久 > 场景变化打招呼 > 习惯预测
 */
export function planIntervention(input: {
  readonly observation: ScreenObservation | null;
  readonly behavior: BehaviorSnapshot;
  readonly settings: PerceptionSettings;
  readonly habitText?: string | null;
  /** 上一个场景（用于判断"变化"）。 */
  readonly previousScene: SceneKind | null;
}): InterventionPlan | null {
  const { observation, behavior, settings } = input;

  // 1) 敏感内容：立刻捂眼睛躲起来（这是唯一"躲"的行为）
  if (observation?.sensitive === true) {
    return {
      kind: 'sensitive',
      text: '唔……这个我不看，捂住眼睛。',
      animation: 'peek',
      hide: true,
    };
  }

  // 2) 深夜还在电脑前
  //    注意：这一条**不需要模型**（只看本地时间），所以没有观察结果时也要能触发 ——
  //    没配密钥的用户同样应该被提醒"该睡了"。
  if (behavior.lateNight && (observation === null || observation.scene !== 'idle')) {
    return {
      kind: 'late-night',
      text: `已经 ${behavior.hour} 点啦……我有点困了，你也早点休息吧。`,
      animation: 'sleep',
      hide: false,
    };
  }

  // 3) 连续使用过久
  if (behavior.sessionMinutes >= settings.longSessionMinutes && behavior.idleSeconds < IDLE_THRESHOLDS.idle) {
    const hours = (behavior.sessionMinutes / 60).toFixed(1);
    return {
      kind: 'long-session',
      text: `已经连续坐了 ${hours} 小时啦，要不要起来活动一下？`,
      animation: 'remind',
      hide: false,
    };
  }

  // 4) 场景变化：只在"从别的事换到新的事"且是新场景时打招呼
  if (
    observation &&
    input.previousScene !== null &&
    input.previousScene !== observation.scene &&
    observation.scene !== 'idle' &&
    observation.scene !== 'other'
  ) {
    return {
      kind: 'scene-change',
      text: SCENE_OPENERS[observation.scene],
      animation: observation.scene === 'gaming' ? 'cute' : 'talk',
      hide: false,
    };
  }

  // 5) 习惯预测（3.6）：只在她真的学到东西、且和"上一件事"不同的时候说
  if (input.habitText) {
    return { kind: 'habit', text: input.habitText, animation: 'talk', hide: false };
  }

  // 6) 用户在做事时报错求助（3.2）：模型给了 suggestion 才说
  if (observation?.suggestion) {
    return {
      kind: 'error-help',
      text: observation.suggestion,
      animation: 'read',
      hide: false,
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* 五、习惯学习（3.6）                                                         */
/* -------------------------------------------------------------------------- */

export function emptyHabitProfile(now: string = new Date().toISOString()): HabitProfile {
  return {
    hours: {},
    observedHours: 0,
    samples: 0,
    activeDays: 0,
    latestActiveHour: null,
    earliestActiveHour: null,
    lastActiveDate: '',
    updatedAt: now,
  };
}

/**
 * 把一次观察并入习惯画像（**纯函数**，返回新的 profile）。
 *
 * 这里只做"时间序列统计"里最朴素的一层：按小时直方图。
 * 需求里提到的强化学习 / Contextual Bandit 属于"要做成个性化推荐系统"的路径，
 * 当前版本刻意停在**可解释的统计模型**上：用户能看懂"她学会了我 10 点在写代码"，
 * 也才敢让它影响行为。（见文档"已知限制"）
 */
export function learnHabit(profile: HabitProfile, observation: ScreenObservation): HabitProfile {
  const at = new Date(observation.at);
  if (Number.isNaN(at.getTime())) return profile;
  if (observation.scene === 'idle' || observation.scene === 'sensitive') return profile;

  const hour = String(at.getHours());
  const dateKey = observation.at.slice(0, 10);
  const hours: Record<string, Record<string, number>> = { ...profile.hours };
  const bucket: Record<string, number> = { ...(hours[hour] ?? {}) };
  bucket[observation.scene] = (bucket[observation.scene] ?? 0) + 1;
  hours[hour] = bucket;

  const observedHours = Object.keys(hours).length;
  const newDay = profile.lastActiveDate !== dateKey;
  const activeDays = newDay && profile.lastActiveDate !== '' ? profile.activeDays + 1 : profile.lastActiveDate === '' ? 1 : profile.activeDays;

  const hourNumber = at.getHours();
  const latestActiveHour = profile.latestActiveHour === null ? hourNumber : Math.max(profile.latestActiveHour, hourNumber);
  const earliestActiveHour = profile.earliestActiveHour === null ? hourNumber : Math.min(profile.earliestActiveHour, hourNumber);

  return {
    hours,
    observedHours,
    samples: profile.samples + 1,
    activeDays,
    latestActiveHour,
    earliestActiveHour,
    lastActiveDate: dateKey,
    updatedAt: new Date().toISOString(),
  };
}

/** 某小时最常做的事（样本太少时返回 null）。 */
export function topSceneAtHour(profile: HabitProfile, hour: number, minSamples = 2): SceneKind | null {
  const bucket = profile.hours[String(hour)];
  if (!bucket) return null;
  let best: { scene: string; count: number } | null = null;
  let total = 0;
  for (const [scene, count] of Object.entries(bucket)) {
    total += count;
    if (!best || count > best.count) best = { scene, count };
  }
  if (!best || total < minSamples) return null;
  return normalizeScene(best.scene);
}

/**
 * 生成"按你的习惯…"这类台词。
 *
 * @returns 台词；没有足够数据时返回 null（**她不该在没学会的时候装懂**）
 */
export function habitPredictionText(input: {
  readonly profile: HabitProfile;
  readonly now: number;
  readonly settings: PerceptionSettings;
  readonly behavior: BehaviorSnapshot;
}): string | null {
  const hour = new Date(input.now).getHours();
  const typical = topSceneAtHour(input.profile, hour);
  if (!typical) return null;

  // 深夜：拿"平时最晚几点还在"对比（3.6 的原例）
  if (input.behavior.lateNight && input.profile.latestActiveHour !== null) {
    const over = hour - input.profile.latestActiveHour;
    if (over >= 2) return `今天已经比你平时睡觉的时间晚 ${over} 个小时了……`;
  }

  if (typical === 'idle') return null;
  return `按你平时的习惯，这个点一般在${sceneLabel(typical)}，今天也是吗？`;
}

/** 画像的一句话摘要（设置界面展示）。 */
export function describeHabits(profile: HabitProfile): string {
  if (profile.samples === 0) return '还没学到东西（打开感知后我会慢慢记）';
  const parts = [
    `采样 ${profile.samples} 次`,
    `覆盖 ${profile.observedHours} 个整点`,
    `活跃 ${profile.activeDays} 天`,
  ];
  if (profile.earliestActiveHour !== null && profile.latestActiveHour !== null) {
    parts.push(`通常 ${profile.earliestActiveHour}:00 – ${profile.latestActiveHour}:00 在线`);
  }
  return parts.join(' · ');
}

/* -------------------------------------------------------------------------- */
/* 六、隐私与敏感                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 关键词敏感判定（模型之外的第二道闸）。
 *
 * 为什么要有它：模型可能没意识到"这是私人内容"，而关键词是**确定性**的。
 * 两道闸任意一道命中都按敏感处理（宁可不看）。
 */
export function matchesSensitiveKeywords(text: string, keywords: readonly string[]): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return keywords.some((keyword) => {
    const needle = keyword.trim().toLowerCase();
    return needle.length > 0 && haystack.includes(needle);
  });
}

/** 综合判定（模型 flag + 关键词）。 */
export function isSensitive(observation: Pick<ScreenObservation, 'app' | 'activity' | 'summary' | 'sensitive'>, keywords: readonly string[]): boolean {
  if (observation.sensitive) return true;
  return matchesSensitiveKeywords(`${observation.app} ${observation.activity} ${observation.summary}`, keywords);
}

/** 当前是否能采集；不能时给出人类可读原因（UI 直接显示）。 */
export function capturePermission(settings: PerceptionSettings): { allowed: boolean; reason: string } {
  if (settings.privacyMode) return { allowed: false, reason: '隐私模式开启中（一键停止一切采集）' };
  if (!settings.screen) return { allowed: false, reason: '屏幕感知开关未打开' };
  return { allowed: true, reason: '' };
}
