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

  /* 设置窗口（独立的小窗口，只暴露尺寸/置顶） */
  SettingsWindowShow: 'pet:settings-window-show',
  SettingsWindowSetScale: 'pet:settings-window-set-scale',
  SettingsWindowSetAlwaysOnTop: 'pet:settings-window-set-always-on-top',
  SettingsWindowOpenConfig: 'pet:settings-window-open-config',
  SettingsWindowClose: 'pet:settings-window-close',
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

  /* Main -> Renderer 指令 */
  CommandAction: 'pet:command-action',
  CommandSetBehaviorPaused: 'pet:command-set-behavior-paused',
  CommandReloadPlugins: 'pet:command-reload-plugins',
  CommandSetAnimation: 'pet:command-set-animation',
  CommandSizeChanged: 'pet:command-size-changed',
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

export interface CommandAPI {
  onAction(handler: (action: PetAction) => void): () => void;
  onSetBehaviorPaused(handler: (paused: boolean) => void): () => void;
  onSetAnimation(handler: (animationId: string) => void): () => void;
  /** 尺寸变化（托盘/右键菜单/设置界面调整）时通知 Renderer。 */
  onSizeChanged(handler: (size: PetSizeInfo) => void): () => void;
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
  notifyAnimationChanged(payload: AnimationChangedPayload): void;
  notifyStateChanged(payload: StateChangedPayload): void;
  notifyBehaviorPaused(paused: boolean): void;
}
