/**
 * SettingsWindowManager —— 设置窗口（一个**普通窗口**，带滚动条调尺寸）。
 *
 * 为什么不是对话框、也不是塞进桌宠窗口：
 * - `dialog.showMessageBox` 只能给按钮，做不出滑块；
 * - 桌宠窗口是透明、无边框、永远置顶的"活体图层"，
 *   在里面放交互控件既看不见（透明背景）又会跟着桌宠一起缩放。
 *
 * 交互契约（重要）：
 * **拖动滑块 = 立即生效 + 立即写盘**。没有"预览 / 应用"两套状态，
 * 因此关掉窗口、重启程序都不会丢；用户不需要记得点保存。
 *
 * 窗口生命周期：关闭 = 隐藏（`hide()`），不销毁，
 * 这样重复打开是瞬时的；退出程序时由 `destroy()` 真正销毁。
 *
 * preload 与桌宠窗口共用 `dist/preload/preload.js`：多传一个
 * `--pet-window=settings` 参数，preload 就只暴露 `window.settingsAPI`，
 * 设置页拿不到 `window.petAPI`（见 shared/settings-window.ts）。
 */

import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron';
import { IpcChannels } from '../shared/ipc';
import type { PetConfig } from '../shared/config';
import type { PetSettingsState } from '../shared/pet-size';
import type { AIStatusView } from '../shared/ai-types';
import type { PerceptionStatus } from '../shared/perception-types';
import type { GrowthStatus } from '../shared/growth-types';
import {
  SETTINGS_BOOTSTRAP_FLAG,
  SETTINGS_WINDOW_FLAG,
  type SettingsWindowBootstrap,
} from '../shared/settings-window';
import type { Logger } from '../shared/logger';
import { describeError } from '../shared/errors';

export interface SettingsWindowOptions {
  readonly config: PetConfig;
  readonly logger: Logger;
  /** 当前设置快照（每次打开窗口时读取，保证回显是最新的）。 */
  readonly getState: () => PetSettingsState;
  /** 调整尺寸（已含 clamp + 写盘），返回应用后的真实尺寸。 */
  readonly setScale: (scale: number) => PetSettingsState;
  readonly setAlwaysOnTop: (value: boolean) => PetSettingsState;
  /** AI 状态快照（AI 面板的初始数据 + 推送更新）。 */
  readonly getAIStatus: () => AIStatusView;
  /** 感知状态快照（感知面板的初始数据 + 推送更新）。 */
  readonly getPerceptionStatus: () => PerceptionStatus;
  /** 成长与反思状态快照（成长面板的初始数据 + 推送更新）。 */
  readonly getGrowthStatus: () => GrowthStatus;
}

/**
 * 设置窗口尺寸（DIP）。
 *
 * 高度从 430 提到 700：多出来的部分给「AI 认知与人格」面板
 * （四个开关 + 服务商配置 + 测试连接 + 日记/记忆入口）。
 * 同时把 resizable 打开 —— 日记列表可能很长，用户应该能自己拉高。
 */
const WINDOW_WIDTH = 520;
const WINDOW_HEIGHT = 700;

export class SettingsWindowManager {
  private readonly options: SettingsWindowOptions;
  private readonly logger: Logger;
  private window: BrowserWindow | null = null;

