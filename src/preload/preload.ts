/**
 * preload.ts —— Renderer 与 Electron/Node 之间唯一的桥。
 *
 * 安全原则（Electron 官方 Context Isolation 架构）：
 * - `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`；
 * - Renderer 侧拿不到 require / process / ipcRenderer / BrowserWindow；
 * - 只通过 `contextBridge.exposeInMainWorld` 暴露一组**语义化、白名单化**的方法；
 * - 不暴露通用 `invoke(channel, ...)`：那等于把整个 IPC 面交给 Renderer；
 * - 不向 Renderer 传递任何 Node 对象（Buffer / stream / fs handle），只传纯 JSON。
 *
 * 启动数据（runtime + 插件清单 + 窗口尺寸）通过 `additionalArguments` 注入，
 * 避免 preload 阶段的同步 IPC（sendSync 会阻塞渲染进程启动）。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels } from '../shared/ipc';
import type {
  AIAPI,
  AnimationChangedPayload,
  LogPayload,
  PetBootstrap,
  PetBridge,
  PluginCodePayload,
  PluginEnabledPayload,
  PluginPanelActionPayload,
  PluginStatePayload,
  PluginTimerPayload,
  PluginTimerTickPayload,
  PluginUIContributionPayload,
  RuntimeInfo,
  StateChangedPayload,
  TrayStatePayload,
  TriggerAnimationPayload,
  WindowPosition,
} from '../shared/ipc';
import type {
  DiscoveredPlugin,
  PluginInstallResult,
  PluginMailRequest,
  PluginMailResult,
  PluginNetRequest,
  PluginNetResponse,
  PluginNotificationRequest,
  PluginPanelView,
  PluginProcessRequest,
  PluginProcessResult,
  PluginPythonInfo,
  PluginPythonRequest,
  PluginRecord,
  PluginUIEvent,
} from '../shared/plugin-types';
import type { PetDisplayState } from '../shared/behavior-config';
import { DEFAULT_BEHAVIOR_CONFIG, DEFAULT_DISPLAY_STATE } from '../shared/behavior-config';
import type { PetAction, ActionResult } from '../shared/action-types';
import type { PetSettingsState, PetSizeInfo } from '../shared/pet-size';
import type { BubblePayload, BubbleState } from '../shared/bubble';
import type {
  AIChatReply,
  AISettingsPatch,
  AIStatusView,
  AITestResult,
  ChatMessagePush,
  ChatTurn,
  DiaryEntry,
  DiarySnapshot,
  InteractionKind,
  MemorySnapshot,
  PetPresence,
} from '../shared/ai-types';import { createDefaultAIStatus } from '../shared/ai-types';
import type { GrowthAPI, PerceptionAPI } from '../shared/ipc';
import type {
  GrowthSettingsPatch,
  GrowthStatus,
  MemoryNodeKind,
} from '../shared/growth-types';
import { DEFAULT_GROWTH_SETTINGS } from '../shared/growth-types';
import type {
  PerceptionLogItem,
  PerceptionSettingsPatch,
  PerceptionStatus,
  PerceptionViewMode,
  PerceptionViewResult,
} from '../shared/perception-types';
import type { TimelineTextResult } from '../shared/timeline-types';
import { DEFAULT_PERCEPTION_SETTINGS } from '../shared/perception-types';
import { ASSET_HOST, ASSET_SCHEME } from '../shared/protocol';
import {
  SETTINGS_BOOTSTRAP_FLAG,
  SETTINGS_WINDOW_FLAG,
  type SettingsPluginAPI,
  type SettingsWindowBootstrap,
  type SettingsWindowBridge,
} from '../shared/settings-window';
import {
  CHAT_BOOTSTRAP_FLAG,
  CHAT_WINDOW_FLAG,
  type ChatView,
  type ChatWindowBootstrap,
  type ChatWindowBridge,
  type PluginPanelTarget,
} from '../shared/chat-window';
import type { NoteBox, NoteFileEntry, NotePreview } from '../shared/notes';

/* -------------------------------------------------------------------------- */
/* 启动数据                                                                    */
/* -------------------------------------------------------------------------- */

/** Main 进程用 `--pet-bootstrap=<base64>` 注入，这里解析（失败也不抛，降级为空数据）。 */
const BOOTSTRAP_FLAG = '--pet-bootstrap=';

function readFlaggedJson<T>(flag: string): T | null {
  try {
    const arg = process.argv.find((value) => value.startsWith(flag));
    if (!arg) return null;
    const encoded = arg.slice(flag.length);
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    return JSON.parse(json) as T;
  } catch (error) {
    console.error(`[preload] ${flag} parse failed`, error);
    return null;
  }
}

const bootstrap = readFlaggedJson<PetBootstrap>(BOOTSTRAP_FLAG);

const fallbackRuntime: RuntimeInfo = {
  version: '0.0.0',
  electronVersion: process.versions.electron ?? 'unknown',
  platform: process.platform,
  mode: 'production',
  assetsPath: '',
  animationManifest: {},
  // bootstrap 拿不到时（preload 早于主进程注入）也要有一份自洽的默认：
  // 正常状态 + 内置随机池，保证"随机动画没了"这种静默失败不会发生。
  behaviorConfig: DEFAULT_BEHAVIOR_CONFIG,
  display: DEFAULT_DISPLAY_STATE,
};

