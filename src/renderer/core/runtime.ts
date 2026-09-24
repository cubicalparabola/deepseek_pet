/**
 * RuntimeCapabilities —— Renderer 侧对 preload 暴露能力的唯一封装。
 *
 * 铁律：Renderer 里除了本文件（以及 plugin-host 通过注入的方式），
 * 任何模块都不允许直接访问 window.petAPI。
 * 这样将来把能力搬到别处（例如加入设置窗口）时只需要改这一处。
 *
 * 注意：本文件不 import 任何 electron / node 模块，能力全部来自 preload 的 contextBridge。
 */

import type { PetBridge, TrayStatePayload } from '../../shared/ipc';
import type { PetAction } from '../../shared/action-types';
import type { PluginRecord } from '../../shared/plugin-types';
import type { PetSettingsState, PetSizeInfo } from '../../shared/pet-size';
import type { BubblePayload } from '../../shared/bubble';
import type { Logger } from '../../shared/logger';
import { PetError } from '../../shared/errors';

export interface RuntimeCapabilitiesOptions {
  readonly bridge: PetBridge | undefined;
  readonly logger: Logger;
}

export class RuntimeCapabilities {
  private readonly bridge: PetBridge | undefined;
  private readonly logger: Logger;

  public constructor(options: RuntimeCapabilitiesOptions) {
    this.bridge = options.bridge;
    this.logger = options.logger;
    if (!this.bridge) {
      // preload 未加载时给出明确诊断，而不是到处 undefined 报错
      this.logger.error('window.petAPI unavailable: preload missing or contextIsolation misconfigured');
    }
  }

  public get available(): boolean {
    return this.bridge !== undefined;
  }

  public get runtime() {
    return this.bridge?.runtime;
  }

  public get assetsPath(): string {
    return this.bridge?.runtime.assetsPath ?? '';
  }

  /** 应用版本（插件 system API 使用）。 */
  public get version(): string {
    return this.bridge?.runtime.version ?? '0.0.0';
  }

  /** 运行平台（插件 system API 使用）。 */
  public get platform(): string {
    return String(this.bridge?.runtime.platform ?? 'unknown');
  }

  /** 是否 paused（行为暂停状态由 Renderer 维护，这里仅转发给 Main）。 */
  public notifyBehaviorPausedState(paused: boolean): void {
    this.notifyBehaviorPaused(paused);
  }

  /** 兜底：preload 不可用时退化为相对路径，保证静态资源仍可能被找到（至少不崩）。 */
  public resolveAsset(relativePath: string): string {
    if (this.bridge) return this.bridge.assets.resolve(relativePath);
    return `../../assets/${relativePath}`;
  }

  /** 让 Main 进程知道 renderer 是否真的活着（用于 bootstrap 完成握手）。 */
  public onCommandAction(handler: (action: PetAction) => void): () => void {
    if (!this.bridge) return () => undefined;
    return this.bridge.commands.onAction(handler);
  }

  public onSetBehaviorPaused(handler: (paused: boolean) => void): () => void {
    if (!this.bridge) return () => undefined;
    return this.bridge.commands.onSetBehaviorPaused(handler);
  }

  public onSetAnimation(handler: (animationId: string) => void): () => void {
    if (!this.bridge) return () => undefined;
    return this.bridge.commands.onSetAnimation(handler);
  }

  /** 尺寸变化（托盘/右键菜单/设置界面调整）时通知。 */
  public onSizeChanged(handler: (size: PetSizeInfo) => void): () => void {
    if (!this.bridge) return () => undefined;
    return this.bridge.commands.onSizeChanged(handler);
  }

  /** 对话气泡状态 / 布局变化（含随之而来的窗口尺寸变化）。 */
  public onBubble(handler: (payload: BubblePayload) => void): () => void {
    if (!this.bridge) return () => undefined;
    return this.bridge.commands.onBubble(handler);
  }

  /**
   * 回报当前文本占用的行数，并拿到**重算后的布局**。
   *
   * 气泡高度由行数决定（主进程算），字体度量只有渲染层能做，所以这一步是往返：
   * 主进程顺手返回新布局，调用方直接落地即可。
   */
  public async reportBubbleTextLines(text: string, lines: number): Promise<BubblePayload | null> {
    if (!this.bridge) return null;
    try {
      return await this.bridge.bubble.reportTextLines({ text, lines });
    } catch (error) {
      this.logger.warn('reporting bubble text lines failed', { error });
      return null;
    }
  }

  /**
   * 请求关闭气泡（用户在气泡上点了"知道了"）。
   *
   * 不复用 `send`：这是一次需要确认结果的调用（要拿到收起后的布局），
   * 失败也不会静默 —— 静默会让按钮看起来"点了没反应"。
   */
  public hideBubble(): void {
    if (!this.bridge) return;
    void this.bridge.bubble.acknowledge().catch((error: unknown) => {
      this.logger.warn('acknowledging bubble failed', { error });
    });
  }

