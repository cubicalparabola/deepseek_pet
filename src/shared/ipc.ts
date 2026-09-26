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
import type { BehaviorConfig, PetDisplayState } from './behavior-config';
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
import type {
  PerceptionLogItem,
  PerceptionSettingsPatch,
  PerceptionStatus,
  PerceptionViewMode,
  PerceptionViewResult,
} from './perception-types';
import type { TimelineTextResult } from './timeline-types';
import type {
  GrowthSettingsPatch,
  GrowthStatus,
  MemoryNodeKind,
} from './growth-types';

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
  /**
   * Renderer -> Main：拖拽结束（松开鼠标）。
   *
   * 谁来判定"该不该收起"：只有主进程知道工作区（`screen.workArea`）与宠物在窗口里的
   * 实际位置，所以渲染层只上报"拖完了"，由主进程按最终位置决定
   * 贴下边缘 / 贴右边缘 / 不贴边，并广播显示状态。
   */
  WindowDragEnd: 'pet:window-drag-end',
  /**
   * Renderer -> Main：请求展开（用户点了一下收起状态的宠物）。
   *
   * 收起状态仍然接收点击（需求：点击宠物即可展开），这条只是把"被点了"
   * 转成一次展开动作，位置回退到收起前的位置。
   */
  WindowUndock: 'pet:window-undock',

  /* 尺寸 / 设置 */
  SettingsGet: 'pet:settings-get',
  SettingsSetScale: 'pet:settings-set-scale',
  SettingsSetAlwaysOnTop: 'pet:settings-set-always-on-top',
  /** 拖到边缘是否自动收起（shared/dock.ts）。 */
  SettingsSetDockOnEdge: 'pet:settings-set-dock-on-edge',
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
  /** 立刻查一次余额（DeepSeek `GET /user/balance`：唯一的额度接口）。 */
  AIBalanceRefresh: 'pet:ai-balance-refresh',
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

  /* --------------- 环境与用户感知（3.1~3.6） ---------------
   *
   * 与 AI 一样，采集与判断全在主进程；渲染层只有两件事：
   * 上报"摄像头是否就绪"和"回传一帧"（getUserMedia 只能在渲染层调）。
   */
  /** 感知状态（开关、当前场景、行为快照、在场、习惯、最近干预）。 */
  PerceptionStatusGet: 'pet:perception-status',
  /** 修改感知配置（部分补丁；隐私模式也在其中）。 */
  PerceptionSettingsSet: 'pet:perception-settings-set',
  /** 感知日志（她看见了什么 / 为什么开口）。 */
  PerceptionLog: 'pet:perception-log',
  /** 3.2 按需"看屏幕"：只剩「看我在做什么（场景）」。 */
  PerceptionViewNow: 'pet:perception-view',
  /** 摄像头授权（只能由界面上显式按钮置为 true）。 */
  PerceptionCameraAuthorize: 'pet:perception-camera-authorize',
  /** 清空感知数据（观察记录 + 习惯画像）。 */
  PerceptionClearData: 'pet:perception-clear',
  /** 在文件管理器里打开感知日志文件。 */
  PerceptionOpenLog: 'pet:perception-open-log',
  /** 立刻采一次（验收与手动调试用）。 */
  PerceptionSampleNow: 'pet:perception-sample-now',
  /** 读某天的时间线（默认今天）：区间 + 汇总 + 她写的叙述。 */
  PerceptionTimelineGet: 'pet:perception-timeline',
  /** 让模型写/重写某天的"她记得的今天"（多一次 LLM 调用）。 */
  PerceptionTimelineNarrate: 'pet:perception-timeline-narrate',
  /** Renderer -> Main：一帧摄像头画面（JPEG data URL，**不落盘**）。 */
  PerceptionCameraFrame: 'pet:perception-camera-frame',
  /** Renderer -> Main：摄像头就绪/失败。 */
  PerceptionCameraReady: 'pet:perception-camera-ready',

  /* --------------- 成长、记忆与反思（4.1 / 4.2） ---------------
   *
   * 全部在主进程：记忆宫殿的节点、每天的反思、以及反思得出的行为策略。
   * 渲染层只看到只读快照与几个明确动作（记一笔 / 删一段 / 回忆一下 / 立刻反思 / 重置策略）。
   */
  /** 成长状态（节点时间轴 + 今天的反思 + 当前策略 + 反馈统计）。 */
  GrowthStatusGet: 'pet:growth-status',
  /** 修改开关与反射时刻。 */
  GrowthSettingsSet: 'pet:growth-settings-set',
  /** 手动记一笔（记忆节点）。 */
  GrowthNodeAdd: 'pet:growth-node-add',
  /** 删除一个节点。 */
  GrowthNodeRemove: 'pet:growth-node-remove',
  /** 钉住/取消钉住（"这段很重要"）。 */
  GrowthNodePin: 'pet:growth-node-pin',
  /** 让她回忆某个节点（会说一句话）。 */
  GrowthNodeRecall: 'pet:growth-node-recall',
  /** 立刻写今天的反思（并按结论调整策略）。 */
  GrowthReflectNow: 'pet:growth-reflect-now',
  /** 重置策略（回到用户原始设置）。 */
  GrowthResetPolicy: 'pet:growth-reset-policy',
  /** 从今天的素材里再淘一遍节点（手动补记忆）. */
  GrowthRefreshPalace: 'pet:growth-refresh-palace',
  /** 打开记忆宫殿的可读镜像（`memory/palace.md`）。 */
  GrowthOpenPalace: 'pet:growth-open-palace',
  /** 打开策略调整历史（`reflection/policy-log.md`）。 */
  GrowthOpenPolicyLog: 'pet:growth-open-policy-log',

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
  /** Main -> 感知状态变化（设置窗口的感知面板靠它刷新）。 */
  CommandPerceptionStatus: 'pet:command-perception-status',
  /** Main -> 渲染层：请采集一帧摄像头画面并回传（3.5）。 */
  CommandPerceptionCameraRequest: 'pet:command-perception-camera-request',
  /** Main -> 界面：成长/反思状态变化（记忆宫殿与策略会在反思后变）。 */
  CommandGrowthStatus: 'pet:command-growth-status',
  /**
   * Main -> 渲染层：**播放一条触发动画**（感知/AI/系统触发，不是用户点菜单）。
   *
   * 为什么不能用 `CommandSetAnimation`：那条是"用户在托盘里挑动画（测试）"的语义 ——
   * 强制切换、绕过冷却、再点一次就结束。触发动画要的是普通优先级仲裁
   * （被打断、冷却、礼貌让位都要成立）。
   */
  CommandTriggerAnimation: 'pet:command-trigger-animation',
  /**
   * Main -> 渲染层：显示状态变化（收起方向 / 隐藏）。
   * 渲染层据此切换默认动画与随机池（正常 idle / 下方 lie / 右侧 watch）。
   */
  CommandDisplayState: 'pet:command-display-state',
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
  /**
   * 显示状态与随机池配置（Main 读取 `behavior.json` 后下发）。
   *
   * 渲染层用它决定"这个状态下默认播什么、随机池里有哪些、多久触发一次"。
   */
  readonly behaviorConfig: BehaviorConfig;
  /** 当前显示状态（收起方向 + 是否隐藏）。 */
  readonly display: PetDisplayState;
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
  /** 当前显示状态（收起 / 隐藏可能在 Renderer 就绪前就定了）。 */
  readonly display?: PetDisplayState;
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