const runtime: RuntimeInfo = bootstrap?.runtime ?? fallbackRuntime;

/* -------------------------------------------------------------------------- */
/* 素材路径解析                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 把 assets 下的相对路径解析成自定义协议 URL。
 * 只做字符串拼接与逐段编码，不读文件系统；真正的文件访问在 Main 的白名单处理器里。
 * @example resolve('animations/idle.webm') -> 'pet-asset://assets/animations/idle.webm'
 */
function resolveAsset(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return '';
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) => encodeURIComponent(segment));
  return `${ASSET_SCHEME}://${ASSET_HOST}/${segments.join('/')}`;
}

/* -------------------------------------------------------------------------- */
/* IPC 订阅辅助                                                                */
/* -------------------------------------------------------------------------- */

type Unsubscribe = () => void;

function subscribe<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    try {
      handler(payload);
    } catch (error) {
      // Renderer 侧 handler 抛错不能影响 IPC 通道
      console.error(`[preload] handler error on ${channel}`, error);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/** fire-and-forget：调用失败只记录，不打断 UI。 */
function send(channel: string, ...args: unknown[]): void {
  void ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    console.error(`[preload] invoke failed: ${channel}`, error);
  });
}

/* -------------------------------------------------------------------------- */
/* AI 认知与人格：三份桥共用的实现（2.1~2.4）                                     */
/* -------------------------------------------------------------------------- */

/**
 * AI API 只有一个实现，桌宠窗口与设置窗口共用。
 *
 * 为什么共用：两个窗口需要的是同一件事（看状态、改开关、读日记/记忆），
 * 差异只在布局。共用一份实现意味着"设置窗口能改的，桌宠窗口也一致"，
 * 不会出现两边行为不一致的坑。
 */
function buildAIAPI(): AIAPI {
  return {
    status: (): Promise<AIStatusView> => ipcRenderer.invoke(IpcChannels.AIStatusGet) as Promise<AIStatusView>,
    setSettings: (patch: AISettingsPatch): Promise<AIStatusView> =>
      ipcRenderer.invoke(IpcChannels.AISettingsSet, patch) as Promise<AIStatusView>,
    chat: (text: string): Promise<AIChatReply> => ipcRenderer.invoke(IpcChannels.AIChatSend, text) as Promise<AIChatReply>,
    history: (): Promise<readonly ChatTurn[]> =>
      ipcRenderer.invoke(IpcChannels.AIChatHistory) as Promise<readonly ChatTurn[]>,
    memory: (): Promise<MemorySnapshot> => ipcRenderer.invoke(IpcChannels.AIMemoryGet) as Promise<MemorySnapshot>,
    clearMemory: (): Promise<MemorySnapshot> => ipcRenderer.invoke(IpcChannels.AIMemoryClear) as Promise<MemorySnapshot>,
    pruneMemory: (): Promise<{ readonly days: number; readonly logSections: number }> =>
      ipcRenderer.invoke(IpcChannels.AIMemoryPrune) as Promise<{ readonly days: number; readonly logSections: number }>,
    openMemoryLog: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.AIMemoryOpenLog) as Promise<boolean>,
    diary: (): Promise<DiarySnapshot> => ipcRenderer.invoke(IpcChannels.AIDiaryList) as Promise<DiarySnapshot>,
    diaryGet: (date: string): Promise<DiaryEntry | null> =>
      ipcRenderer.invoke(IpcChannels.AIDiaryGet, date) as Promise<DiaryEntry | null>,
    writeDiary: (): Promise<DiaryEntry> => ipcRenderer.invoke(IpcChannels.AIDiaryWriteNow) as Promise<DiaryEntry>,
    openDiaryDir: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.AIDiaryOpenDir) as Promise<boolean>,
    testConnection: (): Promise<AITestResult> => ipcRenderer.invoke(IpcChannels.AITestConnection) as Promise<AITestResult>,
    refreshBalance: (): Promise<AIStatusView> =>
      ipcRenderer.invoke(IpcChannels.AIBalanceRefresh) as Promise<AIStatusView>,
    notifyInteraction: (kind: InteractionKind): void => send(IpcChannels.AIInteraction, kind),
    notifyInteractionSettled: (kind: InteractionKind): void => send(IpcChannels.AIInteractionSettled, kind),
    notes: (): Promise<NoteBox> => ipcRenderer.invoke(IpcChannels.AINoteList) as Promise<NoteBox>,
    composeNote: (): Promise<NoteBox> => ipcRenderer.invoke(IpcChannels.AINoteCompose) as Promise<NoteBox>,
    markNotesRead: (): Promise<NoteBox> => ipcRenderer.invoke(IpcChannels.AINoteRead) as Promise<NoteBox>,
    clearNotes: (): Promise<NoteBox> => ipcRenderer.invoke(IpcChannels.AINoteClear) as Promise<NoteBox>,
    deleteNote: (id: string): Promise<NoteBox> =>
      ipcRenderer.invoke(IpcChannels.AINoteDelete, id) as Promise<NoteBox>,
    openNoteFile: (id: string, fileIndex?: number): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.AINoteOpenFile, { id, fileIndex }) as Promise<boolean>,
    openNotesDir: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.AINoteOpenDir) as Promise<boolean>,
    noteFiles: (): Promise<readonly NoteFileEntry[]> =>
      ipcRenderer.invoke(IpcChannels.AINoteFiles) as Promise<readonly NoteFileEntry[]>,
    previewNoteFile: (name: string): Promise<NotePreview> =>
      ipcRenderer.invoke(IpcChannels.AINoteFilePreview, name) as Promise<NotePreview>,
    openNoteFileByName: (name: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.AINoteFileOpen, name) as Promise<boolean>,
    deleteNoteFile: (name: string): Promise<{ readonly ok: boolean; readonly reason?: string }> =>
      ipcRenderer.invoke(IpcChannels.AINoteFileDelete, name) as Promise<{ readonly ok: boolean; readonly reason?: string }>,
    importNoteFile: (): Promise<NoteBox | null> =>
      ipcRenderer.invoke(IpcChannels.AINoteFileImport) as Promise<NoteBox | null>,
    resetEmotion: (): Promise<AIStatusView> => ipcRenderer.invoke(IpcChannels.AIResetEmotion) as Promise<AIStatusView>,
    setPresence: (presence: PetPresence): Promise<AIStatusView> =>
      ipcRenderer.invoke(IpcChannels.AISetPresence, presence) as Promise<AIStatusView>,
    openChatWindow: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.AIOpenChat) as Promise<boolean>,
    onStatus: (handler: (status: AIStatusView) => void): Unsubscribe =>
      subscribe<AIStatusView>(IpcChannels.CommandAIStatus, handler),
    onChatMessage: (handler: (message: ChatMessagePush) => void): Unsubscribe =>
      subscribe<ChatMessagePush>(IpcChannels.CommandChatMessage, handler),
  };
}

