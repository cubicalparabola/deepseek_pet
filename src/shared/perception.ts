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
  /** 模型从地址栏读到的网址（可空；空串表示没读出来）。 */
  readonly url?: string;
  /** 最上层窗口（进程名 + 标题）——比像素更具体的证据。 */
  readonly window?: { readonly process: string; readonly title: string } | null;
  /** 用户自定义纠正规则。 */
  readonly fixes?: readonly string[];
}

/**
 * 对模型给出的场景做**确定性纠正**（纯函数，可被验收直接断言）。
 *
 * 规则优先级（越靠前越优先）：
 * 1. **用户自定义纠正**（`Chrome=browsing`）—— 用户说了算；
 * 2. **网址域名**（`youtube.com` -> 看视频、`arxiv.org` -> 读论文；任何网页 + 写东西 -> 浏览网页）；
 * 3. **最上层窗口**（进程名 + 标题：`Typora` -> 写东西、`Code` -> 写代码、标题含 `.pdf` -> 读论文）；
 * 4. **应用名判类**（模型从画面里读到的应用名）；
 * 5. **界面线索**（browserChrome / editorChrome；两者都缺或都有时不动）。
 *
 * 说明：这里刻意**不做**"看到代码就改成 coding"之类的猜测 —— 纠正必须能解释，
 * 否则只是把一种误判换成另一种。
 */
export function refineScene(input: SceneRefineInput): { scene: SceneKind; reason: string } {
  const app = input.app ?? '';
  const kind = appKind(app);

  // 1) 用户自定义规则优先（关键词匹配应用名）
  const fixes = parseSceneFixes(input.fixes ?? []);
  const loweredApp = app.toLowerCase();
  for (const fix of fixes) {
    if (loweredApp.includes(fix.keyword)) {
      return { scene: fix.scene, reason: `用户规则「${fix.keyword}=${fix.scene}」` };
    }
  }

  // 2) 网址域名
  const byUrl = refineSceneByUrl(input.url ?? '', input.scene);
  if (byUrl.reason !== '') return byUrl;

  // 3) 最上层窗口
  if (input.window) {
    const byWindow = refineSceneByWindow({ process: input.window.process, title: input.window.title, scene: input.scene });
    if (byWindow.reason !== '') return byWindow;
  }

  const rawScene = input.scene;

  // 3) 应用名判类
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

  // 4) 界面线索（信息不足时不纠正）
  if (rawScene === 'writing' && input.browserChrome === true && input.editorChrome !== true) {
    return { scene: 'browsing', reason: '看到浏览器界面（地址栏/标签页），没有编辑器界面' };
  }
  if (rawScene === 'browsing' && input.editorChrome === true && input.browserChrome !== true) {
    return { scene: 'writing', reason: '看到编辑器界面（光标/行号/笔记侧栏）' };
  }

  return { scene: rawScene, reason: '' };
}

/* -------------------------------------------------------------------------- */
/* 二点六、网址线索（"网页里到底在干什么"最可靠的一路证据）                          */
/* -------------------------------------------------------------------------- */

/**
 * 判断是不是像网址的字符串。
 *
 * 模型有时会把标签页标题当网址报回来，所以这里要求它**至少像个域名**：
 * 带 `http(s)://`，或者"点号 + 通用顶级域/常见域名"。不满足就整条丢掉 ——
 * 宁可不纠正，也不要拿一句标题去套域名规则。
 */
export function isUrlLike(raw: string): boolean {
  const text = (raw ?? '').trim();
  if (text === '' || text.length > 300) return false;
  if (/\s/.test(text)) return false;
  if (/^https?:\/\/[^\s/]+/i.test(text)) return true;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|cn|net|org|io|dev|edu|gov|ai|co|me|tv|xyz|app|info|club|top|site|gg|so|sh|fm)([/:?#].*)?$/i.test(
    text,
  );
}

/**
 * 从网址里取**域名**（去掉协议、路径、查询串与 `www.`）。
 *
 * 只留域名有两个原因：分类只需要域名；查询串里常有搜索词等私人信息
 * （`google.com/search?q=…`），少存一点，隐私就多一分。
 *
 * ⚠️ 不像网址的字符串一律返回空串（而不是把原话当域名返回）：
 * 模型有时会把标签页标题当网址报回来，那种"域名"进了观察记录只会污染统计。
 */
