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
  type PluginEnabledPayload,
  type PluginPanelActionPayload,
  type PluginTimerPayload,
  type PluginTimerTickPayload,
  type PluginUIContributionPayload,
  type RuntimeInfo,
  type StateChangedPayload,
  type TrayStatePayload,
  type TriggerAnimationPayload,
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
import type { NoteBox, NoteFileEntry, NotePreview } from '../shared/notes';
import type {
  PerceptionLogItem,
  PerceptionSettingsPatch,
  PerceptionStatus,
  PerceptionViewMode,
  PerceptionViewResult,
} from '../shared/perception-types';
import type { TimelineTextResult } from '../shared/timeline-types';
import type {
  GrowthSettingsPatch,
  GrowthStatus,
  MemoryNodeKind,
} from '../shared/growth-types';
import type { PetAction } from '../shared/action-types';
import type { PetDisplayState } from '../shared/behavior-config';
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
} from '../shared/plugin-types';import type { Logger } from '../shared/logger';
import { IpcError, describeError, serializeError } from '../shared/errors';

export interface IpcManagerDependencies {
  readonly logger: Logger;
  getRuntimeInfo(): RuntimeInfo;
  getBootstrap(): PetBootstrap;
  setWindowPosition(x: number, y: number): { x: number; y: number };
  getWindowPosition(): { x: number; y: number };
  setWindowSize(width: number, height: number): void;
  /** 拖拽结束：由主进程判定是否贴边收起。 */
  dragEnd(): PetDisplayState;
  /** 请求展开（收起状态下点了宠物）。 */
  undock(): PetDisplayState;
  showWindow(): void;
  hideWindow(): void;
  setAlwaysOnTop(value: boolean): void;
  setIgnoreMouseEvents(ignore: boolean, forward: boolean): void;
  showContextMenu(): void;
  updateTrayState(state: TrayStatePayload): void;
  /** 当前尺寸 + 设置快照。 */
  getSettingsState(): PetSettingsState;
  /** 设置缩放系数，返回新快照。 */
  setScale(scale: number): PetSettingsState;
  setAlwaysOnTop(value: boolean): PetSettingsState;
  /** 拖到边缘是否自动收起。 */
  setDockOnEdge(value: boolean): PetSettingsState;
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
  /** 设置窗口专用：拖到边缘是否自动收起。 */
  setDockOnEdgeFromSettingsWindow(value: boolean): PetSettingsState;
  /** 设置窗口专用：重载插件，返回发现到的插件个数。 */
  reloadPluginsFromSettingsWindow(): number;
  /** 聊天窗口要一份当前的插件面板快照。 */
  listPluginPanels(): readonly PluginPanelView[];
  openConfigFolder(): boolean;
  closeSettingsWindow(): boolean;
  /** 打开设置窗口（托盘菜单与 renderer 共用）。 */
  showSettingsWindow(): boolean;
  discoverPlugins(): readonly DiscoveredPlugin[];
  fetchPluginCode(id: string): Promise<PluginCodePayload | null>;
  reloadPlugin(id: string): Promise<PluginCodePayload | null>;
  listPlugins(): readonly PluginRecord[];
  /**
   * 运行期启停一个插件（写盘 + 重新发现），返回启停后的清单。
   *
   * 这是"插件可随时关闭"的唯一入口：设置窗口、托盘菜单、桌宠窗口都调它。
   */
  setPluginEnabled(id: string, enabled: boolean): readonly PluginRecord[];
  /** 设置窗口专用：与 `setPluginEnabled` 同源（会顺手把清单推回设置窗口）。 */
  setPluginEnabledFromSettingsWindow(id: string, enabled: boolean): readonly PluginRecord[];
  /**
   * 安装插件（`directory` 省略时主进程弹目录选择框）。
   *
   * 校验、复制、登记全在主进程：渲染层给不了路径也读不了磁盘，
   * 只有"用户亲手在原生对话框里挑的那个文件夹"能被安装。
   */
  installPlugin(directory?: string): PluginInstallResult;
  /** 卸载插件：停用 -> 删目录 -> 从清单移除。 */
  uninstallPlugin(id: string): PluginInstallResult;
  /** 插件运行期能力（权限执法在 Main，见 plugin-runtime.ts）。 */
  pluginNet: (pluginId: string, request: PluginNetRequest) => Promise<PluginNetResponse>;
  pluginProcess: (pluginId: string, request: PluginProcessRequest) => Promise<PluginProcessResult>;
  pluginWhich: (pluginId: string, command: string) => Promise<string | null>;
  pluginPythonInfo: (pluginId: string) => Promise<PluginPythonInfo>;
  pluginPythonRun: (pluginId: string, request: PluginPythonRequest) => Promise<PluginProcessResult>;
  pluginNotify: (pluginId: string, request: PluginNotificationRequest) => boolean;
  /** 往「交互」收件箱投递消息与文件（权限 `mail`）。 */
  pluginMail: (pluginId: string, request: PluginMailRequest) => PluginMailResult;
  pluginOpenExternal: (pluginId: string, url: string) => Promise<boolean>;
  pluginStartTimer: (payload: PluginTimerPayload) => boolean;
  pluginCancelTimer: (pluginId: string, timerId: string) => boolean;
  pluginSetUIContribution: (payload: PluginUIContributionPayload) => void;
  pluginPanelAction: (payload: PluginPanelActionPayload) => boolean;
  /** 打开聊天窗口并切到某个插件的面板。 */
  openPluginPanel: (pluginId: string, panelId: string) => boolean;
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
  /** 立刻按保留期清理一次记忆明细流水（调试/验收）。 */
  aiPruneMemory(): { readonly days: number; readonly logSections: number };
  aiOpenMemoryLog(): boolean;
  aiDiary(): DiarySnapshot;
  aiDiaryGet(date: string): DiaryEntry | null;
  aiWriteDiary(): Promise<DiaryEntry>;
  aiOpenDiaryDir(): boolean;
  aiTest(): Promise<AITestResult>;
  /** 立刻查一次余额并返回最新状态。 */
  aiRefreshBalance(): Promise<AIStatusView>;
  aiInteraction(kind: InteractionKind): void;
  /** 互动动画播完后结算心情（真正加 mood 的那一步）。 */
  aiInteractionSettled(kind: InteractionKind): void;
  aiResetEmotion(): AIStatusView;
  aiSetPresence(presence: 'visible' | 'collapsed' | 'hidden'): AIStatusView;