/* -------------------------------------------------------------------------- */
/* 环境与用户感知（3.1~3.6）：桌宠窗口与设置窗口共用一份实现                       */
/* -------------------------------------------------------------------------- */

function buildPerceptionAPI(): PerceptionAPI {
  return {
    status: (): Promise<PerceptionStatus> => ipcRenderer.invoke(IpcChannels.PerceptionStatusGet) as Promise<PerceptionStatus>,
    setSettings: (patch: PerceptionSettingsPatch): Promise<PerceptionStatus> =>
      ipcRenderer.invoke(IpcChannels.PerceptionSettingsSet, patch) as Promise<PerceptionStatus>,
    log: (limit?: number): Promise<readonly PerceptionLogItem[]> =>
      ipcRenderer.invoke(IpcChannels.PerceptionLog, limit) as Promise<readonly PerceptionLogItem[]>,
    viewNow: (mode: PerceptionViewMode): Promise<PerceptionViewResult> =>
      ipcRenderer.invoke(IpcChannels.PerceptionViewNow, mode) as Promise<PerceptionViewResult>,
    authorizeCamera: (authorized: boolean): Promise<PerceptionStatus> =>
      ipcRenderer.invoke(IpcChannels.PerceptionCameraAuthorize, authorized) as Promise<PerceptionStatus>,
    clearData: (): Promise<PerceptionStatus> => ipcRenderer.invoke(IpcChannels.PerceptionClearData) as Promise<PerceptionStatus>,
    modelHabits: (): Promise<PerceptionStatus> =>
      ipcRenderer.invoke(IpcChannels.PerceptionModelHabits) as Promise<PerceptionStatus>,
    openLog: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.PerceptionOpenLog) as Promise<boolean>,
    sampleNow: (): Promise<PerceptionStatus> => ipcRenderer.invoke(IpcChannels.PerceptionSampleNow) as Promise<PerceptionStatus>,
    timeline: (date?: string): Promise<TimelineTextResult> =>
      ipcRenderer.invoke(IpcChannels.PerceptionTimelineGet, date) as Promise<TimelineTextResult>,
    narrateTimeline: (date?: string, force?: boolean): Promise<TimelineTextResult> =>
      ipcRenderer.invoke(IpcChannels.PerceptionTimelineNarrate, date, force) as Promise<TimelineTextResult>,
    setCameraReady: (ready: boolean, error = ''): void => send(IpcChannels.PerceptionCameraReady, { ready, error }),
    cameraFrame: (dataUrl: string): void => send(IpcChannels.PerceptionCameraFrame, dataUrl),
    onStatus: (handler: (status: PerceptionStatus) => void): Unsubscribe =>
      subscribe<PerceptionStatus>(IpcChannels.CommandPerceptionStatus, handler),
    onCameraRequest: (handler: () => void): Unsubscribe =>
      subscribe(IpcChannels.CommandPerceptionCameraRequest, () => handler()),
  };
}

/* -------------------------------------------------------------------------- */
/* 成长、记忆与反思（4.1 / 4.2）：桌宠窗口与设置窗口共用一份实现                    */
/* -------------------------------------------------------------------------- */

