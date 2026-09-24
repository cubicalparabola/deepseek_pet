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
  AnimationChangedPayload,
  LogPayload,
  PetBootstrap,
  PetBridge,
  PluginCodePayload,
  PluginStatePayload,
  RuntimeInfo,
  StateChangedPayload,
  TrayStatePayload,
  WindowPosition,
} from '../shared/ipc';
import type { PetAction, ActionResult } from '../shared/action-types';
import type { PetSettingsState, PetSizeInfo } from '../shared/pet-size';
import type { BubblePayload, BubbleState } from '../shared/bubble';
import { ASSET_HOST, ASSET_SCHEME } from '../shared/protocol';
import {
  SETTINGS_BOOTSTRAP_FLAG,
  SETTINGS_WINDOW_FLAG,
  type SettingsWindowBootstrap,
  type SettingsWindowBridge,
} from '../shared/settings-window';

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
/* window.settingsAPI（仅设置窗口）                                             */
/* -------------------------------------------------------------------------- */

/**
 * 设置窗口走的是**同一份 preload 产物**，但只暴露下面这 4 个方法。
 *
 * 用命令行参数区分角色，而不是开第二份 preload 文件：
 * 桥的面越小越好维护，也让"设置窗口拿不到桌宠 IPC"这件事在代码上是显然的。
 */
const isSettingsWindow = process.argv.includes(SETTINGS_WINDOW_FLAG);

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
  },
  configPath: '',
};

function buildSettingsBridge(): SettingsWindowBridge {
  return {
    initial: readFlaggedJson<SettingsWindowBootstrap>(SETTINGS_BOOTSTRAP_FLAG) ?? settingsFallback,
    setScale: (scale: number): Promise<PetSettingsState> =>
      ipcRenderer.invoke(IpcChannels.SettingsWindowSetScale, scale) as Promise<PetSettingsState>,
    setAlwaysOnTop: (value: boolean): Promise<PetSettingsState> =>
      ipcRenderer.invoke(IpcChannels.SettingsWindowSetAlwaysOnTop, value) as Promise<PetSettingsState>,
    openConfigFolder: (): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.SettingsWindowOpenConfig) as Promise<boolean>,
    close: (): Promise<void> => ipcRenderer.invoke(IpcChannels.SettingsWindowClose) as Promise<void>,
    onChanged: (handler: (state: PetSettingsState) => void): Unsubscribe =>
      subscribe<PetSettingsState>(IpcChannels.CommandSettingsChanged, handler),
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
      showSettingsWindow: (): Promise<boolean> =>
        ipcRenderer.invoke(IpcChannels.SettingsWindowShow) as Promise<boolean>,
    },

    menu: {
      showContextMenu: (context: { region?: string; animationId?: string | null }): void =>
        send(IpcChannels.ContextMenuShow, context),
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
      fetchCode: (id: string): Promise<PluginCodePayload | null> =>
        ipcRenderer.invoke(IpcChannels.PluginFetchCode, id) as Promise<PluginCodePayload | null>,
      reload: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannels.PluginReload, id) as Promise<void>,
      notifyActivated: (payload: PluginStatePayload): void => send(IpcChannels.PluginActivated, payload),
      notifyDeactivated: (payload: PluginStatePayload): void => send(IpcChannels.PluginDeactivated, payload),
      notifyError: (payload: { id: string; hook: string; message: string }): void =>
        send(IpcChannels.PluginError, payload),
      onReloadRequested: (handler: () => void): Unsubscribe =>
        subscribe(IpcChannels.CommandReloadPlugins, () => handler()),
    },

    commands: {
      onAction: (handler: (action: PetAction) => void): Unsubscribe =>
        subscribe<PetAction>(IpcChannels.CommandAction, handler),
      onSetBehaviorPaused: (handler: (paused: boolean) => void): Unsubscribe =>
        subscribe<boolean>(IpcChannels.CommandSetBehaviorPaused, handler),
      onSetAnimation: (handler: (animationId: string) => void): Unsubscribe =>
        subscribe<string>(IpcChannels.CommandSetAnimation, handler),
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
} else {
  contextBridge.exposeInMainWorld('petAPI', buildPetBridge());
  contextBridge.exposeInMainWorld('petBootstrap', bootstrap ?? petWindowFallbackBootstrap);
}