  /** 当前尺寸 + 设置快照。 */
  public async getSettings(): Promise<PetSettingsState | null> {
    if (!this.bridge) return null;
    try {
      return await this.bridge.settings.get();
    } catch (error) {
      this.logger.warn('reading settings failed', { error });
      return null;
    }
  }

  /** 设置桌宠大小（会被 Main 夹到合法区间并受显示器限制）。 */
  public async setScale(scale: number): Promise<PetSettingsState | null> {
    if (!this.bridge) return null;
    try {
      return await this.bridge.settings.setScale(scale);
    } catch (error) {
      this.logger.warn('applying scale failed', { error });
      return null;
    }
  }

  public async setAlwaysOnTopSetting(value: boolean): Promise<PetSettingsState | null> {
    if (!this.bridge) return null;
    try {
      return await this.bridge.settings.setAlwaysOnTop(value);
    } catch (error) {
      this.logger.warn('applying always-on-top failed', { error });
      return null;
    }
  }

  public onShutdown(handler: () => void): () => void {
    if (!this.bridge) return () => undefined;
    return this.bridge.commands.onShutdown(handler);
  }

  public updateTrayState(state: TrayStatePayload): void {
    if (!this.bridge) return;
    try {
      this.bridge.tray.updateState(state);
    } catch (error) {
      this.logger.warn('updating tray state failed', { error });
    }
  }

  public showContextMenu(context: { region?: string; animationId?: string | null }): void {
    if (!this.bridge) return;
    try {
      this.bridge.menu.showContextMenu(context);
    } catch (error) {
      this.logger.warn('opening context menu failed', { error });
    }
  }

  public notifyAnimationChanged(payload: {
    animationId: string;
    priority: number;
    source?: string;
    reason?: string;
  }): void {
    if (!this.bridge) return;
    this.bridge.notifyAnimationChanged(payload);
  }

  public notifyStateChanged(payload: {
    from: string;
    to: string;
    reason: string;
    source?: string;
  }): void {
    if (!this.bridge) return;
    // 状态名来自 StateMachine，类型安全由调用方保证
    this.bridge.notifyStateChanged(payload as Parameters<PetBridge['notifyStateChanged']>[0]);
  }

  public notifyBehaviorPaused(paused: boolean): void {
    if (!this.bridge) return;
    this.bridge.notifyBehaviorPaused(paused);
  }

  public moveWindowTo(screenX: number, screenY: number): void {
    if (!this.bridge) return;
    void this.bridge.window.setPosition(screenX, screenY);
  }

  public setWindowPosition(x: number, y: number): Promise<void> {
    if (!this.bridge) {
      return Promise.reject(
        new PetError('窗口能力不可用', { code: 'IPC_UNAVAILABLE', module: 'RuntimeCapabilities' }),
      );
    }
    return this.bridge.window.setPosition(x, y);
  }

  public async getWindowPosition(): Promise<{ x: number; y: number }> {
    if (!this.bridge) return { x: 0, y: 0 };
    return this.bridge.window.getPosition();
  }

  public setWindowSize(width: number, height: number): void {
    if (!this.bridge) return;
    void this.bridge.window.setSize(width, height);
  }

  public pluginBridge() {
    return this.bridge?.plugins;
  }

  /** 插件列表变化时同步给 Main（托盘菜单展示用）。 */
  public updatePluginRecords(records: readonly PluginRecord[]): void {
    this.updateTrayState({ plugins: records });
  }

  /** 向 Main 索取已编译的插件代码。 */
  public async fetchPluginCode(id: string): Promise<{ readonly code: string } | null> {
    const bridge = this.bridge;
    if (!bridge) return null;
    try {
      const payload = await bridge.plugins.fetchCode(id);
      return payload ? { code: payload.code } : null;
    } catch (error) {
      this.logger.error('fetching plugin code failed', { error, data: { id } });
      return null;
    }
  }

  public log(payload: {
    level: 'debug' | 'info' | 'warn' | 'error';
    module: string;
    message: string;
    event?: string;
    data?: Record<string, unknown>;
  }): void {
    if (!this.bridge) return;
    try {
      this.bridge.log.write(payload);
    } catch {
      /* 日志失败静默 */
    }
  }

  public async executeAction(action: PetAction) {
    if (!this.bridge) {
      return { accepted: false, type: action.type, rejection: 'invalid-action' as const };
    }
    return this.bridge.actions.execute(action);
  }
}

/** 从 window 读取 preload 注入的 bridge（带类型收窄，不使用 any）。 */
export function readBridge(): PetBridge | undefined {
  const candidate = (window as unknown as { petAPI?: PetBridge }).petAPI;
  if (!candidate || typeof candidate !== 'object') return undefined;
  return candidate;
}