function buildGrowthAPI(): GrowthAPI {
  return {
    status: (): Promise<GrowthStatus> => ipcRenderer.invoke(IpcChannels.GrowthStatusGet) as Promise<GrowthStatus>,
    setSettings: (patch: GrowthSettingsPatch): Promise<GrowthStatus> =>
      ipcRenderer.invoke(IpcChannels.GrowthSettingsSet, patch) as Promise<GrowthStatus>,
    addNode: (input: { kind: MemoryNodeKind; title: string; detail: string }): Promise<GrowthStatus> =>
      ipcRenderer.invoke(IpcChannels.GrowthNodeAdd, input) as Promise<GrowthStatus>,
    removeNode: (id: string): Promise<GrowthStatus> =>
      ipcRenderer.invoke(IpcChannels.GrowthNodeRemove, id) as Promise<GrowthStatus>,
    pinNode: (id: string, pinned: boolean): Promise<GrowthStatus> =>
      ipcRenderer.invoke(IpcChannels.GrowthNodePin, { id, pinned }) as Promise<GrowthStatus>,
    recallNode: (id: string): Promise<{ readonly ok: boolean; readonly text: string }> =>
      ipcRenderer.invoke(IpcChannels.GrowthNodeRecall, id) as Promise<{ readonly ok: boolean; readonly text: string }>,
    reflectNow: (): Promise<GrowthStatus> => ipcRenderer.invoke(IpcChannels.GrowthReflectNow) as Promise<GrowthStatus>,
    resetPolicy: (): Promise<GrowthStatus> => ipcRenderer.invoke(IpcChannels.GrowthResetPolicy) as Promise<GrowthStatus>,
    refreshPalace: (): Promise<GrowthStatus> => ipcRenderer.invoke(IpcChannels.GrowthRefreshPalace) as Promise<GrowthStatus>,
    openPalace: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.GrowthOpenPalace) as Promise<boolean>,
    openPolicyLog: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.GrowthOpenPolicyLog) as Promise<boolean>,
    onStatus: (handler: (status: GrowthStatus) => void): Unsubscribe =>
      subscribe<GrowthStatus>(IpcChannels.CommandGrowthStatus, handler),
  };
}

/* -------------------------------------------------------------------------- */
/* window.settingsAPI（仅设置窗口）                                             */
/* -------------------------------------------------------------------------- */

/**
 * 设置窗口走的是**同一份 preload 产物**，但只暴露下面这几个方法。
 *
 * 用命令行参数区分角色，而不是开第二份 preload 文件：
 * 桥的面越小越好维护，也让"设置窗口拿不到桌宠 IPC"这件事在代码上是显然的。
 */
const isSettingsWindow = process.argv.includes(SETTINGS_WINDOW_FLAG);
const isChatWindow = process.argv.includes(CHAT_WINDOW_FLAG);

const settingsFallback: SettingsWindowBootstrap = {
  state: {
    size: {
      width: 288,
      height: 384,
      scale: 0.6,
      requestedScale: 0.6,
      windowScale: 0.6,
      clampedByDisplay: false,
      aspectRatio: 834 / 1112,
      baseHeight: 480,
    },
    alwaysOnTop: true,
    dockOnEdge: true,
  },
  configPath: '',
  ai: createDefaultAIStatus(),
  perception: createDefaultPerceptionStatus(),
  growth: createDefaultGrowthStatus(),
  plugins: [],
};

/** 成长状态的兜底值（preload 早于主进程数据就绪时使用）。 */
function createDefaultGrowthStatus(): GrowthStatus {
  return {
    settings: DEFAULT_GROWTH_SETTINGS,
    palace: {
      nodes: [],
      byMonth: [],
      updatedAt: '',
      dataDir: '',
      markdownFile: '',
      stats: { total: 0, daysTogether: 0, since: '' },
    },
    todayReflection: null,
    recentReflections: [],
    policy: { minIntervalFactor: 1, maxPerHourFactor: 1, sceneFactors: {}, updatedAt: '', reason: '', adjustments: 0 },
    policyEffect: '还没调整过（保持你的设置）',
    responseStats: [],
    dataDir: '',
    lastError: '',
  };
}

/** 感知状态的兜底值（preload 早于主进程数据就绪时使用）。 */
function createDefaultPerceptionStatus(): PerceptionStatus {
  return {
    settings: DEFAULT_PERCEPTION_SETTINGS,
    capturing: false,
    pausedReason: '尚未初始化',
    lastObservation: null,
    behavior: { idleSeconds: 0, sessionMinutes: 0, switchesLastHour: 0, hour: new Date().getHours(), lateNight: false, userState: 'unknown' },
    presence: { present: true, source: 'unknown', at: '' },
    habits: {
      samples: 0,
      activeDays: 0,
      latestActiveHour: null,
      earliestActiveHour: null,
      typicalNow: null,
      typicalKind: '*',
      recentDays: 0,
      windowDays: 21,
      model: null,
    },
    lastIntervention: null,
    interventionsToday: 0,
    cameraReady: false,
    windowContext: { count: 0, foregroundTitle: '', foregroundProcess: '', sample: [], backingOff: false },
    timeline: { date: '', activeMinutes: 0, idleMinutes: 0, unaccountedMinutes: 0, byScene: [], byApp: [], recent: [], narrative: '' },
    retention: { days: 0, lastPrunedAt: '', lastPrunedDays: 0 },
    dataDir: '',
    lastError: '',
  };
}

/**
 * 设置窗口的插件管理面。
 *
 * 这里只给四个方法（列出 / 启停 / 重载 / 订阅变化）：插件本身的能力
 * （联网、起进程、发通知、注册面板）**一个都不在设置窗口暴露** ——
 * 设置窗口是"管插件的地方"，不是"插件运行的地方"。
 */
