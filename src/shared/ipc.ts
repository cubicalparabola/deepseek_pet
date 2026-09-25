/**
 * IPC 契约（Main <-> Preload <-> Renderer）。
 *
 * 这里是唯一的跨进程 API 清单：
 * - Renderer 永远不能直接触碰 Electron / Node；
 * - 所有系统能力都必须出现在 `IpcChannels` 中，并经由 preload 的 contextBridge 暴露；
 * - 通道名集中在 `IpcChannels`，避免各模块手写字符串。
 */

import type { PetAction, ActionResult } from './action-types';
import type { PetState } from './state-types';
import type { DiscoveredPlugin, PluginRecord } from './plugin-types';
import type { AnimationManifest } from './animation-types';
import type { PetSettingsState, PetSizeInfo } from './pet-size';
import type { BubblePayload, BubbleState } from './bubble';
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
} from './ai-types';

/* -------------------------------------------------------------------------- */
/* 通道名                                                                      */
/* -------------------------------------------------------------------------- */

export const IpcChannels = {
  /* 初始化 / 配置 */
  Bootstrap: 'pet:bootstrap',
  RuntimeInfo: 'pet:runtime-info',

  /* 窗口 */
  WindowSetPosition: 'pet:window-set-position',
  WindowGetPosition: 'pet:window-get-position',
  WindowStartDrag: 'pet:window-start-drag',
  WindowShow: 'pet:window-show',
  WindowHide: 'pet:window-hide',
  WindowSetSize: 'pet:window-set-size',
  WindowSetIgnoreMouse: 'pet:window-set-ignore-mouse',
  WindowSetAlwaysOnTop: 'pet:window-set-always-on-top',

  /* 尺寸 / 设置 */
  SettingsGet: 'pet:settings-get',
  SettingsSetScale: 'pet:settings-set-scale',
  SettingsSetAlwaysOnTop: 'pet:settings-set-always-on-top',
  /** 显示/隐藏对话气泡（托盘菜单与验收脚本共用同一条实现）。 */
  PetSetBubble: 'pet:set-bubble',
  /**
   * Renderer -> Main：回报"当前文本在文字区宽度下占几行"。
   *
   * 只有 Renderer 能做字体度量，而气泡高度由 Main 决策，所以这一环必须回传。
   * Main 据此重算气泡高度 —— 这就是"气泡大小随文本长短变化"的闭环。
   */
  BubbleReportText: 'pet:bubble-report-text',
  /**
   * Renderer -> Main：用户点了气泡上的"知道了"，请求关闭气泡。
   *
   * 与托盘菜单「隐藏气泡」走同一条实现（`setBubble(null)`）——
   * 气泡状态与窗口尺寸必须成对更新，不能只由渲染层自己藏起来。
   */
  BubbleAcknowledge: 'pet:bubble-acknowledge',
  /**
   * Renderer -> Main：指针在窗口内的位置（归一化 0~1）。
   *
   * 用途：透明区域要**穿透**（点得到下面的窗口），而"哪个区域该接收点击"
   * 的几何只有主进程知道（宠物尺寸 + 气泡布局都在它手里），
   * 因此渲染层只上报指针位置，由主进程判定并切换 `setIgnoreMouseEvents`。
   */
  PointerPosition: 'pet:pointer-position',

  /* 设置窗口（独立的小窗口，只暴露尺寸/置顶） */
  SettingsWindowShow: 'pet:settings-window-show',
  SettingsWindowSetScale: 'pet:settings-window-set-scale',
  SettingsWindowSetAlwaysOnTop: 'pet:settings-window-set-always-on-top',
  SettingsWindowOpenConfig: 'pet:settings-window-open-config',
  SettingsWindowClose: 'pet:settings-window-close',
  /** 聊天窗口关闭（隐藏，不销毁）。 */
  ChatWindowClose: 'pet:chat-window-close',
  CommandSettingsChanged: 'pet:command-settings-changed',

  /* 菜单 / 托盘 */
  ContextMenuShow: 'pet:context-menu-show',
  TrayStateSelect: 'pet:tray-state',

  /* 日志 */
  Log: 'pet:log',
  LogMain: 'pet:log-main',

  /* Action / 动画 / 状态（Renderer -> Main，仅用于观测与未来扩展） */
  ActionExecute: 'pet:action-execute',
  AnimationChanged: 'pet:animation-changed',
  StateChanged: 'pet:state-changed',
  BehaviorPausedChanged: 'pet:behavior-paused-changed',

  /* 插件 */
  PluginDiscover: 'pet:plugin-discover',
  PluginFetchCode: 'pet:plugin-fetch-code',
  PluginList: 'pet:plugin-list',
  PluginReload: 'pet:plugin-reload',
  PluginActivated: 'pet:plugin-activated',
  PluginDeactivated: 'pet:plugin-deactivated',
  PluginError: 'pet:plugin-error',

  /* --------------- AI 认知与人格（2.1~2.4） ---------------
   *
   * 全部落在 Main 进程：大模型调用（密钥不出主进程）、记忆文件、
   * 情绪结算、日记生成都在那边；渲染层只能拿只读快照与提交一句话。
   */
  /** 读取 AI 运行状态（含掩码后的配置 + 情绪快照）。 */
  AIStatusGet: 'pet:ai-status',
  /** 修改 AI 配置（部分补丁；apiKey 省略表示不改动）。 */
  AISettingsSet: 'pet:ai-settings-set',
  /** 发一句话给桌宠（2.1）。 */
  AIChatSend: 'pet:ai-chat-send',
  /** 读最近对话（聊天窗口打开时回填历史）。 */
  AIChatHistory: 'pet:ai-chat-history',
  /** 读记忆快照（2.2）。 */
  AIMemoryGet: 'pet:ai-memory-get',
  /** 清空记忆（事实 + 流水，profile 一并重置）。 */
  AIMemoryClear: 'pet:ai-memory-clear',
  /** 在文件管理器里打开记忆日志。 */
  AIMemoryOpenLog: 'pet:ai-memory-open-log',
  /** 日记列表（2.4）。 */
  AIDiaryList: 'pet:ai-diary-list',
  /** 读某一篇日记（date = YYYY-MM-DD）。 */
  AIDiaryGet: 'pet:ai-diary-get',
  /** 立刻写今天的日记（不等定时器）。 */
  AIDiaryWriteNow: 'pet:ai-diary-write',
  /** 打开日记目录。 */
  AIDiaryOpenDir: 'pet:ai-diary-open',
  /** 连通性自检（设置界面「测试连接」）。 */
  AITestConnection: 'pet:ai-test',
  /** Renderer -> Main：发生了一次互动（点击/拖动…），用于情绪上涨。 */
  AIInteraction: 'pet:ai-interaction',
  /** 把情绪重置为初始值（调试/后悔药）。 */
  AIResetEmotion: 'pet:ai-reset-emotion',
  /**
   * 切换在场状态（可见 / 收起 / 隐藏）。
   *
   * 收起 = 她还在屏幕上但整窗点击穿透、行为暂停、情绪下降更快（见 2.3）。
   * 入口在托盘菜单，同时开给渲染层与验收脚本 —— 否则这个状态无法被断言。
   */
  AISetPresence: 'pet:ai-set-presence',
  /** 打开聊天窗口（托盘菜单与桌宠共用）。 */
  AIOpenChat: 'pet:ai-open-chat',
  /** 让桌宠主动说一句话（聊天窗口的「让她说句话」，也是"主动搭话"的手动入口）。 */
  AISpeakUp: 'pet:ai-speak-up',

  /* Main -> Renderer 指令 */
  CommandAction: 'pet:command-action',
  CommandSetBehaviorPaused: 'pet:command-set-behavior-paused',
  CommandReloadPlugins: 'pet:command-reload-plugins',
  CommandSetAnimation: 'pet:command-set-animation',
  CommandSizeChanged: 'pet:command-size-changed',
  CommandBubble: 'pet:command-bubble',
  /** AI 状态变化（开关、情绪、模式），推给设置窗口与桌宠窗口。 */
  CommandAIStatus: 'pet:command-ai-status',
  /** Main -> 聊天窗口：一条新消息（用户/宠物/系统提示）。 */
  CommandChatMessage: 'pet:command-chat-message',
  CommandShutdown: 'pet:command-shutdown',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

/* -------------------------------------------------------------------------- */
/* 数据结构                                                                    */
/* -------------------------------------------------------------------------- */

export interface RuntimeInfo {
  readonly version: string;
  readonly electronVersion: string;
  readonly platform: NodeJS.Platform | string;
  readonly mode: 'development' | 'production';
  /** assets 目录绝对路径（Renderer 内部使用，不暴露给插件）。 */
  readonly assetsPath: string;
  /** 已解析的动画 Manifest（Main 读取后随 bootstrap 一次性下发）。 */
  readonly animationManifest: AnimationManifest;
}

export interface WindowPosition {
  readonly x: number;
  readonly y: number;
}

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

export interface PetBootstrap {
  readonly runtime: RuntimeInfo;
  readonly plugins: readonly DiscoveredPlugin[];
  readonly window: WindowSize & WindowPosition;
  /** 主进程解析出的尺寸信息（Renderer 不需要自己算宽高比与收敛）。 */
  readonly size?: PetSizeInfo;
  /**
   * 当前对话气泡状态与布局。
   *
   * 为什么放进 bootstrap：气泡可能在 Renderer 就绪**之前**就已经打开
   * （例如主进程启动时带着状态），只靠 IPC 推送会漏掉这一次。
   */
  readonly bubble?: BubblePayload;
}

export interface PluginCodePayload {
  /** 插件 id。 */
  readonly id: string;
  /** 已编译为 CommonJS 的插件入口代码。 */
  readonly code: string;
  /** 编译诊断（如果有）。 */
  readonly warnings?: readonly string[];
}

export interface LogPayload {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly module: string;
  readonly message: string;
  readonly event?: string;
  readonly data?: Record<string, unknown>;
}

export interface AnimationChangedPayload {
  readonly animationId: string;
  readonly priority: number;
  readonly source?: string;
  readonly reason?: string;
}

export interface StateChangedPayload {
  readonly from: PetState;
  readonly to: PetState;
  readonly reason: string;
  readonly source?: string;
}

export interface PluginStatePayload {
  readonly id: string;
  readonly status: PluginRecord['status'];
  readonly error?: string;
}

export interface TrayStatePayload {
  readonly visible?: boolean;
  readonly behaviorPaused?: boolean;
  readonly currentAnimation?: string | null;
  readonly currentState?: PetState;
  readonly plugins?: readonly PluginRecord[];
  /** 当前尺寸（用于菜单勾选状态）。 */
  readonly size?: PetSizeInfo;
  readonly alwaysOnTop?: boolean;
  /** 全部已注册动画（仅供主进程构造「播放动画」菜单使用）。 */
  readonly animations?: readonly AnimationSummary[];
  /** AI 状态（仅供主进程构造「AI（认知与人格）」子菜单使用）。 */
  readonly ai?: AIStatusView;
  /** 在场状态（可见 / 收起 / 隐藏），子菜单据此显示"收起/展开"。 */
  readonly presence?: PetPresence;
}

/** 菜单展示用的动画摘要（主进程从 Manifest 解析）。 */
export interface AnimationSummary {
  readonly id: string;
  readonly label: string;
  readonly priority: number;
  readonly loop: boolean;
  readonly type: string;
}

/* -------------------------------------------------------------------------- */
/* Preload 暴露给 Renderer 的 API                                              */
/* -------------------------------------------------------------------------- */

/** 资源加载：把相对 assets/ 的路径解析成可用的 URL。 */
export interface AssetAPI {
  /** 例如 resolve('animations/sleep.webm') -> file:///.../assets/animations/sleep.webm */
  resolve(relativePath: string): string;
}

export interface WindowAPI {
  setPosition(x: number, y: number): Promise<void>;
  getPosition(): Promise<WindowPosition>;
  setSize(width: number, height: number): Promise<void>;
  startDrag(): void;
  show(): void;
  hide(): void;
  setAlwaysOnTop(value: boolean): void;
  setIgnoreMouseEvents(ignore: boolean, forward?: boolean): void;
  /**
   * 上报指针在窗口内的归一化位置（0~1）。
   *
   * 主进程据此判断指针是否落在"宠物/气泡"上，从而切换鼠标穿透 ——
   * 透明区域应当点得到下面的窗口。
   */
  reportPointer(nx: number, ny: number): void;
  /** 打开设置窗口（滚动条调尺寸）。与托盘「设置…」是同一条路径。 */
  showSettingsWindow(): Promise<boolean>;
}

export interface MenuAPI {
  showContextMenu(payload: { region?: string; animationId?: string | null }): void;
}

export interface TrayAPI {
  updateState(state: TrayStatePayload): void;
}

export interface LogAPI {
  write(payload: LogPayload): void;
}

export interface ActionAPI {
  execute(action: PetAction): Promise<ActionResult>;
}

export interface PluginBridgeAPI {
  list(): Promise<readonly PluginRecord[]>;
  fetchCode(id: string): Promise<PluginCodePayload | null>;
  reload(id: string): Promise<void>;
  notifyActivated(payload: PluginStatePayload): void;
  notifyDeactivated(payload: PluginStatePayload): void;
  notifyError(payload: { id: string; hook: string; message: string }): void;
  /** 主进程主动要求重新加载全部插件时触发。 */
  onReloadRequested(handler: () => void): () => void;
}

/** 对话气泡 API（托盘菜单与验收脚本共用；第一版不做自动触发）。 */
export interface BubbleAPI {
  /**
   * 显示气泡（text 为空串表示只显示空气泡）。
   * 传 null 表示隐藏。
   */
  set(state: BubbleState | null): Promise<BubblePayload>;
  /**
   * 回报当前文本占用的行数（Renderer 量出后调用），返回**重算后的状态与布局**。
   *
   * 气泡高度由文本行数决定，而字体度量只有 Renderer 能做，因此由它回传；
   * 主进程顺手把新布局返回，渲染层直接落地，省掉一次单独推送。
   */
  reportTextLines(payload: { text: string; lines: number }): Promise<BubblePayload>;
  /**
   * 用户点了气泡上的"知道了"：请求关闭气泡。返回收起后的状态与布局。
   *
   * 关闭必须由 Main 执行 —— 窗口尺寸要跟着收回宠物大小。
   */
  acknowledge(): Promise<BubblePayload>;
}

export interface CommandAPI {
  onAction(handler: (action: PetAction) => void): () => void;
  onSetBehaviorPaused(handler: (paused: boolean) => void): () => void;
  onSetAnimation(handler: (animationId: string) => void): () => void;
  /** 尺寸变化（托盘/右键菜单/设置界面调整）时通知 Renderer。 */
  onSizeChanged(handler: (size: PetSizeInfo) => void): () => void;
  /** 对话气泡状态/布局变化（含由它引起的窗口尺寸变化）。 */
  onBubble(handler: (payload: BubblePayload) => void): () => void;
  onShutdown(handler: () => void): () => void;
}

/** 尺寸与设置 API（托盘菜单、未来的设置界面都走这里）。 */
export interface SettingsAPI {
  get(): Promise<PetSettingsState>;
  /** 设置缩放系数（会被 clamp 到合法区间）。返回实际生效的尺寸信息。 */
  setScale(scale: number): Promise<PetSettingsState>;
  setAlwaysOnTop(value: boolean): Promise<PetSettingsState>;
  /** 订阅尺寸/设置变化（含托盘菜单触发的调整）。 */
  onChanged(handler: (state: PetSettingsState) => void): () => void;
}

/**
 * AI 认知与人格 API（2.1~2.4）。
 *
 * 桌宠窗口（`petAPI.ai`）与设置窗口（`settingsAPI.ai`）共用同一个面：
 * 两边都需要"看状态、改开关、读日记、读记忆"，差别只在布局。
 * 注意返回的配置里**没有明文密钥**（只有掩码），密钥的写入是单向的。
 */
export interface AIAPI {
  /** 状态快照：开关、掩码配置、模式（llm/local）、情绪、数据目录。 */
  status(): Promise<AIStatusView>;
  /** 修改配置（部分字段；`apiKey` 省略 = 保持原值）。 */
  setSettings(patch: AISettingsPatch): Promise<AIStatusView>;
  /** 对桌宠说一句话（2.1）。关掉 AI 时走本地兜底回复，不会报错。 */
  chat(text: string): Promise<AIChatReply>;
  /** 最近的对话记录（倒序，最多 20 轮）。 */
  history(): Promise<readonly ChatTurn[]>;
  /** 记忆快照（2.2）。 */
  memory(): Promise<MemorySnapshot>;
  /** 清空记忆（保留配置文件）。 */
  clearMemory(): Promise<MemorySnapshot>;
  /** 在系统文件管理器里打开记忆日志文件。 */
  openMemoryLog(): Promise<boolean>;
  /** 日记列表（2.4）。 */
  diary(): Promise<DiarySnapshot>;
  /** 读某一篇日记；不存在返回 null。 */
  diaryGet(date: string): Promise<DiaryEntry | null>;
  /** 立刻写今天的日记（已写过则覆盖）。 */
  writeDiary(): Promise<DiaryEntry>;
  /** 打开日记目录。 */
  openDiaryDir(): Promise<boolean>;
  /** 连通性自检（设置界面「测试连接」）。 */
  testConnection(): Promise<AITestResult>;
  /** 上报一次互动（点击/拖动/双击），用于情绪上涨。 */
  notifyInteraction(kind: InteractionKind): void;
  /** 把情绪重置回初始值。 */
  resetEmotion(): Promise<AIStatusView>;
  /** 切换在场状态（收起 = 安静待着：点击穿透 + 行为暂停 + 情绪下降更快）。 */
  setPresence(presence: PetPresence): Promise<AIStatusView>;
  /** 打开聊天窗口（桌宠窗口/托盘共用）。 */
  openChatWindow(): Promise<boolean>;
  /** 订阅状态变化（情绪心跳会定期推送）。 */
  onStatus(handler: (status: AIStatusView) => void): () => void;
  /** 订阅"宠物主动说话 / 系统提示"（聊天窗口与桌宠窗口都可订阅）。 */
  onChatMessage(handler: (message: ChatMessagePush) => void): () => void;
}

/** `window.petAPI` 的完整形状。 */
export interface PetBridge {
  readonly runtime: RuntimeInfo;
  readonly assets: AssetAPI;
  readonly window: WindowAPI;
  readonly menu: MenuAPI;
  readonly tray: TrayAPI;
  readonly log: LogAPI;
  readonly actions: ActionAPI;
  readonly plugins: PluginBridgeAPI;
  readonly commands: CommandAPI;
  readonly settings: SettingsAPI;
  /** 对话气泡（第一版只用于手动验证）。 */
  readonly bubble: BubbleAPI;
  /** AI 认知与人格（2.1~2.4）。 */
  readonly ai: AIAPI;
  notifyAnimationChanged(payload: AnimationChangedPayload): void;
  notifyStateChanged(payload: StateChangedPayload): void;
  notifyBehaviorPaused(paused: boolean): void;
}