  /* --------------------- 小纸条（她的收纳夹） --------------------- */
  aiNotes(): NoteBox;
  aiNoteCompose(): Promise<NoteBox>;
  aiNoteRead(): NoteBox;
  /** 删掉一条纸条（只删记录，不删文件）。 */
  aiNoteDelete(id: string): NoteBox;
  aiNoteClear(): NoteBox;
  /** 打开某条纸条附带的文件（只接受纸条 id + 附件序号）。 */
  aiNoteOpenFile(id: string, fileIndex?: number): boolean;
  aiNoteOpenDir(): boolean;
  /** 收纳夹里的文件清单。 */
  aiNoteFiles(): readonly NoteFileEntry[];
  /** 读一个文件的内容给界面看（只接受文件名）。 */
  aiNoteFilePreview(name: string): NotePreview;
  /** 用系统默认程序打开收纳夹里的文件（只接受文件名）。 */
  aiNoteFileOpen(name: string): boolean;
  /** 删掉收纳夹里的文件（只接受文件名）。 */
  aiNoteFileDelete(name: string): { readonly ok: boolean; readonly reason?: string };
  /** 弹文件选择框把文件收进收纳夹；null = 用户取消。 */
  aiNoteFileImport(): Promise<NoteBox | null>;

  /* --------------------- 环境与用户感知（3.1~3.6） --------------------- */
  getPerceptionStatus(): PerceptionStatus;
  setPerceptionSettings(patch: PerceptionSettingsPatch): PerceptionStatus;
  perceptionLog(limit: number): readonly PerceptionLogItem[];
  perceptionView(mode: PerceptionViewMode): Promise<PerceptionViewResult>;
  perceptionAuthorizeCamera(authorized: boolean): PerceptionStatus;
  perceptionClearData(): PerceptionStatus;
  /** 立刻做一次习惯建模（会调用大模型；返回最新状态）。 */
  perceptionModelHabits(): Promise<PerceptionStatus>;
  perceptionOpenLog(): boolean;
  perceptionSampleNow(): Promise<PerceptionStatus>;
  /** 读某天的时间线（不传 = 今天）。 */
  perceptionTimeline(date?: string): Promise<TimelineTextResult>;
  /** 让模型写/重写某天的叙述。 */
  perceptionNarrateTimeline(date?: string, force?: boolean): Promise<TimelineTextResult>;
  perceptionCameraFrame(dataUrl: string): void;
  perceptionCameraReady(ready: boolean, error: string): void;