function buildSettingsPluginAPI(): SettingsPluginAPI {
  return {
    list: (): Promise<readonly PluginRecord[]> =>
      ipcRenderer.invoke(IpcChannels.PluginList) as Promise<readonly PluginRecord[]>,
    setEnabled: (id: string, enabled: boolean): Promise<readonly PluginRecord[]> =>
      ipcRenderer.invoke(IpcChannels.SettingsWindowSetPluginEnabled, { id, enabled }) as Promise<
        readonly PluginRecord[]
      >,
    reload: (): Promise<number> =>
      ipcRenderer.invoke(IpcChannels.SettingsWindowReloadPlugins) as Promise<number>,
    onChanged: (handler: (records: readonly PluginRecord[]) => void): Unsubscribe =>
      subscribe<readonly PluginRecord[]>(IpcChannels.CommandPluginsChanged, handler),
    install: (directory?: string): Promise<PluginInstallResult> =>
      ipcRenderer.invoke(IpcChannels.PluginInstall, { directory }) as Promise<PluginInstallResult>,
    uninstall: (id: string): Promise<PluginInstallResult> =>
      ipcRenderer.invoke(IpcChannels.PluginUninstall, { id }) as Promise<PluginInstallResult>,
  };
}

function buildSettingsBridge(): SettingsWindowBridge {
  return {
    initial: readFlaggedJson<SettingsWindowBootstrap>(SETTINGS_BOOTSTRAP_FLAG) ?? settingsFallback,
    setScale: (scale: number): Promise<PetSettingsState> =>
      ipcRenderer.invoke(IpcChannels.SettingsWindowSetScale, scale) as Promise<PetSettingsState>,
    setAlwaysOnTop: (value: boolean): Promise<PetSettingsState> =>
      ipcRenderer.invoke(IpcChannels.SettingsWindowSetAlwaysOnTop, value) as Promise<PetSettingsState>,
    setDockOnEdge: (value: boolean): Promise<PetSettingsState> =>
      ipcRenderer.invoke(IpcChannels.SettingsWindowSetDockOnEdge, value) as Promise<PetSettingsState>,
    reloadPlugins: (): Promise<number> =>
      ipcRenderer.invoke(IpcChannels.SettingsWindowReloadPlugins) as Promise<number>,
    openConfigFolder: (): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.SettingsWindowOpenConfig) as Promise<boolean>,
    close: (): Promise<void> => ipcRenderer.invoke(IpcChannels.SettingsWindowClose) as Promise<void>,
    onChanged: (handler: (state: PetSettingsState) => void): Unsubscribe =>
      subscribe<PetSettingsState>(IpcChannels.CommandSettingsChanged, handler),
    ai: buildAIAPI(),
    perception: buildPerceptionAPI(),
    growth: buildGrowthAPI(),
    plugins: buildSettingsPluginAPI(),
  };
}

/* -------------------------------------------------------------------------- */
/* window.chatAPI（仅聊天窗口）                                                 */
/* -------------------------------------------------------------------------- */

const chatFallback: ChatWindowBootstrap = {
  history: [],
  status: createDefaultAIStatus(),
  notes: { notes: [], unread: 0, dataDir: '', filesDir: '', orphans: [] },
  diary: { items: [], dataDir: '', todayWritten: false, diaryHour: 22 },
  view: 'chat',
  panels: [],
};

