/**
 * ChatWindowManager —— 聊天窗口（2.1 的输入口）。
 *
 * 与设置窗口刻意保持一致的三点（少一套机制就少一类 bug）：
 * 1. **复用同一份 preload 产物**（`dist/preload/preload.js`），
 *    只靠命令行参数 `--pet-window=chat` 决定暴露 `window.chatAPI`；
 * 2. **关闭 = 隐藏**（不销毁），下次打开是瞬时的；
 * 3. 窗口在第一次打开时才创建（惰性），主进程只持有引用与回调。
 *
 * 它本身不含任何 AI 逻辑：所有请求都转发给 AIService，
 * 这样"桌宠窗口说话"与"聊天窗口说话"走的是**同一条链路**（不会两套行为）。
 */

import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import { IpcChannels } from '../shared/ipc';
import type { PluginPanelTargetPayload } from '../shared/ipc';
import type { PetConfig } from '../shared/config';
import type { AIStatusView, ChatMessagePush, ChatTurn, DiarySnapshot } from '../shared/ai-types';
import type { NoteBox } from '../shared/notes';
import type { PluginPanelView } from '../shared/plugin-types';
import {
  CHAT_BOOTSTRAP_FLAG,
  CHAT_WINDOW_FLAG,
  type ChatView,
  type ChatWindowBootstrap,
} from '../shared/chat-window';
import type { Logger } from '../shared/logger';
import { describeError } from '../shared/errors';

export interface ChatWindowOptions {
  readonly config: PetConfig;
  readonly logger: Logger;
  /** 打开窗口时读一次历史。 */
  readonly getHistory: () => readonly ChatTurn[];
  /** 打开窗口时读一次状态。 */
  readonly getStatus: () => AIStatusView;
  /** 打开窗口时读一次留言箱。 */
  readonly getNotes: () => NoteBox;
  /**
   * 当前已注册的插件面板（TODO / 课程表 / 番茄钟这类内容渲染在这个窗口里）。
   *
   * 面板住在桌宠渲染层的插件里，而**渲染**在聊天窗口 —— 两边通过 Main 中转：
   * 插件上报 HTML 快照，用户点击再原路回传。这样插件不必（也不能）拿到
   * 第二个窗口的 DOM。
   */
  readonly getPanels: () => readonly PluginPanelView[];
  /** 打开窗口时读一次日记清单（「交互」窗口的日记页）。 */
  readonly getDiary: () => DiarySnapshot;
}

/** 聊天窗口尺寸（DIP）：够宽放得下一句话，够高看得到几轮对话。 */
const WINDOW_WIDTH = 420;
const WINDOW_HEIGHT = 560;

export class ChatWindowManager {
  private readonly options: ChatWindowOptions;
  private readonly logger: Logger;
  private window: BrowserWindow | null = null;
  private ready = false;
  /** preload 就绪前推来的消息先排队，避免丢消息（打开瞬间最常见的竞态）。 */
  private readonly pending: ChatMessagePush[] = [];
  /** preload 就绪前推来的"切到某个插件面板"请求（只保留最后一次意图）。 */
  private pendingPanelRequest: PluginPanelTargetPayload | null = null;