  /* --------------------- 成长、记忆与反思（4.1 / 4.2） --------------------- */
  getGrowthStatus(): GrowthStatus;
  setGrowthSettings(patch: GrowthSettingsPatch): GrowthStatus;
  growthAddNode(input: { kind: MemoryNodeKind; title: string; detail: string }): GrowthStatus;
  growthRemoveNode(id: string): GrowthStatus;
  growthPinNode(id: string, pinned: boolean): GrowthStatus;
  growthRecallNode(id: string): Promise<{ readonly ok: boolean; readonly text: string }>;
  growthReflectNow(): Promise<GrowthStatus>;
  growthResetPolicy(): GrowthStatus;
  growthRefreshPalace(): GrowthStatus;
  growthOpenPalace(): boolean;
  growthOpenPolicyLog(): boolean;
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
    // 拖拽结束：渲染层只负责说"拖完了"，贴边判定在工作区那一侧（主进程）
    this.handle(IpcChannels.WindowDragEnd, () => this.deps.dragEnd());
    this.handle(IpcChannels.WindowUndock, () => this.deps.undock());
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
    this.handle(IpcChannels.SettingsSetDockOnEdge, (_event, value) =>
      this.deps.setDockOnEdge(asBoolean(value, true)),
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
     * 真正的隔离来自"方法面"：设置窗口的 preload 只暴露这几个方法。
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
    this.handle(IpcChannels.SettingsWindowSetDockOnEdge, (_event, value) =>
      this.deps.setDockOnEdgeFromSettingsWindow(asBoolean(value, true)),
    );
    this.handle(IpcChannels.SettingsWindowReloadPlugins, () => this.deps.reloadPluginsFromSettingsWindow());
    this.handle(IpcChannels.ChatWindowPanelsGet, () => this.deps.listPluginPanels());
    this.handle(IpcChannels.SettingsWindowOpenConfig, () => this.deps.openConfigFolder());
    this.handle(IpcChannels.SettingsWindowClose, () => this.deps.closeSettingsWindow());

    /*
     * 右键菜单：不再需要 renderer 上报"点击区域 / 当前动画"
     * （菜单里那两行信息已按需求删掉），所以这里也不解析 payload。
     */
    this.handle(IpcChannels.ContextMenuShow, () => {
      this.deps.showContextMenu();
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
    this.handle(IpcChannels.AIMemoryPrune, () => this.deps.aiPruneMemory());
    this.handle(IpcChannels.AIMemoryOpenLog, () => this.deps.aiOpenMemoryLog());
    this.handle(IpcChannels.AIDiaryList, () => this.deps.aiDiary());
    this.handle(IpcChannels.AIDiaryGet, (_event, date) => this.deps.aiDiaryGet(asString(date)));
    this.handle(IpcChannels.AIDiaryWriteNow, async () => this.deps.aiWriteDiary());
    this.handle(IpcChannels.AIDiaryOpenDir, () => this.deps.aiOpenDiaryDir());
    this.handle(IpcChannels.AITestConnection, async () => this.deps.aiTest());
    this.handle(IpcChannels.AIBalanceRefresh, async () => this.deps.aiRefreshBalance());
    /*
     * 小纸条（她的收纳夹）。写操作返回**最新快照**，窗口直接用它刷新。
     * 注意**没有"写纸条"**：用户不能留言（需求），只能查看与打开文件。
     */
    this.handle(IpcChannels.AINoteList, () => this.deps.aiNotes());
    this.handle(IpcChannels.AINoteCompose, async () => this.deps.aiNoteCompose());
    this.handle(IpcChannels.AINoteRead, () => this.deps.aiNoteRead());
    this.handle(IpcChannels.AINoteDelete, (_event, id) => this.deps.aiNoteDelete(asString(id)));
    this.handle(IpcChannels.AINoteClear, () => this.deps.aiNoteClear());
    this.handle(IpcChannels.AINoteOpenFile, (_event, payload) => {
      // 兼容两种调用：老的是裸 id，新的是 { id, fileIndex }（一条消息可以有多个附件）
      const record = asRecord(payload);
      if (record) {
        return this.deps.aiNoteOpenFile(
          asString(record.id),
          typeof record.fileIndex === 'number' ? record.fileIndex : undefined,
        );
      }
      return this.deps.aiNoteOpenFile(asString(payload));
    });
    this.handle(IpcChannels.AINoteOpenDir, () => this.deps.aiNoteOpenDir());
    this.handle(IpcChannels.AINoteFiles, () => this.deps.aiNoteFiles());
    this.handle(IpcChannels.AINoteFilePreview, (_event, name) => this.deps.aiNoteFilePreview(asString(name)));
    this.handle(IpcChannels.AINoteFileOpen, (_event, name) => this.deps.aiNoteFileOpen(asString(name)));
    this.handle(IpcChannels.AINoteFileDelete, (_event, name) => this.deps.aiNoteFileDelete(asString(name)));
    this.handle(IpcChannels.AINoteFileImport, async () => this.deps.aiNoteFileImport());
    this.handle(IpcChannels.AIInteraction, (_event, kind) => {
      const value = this.readInteractionKind(kind);
      if (value === null) return false;
      this.deps.aiInteraction(value);
      return true;
    });
    /*
     * 互动动画播完 -> 才加心情（需求：互动动画播放结束才能加 mood 值）。
     * 校验与 `AIInteraction` 完全一致，避免两个入口对"合法 kind"的口径分叉。
     */
    this.handle(IpcChannels.AIInteractionSettled, (_event, kind) => {
      const value = this.readInteractionKind(kind);
      if (value === null) return false;
      this.deps.aiInteractionSettled(value);
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

    /* -------------------- 环境与用户感知（3.1~3.6） -------------------- */
    /*
     * 这一组的隐私含义最重，因此两条规矩：
     * 1. 摄像头授权只能通过**显式的** `PerceptionCameraAuthorize` 设置，
     *    而且渲染层回传的帧只走 `perceptionCameraFrame`（不落盘、不回显）；
     * 2. 帧大小有上限（8MB），超过直接丢弃 —— 防止渲染层被利用来撑爆内存。
     */
    this.handle(IpcChannels.PerceptionStatusGet, () => this.deps.getPerceptionStatus());
    this.handle(IpcChannels.PerceptionSettingsSet, (_event, patch) => {
      const record = asRecord(patch);
      if (record === null) {
        throw new IpcError('perception settings patch must be an object', {
          code: 'IPC_HANDLER_FAILED',
          module: 'IpcManager',
        });
      }
      return this.deps.setPerceptionSettings(record as PerceptionSettingsPatch);
    });
    this.handle(IpcChannels.PerceptionLog, (_event, limit) => this.deps.perceptionLog(Math.max(1, Math.min(500, Math.round(asNumber(limit, 60))))));
    this.handle(IpcChannels.PerceptionViewNow, async (_event, mode) => {
      const allowed: readonly PerceptionViewMode[] = ['scene'];
      const value = asString(mode, 'scene') as PerceptionViewMode;
      if (!allowed.includes(value)) {
        throw new IpcError('unknown perception view mode', { code: 'IPC_HANDLER_FAILED', module: 'IpcManager' });
      }
      return this.deps.perceptionView(value);
    });
    this.handle(IpcChannels.PerceptionCameraAuthorize, (_event, authorized) =>
      this.deps.perceptionAuthorizeCamera(asBoolean(authorized, false)),
    );
    this.handle(IpcChannels.PerceptionClearData, () => this.deps.perceptionClearData());
    this.handle(IpcChannels.PerceptionModelHabits, async () => this.deps.perceptionModelHabits());
    this.handle(IpcChannels.PerceptionOpenLog, () => this.deps.perceptionOpenLog());
    this.handle(IpcChannels.PerceptionSampleNow, async () => this.deps.perceptionSampleNow());
    this.handle(IpcChannels.PerceptionTimelineGet, async (_event, date) => {
      // 日期只接受 `YYYY-MM-DD`；其它一律当"今天"（不猜用户意图）
      const value = asString(date, '');
      return this.deps.perceptionTimeline(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
    });
    this.handle(IpcChannels.PerceptionTimelineNarrate, async (_event, date, force) => {
      const value = asString(date, '');
      return this.deps.perceptionNarrateTimeline(
        /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined,
        asBoolean(force, false),
      );
    });
    this.handle(IpcChannels.PerceptionCameraFrame, (_event, dataUrl) => {
      const value = asString(dataUrl, '');
      if (value.length === 0 || value.length > 8 * 1024 * 1024) return false;
      this.deps.perceptionCameraFrame(value);
      return true;
    });
    this.handle(IpcChannels.PerceptionCameraReady, (_event, payload) => {
      const record = asRecord(payload) ?? {};
      this.deps.perceptionCameraReady(asBoolean(record.ready, false), asString(record.error, ''));
      return true;
    });

    /* ------------------ 成长、记忆与反思（4.1 / 4.2） ------------------ */
    /*
     * 这一组的关键是"**可编辑 + 可回退**"：
     * 记忆宫殿的节点能加能删能钉，反思得出的策略能一键重置 ——
     * 会自己改变行为的系统必须给用户留一个明确的手刹。
     */
    this.handle(IpcChannels.GrowthStatusGet, () => this.deps.getGrowthStatus());
    this.handle(IpcChannels.GrowthSettingsSet, (_event, patch) => {
      const record = asRecord(patch);
      if (record === null) {
        throw new IpcError('growth settings patch must be an object', {
          code: 'IPC_HANDLER_FAILED',
          module: 'IpcManager',
        });
      }
      return this.deps.setGrowthSettings(record as GrowthSettingsPatch);
    });
    this.handle(IpcChannels.GrowthNodeAdd, (_event, payload) => {
      const record = asRecord(payload) ?? {};
      return this.deps.growthAddNode({
        kind: asString(record.kind, 'manual') as MemoryNodeKind,
        title: asString(record.title, ''),
        detail: asString(record.detail, ''),
      });
    });
    this.handle(IpcChannels.GrowthNodeRemove, (_event, id) => this.deps.growthRemoveNode(asString(id)));
    this.handle(IpcChannels.GrowthNodePin, (_event, payload) => {
      const record = asRecord(payload) ?? {};
      return this.deps.growthPinNode(asString(record.id), asBoolean(record.pinned, false));
    });
    this.handle(IpcChannels.GrowthNodeRecall, async (_event, id) => this.deps.growthRecallNode(asString(id)));
    this.handle(IpcChannels.GrowthReflectNow, async () => this.deps.growthReflectNow());
    this.handle(IpcChannels.GrowthResetPolicy, () => this.deps.growthResetPolicy());
    this.handle(IpcChannels.GrowthRefreshPalace, () => this.deps.growthRefreshPalace());
    this.handle(IpcChannels.GrowthOpenPalace, () => this.deps.growthOpenPalace());
    this.handle(IpcChannels.GrowthOpenPolicyLog, () => this.deps.growthOpenPolicyLog());

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

    /*
     * 运行期启停（"插件可随时关闭"）。
     *
     * 三条入口（桌宠窗口 / 设置窗口 / 托盘菜单）都落到 `deps.setPluginEnabled`，
     * 因此不存在"某个入口忘了回收插件资源"这种分叉。
     */
    this.handle(IpcChannels.PluginSetEnabled, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) throw new IpcError('plugin toggle payload must be an object', {
        code: 'IPC_HANDLER_FAILED',
        module: 'IpcManager',
      });
      return this.deps.setPluginEnabled(asString(record.id), asBoolean(record.enabled, true));
    });
    this.handle(IpcChannels.SettingsWindowSetPluginEnabled, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) throw new IpcError('plugin toggle payload must be an object', {
        code: 'IPC_HANDLER_FAILED',
        module: 'IpcManager',
      });
      return this.deps.setPluginEnabledFromSettingsWindow(asString(record.id), asBoolean(record.enabled, true));
    });
    this.handle(IpcChannels.PluginInstall, (_event, payload) => {
      const record = asRecord(payload) ?? {};
      const directory = typeof record.directory === 'string' && record.directory.trim() !== ''
        ? record.directory
        : undefined;
      return this.deps.installPlugin(directory);
    });
    this.handle(IpcChannels.PluginUninstall, (_event, payload) => {
      const record = asRecord(payload) ?? {};
      return this.deps.uninstallPlugin(asString(record.id));
    });

    /*
     * 插件运行期能力：IPC 层只做参数形状校验，**权限执法在 plugin-runtime**。
     * 校验放在这里是为了"插件传来一个 undefined 也不要让主进程抛"。
     */
    this.handle(IpcChannels.PluginNet, async (_event, payload) => {
      const record = asRecord(payload) ?? {};
      const pluginId = asString(record.pluginId);
      const request = (asRecord(record.request) ?? {}) as unknown as PluginNetRequest;
      return this.deps.pluginNet(pluginId, request);
    });
    this.handle(IpcChannels.PluginProcess, async (_event, payload) => {
      const record = asRecord(payload) ?? {};
      const pluginId = asString(record.pluginId);
      const request = (asRecord(record.request) ?? {}) as unknown as PluginProcessRequest;
      if (asString(record.action) === 'which') {
        return this.deps.pluginWhich(pluginId, asString(request.command));
      }
      return this.deps.pluginProcess(pluginId, request);
    });
    this.handle(IpcChannels.PluginPython, async (_event, payload) => {
      const record = asRecord(payload) ?? {};
      const pluginId = asString(record.pluginId);
      const action = asString(record.action, 'info');
      if (action === 'run') {
        const request = (asRecord(record.request) ?? {}) as unknown as PluginPythonRequest;
        return this.deps.pluginPythonRun(pluginId, request);
      }
      return this.deps.pluginPythonInfo(pluginId);
    });
    this.handle(IpcChannels.PluginNotify, (_event, payload) => {
      const record = asRecord(payload) ?? {};
      const request = (asRecord(record.request) ?? {}) as unknown as PluginNotificationRequest;
      return this.deps.pluginNotify(asString(record.pluginId), request);
    });
    this.handle(IpcChannels.PluginMailSend, (_event, payload) => {
      const record = asRecord(payload) ?? {};
      const request = (asRecord(record.request) ?? {}) as unknown as PluginMailRequest;
      return this.deps.pluginMail(asString(record.pluginId), request);
    });
    this.handle(IpcChannels.PluginOpenExternal, async (_event, payload) => {
      const record = asRecord(payload) ?? {};
      return this.deps.pluginOpenExternal(asString(record.pluginId), asString(record.url));
    });
    this.handle(IpcChannels.PluginTimer, (_event, payload) => {
      const record = asRecord(payload) ?? {};
      const pluginId = asString(record.pluginId);
      const timerId = asString(record.timerId);
      if (asString(record.action, 'start') === 'cancel') {
        return this.deps.pluginCancelTimer(pluginId, timerId);
      }
      return this.deps.pluginStartTimer({
        pluginId,
        timerId,
        kind: asString(record.kind, 'after') === 'every' ? 'every' : 'after',
        intervalMs: typeof record.intervalMs === 'number' ? record.intervalMs : 0,
      });
    });
    this.handle(IpcChannels.PluginUIContribute, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) return false;
      this.deps.pluginSetUIContribution(record as unknown as PluginUIContributionPayload);
      return true;
    });
    this.handle(IpcChannels.PluginPanelAction, (_event, payload) => {
      const record = asRecord(payload);
      if (!record) return false;
      return this.deps.pluginPanelAction(record as unknown as PluginPanelActionPayload);
    });
    this.handle(IpcChannels.PluginOpenPanel, (_event, payload) => {
      const record = asRecord(payload) ?? {};
      return this.deps.openPluginPanel(asString(record.pluginId), asString(record.panelId));
    });