function buildChatBridge(): ChatWindowBridge {
  return {
    initial: readFlaggedJson<ChatWindowBootstrap>(CHAT_BOOTSTRAP_FLAG) ?? chatFallback,
    send: (text: string): Promise<AIChatReply> => ipcRenderer.invoke(IpcChannels.AIChatSend, text) as Promise<AIChatReply>,
    speakUp: (): Promise<AIChatReply> => ipcRenderer.invoke(IpcChannels.AISpeakUp) as Promise<AIChatReply>,
    history: (): Promise<readonly ChatTurn[]> =>
      ipcRenderer.invoke(IpcChannels.AIChatHistory) as Promise<readonly ChatTurn[]>,
    status: (): Promise<AIStatusView> => ipcRenderer.invoke(IpcChannels.AIStatusGet) as Promise<AIStatusView>,
    notes: (): Promise<NoteBox> => ipcRenderer.invoke(IpcChannels.AINoteList) as Promise<NoteBox>,
    composeNote: (): Promise<NoteBox> => ipcRenderer.invoke(IpcChannels.AINoteCompose) as Promise<NoteBox>,
    markNotesRead: (): Promise<NoteBox> => ipcRenderer.invoke(IpcChannels.AINoteRead) as Promise<NoteBox>,
    clearNotes: (): Promise<NoteBox> => ipcRenderer.invoke(IpcChannels.AINoteClear) as Promise<NoteBox>,
    deleteNote: (id: string): Promise<NoteBox> =>
      ipcRenderer.invoke(IpcChannels.AINoteDelete, id) as Promise<NoteBox>,
    openNoteFile: (id: string, fileIndex?: number): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.AINoteOpenFile, { id, fileIndex }) as Promise<boolean>,
    openNotesDir: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.AINoteOpenDir) as Promise<boolean>,
    noteFiles: (): Promise<readonly NoteFileEntry[]> =>
      ipcRenderer.invoke(IpcChannels.AINoteFiles) as Promise<readonly NoteFileEntry[]>,
    previewNoteFile: (name: string): Promise<NotePreview> =>
      ipcRenderer.invoke(IpcChannels.AINoteFilePreview, name) as Promise<NotePreview>,
    openNoteFileByName: (name: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.AINoteFileOpen, name) as Promise<boolean>,
    deleteNoteFile: (name: string): Promise<{ readonly ok: boolean; readonly reason?: string }> =>
      ipcRenderer.invoke(IpcChannels.AINoteFileDelete, name) as Promise<{ readonly ok: boolean; readonly reason?: string }>,
    importNoteFile: (): Promise<NoteBox | null> =>
      ipcRenderer.invoke(IpcChannels.AINoteFileImport) as Promise<NoteBox | null>,
    /* 日记：与设置窗口的 AI 面板共用同一批 IPC，两边看到的永远是同一份 */
    diary: (): Promise<DiarySnapshot> => ipcRenderer.invoke(IpcChannels.AIDiaryList) as Promise<DiarySnapshot>,
    diaryGet: (date: string): Promise<DiaryEntry | null> =>
      ipcRenderer.invoke(IpcChannels.AIDiaryGet, date) as Promise<DiaryEntry | null>,
    writeDiary: (): Promise<DiaryEntry> => ipcRenderer.invoke(IpcChannels.AIDiaryWriteNow) as Promise<DiaryEntry>,
    openDiaryDir: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.AIDiaryOpenDir) as Promise<boolean>,
    onDiary: (handler: (snapshot: DiarySnapshot) => void): Unsubscribe =>
      subscribe<DiarySnapshot>(IpcChannels.CommandDiary, handler),
    onMessage: (handler: (message: ChatMessagePush) => void): Unsubscribe =>
      subscribe<ChatMessagePush>(IpcChannels.CommandChatMessage, handler),
    onStatus: (handler: (status: AIStatusView) => void): Unsubscribe =>
      subscribe<AIStatusView>(IpcChannels.CommandAIStatus, handler),
    onNotes: (handler: (box: NoteBox) => void): Unsubscribe =>
      subscribe<NoteBox>(IpcChannels.CommandNotes, handler),
    onView: (handler: (view: ChatView) => void): Unsubscribe =>
      subscribe<ChatView>(IpcChannels.CommandChatView, handler),
    openSettings: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.SettingsWindowShow) as Promise<boolean>,
    close: (): Promise<void> => ipcRenderer.invoke(IpcChannels.ChatWindowClose) as Promise<void>,
    /*
     * 插件面板（TODO / 课程表 / 番茄钟画在这里）。
     *
     * 注意方向：**面板内容是插件推过来的，用户点击是往回传的**。
     * 这个窗口自己不认识任何插件，它只是"把净化后的 HTML 画出来 +
     * 把 `data-plugin-action` 的点击原样送回主进程"。
     */
    panels: (): Promise<readonly PluginPanelView[]> =>
      ipcRenderer.invoke(IpcChannels.ChatWindowPanelsGet) as Promise<readonly PluginPanelView[]>,
    panelAction: (action: PluginPanelActionPayload): void => send(IpcChannels.PluginPanelAction, action),
    onPanels: (handler: (panels: readonly PluginPanelView[]) => void): Unsubscribe =>
      subscribe<readonly PluginPanelView[]>(IpcChannels.CommandPluginPanels, handler),
    onPanelRequest: (handler: (target: PluginPanelTarget) => void): Unsubscribe =>
      subscribe<PluginPanelTarget>(IpcChannels.CommandChatPanel, handler),
  };
}

/* -------------------------------------------------------------------------- */
/* window.petAPI（桌宠窗口）                                                    */
/* -------------------------------------------------------------------------- */