export function safeHost(raw: string): string {
  const text = (raw ?? '').trim();
  if (text === '' || !isUrlLike(text)) return '';
  const withoutScheme = text.replace(/^[a-z]+:\/\//i, '');
  const hostAndRest = withoutScheme.split(/[/?#]/)[0] ?? '';
  const host = hostAndRest.split('@').pop() ?? ''; // 去掉 user:pass@
  return host.replace(/^www\./i, '').toLowerCase().slice(0, 120);
}

/**
 * 域名 -> 场景的确定性规则（命中即纠正，顺序即优先级）。
 *
 * 注意每条都以 `(\.|$)` 结尾而不是 `\.`：像 `vscode.dev` 这种**自带点**的域名，
 * 主机名就是它本身（后面没有第二个点），写成 `vscode\.dev\.` 会永远匹配不上
 * （实测踩到：`vscode.dev/github/x` 被判成 browsing）。
 */
export const URL_SCENE_RULES: readonly { readonly match: RegExp; readonly scene: SceneKind; readonly note: string }[] = [
  // 影音
  { match: /(^|\.)(youtube|bilibili|iqiyi|youku|netflix|twitch|douyu|huya|vimeo|nicovideo)(\.|$)/i, scene: 'video', note: '影音站点' },
  // 论文/文献
  { match: /(^|\.)(arxiv|openreview|scholar\.google|semanticscholar|researchgate|ieee|xueshu|cnki|sciencedirect|springer|acm)(\.|$)/i, scene: 'reading', note: '论文/文献站点' },
  { match: /\.pdf($|[?#])/i, scene: 'reading', note: 'PDF 文件' },
  // 代码托管与问答（属"浏览网页"，但明确不是记笔记）
  { match: /(^|\.)(github|gitlab|gitee|bitbucket|stackoverflow|stackexchange|segmentfault|csdn|juejin)(\.|$)/i, scene: 'browsing', note: '代码/问答站点' },
  // 在线 IDE（这才算写代码）
  { match: /(^|\.)(vscode\.dev|codesandbox|stackblitz|replit|colab\.research|jupyter)(\.|$)/i, scene: 'coding', note: '在线 IDE' },
  // 邮件
  { match: /(^|\.)(mail\.google|outlook|mail\.qq|mail\.163|foxmail|zoho)(\.|$)/i, scene: 'writing', note: '网页邮箱' },
  // 在线文档与笔记（这些才是 writing）
  { match: /(^|\.)(notion\.so|obsidian|yuque|feishu|docs\.google|office|sharepoint|confluence|atlassian)(\.|$)/i, scene: 'writing', note: '在线文档/笔记' },
  // 游戏
  { match: /(^|\.)(steam|epicgames|battle\.net|wegame|roblox)(\.|$)/i, scene: 'gaming', note: '游戏平台' },
  // 会议
  { match: /(^|\.)(meet\.google|zoom|teams\.microsoft|voov)(\.|$)/i, scene: 'meeting', note: '在线会议' },
];

/** 域名线索的纠正结果。 */
export function refineSceneByUrl(url: string, scene: SceneKind): { scene: SceneKind; reason: string } {
  const host = safeHost(url);
  if (host === '' || !isUrlLike(url.trim())) return { scene, reason: '' };
  for (const rule of URL_SCENE_RULES) {
    if (rule.match.test(host) || rule.match.test(url)) {
      // 只纠正"做事类"标签：影音站点里报 coding 显然是错的；idle 表示人不在，保留
      if (scene === 'idle' || scene === 'sensitive') continue;
      if (rule.scene === scene) return { scene, reason: '' };
      return { scene: rule.scene, reason: `${rule.note}（${host}）` };
    }
  }
  /*
   * 没命中规则但**确实是网址**：说明用户在浏览器里看网页。
   * 只有在模型给出"写东西"时纠正一次 —— 这正是用户实测的那个误判
   * （浏览器里看长文被判成记笔记）；其它场景不动，避免过度干预。
   */
  if (scene === 'writing') return { scene: 'browsing', reason: `浏览器里的网页（${host}）不算写笔记` };
  return { scene, reason: '' };
}

/* -------------------------------------------------------------------------- */
/* 二点七、窗口上下文（"现在开着哪些窗口 / 最上层是哪个"）                          */
/* -------------------------------------------------------------------------- */

/**
 * 规范化窗口标题。
 *
 * 必须做的事（都是实测踩出来的）：
 * - 去掉**不可见字符**：Chromium 给的标题里混着零宽空格/方向标记
 *   （`Microsoft​ Edge` 里就有一个），肉眼一样但字符串比较永远不相等；
 * - 把**不换行空格**（U+00A0/U+2007/U+202F）换成普通空格；
 * - 压掉多余空白、限长。
 */
export function normalizeWindowTitle(raw: string): string {
  return (raw ?? '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** 进程名 -> 场景（"最上层窗口"这一路证据）。 */
const PROCESS_SCENE_RULES: readonly { readonly match: RegExp; readonly scene: SceneKind; readonly note: string }[] = [
  { match: /^(code|cursor|windsurf|devenv|idea64?|pycharm64?|webstorm64?|goland64?|clion64?|rider64?|sublime_text|notepad\+\+|vim|nvim|emacs|zed)$/i, scene: 'coding', note: '代码编辑器' },
  { match: /^(windowsterminal|wt|cmd|powershell|pwsh|conhost|alacritty|wezterm|mintty|xshell|putty|tabby|termius)$/i, scene: 'terminal', note: '终端' },
  { match: /^(notepad|winword|wordpad|wps|et|wpp|typora|obsidian|notion|logseq|joplin|onenote|evernote|yuque|zotero|acrobat|acrord32|sumatrapdf|foxitreader)$/i, scene: 'writing', note: '文档/笔记应用' },
  { match: /^(potplayer64?|potplayermini64?|vlc|mpv|mpc-hc64?|kmplayer|bilibili|iqiyi|youku|tencentvideo|twitch|obs64?)$/i, scene: 'video', note: '影音应用' },
  { match: /^(steam|steamwebhelper|epicgameslauncher|battle\.net|wegame|genshinimpact|yuanshen|robloxplayerbeta)$/i, scene: 'gaming', note: '游戏应用' },
  { match: /^(zoom|teams|ms-teams|wemeetapp|dingtalk|feishu|lark|skype)$/i, scene: 'meeting', note: '会议应用' },
  { match: /^(msedge|chrome|firefox|brave|opera|vivaldi|arc|360se|qqbrowser|sogouexplorer)$/i, scene: 'browsing', note: '浏览器' },
];

/** 窗口标题里的**内容型**线索（比进程名更具体）。 */
const TITLE_SCENE_HINTS: readonly { readonly match: RegExp; readonly scene: SceneKind; readonly note: string }[] = [
  { match: /\.pdf(\s|$|-|—)/i, scene: 'reading', note: '在看 PDF' },
  { match: /(哔哩哔哩|bilibili|youtube|腾讯视频|爱奇艺|优酷|netflix|twitch)/i, scene: 'video', note: '影音站点标题' },
  { match: /(arxiv|openreview|参考文献|reference|\.bib)/i, scene: 'reading', note: '文献相关标题' },
  { match: /(stack\s?overflow|github|gitlab|pull request|issue #|merge request)/i, scene: 'browsing', note: '代码/问答站点标题' },
  { match: /(visual studio code|devenv|pycharm|intellij|webstorm|sublime)/i, scene: 'coding', note: '编辑器窗口标题' },
  { match: /(steam|原神|minecraft|英雄联盟|league of legends)/i, scene: 'gaming', note: '游戏窗口标题' },
  { match: /(zoom|tencent meeting|腾讯会议|teams|飞书会议)/i, scene: 'meeting', note: '会议窗口标题' },
];

/**
 * 按"最上层窗口（进程名 + 标题）"纠正场景。
 *
 * 这是三路证据里**最具体**的一路：进程名给出"用的什么软件"，标题给出"在看什么"。
 * 顺序：标题线索 > 进程名规则 > 不动（信息不足时保持模型判断）。
 */
export function refineSceneByWindow(input: {
  readonly process: string;
  readonly title: string;
  readonly scene: SceneKind;
}): { scene: SceneKind; reason: string } {
  if (input.scene === 'idle' || input.scene === 'sensitive') return { scene: input.scene, reason: '' };
  const title = normalizeWindowTitle(input.title);
  const process = (input.process ?? '').toLowerCase().trim();

  for (const hint of TITLE_SCENE_HINTS) {
    if (hint.match.test(title) && hint.scene !== input.scene) {
      return { scene: hint.scene, reason: `${hint.note}（${title.slice(0, 40)}）` };
    }
  }
  for (const rule of PROCESS_SCENE_RULES) {
    if (rule.match.test(process)) {
      if (rule.scene === input.scene) return { scene: input.scene, reason: '' };
      // 浏览器进程只在模型给出"做事类"标签时纠正：浏览器里能干太多事，
      // 具体场景交给标题/网址那两路证据（它们更具体）
      if (rule.scene === 'browsing' && input.scene !== 'writing' && input.scene !== 'terminal' && input.scene !== 'other') {
        return { scene: input.scene, reason: '' };
      }
      return { scene: rule.scene, reason: `${rule.note}（${process}）` };
    }
  }
  return { scene: input.scene, reason: '' };
}

/** 窗口上下文 -> 提示词里的一段文本（给模型当参考，不进观察记录）。 */
export function describeWindowContext(input: {
  readonly foreground: { readonly title: string; readonly process: string } | null;
  readonly windows: readonly { readonly title: string; readonly process: string }[];
  readonly limit?: number;
}): string {
  const limit = Math.max(1, Math.min(24, input.limit ?? 12));
  const lines: string[] = [];
  /*
   * 这里**自己再过滤一次**我们自己的窗口，而不是只依赖调用方：
   * 提示词是这个函数的最终产物，多一道防线就不会因为调用方忘了过滤
   * 而把"桌宠设置"这种噪声喂给模型（验收断言也钉住了这一点）。
   */
  const foreground = input.foreground && !OWN_WINDOW_TITLES.some((own) => input.foreground?.title.includes(own))
    ? input.foreground
    : null;
  if (foreground) {
    lines.push(`最上层窗口：${foreground.title}（进程 ${foreground.process || '未知'}）`);
  }
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of withoutOwnWindows(input.windows)) {
    const title = normalizeWindowTitle(item.title);
    if (title === '') continue;
    // 最上层窗口已经在上面单列一行，列表里**不重复**（省 token 也更清楚）
    if (foreground && title === normalizeWindowTitle(foreground.title) && (item.process ?? '') === foreground.process) continue;
    const key = `${item.process}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(`${list.length + 1}. ${title}（${item.process || '未知'}）`);
    if (list.length >= limit) break;
  }
  if (list.length > 0) {
    lines.push('当前打开的窗口（大致按从上到下的顺序）：', ...list);
  }
  return lines.join('\n');
}

/**
 * 我们自己那几个窗口的标题片段（枚举时排除掉，免得干扰判断）。
 *
 * `鲸鱼娘桌宠` 是桌宠页面自己的标题（`index.html`），实测它会出现在窗口列表里
 * （诊断输出里第一项就是它）—— 不排除的话，"她自己"会变成判断"主人在干什么"的证据。
 */
export const OWN_WINDOW_TITLES: readonly string[] = ['桌宠设置', '和鲸鱼娘说话', '鲸鱼娘桌宠', 'DesktopPet'];

/** 过滤掉我们自己的窗口（探针回传的原始列表里带上它们没有意义）。 */
export function withoutOwnWindows<T extends { readonly title: string }>(windows: readonly T[]): T[] {
  return windows.filter((item) => !OWN_WINDOW_TITLES.some((own) => item.title.includes(own)));
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

/**
 * 综合判定（模型 flag + 关键词）。
 *
 * ⚠️ 扫描范围必须包含 **`url` 与 `windowTitle`**：窗口标题恰恰是"文档名/网页标题"
 * 出现的地方（`工资表.xlsx - Excel`、`招商银行 - 转账`），漏掉它等于把最可能泄露
 * 私人内容的那一路排除在保护之外（文档评审抓到这个真 bug）。
 */
export function isSensitive(
  observation: Pick<ScreenObservation, 'app' | 'activity' | 'summary' | 'sensitive'> &
    Partial<Pick<ScreenObservation, 'url' | 'windowTitle'>>,
  keywords: readonly string[],
): boolean {
  if (observation.sensitive) return true;
  const text = [
    observation.app,
    observation.activity,
    observation.summary,
    observation.url ?? '',
    observation.windowTitle ?? '',
  ].join(' ');
  return matchesSensitiveKeywords(text, keywords);
}

/**
 * 终端类进程名（**只有这些进程才会去读缓冲区文本**）。
 *
 * 为什么要单独列一份：读终端缓冲区是本模块最"深"的一次读取（里面就是用户敲过的
 * 命令与输出，实测还出现过密钥），所以范围必须收得很紧 —— 不在名单里的进程一律不碰。
 * 与 `PROCESS_SCENE_RULES` 里那条"终端 → terminal"保持一致（那边是判场景，这边是决定要不要读文本）。
 */
export const TERMINAL_PROCESSES: readonly string[] = [
  'windowsterminal', 'windowsterminalpreview', 'conhost', 'cmd', 'powershell', 'pwsh',
  'wezterm', 'wezterm-gui', 'alacritty', 'mintty', 'tabby', 'xshell', 'putty', 'termius',
];

/** 这个进程名是不是终端（大小写不敏感、允许带 `.exe`）。 */
export function isTerminalProcess(name: string): boolean {
  const normalized = (name ?? '').trim().toLowerCase().replace(/\.exe$/, '');
  if (normalized === '') return false;
  return TERMINAL_PROCESSES.includes(normalized);
}

/**
 * 去掉终端文本里的 ANSI 转义序列（颜色、光标控制、OSC 标题等）。
 *
 * 终端缓冲区拿到的是**带控制字符的原文**，直接塞进提示词既占 token 又会干扰模型
 * （`\u001b[0m` 这种在模型眼里就是乱码）。只做文本清理，不做任何语义改动。
 */
export function stripAnsiEscape(text: string): string {
  return (text ?? '')
    // OSC：ESC ] ... BEL 或 ESC \
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // CSI：ESC [ 参数 中间 终止
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // 其余单字符转义（ESC 后跟一个字符）与回车
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

/**
 * 给终端文本里的**密钥/令牌打码**（在读之前就挡住，别指望模型"不要复述"）。
 *
 * 为什么必须有这一道：实测终端缓冲区里真的躺着
 * `dsh web: http://127.0.0.1:3080/?token=vKct...` 这种地址 ——
 * 我们只想要"他在终端里干什么"，不想要"他手里有什么凭据"。
 * 打码是**纯文本替换**，宁可多打一点（长串一律打掉），也不要漏。
 */
export function redactTerminalSecrets(text: string): string {
  return (text ?? '')
    // 显式键值：token=xxx / password: xxx / api_key=xxx / Authorization: Bearer xxx
    .replace(
      /\b(token|access[_-]?token|refresh[_-]?token|password|passwd|pwd|secret|api[_-]?key|apikey|authorization|bearer|cookie|session[_-]?id)\b\s*[:=]?\s*\S{4,}/gi,
      '$1=***',
    )
    // 常见前缀令牌
    .replace(/\b(sk|pk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, '***')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, '***')
    // 长随机串（base64 / hex / JWT 片段）：32 位以上一律打掉
    .replace(/\b[A-Za-z0-9_\-+/]{32,}={0,2}\b/g, '***');
}

/**
 * 取终端文本的**尾部**（最近发生了什么）并限长。
 *
 * 为什么只取尾部：实测一个终端缓冲区能有 46 万字符（整段 scrollback），
 * 既没必要也不安全；用户此刻在做什么，全在最后几屏里。
 *
 * @param maxLines 最多保留的行数（默认 30）
 * @param maxChars 最多保留的字符数（默认 1200）
 */
export function tailTerminalText(text: string, options?: { readonly maxLines?: number; readonly maxChars?: number }): string {
  const maxLines = Math.max(1, options?.maxLines ?? 30);
  const maxChars = Math.max(80, options?.maxChars ?? 1200);
  const lines = (text ?? '').split('\n');
  const tail = lines.slice(-maxLines).join('\n').trim();
  if (tail.length <= maxChars) return tail;
  return tail.slice(tail.length - maxChars).trim();
}

/** 当前是否能采集；不能时给出人类可读原因（UI 直接显示）。 */
export function capturePermission(settings: PerceptionSettings): { allowed: boolean; reason: string } {
  if (settings.privacyMode) return { allowed: false, reason: '隐私模式开启中（一键停止一切采集）' };
  if (!settings.screen) return { allowed: false, reason: '屏幕感知开关未打开' };
  return { allowed: true, reason: '' };
}