/**
 * 触发动画指令（Main -> Renderer）。
 *
 * 与"用户在托盘挑动画"不同：这是**自动来源**（感知 / AI / 系统），
 * 因此走普通优先级仲裁与冷却，并且不享受 force / bypassCooldown。
 */
export interface TriggerAnimationPayload {
  readonly animationId: string;
  /** 触发原因（写进日志，便于回答"她为什么突然难过"）。 */
  readonly reason: string;
  readonly source?: string;
  /** 优先级覆盖（省略 = 用清单里的定义）。 */
  readonly priority?: number;
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
  /** 拖到边缘是否自动收起（菜单勾选状态）。 */
  readonly dockOnEdge?: boolean;
  /** 全部已注册动画（仅供主进程构造「播放动画」菜单使用）。 */
  readonly animations?: readonly AnimationSummary[];
  /** AI 状态（仅供主进程构造「AI（认知与人格）」子菜单使用）。 */
  readonly ai?: AIStatusView;
  /** 在场状态（可见 / 收起 / 隐藏），子菜单据此显示"收起/展开"。 */
  readonly presence?: PetPresence;
  /** 显示状态（收起方向 / 是否隐藏）：菜单据此显示"收起（右侧）/ 展开"。 */
  readonly display?: PetDisplayState;
  /** 感知状态（仅供主进程构造「感知（环境与用户）」子菜单使用）。 */
  readonly perception?: PerceptionStatus;
  /** 成长状态（仅供主进程构造「成长与记忆」子菜单使用）。 */
  readonly growth?: GrowthStatus;
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
  /**
   * 上报"拖拽结束"，由主进程判定是否贴边收起（并广播新的显示状态）。
   * @param screenX/screenY 松开鼠标时的屏幕坐标（主进程用它兜底判定贴边）
   */
  dragEnd(screenX?: number, screenY?: number): Promise<PetDisplayState>;
  /** 请求展开（收起状态下点了宠物）：回到收起前的位置。 */
  undock(): Promise<PetDisplayState>;
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
  /** 自动来源的触发动画（感知 / AI / 系统）：走普通优先级仲裁，不是强制切换。 */
  onTriggerAnimation(handler: (payload: TriggerAnimationPayload) => void): () => void;
  /** 显示状态变化（收起方向 / 隐藏）：渲染层据此切换默认动画与随机池。 */
  onDisplayState(handler: (payload: PetDisplayState) => void): () => void;
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
  /**
   * 拖到屏幕边缘是否自动收起。
   *
   * 关掉后边缘不再触发收起（托盘的「收起（贴边）」仍然可用 —— 那是显式动作）。
   */
  setDockOnEdge(value: boolean): Promise<PetSettingsState>;
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
  /**
   * 立刻查一次余额（DeepSeek `GET /user/balance`）。
   *
   * 余额不只用于展示：它**优先于本地累计 token** 决定"饿"，
   * 余额不足 / key 无效还会让她演 offline。
   */
  refreshBalance(): Promise<AIStatusView>;
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

/**
 * 环境与用户感知 API（3.1~3.6）。
 *
 * 与 `AIAPI` 一样，桌宠窗口（`petAPI.perception`）与设置窗口（`settingsAPI.perception`）
 * 共用同一个面；区别是这里还多了**渲染层负责的两件事**：
 * `setCameraReady` 与 `cameraFrame` —— 因为 `getUserMedia` 只能在渲染层调用。
 */
export interface PerceptionAPI {
  /** 状态快照（开关、当前场景、行为、在场、习惯、最近一次干预）。 */
  status(): Promise<PerceptionStatus>;
  /** 修改配置（含 `privacyMode`：一键停止一切采集）。 */
  setSettings(patch: PerceptionSettingsPatch): Promise<PerceptionStatus>;
  /** 感知日志（倒序，最多 limit 条）。 */
  log(limit?: number): Promise<readonly PerceptionLogItem[]>;
  /** 3.2 按需看屏幕（只剩「看我在做什么（场景）」）。 */
  viewNow(mode: PerceptionViewMode): Promise<PerceptionViewResult>;
  /** 摄像头授权开关（界面上必须是**显式**按钮，不允许偷偷打开）。 */
  authorizeCamera(authorized: boolean): Promise<PerceptionStatus>;
  /** 清空她观察到的一切（观察记录 + 习惯画像）。 */
  clearData(): Promise<PerceptionStatus>;
  /** 打开感知日志文件（人可读那份）。 */
  openLog(): Promise<boolean>;
  /** 立刻采一次（验收/调试入口）。 */
  sampleNow(): Promise<PerceptionStatus>;
  /** 读某天的时间线（不传 = 今天）：区间汇总 + 她写的那段叙述。 */
  timeline(date?: string): Promise<TimelineTextResult>;
  /** 让模型写/重写某天的叙述（`force` = 已有也重写）。 */
  narrateTimeline(date?: string, force?: boolean): Promise<TimelineTextResult>;
  /** 渲染层：摄像头可用性上报。 */
  setCameraReady(ready: boolean, error?: string): void;
  /** 渲染层：回传一帧摄像头画面（JPEG data URL）。 */
  cameraFrame(dataUrl: string): void;
  /** 订阅状态变化（采样后与开关变化时推送）。 */
  onStatus(handler: (status: PerceptionStatus) => void): () => void;
  /** 订阅"请采集一帧"的请求（渲染层据此调用 getUserMedia 取帧）。 */
  onCameraRequest(handler: () => void): () => void;
}

/**
 * 成长、记忆与反思 API（4.1 / 4.2）。
 *
 * 桌宠窗口与设置窗口共用同一个面；两件事是这里的重点：
 * - **记忆宫殿是可编辑的**（记一笔 / 删一段 / 钉住 / 让她回忆）——
 *   用户能改她记的东西，才谈得上"共同经历"；
 * - **反思的结论是可回退的**（`resetPolicy`）—— 她会自己变安静，
 *   但绝不能变成"用户控制不了的行为"。
 */
export interface GrowthAPI {
  status(): Promise<GrowthStatus>;
  setSettings(patch: GrowthSettingsPatch): Promise<GrowthStatus>;
  addNode(input: { kind: MemoryNodeKind; title: string; detail: string }): Promise<GrowthStatus>;
  removeNode(id: string): Promise<GrowthStatus>;
  pinNode(id: string, pinned: boolean): Promise<GrowthStatus>;
  /** 让她回忆这个节点（返回她说的话）。 */
  recallNode(id: string): Promise<{ readonly ok: boolean; readonly text: string }>;
  /** 立刻写今天的反思（会按结论调整策略）。 */
  reflectNow(): Promise<GrowthStatus>;
  resetPolicy(): Promise<GrowthStatus>;
  /** 从今天的素材里再淘一遍节点。 */
  refreshPalace(): Promise<GrowthStatus>;
  openPalace(): Promise<boolean>;
  openPolicyLog(): Promise<boolean>;
  onStatus(handler: (status: GrowthStatus) => void): () => void;
}

/** `window.petAPI` 的完整形状。 */
export interface PetBridge {  readonly runtime: RuntimeInfo;
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
  /** 环境与用户感知（3.1~3.6）。 */
  readonly perception: PerceptionAPI;
  /** 成长、记忆与反思（4.1 / 4.2）。 */
  readonly growth: GrowthAPI;
  notifyAnimationChanged(payload: AnimationChangedPayload): void;
  notifyStateChanged(payload: StateChangedPayload): void;
  notifyBehaviorPaused(paused: boolean): void;
}