function buildPetBridge(): PetBridge {
  return {
    runtime,

    assets: {
      resolve: resolveAsset,
    },

    window: {
      setPosition: (x: number, y: number): Promise<void> =>
        ipcRenderer.invoke(IpcChannels.WindowSetPosition, x, y) as Promise<void>,
      getPosition: (): Promise<WindowPosition> =>
        ipcRenderer.invoke(IpcChannels.WindowGetPosition) as Promise<WindowPosition>,
      setSize: (width: number, height: number): Promise<void> =>
        ipcRenderer.invoke(IpcChannels.WindowSetSize, width, height) as Promise<void>,
      startDrag: (): void => send(IpcChannels.WindowStartDrag),
      show: (): void => send(IpcChannels.WindowShow),
      hide: (): void => send(IpcChannels.WindowHide),
      setAlwaysOnTop: (value: boolean): void => send(IpcChannels.WindowSetAlwaysOnTop, value),
      setIgnoreMouseEvents: (ignore: boolean, forward = true): void =>
        send(IpcChannels.WindowSetIgnoreMouse, ignore, forward),
      reportPointer: (nx: number, ny: number): void => send(IpcChannels.PointerPosition, { nx, ny }),
      dragEnd: (screenX?: number, screenY?: number): Promise<PetDisplayState> =>
        ipcRenderer.invoke(IpcChannels.WindowDragEnd, { screenX, screenY }) as Promise<PetDisplayState>,
      undock: (): Promise<PetDisplayState> =>
        ipcRenderer.invoke(IpcChannels.WindowUndock) as Promise<PetDisplayState>,
      showSettingsWindow: (): Promise<boolean> =>
        ipcRenderer.invoke(IpcChannels.SettingsWindowShow) as Promise<boolean>,
    },

    menu: {
      showContextMenu: (): void => send(IpcChannels.ContextMenuShow),
    },

    tray: {
      updateState: (state: TrayStatePayload): void => send(IpcChannels.TrayStateSelect, state),
    },

    log: {
      write: (payload: LogPayload): void => send(IpcChannels.Log, payload),
    },

    actions: {
      execute: (action: PetAction): Promise<ActionResult> =>
        ipcRenderer.invoke(IpcChannels.ActionExecute, action) as Promise<ActionResult>,
    },

    plugins: {
      list: () => ipcRenderer.invoke(IpcChannels.PluginList),
      discover: (): Promise<readonly DiscoveredPlugin[]> =>
        ipcRenderer.invoke(IpcChannels.PluginDiscover) as Promise<readonly DiscoveredPlugin[]>,
      fetchCode: (id: string): Promise<PluginCodePayload | null> =>
        ipcRenderer.invoke(IpcChannels.PluginFetchCode, id) as Promise<PluginCodePayload | null>,
      reload: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannels.PluginReload, id) as Promise<void>,
      notifyActivated: (payload: PluginStatePayload): void => send(IpcChannels.PluginActivated, payload),
      notifyDeactivated: (payload: PluginStatePayload): void => send(IpcChannels.PluginDeactivated, payload),
      notifyError: (payload: { id: string; hook: string; message: string }): void =>
        send(IpcChannels.PluginError, payload),
      onReloadRequested: (handler: () => void): Unsubscribe =>
        subscribe(IpcChannels.CommandReloadPlugins, () => handler()),

      /* --------------------- 运行期启停（"插件可随时关闭"） --------------------- */
      setEnabled: (id: string, enabled: boolean) =>
        ipcRenderer.invoke(IpcChannels.PluginSetEnabled, { id, enabled }),
      onEnabled: (handler: (payload: PluginEnabledPayload) => void): Unsubscribe =>
        subscribe<PluginEnabledPayload>(IpcChannels.CommandPluginEnabled, handler),

      /* --------------------------- 安装 / 卸载 --------------------------- */
      install: (directory?: string): Promise<PluginInstallResult> =>
        ipcRenderer.invoke(IpcChannels.PluginInstall, { directory }) as Promise<PluginInstallResult>,
      uninstall: (id: string): Promise<PluginInstallResult> =>
        ipcRenderer.invoke(IpcChannels.PluginUninstall, { id }) as Promise<PluginInstallResult>,
      onRemoved: (handler: (payload: { id: string }) => void): Unsubscribe =>
        subscribe<{ id: string }>(IpcChannels.CommandPluginRemoved, handler),

      /* --------------------- 受权限约束的系统能力（执法在 Main） --------------------- */
      net: (pluginId: string, request: PluginNetRequest): Promise<PluginNetResponse> =>
        ipcRenderer.invoke(IpcChannels.PluginNet, { pluginId, request }) as Promise<PluginNetResponse>,
      process: (pluginId: string, request: PluginProcessRequest): Promise<PluginProcessResult> =>
        ipcRenderer.invoke(IpcChannels.PluginProcess, { pluginId, action: 'run', request }) as Promise<PluginProcessResult>,
      which: (pluginId: string, command: string): Promise<string | null> =>
        ipcRenderer.invoke(IpcChannels.PluginProcess, {
          pluginId,
          action: 'which',
          request: { command },
        }) as Promise<string | null>,
      pythonInfo: (pluginId: string): Promise<PluginPythonInfo> =>
        ipcRenderer.invoke(IpcChannels.PluginPython, { pluginId, action: 'info' }) as Promise<PluginPythonInfo>,
      pythonRun: (pluginId: string, request: PluginPythonRequest): Promise<PluginProcessResult> =>
        ipcRenderer.invoke(IpcChannels.PluginPython, { pluginId, action: 'run', request }) as Promise<PluginProcessResult>,
      notify: (pluginId: string, request: PluginNotificationRequest): Promise<boolean> =>
        ipcRenderer.invoke(IpcChannels.PluginNotify, { pluginId, request }) as Promise<boolean>,
      mail: (pluginId: string, request: PluginMailRequest): Promise<PluginMailResult> =>
        ipcRenderer.invoke(IpcChannels.PluginMailSend, { pluginId, request }) as Promise<PluginMailResult>,
      openExternal: (pluginId: string, url: string): Promise<boolean> =>
        ipcRenderer.invoke(IpcChannels.PluginOpenExternal, { pluginId, url }) as Promise<boolean>,
      startTimer: (pluginId: string, timer: Omit<PluginTimerPayload, 'pluginId'>): Promise<boolean> =>
        ipcRenderer.invoke(IpcChannels.PluginTimer, { pluginId, action: 'start', ...timer }) as Promise<boolean>,
      cancelTimer: (pluginId: string, timerId: string): Promise<boolean> =>
        ipcRenderer.invoke(IpcChannels.PluginTimer, { pluginId, timerId, action: 'cancel' }) as Promise<boolean>,
      contributeUI: (contribution: PluginUIContributionPayload): void =>
        send(IpcChannels.PluginUIContribute, contribution),
      openPanel: (pluginId: string, panelId: string): Promise<boolean> =>
        ipcRenderer.invoke(IpcChannels.PluginOpenPanel, { pluginId, panelId }) as Promise<boolean>,
      onUIEvent: (handler: (payload: PluginUIEvent) => void): Unsubscribe =>
        subscribe<PluginUIEvent>(IpcChannels.CommandPluginUIEvent, handler),
      onTimer: (handler: (payload: PluginTimerTickPayload) => void): Unsubscribe =>
        subscribe<PluginTimerTickPayload>(IpcChannels.CommandPluginTimer, handler),
    },

    commands: {
      onAction: (handler: (action: PetAction) => void): Unsubscribe =>
        subscribe<PetAction>(IpcChannels.CommandAction, handler),
      onSetBehaviorPaused: (handler: (paused: boolean) => void): Unsubscribe =>
        subscribe<boolean>(IpcChannels.CommandSetBehaviorPaused, handler),
      onSetAnimation: (handler: (animationId: string) => void): Unsubscribe =>
        subscribe<string>(IpcChannels.CommandSetAnimation, handler),
      onTriggerAnimation: (handler: (payload: TriggerAnimationPayload) => void): Unsubscribe =>
        subscribe<TriggerAnimationPayload>(IpcChannels.CommandTriggerAnimation, handler),
      onDisplayState: (handler: (payload: PetDisplayState) => void): Unsubscribe =>
        subscribe<PetDisplayState>(IpcChannels.CommandDisplayState, handler),
      onSizeChanged: (handler: (size: PetSizeInfo) => void): Unsubscribe =>
        subscribe<PetSizeInfo>(IpcChannels.CommandSizeChanged, handler),
      onBubble: (handler: (payload: BubblePayload) => void): Unsubscribe =>
        subscribe<BubblePayload>(IpcChannels.CommandBubble, handler),
      onShutdown: (handler: () => void): Unsubscribe =>
        subscribe(IpcChannels.CommandShutdown, () => handler()),
    },

    settings: {
      get: (): Promise<PetSettingsState> =>
        ipcRenderer.invoke(IpcChannels.SettingsGet) as Promise<PetSettingsState>,
      setScale: (scale: number): Promise<PetSettingsState> =>
        ipcRenderer.invoke(IpcChannels.SettingsSetScale, scale) as Promise<PetSettingsState>,
      setAlwaysOnTop: (value: boolean): Promise<PetSettingsState> =>
        ipcRenderer.invoke(IpcChannels.SettingsSetAlwaysOnTop, value) as Promise<PetSettingsState>,
      setDockOnEdge: (value: boolean): Promise<PetSettingsState> =>
        ipcRenderer.invoke(IpcChannels.SettingsSetDockOnEdge, value) as Promise<PetSettingsState>,
      onChanged: (handler: (state: PetSettingsState) => void): Unsubscribe =>
        subscribe<PetSettingsState>(IpcChannels.CommandSizeChanged, handler),
    },

    bubble: {
      set: (state: BubbleState | null): Promise<BubblePayload> =>
        ipcRenderer.invoke(IpcChannels.PetSetBubble, state) as Promise<BubblePayload>,
      reportTextLines: (payload: { text: string; lines: number }): Promise<BubblePayload> =>
        ipcRenderer.invoke(IpcChannels.BubbleReportText, payload) as Promise<BubblePayload>,
      acknowledge: (): Promise<BubblePayload> =>
        ipcRenderer.invoke(IpcChannels.BubbleAcknowledge) as Promise<BubblePayload>,
    },

    ai: buildAIAPI(),
    perception: buildPerceptionAPI(),
    growth: buildGrowthAPI(),

    notifyAnimationChanged: (payload: AnimationChangedPayload): void =>
      send(IpcChannels.AnimationChanged, payload),
    notifyStateChanged: (payload: StateChangedPayload): void => send(IpcChannels.StateChanged, payload),
    notifyBehaviorPaused: (paused: boolean): void => send(IpcChannels.BehaviorPausedChanged, paused),
  };
}

/* -------------------------------------------------------------------------- */
/* 分别暴露：一个窗口只会拿到其中一份桥                                          */
/* -------------------------------------------------------------------------- */

const petWindowFallbackBootstrap: PetBootstrap = {
  runtime: fallbackRuntime,
  plugins: [],
  window: { width: 288, height: 384, x: 0, y: 0 },
};

if (isSettingsWindow) {
  // 设置窗口：只有 settingsAPI，**没有** petAPI（更小的暴露面）。
  contextBridge.exposeInMainWorld('settingsAPI', buildSettingsBridge());
} else if (isChatWindow) {
  // 聊天窗口：只有 chatAPI（连"改桌宠尺寸"都拿不到）。
  contextBridge.exposeInMainWorld('chatAPI', buildChatBridge());
} else {
  contextBridge.exposeInMainWorld('petAPI', buildPetBridge());
  contextBridge.exposeInMainWorld('petBootstrap', bootstrap ?? petWindowFallbackBootstrap);
}