  public constructor(options: ChatWindowOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  public open(view: ChatView = 'chat'): boolean {
    if (this.exists()) {
      const window = this.window as BrowserWindow;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      this.pushStatus();
      this.pushNotes();
      this.pushDiary();
      this.pushPanels();
      // 窗口已存在时"去哪个视图"只能靠推一条指令（bootstrap 早就用过了）
      this.pushView(view);
      return true;
    }
    this.create(view);
    return true;
  }

  public exists(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  /** 窗口引用（例如主进程要统一设置"不出现在截屏里"）。 */
  public getWindow(): BrowserWindow | null {
    return this.exists() ? this.window : null;
  }

  public isVisible(): boolean {
    return this.exists() && (this.window as BrowserWindow).isVisible();
  }

  public hide(): void {
    if (!this.exists()) return;
    (this.window as BrowserWindow).hide();
  }

  public toggle(): boolean {
    if (this.isVisible()) {
      this.hide();
      return false;
    }
    return this.open();
  }

  public destroy(): void {
    if (!this.exists()) {
      this.window = null;
      return;
    }
    const window = this.window as BrowserWindow;
    this.window = null;
    this.ready = false;
    try {
      window.destroy();
    } catch (error) {
      this.logger.warn('destroying chat window failed', { error: describeError(error) });
    }
  }

  /** 推一条消息给聊天窗口（她主动说话 / 系统提示 / 回复）。 */
  public pushMessage(message: ChatMessagePush): void {
    if (!this.exists()) return;
    if (!this.ready) {
      // 窗口还在加载：排队，等 did-finish-load 后补发
      this.pending.push(message);
      if (this.pending.length > 50) this.pending.shift();
      return;
    }
    this.send(IpcChannels.CommandChatMessage, message);
  }

  /** 推状态（心情心跳、设置变化）。 */
  public pushStatus(status?: AIStatusView): void {
    if (!this.exists() || !this.ready) return;
    this.send(IpcChannels.CommandAIStatus, status ?? this.options.getStatus());
  }

  /** 推留言箱（新纸条 / 未读变化）。 */
  public pushNotes(box?: NoteBox): void {
    if (!this.exists() || !this.ready) return;
    this.send(IpcChannels.CommandNotes, box ?? this.options.getNotes());
  }

  /**
   * 推日记清单（刚写好一篇 / 打开窗口时对账）。
   *
   * 为什么需要推：日记每天到点会自动写，用户也可能在设置窗口里点「立即写今天的日记」——
   * 这两种情况下「交互」窗口里的日记页都该自己更新。
   */
  public pushDiary(snapshot?: DiarySnapshot): void {
    if (!this.exists() || !this.ready) return;
    this.send(IpcChannels.CommandDiary, snapshot ?? this.options.getDiary());
  }

  /** 让窗口切到某个视图（托盘点「小纸条…」走这条）。 */
  public pushView(view: ChatView): void {
    if (!this.exists() || !this.ready) return;
    this.send(IpcChannels.CommandChatView, view);
  }

  /**
   * 推插件面板快照（插件注册 / 更新 / 停用都会变）。
   *
   * 插件被停用时快照里自然就没有它的面板了 —— 聊天窗口据此把对应的页签
   * 收掉。这正是"关掉插件，它的界面也跟着消失"的那一环。
   */
  /**
   * 请窗口切到某个插件面板（托盘/桌宠里点了插件的"打开面板"）。
   *
   * 与 `pushPanels` 分开：快照是"有什么面板"，这条是"看哪一个"，
   * 两件事混在一条消息里会让"面板刚注册就要切过去"出现竞态（先切后到 = 白切）。
   */
  public pushPanelRequest(target: PluginPanelTargetPayload): void {
    if (!this.exists()) return;
    if (!this.ready) {
      // 窗口刚创建（还没 did-finish-load）：记下来，加载完补发 —— 否则
      // "插件请求打开自己的面板"会在窗口首次打开时静默丢掉
      this.pendingPanelRequest = target;
      return;
    }
    this.send(IpcChannels.CommandChatPanel, target);
  }

  public pushPanels(panels?: readonly PluginPanelView[]): void {
    if (!this.exists() || !this.ready) return;
    this.send(IpcChannels.CommandPluginPanels, panels ?? this.options.getPanels());
  }

  private send(channel: string, payload: unknown): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send(channel, payload);
    } catch (error) {
      this.logger.warn('pushing to chat window failed', { error: describeError(error), data: { channel } });
    }
  }

  private create(view: ChatView = 'chat'): void {
    const bootstrap: ChatWindowBootstrap = {
      history: this.options.getHistory(),
      status: this.options.getStatus(),
      notes: this.options.getNotes(),
      diary: this.options.getDiary(),
      view,
      panels: this.options.getPanels(),
    };

    const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
      // 与桌宠/设置窗口同一套安全基线
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: this.options.config.settingsPreloadPath,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: this.options.config.mode === 'development',
      additionalArguments: [
        CHAT_WINDOW_FLAG,
        `${CHAT_BOOTSTRAP_FLAG}${Buffer.from(JSON.stringify(bootstrap), 'utf8').toString('base64')}`,
      ],
    };

    const window = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      minWidth: 360,
      minHeight: 420,
      // 普通窗口：可拖动、可关闭、可缩放（聊天记录长短不一，允许用户拉高）
      frame: true,
      resizable: true,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      autoHideMenuBar: true,
      backgroundColor: '#1b1d23',
      show: false,
      title: '和鲸鱼娘说话',
      webPreferences,
    });

    window.on('close', (event) => {
      if (!this.exists()) return;
      event.preventDefault();
      window.hide();
    });
    window.on('closed', () => {
      this.window = null;
      this.ready = false;
    });
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      this.logger.error('chat window preload failed', { error, data: { preloadPath } });
    });
    window.webContents.on('did-fail-load', (_event, code, description, url) => {
      this.logger.error('chat window load failed', { data: { code, description, url } });
    });
    window.webContents.on('did-finish-load', () => {
      this.ready = true;
      // 补发排队中的消息（顺序保持）
      const queued = this.pending.splice(0, this.pending.length);
      for (const message of queued) this.pushMessage(message);
      // 面板请求只保留最后一次意图：用户点的是最新那一次
      const panelRequest = this.pendingPanelRequest;
      this.pendingPanelRequest = null;
      if (panelRequest) this.pushPanelRequest(panelRequest);
    });

    this.window = window;
    void this.load(window);
  }

  private async load(window: BrowserWindow): Promise<void> {
    try {
      await window.loadFile(this.options.config.chatHtmlPath);
      this.logger.info('chat window loaded', { data: { file: this.options.config.chatHtmlPath } });
      window.show();
      window.focus();
    } catch (error) {
      this.logger.error('chat window load failed', { error: describeError(error) });
      this.destroy();
    }
  }
}
