/**
 * IpcManager —— Main 进程的 IPC 中枢。
 *
 * 安全设计：
 * - 只注册 `IpcChannels` 中显式列出的通道，没有兜底通配；
 * - 每个 handler 都用 try/catch 包裹，异常只会返回结构化错误，不会崩主进程；
 * - Renderer 传入的参数一律校验类型，绝不直接透传给 Electron API；
 * - Main -> Renderer 的指令统一走 `broadcast()`。
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  IpcChannels,
  type AnimationChangedPayload,
  type LogPayload,
  type PetBootstrap,
  type PluginCodePayload,
  type RuntimeInfo,
  type StateChangedPayload,
  type TrayStatePayload,
} from '../shared/ipc';
import type { PetSettingsState, PetSizeInfo } from '../shared/pet-size';
import type { BubblePayload, BubbleState } from '../shared/bubble';
import type {
  AIChatReply,
  AISettingsPatch,
  AIStatusView,
  AITestResult,
  ChatTurn,
  DiaryEntry,
  DiarySnapshot,
  InteractionKind,
  MemorySnapshot,
} from '../shared/ai-types';
import type { PetAction } from '../shared/action-types';
import type { DiscoveredPlugin, PluginRecord } from '../shared/plugin-types';
import type { Logger } from '../shared/logger';
import { IpcError, describeError, serializeError } from '../shared/errors';

export interface IpcManagerDependencies {
  readonly logger: Logger;
  getRuntimeInfo(): RuntimeInfo;
  getBootstrap(): PetBootstrap;
  setWindowPosition(x: number, y: number): { x: number; y: number };
  getWindowPosition(): { x: number; y: number };
  setWindowSize(width: number, height: number): void;
  showWindow(): void;
  hideWindow(): void;
  setAlwaysOnTop(value: boolean): void;
  setIgnoreMouseEvents(ignore: boolean, forward: boolean): void;
  showContextMenu(context: { region?: string; animationId?: string | null }): void;
  updateTrayState(state: TrayStatePayload): void;
  /** 当前尺寸 + 设置快照。 */
  getSettingsState(): PetSettingsState;
  /** 设置缩放系数，返回新快照。 */
  setScale(scale: number): PetSettingsState;
  setAlwaysOnTop(value: boolean): PetSettingsState;
  /**
   * 显示/隐藏对话气泡（null = 隐藏）。返回应用后的状态与布局。
   * 托盘菜单与验收脚本共用这一条实现。
   */
  setBubble(state: BubbleState | null): BubblePayload;
  /**
   * Renderer 回报"当前文本占几行"，据此重算气泡高度。返回重算后的状态与布局。
   *
   * Renderer 只在行数与自己算出来的不一致时才会回报，因此这里不必再做去重。
   */
  reportBubbleTextLines(text: string, lines: number): BubblePayload;
  /** 设置窗口专用：应用尺寸并把最新状态推回设置窗口。 */
  setScaleFromSettingsWindow(scale: number): PetSettingsState;
  setAlwaysOnTopFromSettingsWindow(value: boolean): PetSettingsState;
  openConfigFolder(): boolean;
  closeSettingsWindow(): boolean;
  /** 打开设置窗口（托盘菜单与 renderer 共用）。 */
  showSettingsWindow(): boolean;
  discoverPlugins(): readonly DiscoveredPlugin[];
  fetchPluginCode(id: string): Promise<PluginCodePayload | null>;
  reloadPlugin(id: string): Promise<PluginCodePayload | null>;
  listPlugins(): readonly PluginRecord[];
  onRendererLog(payload: LogPayload): void;
  onAnimationChanged(payload: AnimationChangedPayload): void;
  onStateChanged(payload: StateChangedPayload): void;
  onBehaviorPausedChanged(paused: boolean): void;
  onActionFromRenderer(action: PetAction): void;

  /* ------------------------- AI 认知与人格（2.1~2.4） -------------------------
   *
   * 全部转发给 AIService：IPC 层只做参数校验与类型收窄，
   * 业务（prompt、记忆、情绪、日记）都在 ai/ 里，避免"校验逻辑里长出业务"。
   */
  getAIStatus(): AIStatusView;
  setAISettings(patch: AISettingsPatch): AIStatusView;
  aiChat(text: string): Promise<AIChatReply>;
  aiSpeakUp(): Promise<AIChatReply>;
  aiHistory(): readonly ChatTurn[];
  aiMemory(): MemorySnapshot;
  aiClearMemory(): MemorySnapshot;
  aiOpenMemoryLog(): boolean;
  aiDiary(): DiarySnapshot;
  aiDiaryGet(date: string): DiaryEntry | null;
  aiWriteDiary(): Promise<DiaryEntry>;
  aiOpenDiaryDir(): boolean;
  aiTest(): Promise<AITestResult>;
  aiInteraction(kind: InteractionKind): void;
  aiResetEmotion(): AIStatusView;
  aiSetPresence(presence: 'visible' | 'collapsed' | 'hidden'): AIStatusView;
  aiOpenChat(): boolean;
  closeChatWindow(): boolean;
}

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class IpcManager {
  private readonly deps: IpcManagerDependencies;
  private readonly logger: Logger;
  private registered = false;

  public constructor(deps: IpcManagerDependencies) {
    this.deps = deps;
    this.logger = deps.logger;
  }

  /** 注册全部通道。重复调用安全（只注册一次）。 */
  public register(): void {
    if (this.registered) return;
    this.registered = true;

    this.handle(IpcChannels.RuntimeInfo, () => this.deps.getRuntimeInfo());
    this.handle(IpcChannels.Bootstrap, () => this.deps.getBootstrap());

    this.handle(IpcChannels.WindowSetPosition, (_event, x, y) =>
      this.deps.setWindowPosition(asNumber(x), asNumber(y)),
    );
    this.handle(IpcChannels.WindowGetPosition, () => this.deps.getWindowPosition());
    this.handle(IpcChannels.WindowSetSize, (_event, width, height) =>
      this.deps.setWindowSize(asNumber(width, 360), asNumber(height, 480)),
    );
    this.handle(IpcChannels.WindowStartDrag, () => {
      this.deps.logger.debug('drag requested by renderer');
      return true;
    });
    this.handle(IpcChannels.WindowShow, () => {
      this.deps.showWindow();
      return true;
    });
    this.handle(IpcChannels.WindowHide, () => {
      this.deps.hideWindow();
      return true;
    });
    this.handle(IpcChannels.WindowSetAlwaysOnTop, (_event, value) => {
      this.deps.setAlwaysOnTop(asBoolean(value, true));
      return true;
    });
    this.handle(IpcChannels.WindowSetIgnoreMouse, (_event, ignore, forward) => {
      this.deps.setIgnoreMouseEvents(asBoolean(ignore), asBoolean(forward, true));
      return true;
    });

    /* ---------------------------- 尺寸 / 设置 ---------------------------- */
    this.handle(IpcChannels.SettingsGet, () => this.deps.getSettingsState());
    this.handle(IpcChannels.SettingsSetScale, (_event, scale) => {
      if (typeof scale !== 'number' || !Number.isFinite(scale)) {
        throw new IpcError('scale must be a finite number', {
          code: 'IPC_HANDLER_FAILED',
          module: 'IpcManager',
        });
      }
      return this.deps.setScale(scale);
    });
    this.handle(IpcChannels.SettingsSetAlwaysOnTop, (_event, value) =>
      this.deps.setAlwaysOnTop(asBoolean(value, true)),
    );

    /* ---------------------------- 对话气泡 ------------------------------ */
    /*
     * 第一版不做自动触发，这个通道只用于"手动验证"：
     * 托盘菜单的「对话气泡（测试）」与验收脚本走的是**同一个** deps.setBubble。
     * 传 null 表示隐藏。
     */
    this.handle(IpcChannels.PetSetBubble, (_event, state) => {
      const record = asRecord(state);
      if (record === null) return this.deps.setBubble(null);
      const visible = asBoolean(record.visible, false);
      return this.deps.setBubble({ visible, text: asString(record.text, ''), ready: false });
    });

    /*
     * Renderer 回报"文本占几行" -> 重算气泡高度（气泡随文本长短变化的闭环）。
     *
     * 用 `handle`（invoke 往返）与其它 Renderer->Main 通知保持一致：
     * preload 的 send 助手走的就是 invoke，而且**顺手把重算后的布局返回**，
     * 渲染层拿到就能直接落地，不必再等一次推送。
     */
    this.handle(IpcChannels.BubbleReportText, (_event, payload) => {
      const record = asRecord(payload);
      if (record === null) return this.deps.setBubble(null);
      const text = asString(record.text, '');
      const lines = Math.max(0, Math.round(asNumber(record.lines, 0)));
      return this.deps.reportBubbleTextLines(text, lines);
    });

    /* 用户点气泡上的"知道了" -> 与托盘「隐藏气泡」完全同一条实现 */
    this.handle(IpcChannels.BubbleAcknowledge, () => this.deps.setBubble(null));

    /* ------------------------- 设置窗口专用通道 ------------------------- */
    /*
     * 这几个通道只被 `src/settings/` 那个普通窗口调用。
     * 桌宠窗口的 preload 同样能 invoke 它们，但桌宠页面本身不需要、也不会调用；
     * 真正的隔离来自"方法面"：设置窗口的 preload 只暴露这 4 个方法。
     */
    this.handle(IpcChannels.SettingsWindowShow, () => this.deps.showSettingsWindow());
    this.handle(IpcChannels.SettingsWindowSetScale, (_event, scale) => {
      if (typeof scale !== 'number' || !Number.isFinite(scale)) {
        throw new IpcError('scale must be a finite number', {
          code: 'IPC_HANDLER_FAILED',
          module: 'IpcManager',
        });
      }
      return this.deps.setScaleFromSettingsWindow(scale);
    });
    this.handle(IpcChannels.SettingsWindowSetAlwaysOnTop, (_event, value) =>
      this.deps.setAlwaysOnTopFromSettingsWindow(asBoolean(value, true)),
    );
    this.handle(IpcChannels.SettingsWindowOpenConfig, () => this.deps.openConfigFolder());
    this.handle(IpcChannels.SettingsWindowClose, () => this.deps.closeSettingsWindow());

    this.handle(IpcChannels.ContextMenuShow, (_event, payload) => {
      const record = asRecord(payload) ?? {};
      const animationId = record.animationId;
      this.deps.showContextMenu({
        region: asString(record.region, 'body'),
        animationId: typeof animationId === 'string' ? animationId : null,
      });
      return true;
    });
    this.handle(IpcChannels.TrayStateSelect, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) throw new IpcError('tray state payload must be an object', {
        code: 'IPC_HANDLER_FAILED',
        module: 'IpcManager',
      });
      this.deps.updateTrayState({
        ...(typeof record.visible === 'boolean' ? { visible: record.visible } : {}),
        ...(typeof record.behaviorPaused === 'boolean' ? { behaviorPaused: record.behaviorPaused } : {}),
        ...(typeof record.currentAnimation === 'string' || record.currentAnimation === null
          ? { currentAnimation: record.currentAnimation }
          : {}),
        ...(typeof record.currentState === 'string' ? { currentState: record.currentState as never } : {}),
        ...(Array.isArray(record.plugins) ? { plugins: record.plugins as PluginRecord[] } : {}),
      });
      return true;
    });

    this.handle(IpcChannels.Log, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) return false;
      this.deps.onRendererLog({
        level: (['debug', 'info', 'warn', 'error'] as const).includes(record.level as never)
          ? (record.level as LogPayload['level'])
          : 'info',
        module: asString(record.module, 'Renderer'),
        message: asString(record.message, ''),
        ...(typeof record.event === 'string' ? { event: record.event } : {}),
        ...(asRecord(record.data) ? { data: asRecord(record.data) as Record<string, unknown> } : {}),
      });
      return true;
    });

    this.handle(IpcChannels.ActionExecute, (_event, payload) => {
      const record = asRecord(payload);
      if (!record || typeof record.type !== 'string') {
        throw new IpcError('action must be an object with type', {
          code: 'ACTION_INVALID',
          module: 'IpcManager',
        });
      }
      this.deps.onActionFromRenderer(record as unknown as PetAction);
      return { accepted: true, type: record.type };
    });

    this.handle(IpcChannels.AnimationChanged, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) return false;
      this.deps.onAnimationChanged({
        animationId: asString(record.animationId),
        priority: asNumber(record.priority, 0),
        ...(typeof record.source === 'string' ? { source: record.source } : {}),
        ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      });
      return true;
    });
    this.handle(IpcChannels.StateChanged, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) return false;
      this.deps.onStateChanged({
        from: asString(record.from, 'IDLE') as StateChangedPayload['from'],
        to: asString(record.to, 'IDLE') as StateChangedPayload['to'],
        reason: asString(record.reason, 'unknown'),
        ...(typeof record.source === 'string' ? { source: record.source } : {}),
      });
      return true;
    });
    this.handle(IpcChannels.BehaviorPausedChanged, (_event, paused) => {
      this.deps.onBehaviorPausedChanged(asBoolean(paused));
      return true;
    });

    /* ---------------------- AI 认知与人格（2.1~2.4） ---------------------- */
    /*
     * 这一组通道的特点是"**渲染层只提交意图，不提交能力**"：
     * 密钥、prompt、记忆文件、日记文件都只在主进程，渲染层拿到的永远是只读快照。
     */
    this.handle(IpcChannels.AIStatusGet, () => this.deps.getAIStatus());
    this.handle(IpcChannels.AISettingsSet, (_event, patch) => {
      const record = asRecord(patch);
      if (record === null) {
        throw new IpcError('ai settings patch must be an object', {
          code: 'IPC_HANDLER_FAILED',
          module: 'IpcManager',
        });
      }
      return this.deps.setAISettings(record as AISettingsPatch);
    });
    this.handle(IpcChannels.AIChatSend, async (_event, text) => this.deps.aiChat(asString(text)));
    this.handle(IpcChannels.AISpeakUp, async () => this.deps.aiSpeakUp());
    this.handle(IpcChannels.AIChatHistory, () => this.deps.aiHistory());
    this.handle(IpcChannels.AIMemoryGet, () => this.deps.aiMemory());
    this.handle(IpcChannels.AIMemoryClear, () => this.deps.aiClearMemory());
    this.handle(IpcChannels.AIMemoryOpenLog, () => this.deps.aiOpenMemoryLog());
    this.handle(IpcChannels.AIDiaryList, () => this.deps.aiDiary());
    this.handle(IpcChannels.AIDiaryGet, (_event, date) => this.deps.aiDiaryGet(asString(date)));
    this.handle(IpcChannels.AIDiaryWriteNow, async () => this.deps.aiWriteDiary());
    this.handle(IpcChannels.AIDiaryOpenDir, () => this.deps.aiOpenDiaryDir());
    this.handle(IpcChannels.AITestConnection, async () => this.deps.aiTest());
    this.handle(IpcChannels.AIInteraction, (_event, kind) => {
      const allowed: readonly InteractionKind[] = ['click', 'doubleclick', 'drag', 'chat', 'diary', 'gift'];
      const value = asString(kind, 'click') as InteractionKind;
      if (!allowed.includes(value)) return false;
      this.deps.aiInteraction(value);
      return true;
    });
    this.handle(IpcChannels.AIResetEmotion, () => this.deps.aiResetEmotion());
    this.handle(IpcChannels.AISetPresence, (_event, presence) => {
      const allowed: readonly string[] = ['visible', 'collapsed', 'hidden'];
      const value = asString(presence, 'visible');
      if (!allowed.includes(value)) {
        throw new IpcError('presence must be visible|collapsed|hidden', {
          code: 'IPC_HANDLER_FAILED',
          module: 'IpcManager',
        });
      }
      return this.deps.aiSetPresence(value as 'visible' | 'collapsed' | 'hidden');
    });
    this.handle(IpcChannels.AIOpenChat, () => this.deps.aiOpenChat());
    this.handle(IpcChannels.ChatWindowClose, () => this.deps.closeChatWindow());

    this.handle(IpcChannels.PluginDiscover, () => this.deps.discoverPlugins());    this.handle(IpcChannels.PluginFetchCode, async (_event, id) => this.deps.fetchPluginCode(asString(id)));
    this.handle(IpcChannels.PluginReload, async (_event, id) => this.deps.reloadPlugin(asString(id)));
    this.handle(IpcChannels.PluginList, () => this.deps.listPlugins());
    this.handle(IpcChannels.PluginActivated, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) return false;
      this.logger.info('plugin activated', { data: { id: asString(record.id) } });
      return true;
    });
    this.handle(IpcChannels.PluginDeactivated, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) return false;
      this.logger.info('plugin deactivated', { data: { id: asString(record.id) } });
      return true;
    });
    this.handle(IpcChannels.PluginError, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) return false;
      this.logger.error('plugin runtime error', {
        data: { id: asString(record.id), hook: asString(record.hook) },
        error: asString(record.message),
      });
      return true;
    });

    this.logger.info('ipc channels registered');
  }

  /** 统一包装：类型校验失败 / 业务异常都转成结构化错误返回给 Renderer。 */
  private handle(channel: string, handler: InvokeHandler): void {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args);
      } catch (error) {
        this.logger.error('ipc handler failed', { error, data: { channel } });
        throw new Error(JSON.stringify(serializeError(error)));
      }
    });
  }

  /** Main -> Renderer 单播。 */
  public send(channel: string, payload: unknown): void {
    const window = this.resolveSender();
    if (!window) return;
    try {
      window.webContents.send(channel, payload);
    } catch (error) {
      this.logger.warn('failed to send to renderer', { error: describeError(error), data: { channel } });
    }
  }

  /** Main -> Renderer 广播（当前只有一个桌宠窗口，语义上等价于单播）。 */
  public broadcast(channel: string, payload: unknown): void {
    this.send(channel, payload);
  }

  public sendAction(action: PetAction): void {
    this.broadcast(IpcChannels.CommandAction, action);
  }

  public setBehaviorPaused(paused: boolean): void {
    this.broadcast(IpcChannels.CommandSetBehaviorPaused, paused);
  }

  public requestPluginReload(): void {
    this.broadcast(IpcChannels.CommandReloadPlugins, {});
  }

  public setAnimation(animationId: string): void {
    this.broadcast(IpcChannels.CommandSetAnimation, animationId);
  }

  /** 通知 Renderer：尺寸发生变化。 */
  public notifySizeChanged(size: PetSizeInfo): void {
    this.broadcast(IpcChannels.CommandSizeChanged, size);
  }

  /** 通知 Renderer：对话气泡状态 / 布局变化（可能同时伴随窗口尺寸变化）。 */
  public notifyBubble(payload: BubblePayload): void {
    this.broadcast(IpcChannels.CommandBubble, payload);
  }

  public notifyShutdown(): void {
    this.broadcast(IpcChannels.CommandShutdown, {});
  }

  public unregister(): void {
    const channels = Object.values(IpcChannels);
    for (const channel of channels) {
      try {
        ipcMain.removeHandler(channel);
      } catch {
        /* 未注册的通道忽略 */
      }
    }
    this.registered = false;
    this.logger.info('ipc channels unregistered');
  }

  private resolveSender(): BrowserWindow | null {
    // 由 main.ts 注入：通过 getter 延迟获取，避免与 WindowManager 形成循环依赖
    return this.senderProvider ? this.senderProvider() : null;
  }

  private senderProvider: (() => BrowserWindow | null) | null = null;

  public setSenderProvider(provider: () => BrowserWindow | null): void {
    this.senderProvider = provider;
  }
}
