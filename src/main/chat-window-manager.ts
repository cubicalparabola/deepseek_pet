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
import type { PetConfig } from '../shared/config';
import type { AIStatusView, ChatMessagePush, ChatTurn } from '../shared/ai-types';
import { CHAT_BOOTSTRAP_FLAG, CHAT_WINDOW_FLAG, type ChatWindowBootstrap } from '../shared/chat-window';
import type { Logger } from '../shared/logger';
import { describeError } from '../shared/errors';

export interface ChatWindowOptions {
  readonly config: PetConfig;
  readonly logger: Logger;
  /** 打开窗口时读一次历史。 */
  readonly getHistory: () => readonly ChatTurn[];
  /** 打开窗口时读一次状态。 */
  readonly getStatus: () => AIStatusView;
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

  public constructor(options: ChatWindowOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  public open(): boolean {
    if (this.exists()) {
      const window = this.window as BrowserWindow;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      this.pushStatus();
      return true;
    }
    this.create();
    return true;
  }

  public exists(): boolean {
    return this.window !== null && !this.window.isDestroyed();
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

  private send(channel: string, payload: unknown): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send(channel, payload);
    } catch (error) {
      this.logger.warn('pushing to chat window failed', { error: describeError(error), data: { channel } });
    }
  }

  private create(): void {
    const bootstrap: ChatWindowBootstrap = {
      history: this.options.getHistory(),
      status: this.options.getStatus(),
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