    this.logger.info('ipc channels registered');
  }

  /**
   * 校验 Renderer 报上来的互动类型。
   *
   * 两条互动通道（`AIInteraction` / `AIInteractionSettled`）共用它：
   * 口径分叉过一次就会变成"上报记了、结算没记"这类很难查的偏差。
   *
   * @returns 合法的 kind；非法时返回 null（调用方直接回 false，不落地任何副作用）
   */
  private readInteractionKind(kind: unknown): InteractionKind | null {
    const allowed: readonly InteractionKind[] = ['click', 'doubleclick', 'drag', 'chat', 'diary', 'gift'];
    const value = asString(kind, 'click') as InteractionKind;
    return allowed.includes(value) ? value : null;
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

  /**
   * 把 AI 状态（情绪 / 预算）推给**桌宠窗口**。
   *
   * 与设置窗口/聊天窗口各自的那条推送分开：那两个窗口是"给人看的"，
   * 桌宠窗口要它是因为**行为**依赖情绪 —— 需求"心情低于阈值时随机池全变 sad"
   * 的判定发生在渲染层的 BehaviorManager 里，它需要一个心情读数
   * （见 Renderer.wireMoodMirror）。状态变化本来就不频繁（心跳/互动/聊天），
   * 这里只推给它自己的窗口，不会放大成广播风暴。
   */
  public pushAIStatusToPet(status: AIStatusView): void {
    this.broadcast(IpcChannels.CommandAIStatus, status);
  }

  public requestPluginReload(): void {
    this.broadcast(IpcChannels.CommandReloadPlugins, {});
  }

  /**
   * 通知桌宠渲染层：某个插件被启用/停用。
   *
   * 为什么不是"整体重载"：用户点一下开关，不该让**所有**插件重新 activate 一遍
   * （那会让别的插件丢状态、重新请求网络）。这里只动目标插件：
   * 启用时把它的静态信息捎过去让渲染层取代码并 activate，停用时渲染层回收。
   */
  public notifyPluginEnabled(payload: PluginEnabledPayload): void {
    this.broadcast(IpcChannels.CommandPluginEnabled, payload);
  }

  /** 通知桌宠渲染层：插件界面事件（菜单点击 / 通知点击 / 面板动作）。 */
  public notifyPluginUIEvent(event: PluginUIEvent): void {
    this.broadcast(IpcChannels.CommandPluginUIEvent, event);
  }

  /** 通知桌宠渲染层：插件的定时器到点了（定时器由 Main 持有）。 */
  public notifyPluginTimer(payload: PluginTimerTickPayload): void {
    this.broadcast(IpcChannels.CommandPluginTimer, payload);
  }

  /**
   * 通知桌宠渲染层：某个插件被**卸载**了。
   *
   * 与"停用"不同：卸载之后渲染层要连记录一起忘掉（清单里已经没有它了），
   * 并清掉它的 localStorage 命名空间（插件自己的数据不该留在别人的机器上）。
   */
  public notifyPluginRemoved(id: string): void {
    this.broadcast(IpcChannels.CommandPluginRemoved, { id });
  }

  public setAnimation(animationId: string): void {
    this.broadcast(IpcChannels.CommandSetAnimation, animationId);
  }

  /**
   * 通知 Renderer：播放一条**触发动画**（感知 / AI / 系统来源）。
   *
   * 与 `setAnimation` 分开是刻意的：那条是"用户在托盘挑动画测试"（强制切换），
   * 这条要走普通优先级仲裁与冷却 —— 否则感知到的 work/read 会硬切掉用户正在看的点击反应。
   */
  public triggerAnimation(payload: TriggerAnimationPayload): void {
    this.broadcast(IpcChannels.CommandTriggerAnimation, payload);
  }

  /** 通知 Renderer：显示状态（收起方向 / 隐藏）变了。 */
  public notifyDisplayState(display: PetDisplayState): void {
    this.broadcast(IpcChannels.CommandDisplayState, display);
  }

  /** 通知 Renderer：尺寸发生变化。 */
  public notifySizeChanged(size: PetSizeInfo): void {
    this.broadcast(IpcChannels.CommandSizeChanged, size);
  }

  /** 通知 Renderer：对话气泡状态 / 布局变化（可能同时伴随窗口尺寸变化）。 */
  public notifyBubble(payload: BubblePayload): void {
    this.broadcast(IpcChannels.CommandBubble, payload);
  }

  /** 通知渲染层与设置窗口：感知状态变化。 */
  public notifyPerceptionStatus(status: PerceptionStatus): void {
    this.broadcast(IpcChannels.CommandPerceptionStatus, status);
  }

  /** 请求渲染层采集一帧摄像头画面（3.5）。 */
  public requestCameraFrame(): void {
    this.broadcast(IpcChannels.CommandPerceptionCameraRequest, {});
  }

  /** 通知界面：成长/反思状态变化（记忆宫殿与策略在反思后会变）。 */
  public notifyGrowthStatus(status: GrowthStatus): void {
    this.broadcast(IpcChannels.CommandGrowthStatus, status);
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