  public constructor(options: SettingsWindowOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /** 打开（或聚焦）设置窗口。 */
  public open(): void {
    if (this.exists()) {
      const window = this.window as BrowserWindow;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      // 重新打开时把最新设置推回页面（托盘菜单可能刚改过尺寸/情绪/隐私模式）
      this.pushState();
      this.pushAIStatus();
      this.pushPerceptionStatus();
      this.pushGrowthStatus();
      return;
    }
    this.create();
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

  /** 把最新设置推给设置窗口（若它正开着）。 */
  public pushState(): void {
    if (!this.exists()) return;
    const window = this.window as BrowserWindow;
    if (window.isDestroyed()) return;
    try {
      window.webContents.send(IpcChannels.CommandSettingsChanged, this.options.getState());
    } catch (error) {
      this.logger.warn('pushing settings to settings window failed', { error: describeError(error) });
    }
  }

  /** 把最新 AI 状态推给设置窗口（情绪心跳会让"心情"数字自己动）。 */
  public pushAIStatus(): void {
    this.sendToWindow(IpcChannels.CommandAIStatus, this.options.getAIStatus(), 'ai status');
  }

  /** 把最新感知状态推给设置窗口（当前场景/行为快照会随采样变化）。 */
  public pushPerceptionStatus(): void {
    this.sendToWindow(IpcChannels.CommandPerceptionStatus, this.options.getPerceptionStatus(), 'perception status');
  }

  /** 把最新成长状态推给设置窗口（记忆宫殿与策略会在反思后变）。 */
  public pushGrowthStatus(): void {
    this.sendToWindow(IpcChannels.CommandGrowthStatus, this.options.getGrowthStatus(), 'growth status');
  }

  private sendToWindow(channel: string, payload: unknown, what: string): void {
    if (!this.exists()) return;
    const window = this.window as BrowserWindow;
    if (window.isDestroyed()) return;
    try {
      window.webContents.send(channel, payload);
    } catch (error) {
      this.logger.warn(`pushing ${what} to settings window failed`, { error: describeError(error) });
    }
  }

  public destroy(): void {
    if (!this.exists()) {
      this.window = null;
      return;
    }
    const window = this.window as BrowserWindow;
    // 先摘引用再销毁：close 处理器里的 this.exists() 判断会因此失效，
    // 从而不会在真正退出时把窗口又"隐藏"回去。
    this.window = null;
    try {
      window.destroy();
    } catch (error) {
      this.logger.warn('destroying settings window failed', { error: describeError(error) });
    }
  }

  /** 打开配置目录（设置窗口里的按钮）。 */
  public openConfigFolder(): boolean {
    const target = this.options.config.configPath;
    try {
      void shell.openPath(target);
      return true;
    } catch (error) {
      this.logger.error('opening config folder failed', { error: describeError(error) });
      return false;
    }
  }

  private create(): void {
    const bootstrap: SettingsWindowBootstrap = {
      state: this.options.getState(),
      configPath: this.options.config.configPath,
      ai: this.options.getAIStatus(),
      perception: this.options.getPerceptionStatus(),
      growth: this.options.getGrowthStatus(),
    };

    const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
      // 与桌宠窗口同一套安全基线
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: this.options.config.settingsPreloadPath,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: this.options.config.mode === 'development',
      additionalArguments: [
        SETTINGS_WINDOW_FLAG,
        `${SETTINGS_BOOTSTRAP_FLAG}${Buffer.from(JSON.stringify(bootstrap), 'utf8').toString('base64')}`,
      ],
    };

    const window = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      minWidth: 460,
      minHeight: 480,
      // 普通窗口：有边框（可拖动、可关闭），可纵向拉伸（AI 面板内容较长）
      frame: true,
      resizable: true,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      autoHideMenuBar: true,
      backgroundColor: '#1b1d23',
      show: false,
      title: '桌宠设置',
      webPreferences,
    });

    // 关闭 = 隐藏（与桌宠窗口一致：不销毁，下次打开秒开）
    window.on('close', (event) => {
      if (!this.exists()) return;
      event.preventDefault();
      window.hide();
    });
    window.on('closed', () => {
      this.window = null;
    });
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      this.logger.error('settings window preload failed', { error, data: { preloadPath } });
    });
    window.webContents.on('did-fail-load', (_event, code, description, url) => {
      this.logger.error('settings window load failed', { data: { code, description, url } });
    });

    this.window = window;
    void this.load(window);
  }

  private async load(window: BrowserWindow): Promise<void> {
    try {
      await window.loadFile(this.options.config.settingsHtmlPath);
      this.logger.info('settings window loaded', { data: { file: this.options.config.settingsHtmlPath } });
      window.show();
      window.focus();
    } catch (error) {
      this.logger.error('settings window load failed', { error: describeError(error) });
      // 加载失败就不要把空窗口留在屏幕上
      this.destroy();
    }
  }
}
