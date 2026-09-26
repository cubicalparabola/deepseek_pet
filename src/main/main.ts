/**
 * main.ts —— Electron 主进程入口与应用程序生命周期。
 *
 * 进程架构（严格按 Electron 官方推荐）：
 *
 *   Main Process
 *     ├── WindowManager   透明桌宠窗口
 *     ├── TrayManager     系统托盘 + 原生菜单（托盘菜单 / 右键菜单）
 *     ├── IpcManager      IPC 白名单中枢
 *     ├── PluginManager   插件发现 / 编译 / 生命周期编排
 *     └── Application     生命周期、异常兜底、与 renderer 的握手
 *
 * 主进程**不做任何动画与业务逻辑**：动画、状态机、行为、插件运行都在 renderer。
 * 主进程只负责系统能力，并把它们通过 preload + IPC 暴露出去。
 */

import { app, dialog, screen, session, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveAppRoot,
  resolvePetConfig,
  type PetConfig,
} from '../shared/config';
import { validateManifest, manifestToRecord } from '../shared/animation-config';
import type { AnimationDefinition, AnimationManifest } from '../shared/animation-types';
import {
  DEFAULT_BEHAVIOR_CONFIG,
  DEFAULT_DISPLAY_STATE,
  isQuietDisplay,
  parseBehaviorConfig,
  resolveDisplayState,
  type BehaviorConfig,
  type PetDock,
  type PetDisplayState,
} from '../shared/behavior-config';
import {
  dockTargetPosition,
  evaluateDock,
  nudgeInward,
  petRectIn,
  shouldUndock,
  type Rect,
} from '../shared/dock';
import { describeError } from '../shared/errors';
import type { Logger, LoggerFactory } from '../shared/logger';
import type {
  AnimationChangedPayload,
  AnimationSummary,
  LogPayload,
  PetBootstrap,
  RuntimeInfo,
  StateChangedPayload,
  TrayStatePayload,
  WindowPosition,
} from '../shared/ipc';
import type { PetAction } from '../shared/action-types';
import type { PluginRecord } from '../shared/plugin-types';
import { createLoggerFactory, type LogEntry } from '../shared/logging';
import { attachUtf8Console, writeUtf8 } from './console-encoding';
import {
  DEFAULT_PET_SETTINGS,
  clampPetScale,
  type PetSettings,
  type PetSettingsState,
  type PetSizeInfo,
} from '../shared/pet-size';
import { createFileSink } from './log-file-sink';
import { SettingsStore } from './settings-store';
import { SettingsWindowManager } from './settings-window-manager';
import { FALLBACK_ASPECT_RATIO, resolvePetSize } from './pet-size';
import { resolveBubbleLayout, type BubblePayload, type BubbleState } from '../shared/bubble';
import type { AIStatusView, DiaryEntry, PetPresence } from '../shared/ai-types';
import { createDefaultAIStatus } from '../shared/ai-types';
import type { PerceptionStatus, PerceptionViewMode } from '../shared/perception-types';
import { DEFAULT_PERCEPTION_SETTINGS } from '../shared/perception-types';
import { sceneLabel } from '../shared/perception';
import { PerceptionService, viewModeLabel } from './perception/perception-service';
import { GrowthService } from './growth/growth-service';
import type { GrowthStatus } from '../shared/growth-types';
import { DEFAULT_GROWTH_SETTINGS } from '../shared/growth-types';
import { registerAssetProtocolHandler, registerAssetScheme } from './asset-protocol';
import { AIService } from './ai/ai-service';
import { ChatWindowManager } from './chat-window-manager';
import { IpcManager } from './ipc-manager';
import { PluginManager } from './plugin-manager';
import { TrayManager } from './tray-manager';
import { WindowManager } from './window-manager';
import { BubbleController } from './bubble-controller';
import { TriggerService } from './pet/trigger-service';

class DesktopPetApplication {
  private config!: PetConfig;
  private loggerFactory!: LoggerFactory;
  private logger!: Logger;

  private windowManager: WindowManager | null = null;
  private trayManager: TrayManager | null = null;
  private settingsWindow: SettingsWindowManager | null = null;
  private ipcManager: IpcManager | null = null;
  private pluginManager: PluginManager | null = null;
  private bubbleController: BubbleController | null = null;
  /** AI 认知与人格（2.1~2.4）：大模型、记忆、情绪、日记都在这里。 */
  private aiService: AIService | null = null;
  /** 环境与用户感知（3.1~3.6）：屏幕/场景、行为、摄像头、习惯。 */
  private perception: PerceptionService | null = null;
  /** 成长、记忆与反思（4.1/4.2）：记忆宫殿、每日反思、行为策略。 */
  private growth: GrowthService | null = null;
  /**
   * 触发动画的信号源（鼠标靠近 / GPU 温度 / 心情 / 饿 / 掉线）。
   *
   * 判定规则都在 shared/pet-triggers.ts（纯函数），这里只负责取数与节流。
   */
  private triggers: TriggerService | null = null;
  private chatWindow: ChatWindowManager | null = null;
  /** 桌宠"在不在场"（影响情绪衰减与是否接收点击）。 */
  private presence: PetPresence = 'visible';
  /** "捂住眼睛躲起来"后的自动恢复定时器（见 handleIntervention）。 */
  private revealTimer: NodeJS.Timeout | null = null;

  private animationManifest: AnimationManifest = {};
  /** 显示状态与随机池（`behavior.json`，缺失时用内置默认）。 */
  private behaviorConfig: BehaviorConfig = DEFAULT_BEHAVIOR_CONFIG;
  private bootstrapData: PetBootstrap | null = null;
  private settingsStore: SettingsStore | null = null;
  private settings: PetSettings = { ...DEFAULT_PET_SETTINGS };
  private sizeInfo: PetSizeInfo | null = null;
  private quitting = false;
  private readonly pendingLogs: LogEntry[] = [];
  private behaviorPaused = false;
  /**
   * 用户**显式**按下的「暂停行为」（持久意图）。
   *
   * 与 `behaviorPaused`（实际生效值 = 用户暂停 ∪ 已隐藏）分开：
   * 隐藏带来的暂停是暂时的，显示回来要恢复用户的设置，不能把用户的暂停"顺手清掉"。
   */
  private behaviorsPausedByUser = false;
  private currentAnimation: string | null = null;
  private currentState = 'IDLE';
  private windowVisible = true;
  private readonly mode: 'development' | 'production';

  public constructor(devMode: boolean) {
    this.mode = devMode ? 'development' : 'production';
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  public bootstrap(): void {
    // 控制台输出：日志消息为英文（ASCII），因此不再受终端代码页影响。
    attachUtf8Console(true);

    // __dirname 指向 dist/main，据此上溯得到可靠的 appRoot（开发模式）
    const appRoot = resolveAppRoot({
      mainDir: __dirname,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      cwd: process.cwd(),
      exists: existsSync,
    });

    // 代码产物根：打包后是 app.asar（由 electron-builder 决定），开发时就是仓库根
    const distRoot = app.isPackaged ? app.getAppPath() : appRoot;

    this.config = resolvePetConfig({
      appRoot,
      distRoot,
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      mode: this.mode,
    });

    // 日志：开发环境 debug，生产 info；控制台 + 文件双输出。
    // 文件落在 userData/logs 下：Electron 在 Windows 上是 GUI 子系统程序，
    // 后台启动时 stdout 不可靠，文件日志是打包后唯一稳定的诊断入口。
    const logFile = join(app.getPath('userData'), 'logs', 'desktop-pet.log');
    this.loggerFactory = createLoggerFactory({
      level: this.mode === 'development' || process.argv.includes('--debug') ? 'debug' : 'info',
      toConsole: true,
      writeLine: (level, line) => writeUtf8(level, line),
      sinks: [createFileSink(logFile)],
    });
    this.logger = this.loggerFactory.create('Main');
    this.wireProcessGuards();
    this.logger.info('main process starting', {
      data: {
        mode: this.mode,
        appRoot: this.config.appRoot,
        assetsPath: this.config.assetsPath,
        pluginsPath: this.config.pluginsPath,
        electron: process.versions.electron,
      },
    });

    this.loadAnimationManifest();
    this.loadBehaviorConfig();

    // 设置（尺寸 / 置顶）：存放于 assets/config/settings.json，与其它配置在一起
    this.settingsStore = new SettingsStore({
      configPath: this.config.configPath,
      logger: this.loggerFactory.create('Settings'),
    });
    this.settings = this.settingsStore.load();
  }

  public async onReady(): Promise<void> {
    registerAssetProtocolHandler({ assetsPath: this.config.assetsPath, logger: this.loggerFactory.create('AssetProtocol') });

    this.pluginManager = new PluginManager({
      config: this.config,
      logger: this.loggerFactory.create('PluginManager'),
    });
    this.pluginManager.discoverPlugins();

    /*
     * AI 认知与人格（2.1~2.4）。
     *
     * 刻意在窗口创建**之前**装配：这样"打开桌宠时她先跟你打个招呼"
     * 这类主动行为才有地方挂。装配本身不联网、不读密钥以外的外部资源。
     */
    this.createAIService();
    this.createChatWindow();
    this.createPerceptionService();
    this.createGrowthService();

    this.bootstrapData = this.createBootstrap();

    this.ipcManager = new IpcManager({
      logger: this.loggerFactory.create('IpcManager'),
      getRuntimeInfo: () => this.bootstrapData?.runtime ?? this.createRuntimeInfo(),
      getBootstrap: () => this.bootstrapData ?? this.createBootstrap(),
      getSettingsState: () => this.settingsState(),
      setScale: (scale) => this.applyScale(scale),
      setAlwaysOnTop: (value) => this.applyAlwaysOnTop(value),
      setDockOnEdge: (value) => this.applyDockOnEdge(value),
      // 对话气泡：托盘菜单与验收脚本共用这一条实现（null = 隐藏）
      setBubble: (state) => this.applyBubble(state),
      // Renderer 量出的文本行数回报 -> 重算气泡高度（气泡随文本长短变化的闭环）
      reportBubbleTextLines: (text, lines) => {
        const controller = this.bubbleController;
        if (!controller) {
          return { state: { visible: false, text: '', ready: false }, layout: resolveBubbleLayout({ petWidth: 1, petHeight: 1 }) };
        }
        const payload = controller.reportTextLines(text, lines);
        this.refreshTray();
        return payload;
      },
      // 设置窗口：只有它能改尺寸，且改动与托盘菜单共用同一条写盘路径
      setScaleFromSettingsWindow: (scale) => {
        const state = this.applyScale(scale);
        this.settingsWindow?.pushState();
        return state;
      },
      setAlwaysOnTopFromSettingsWindow: (value) => {
        const state = this.applyAlwaysOnTop(value);
        this.settingsWindow?.pushState();
        return state;
      },
      openConfigFolder: () => this.settingsWindow?.openConfigFolder() ?? false,
      closeSettingsWindow: () => {
        this.settingsWindow?.hide();
        return true;
      },
      showSettingsWindow: () => {
        this.settingsWindow?.open();
        return this.settingsWindow?.exists() ?? false;
      },
      setWindowPosition: (x, y) => {
        const result = this.windowManager?.setPosition(x, y) ?? { x, y };
        // 收起状态下被拖动：拖离边缘就自动展开（跟手，不等松手）
        this.checkUndockWhileDragging();
        return result;
      },
      getWindowPosition: () => this.windowManager?.getPosition() ?? { x: 0, y: 0 },
      setWindowSize: (width, height) => this.windowManager?.setSize(width, height),
      dragEnd: () => this.handleDragEnd(),
      undock: () => this.handleUndock(),
      showWindow: () => this.showPet(),
      hideWindow: () => this.hidePet(),
      setIgnoreMouseEvents: (ignore, forward) => this.windowManager?.setIgnoreMouseEvents(ignore, forward),
      showContextMenu: (context) => this.trayManager?.showContextMenu(context),
      updateTrayState: (state) => this.applyTrayState(state),
      discoverPlugins: () => this.pluginManager?.discoverPlugins() ?? [],
      fetchPluginCode: async (id) => this.pluginManager?.loadPlugin(id) ?? null,
      reloadPlugin: async (id) => this.pluginManager?.reloadPlugin(id) ?? null,
      listPlugins: () => this.pluginManager?.getLoadedPlugins() ?? [],
      onRendererLog: (payload) => this.handleRendererLog(payload),
      onAnimationChanged: (payload) => this.handleAnimationChanged(payload),
      onStateChanged: (payload) => this.handleStateChanged(payload),
      onBehaviorPausedChanged: (paused) => {
        // 渲染层只在**用户/测试显式要求**时上报这条（镜像主进程自己的指令走的是
        // 另一条路），因此这里视为"用户的暂停意图"，并参与有效值计算。
        this.behaviorsPausedByUser = paused;
        this.syncBehaviorPause();
        this.refreshTray();
      },
      onActionFromRenderer: (action) => this.handleRendererAction(action),

      /* --------------------- AI 认知与人格（2.1~2.4） ---------------------
       *
       * IPC 层只做转发，真正的业务在 ai/ 里（见 src/main/ai/）。
       * 这里每个方法都是一行 —— "接线"与"逻辑"分开，改逻辑不必碰 IPC。
       */
      getAIStatus: () => this.aiStatus(),
      setAISettings: (patch) => this.aiService?.setSettings(patch) ?? this.aiStatus(),
      aiChat: async (text) => {
        // 说话同样算"回应"（比点一下更强的信号）
        this.growth?.recordUserActivity();
        return this.aiService?.chat(text, 'chat-window') ?? localChatFallback('AI 模块未就绪');
      },
      aiSpeakUp: async () => {
        // 用户主动要她说话：收起/隐藏时先把她请回桌面（见 expandForSpeech）
        this.expandForSpeech('ai-speak-up');
        return this.aiService?.speakUp('tray') ?? localChatFallback('AI 模块未就绪');
      },
      aiHistory: () => this.aiService?.history() ?? [],
      aiMemory: () => this.aiService?.memorySnapshot() ?? emptyMemorySnapshot(),
      aiClearMemory: () => this.aiService?.clearMemory() ?? emptyMemorySnapshot(),
      aiOpenMemoryLog: () => this.openPath(this.aiService?.memoryLogFile ?? ''),
      aiDiary: () => this.aiService?.diarySnapshot() ?? { items: [], dataDir: '', todayWritten: false, diaryHour: 22 },
      aiDiaryGet: (date) => this.aiService?.getDiary(date) ?? null,
      aiWriteDiary: () => this.writeDiaryNow(),
      aiOpenDiaryDir: () => this.openPath(this.aiService?.diaryService.dataDir ?? ''),
      aiTest: async () =>
        this.aiService?.testConnection() ?? { ok: false, mode: 'local', latencyMs: 0, sample: '', error: 'AI 模块未就绪', tokens: 0 },
      /*
       * 立刻查一次余额：返回**最新状态**（含余额快照与错误），
       * 面板据此刷新读数 —— 用户点了按钮就该看到结果，而不是等下一次轮询。
       */
      aiRefreshBalance: async () => {
        await this.aiService?.refreshBalance();
        this.refreshAISurfaces();
        return this.aiStatus();
      },
      aiInteraction: (kind) => {
        this.aiService?.notifyInteraction(kind);
        // 用户碰了她 = 对刚才那次主动开口的"回应"（4.2 的反馈信号）
        this.growth?.recordUserActivity();
      },
      aiResetEmotion: () => this.aiService?.resetEmotion() ?? this.aiStatus(),
      aiSetPresence: (presence) => {
        this.applyPresenceFromUI(presence);
        return this.aiStatus();
      },
      aiOpenChat: () => this.openChatWindow(),

      /* ------------------ 环境与用户感知（3.1~3.6） ------------------ */
      getPerceptionStatus: () => this.perceptionStatus(),
      setPerceptionSettings: (patch) => this.perception?.setSettings(patch) ?? this.perceptionStatus(),
      perceptionLog: (limit) => this.perception?.log(limit) ?? [],
      perceptionView: (mode) => this.perception?.viewNow(mode) ?? Promise.resolve({ ok: false, mode, text: '感知模块未就绪', scene: 'other' as const, sensitive: false, tokens: 0, error: 'not-ready' }),
      perceptionAuthorizeCamera: (authorized) => {
        const status = this.perception?.authorizeCamera(authorized) ?? this.perceptionStatus();
        // 授权后让渲染层立刻去开摄像头（否则要等下一个采样周期）
        if (authorized) this.ipcManager?.requestCameraFrame();
        return status;
      },
      perceptionClearData: () => this.perception?.clearData() ?? this.perceptionStatus(),
      perceptionOpenLog: () => this.openPath(this.perception?.logPath ?? ''),
      perceptionSampleNow: async () => this.perception?.tick(Date.now(), true) ?? this.perceptionStatus(),
      perceptionTimeline: async (date) =>
        this.perception?.timelineView(date) ?? { date: date ?? '', text: '', narrative: '', hasData: false },
      perceptionNarrateTimeline: async (date, force) =>
        (await this.perception?.narrateTimeline(date, force)) ?? { date: date ?? '', text: '', narrative: '', hasData: false },
      perceptionCameraFrame: (dataUrl) => {
        void this.perception?.ingestCameraFrame(dataUrl);
      },
      perceptionCameraReady: (ready, error) => this.perception?.setCameraReady(ready, error),

      /* ------------------ 成长、记忆与反思（4.1 / 4.2） ------------------ */
      getGrowthStatus: () => this.growthStatus(),
      setGrowthSettings: (patch) => this.growth?.setSettings(patch) ?? this.growthStatus(),
      growthAddNode: (input) => this.growth?.addNode(input) ?? this.growthStatus(),
      growthRemoveNode: (id) => this.growth?.removeNode(id) ?? this.growthStatus(),
      growthPinNode: (id, pinned) => this.growth?.pinNode(id, pinned) ?? this.growthStatus(),
      growthRecallNode: async (id) => this.growth?.recallNode(id) ?? { ok: false, text: '成长模块未就绪' },
      growthReflectNow: async () => {
        await this.growth?.reflectNow();
        return this.growthStatus();
      },
      growthResetPolicy: () => this.growth?.resetPolicy() ?? this.growthStatus(),
      growthRefreshPalace: () => this.growth?.refreshPalace() ?? this.growthStatus(),
      growthOpenPalace: () => this.openPath(this.growth?.palacePath ?? ''),
      growthOpenPolicyLog: () => this.openPath(this.growth?.policyLogPath ?? ''),
      closeChatWindow: () => {
        this.chatWindow?.hide();
        return true;
      },
    });
    this.ipcManager.register();
    this.ipcManager.setSenderProvider(() => this.windowManager?.getWindow() ?? null);

    this.createWindow();
    this.createTray();
    this.createSettingsWindow();
    this.wireMediaPermissions();

    app.on('activate', () => this.showPet());
  }

  /**
   * 品牌图标路径（`<appRoot>/build/<name>`）。
   *
   * 为什么不用 `join(..., 'icon.ico')` 直接拼：
   * 打包后若 extraResources 漏了某个文件，Electron 会静默用默认图标 ——
   * 这里显式判存在，既能按优先级回退，也方便日志里看出到底用了哪一个。
   */
  private resolveBrandIcon(name: string): string | null {
    const candidate = join(this.config.appRoot, 'build', name);
    return existsSync(candidate) ? candidate : null;
  }

  private createWindow(): void {
    const size = this.resolveWindowSize();
    const bootstrapArg = this.encodeBootstrapArg(this.bootstrapData ?? this.createBootstrap());

    this.windowManager = new WindowManager({
      config: this.config,
      logger: this.loggerFactory.create('WindowManager'),
      preloadPath: join(this.config.distPath, 'preload', 'preload.js'),
      rendererHtmlPath: join(this.config.distPath, 'renderer', 'index.html'),
      size,
      iconPath: this.resolveBrandIcon('icon.ico') ?? this.resolveBrandIcon('icon.png') ?? undefined,
      additionalArguments: [bootstrapArg],
    });

    const window = this.windowManager.create();
    window.once('ready-to-show', () => this.windowManager?.show());
    /*
     * 触发动画的信号源必须**等渲染层订阅完**再启动。
     *
     * 实测踩到的：触发服务原来在窗口加载前就启动，启动时的"没配 key -> 演 offline"
     * 在渲染层订阅之前就广播出去了 —— 消息直接丢掉，而 `offlineArmed` 已经置为 false，
     * 于是"启动即掉线"这件事**永远不会演**（只有等用户改配置触发了新的状态变化）。
     * 与显示状态不同（它有 bootstrap 兜底），触发是纯事件，丢了就是丢了。
     */
    window.webContents.once('did-finish-load', () => {
      const timer = setTimeout(() => this.createTriggerService(), 1500);
      timer.unref?.();
    });
    void this.windowManager.load();
  }

  /**
   * 设置窗口（尺寸滚动条）。
   *
   * 主进程持有它，但**不主动打开**：入口在托盘/右键菜单的「设置…」。
   * 构造时只注入回调，窗口本身在第一次打开时才创建（惰性）。
   */
  private createSettingsWindow(): void {
    this.settingsWindow = new SettingsWindowManager({
      config: this.config,
      logger: this.loggerFactory.create('SettingsWindow'),
      getState: () => this.settingsState(),
      setScale: (scale) => this.applyScale(scale),
      setAlwaysOnTop: (value) => this.applyAlwaysOnTop(value),
      getAIStatus: () => this.aiStatus(),
      getPerceptionStatus: () => this.perceptionStatus(),
      getGrowthStatus: () => this.growthStatus(),
    });
  }

  /* ------------------------------------------------------------------ */
  /* 环境与用户感知（3.1~3.6）                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 装配感知服务。
   *
   * 与 AI 模块共用同一个 `LLMClient`（`aiService` 持有一个），因此：
   * - 密钥/网关/模型只在设置里配**一次**，视觉理解立刻跟着生效；
   * - 没配密钥时视觉部分自然降级，但**本地行为信号照常工作**
   *   （连续使用过久、深夜提醒不需要任何模型）。
   */
  private createPerceptionService(): void {
    this.perception = new PerceptionService({
      dataDir: aiDataDir(),
      logger: this.loggerFactory.create('Perception'),
      getClient: () => this.aiService?.llmClient ?? null,
      isLLMUsable: () => this.aiService?.status().usable === true,
      getAvailableAnimations: () => this.animationSummaries().map((item) => item.id),
      onIntervene: (plan, reason) => this.handleIntervention(plan, reason),
      // "感知到在工作 / 在阅读"只演动画不开口（不占打扰上限）
      onTriggerAnimation: (animationId, reason) => {
        if (this.display.hidden || this.display.dock !== 'free') return;
        // 「暂停行为」= 不要自己动：与她主动演动画有关的一切都停下
        if (this.behaviorPaused) return;
        this.triggerAnimation(animationId, reason, 'perception');
      },
      onStatus: (status) => this.ipcManager?.notifyPerceptionStatus(status),
      requestCameraFrame: () => this.ipcManager?.requestCameraFrame(),
      onSettingsChanged: (settings) => this.applyCapturePrivacy(settings),
      // 时间线叙述要用名字（"你记得主人今天做了什么"），名字属于 AI 设置
      getNames: () => {
        const ai = this.aiService?.status();
        return { petName: ai?.settings.petName ?? '鲸鱼娘', userName: ai?.settings.userName ?? '' };
      },
    });
    this.perception.load();
    this.perception.start();
    this.logger.info('perception module ready', { data: { summary: this.perception.describe() } });
  }

  /**
   * 摄像头权限闸门（3.5 的"明确授权"在 Electron 层的落点）。
   *
   * 渲染层调 `getUserMedia` 时 Electron 会问主进程的权限处理器：
   * 只有"摄像头开关打开 + 用户已显式授权 + 没有开隐私模式"三者同时成立才放行，
   * 其余情况一律拒绝（并且**不弹出**系统权限提示）。
   * 这样"授权"这件事只有一条路径：用户在界面上点过那个按钮。
   */
  private wireMediaPermissions(): void {
    try {
      session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
        if (permission !== 'media') {
          callback(false);
          return;
        }
        const settings = this.perception?.settings;
        const allowed =
          settings !== undefined && settings.camera && settings.cameraAuthorized && !settings.privacyMode;
        if (!allowed) {
          this.logger.info('camera permission denied by policy', {
            data: {
              camera: settings?.camera ?? false,
              authorized: settings?.cameraAuthorized ?? false,
              privacyMode: settings?.privacyMode ?? false,
            },
          });
        }
        callback(allowed);
      });
      session.defaultSession.setPermissionCheckHandler((_contents, permission) => {
        if (permission !== 'media') return false;
        const settings = this.perception?.settings;
        return settings !== undefined && settings.camera && settings.cameraAuthorized && !settings.privacyMode;
      });
      this.logger.info('media permission handler installed');
    } catch (error) {
      this.logger.error('installing media permission handler failed', { error: describeError(error) });
    }
  }

  /** 隐私相关的窗口副作用：要不要让自己从截屏/录屏里消失。 */  private applyCapturePrivacy(settings: { hideFromCapture: boolean }): void {
    const windows = [
      this.windowManager?.getWindow() ?? null,
      this.chatWindow?.getWindow() ?? null,
      this.settingsWindow?.getWindow() ?? null,
    ].filter((window): window is NonNullable<typeof window> => window !== null);
    this.perception?.applyContentProtection(windows, settings.hideFromCapture);
  }

  /**
   * "她看见了什么？"——把感知状态整理成一段可读文本（托盘菜单入口）。
   *
   * 与记忆一样，感知必须**可审计**：用户点一下就能看到她掌握了什么信息、
   * 最近一次为什么开口。这是"感知"能被接受的前提。
   */
  private perceptionDigest(): string {
    const status = this.perceptionStatus();
    const observation = status.lastObservation;
    const lines = [
      status.capturing ? '感知中' : `暂停感知（${status.pausedReason || '未开启'}）`,
      observation
        ? `最近看到：${sceneLabel(observation.scene)}${observation.app ? `（${observation.app}）` : ''}${observation.sensitive ? ' · 私人内容' : ''}`
        : '还没看到什么（需要接上大模型才能看懂屏幕）',
      `行为：空闲 ${status.behavior.idleSeconds}s · 连续使用 ${status.behavior.sessionMinutes} 分钟 · 本小时切换 ${status.behavior.switchesLastHour} 次`,
      `在场：${status.presence.present ? '在电脑前' : '不在'}（来源：${status.presence.source}）`,
      `习惯：采样 ${status.habits.samples} 次 · 覆盖 ${status.habits.activeDays} 天` +
        (status.habits.typicalNow ? ` · 这个点通常在做${sceneLabel(status.habits.typicalNow)}` : ''),
      status.lastIntervention
        ? `上次开口：${status.lastIntervention.text}（${status.lastIntervention.reason}）`
        : '还没主动开口过',
      `今天主动打扰：${status.interventionsToday} 次（上限 ${status.settings.proactiveMaxPerHour}/小时）`,
      `感知日志：${status.dataDir}`,
    ];
    return lines.join('\n');
  }

  /** 采了一帧后要在窗口上"躲起来"（敏感内容 / 陌生人）。 */
  private handleIntervention(plan: { kind: string; text: string; animation: string | null; hide: boolean }, reason: string): void {
    this.logger.info('perception intervention', { data: { reason, text: plan.text.slice(0, 40) } });
    /*
     * 收起 / 隐藏 = 安静模式：**感知干预整条不发生**（不冒泡、不演开口动画，
     * 也不记"干预" —— 她没开口就谈不上被回应，记了会白占每小时的打扰额度、
     * 还会把成长模块的回应率算歪）。
     *
     * 唯一的例外是 `plan.hide`（敏感内容 / 陌生人时捂住眼睛躲起来）：
     * 那是隐私动作，与"说不说话"无关，照做。
     */
    const quiet = this.isQuiet();
    const shouldSpeak = plan.text.trim() !== '' && !quiet;
    if (plan.text.trim() !== '' && quiet) {
      this.logger.info('perception intervention speech suppressed: pet is collapsed or hidden', {
        data: { kind: plan.kind, reason, dock: this.display.dock, hidden: this.display.hidden },
      });
    }
    if (shouldSpeak) {
      /*
       * 4.2 的反馈起点：记下"我说了这句话、当时是什么场景"。
       * 之后 3 分钟里如果用户有任何互动/对话，就算"被回应"——
       * 回应率是她反思"该不该少说话"的唯一依据。
       */
      this.growth?.recordIntervention({
        kind: plan.kind,
        text: plan.text,
        scene: this.perception?.status().lastObservation?.scene ?? 'other',
      });
      this.applyBubble({ visible: true, text: plan.text, ready: false });
    }
    if (plan.animation && !quiet) {
      this.triggerAnimation(plan.animation, `perception:${plan.kind}`, 'perception');
    }
    if (plan.hide) {
      /*
       * "捂住眼睛躲起来"：把桌宠藏起来一小会儿。
       *
       * ⚠️ 必须有**自动恢复**：早期版本只 hide 不 restore，她会一直藏着直到用户
       * 自己去托盘点「显示桌宠」—— 用户会以为她崩了（文档评审抓到）。
       * 这里 20 秒后自动回来；期间用户手动显示过就不再干预。
       */
      this.setDisplay({ hidden: true }, 'self-hide:sensitive');
      if (this.revealTimer !== null) clearTimeout(this.revealTimer);
      this.revealTimer = setTimeout(() => {
        this.revealTimer = null;
        if (this.presence === 'hidden') {
          this.logger.info('pet reveals itself after hiding for sensitive content');
          this.setDisplay({ hidden: false }, 'self-reveal');
        }
      }, SELF_HIDE_MS);
      this.revealTimer.unref?.();
      this.logger.info('pet hid itself due to sensitive content / stranger', { data: { revealInMs: SELF_HIDE_MS } });
    }
    if (this.aiService) {
      // 干预也进记忆（日记里能看到"她提醒过你休息"）
      this.aiService.recordEvent('interaction', `感知干预：${plan.text}`, { reason });
    }
  }

  private perceptionStatus(): PerceptionStatus {
    if (this.perception) return this.perception.status();
    return {
      settings: DEFAULT_PERCEPTION_SETTINGS,
      capturing: false,
      pausedReason: '感知模块未就绪',
      lastObservation: null,
      behavior: { idleSeconds: 0, sessionMinutes: 0, switchesLastHour: 0, hour: new Date().getHours(), lateNight: false, userState: 'unknown' },
      presence: { present: true, source: 'unknown', at: '' },
      habits: { samples: 0, activeDays: 0, latestActiveHour: null, earliestActiveHour: null, typicalNow: null },
      lastIntervention: null,
      interventionsToday: 0,
      cameraReady: false,
      windowContext: { count: 0, foregroundTitle: '', foregroundProcess: '', sample: [], backingOff: false },
      timeline: { date: '', activeMinutes: 0, idleMinutes: 0, byScene: [], byApp: [], recent: [], narrative: '' },
      retention: { days: 0, lastPrunedAt: '', lastPrunedDays: 0 },
      dataDir: aiDataDir(),
      lastError: '',
    };
  }

  /** 3.2 按需看屏幕（只剩场景）：结果同时进气泡与聊天窗口（和 AI 回复走同一套展示）。 */
  private async viewScreen(mode: PerceptionViewMode): Promise<void> {
    if (!this.perception) return;
    // 用户主动点的「看我在做什么」：收起/隐藏时先请回桌面，结果才有地方说
    this.expandForSpeech('view-screen');
    const result = await this.perception.viewNow(mode);
    this.handleSpeak({ text: result.text, animation: this.animationForScene(result.scene), kind: 'reply' });
    if (this.aiService) {
      this.aiService.recordEvent('interaction', `看屏幕（${viewModeLabel(mode)}）：${result.text.slice(0, 60)}`);
    }
  }

  /** 场景 -> 动画（挑不到就交给 AI 模块按情绪决定）。 */
  private animationForScene(scene: string): string | null {
    const candidates = this.animationSummaries().map((item) => item.id);
    const pick = (ids: readonly string[]): string | null => ids.find((id) => candidates.includes(id)) ?? null;
    switch (scene) {
      case 'coding':
      case 'terminal':
        return pick(['work', 'read', 'talk']);
      case 'reading':
        return pick(['read', 'work', 'talk']);
      case 'video':
      case 'gaming':
        return pick(['cute', 'fawning', 'talk']);
      case 'idle':
        return pick(['lie', 'sleep', 'read']);
      default:
        return pick(['talk', 'cute']);
    }
  }


  /* ------------------------------------------------------------------ */
  /* 成长、记忆与反思（4.1 / 4.2）                                        */
  /* ------------------------------------------------------------------ */

  /**
   * 装配成长服务。
   *
   * 素材全部通过回调注入（对话来自 AI 模块、心情来自情绪模块、场景与习惯来自感知模块），
   * 因此这里没有服务之间的 import 依赖；结论只往一个方向流：
   * **反思 -> 策略 -> 感知模块的频率闸门**（且只能收紧）。
   */
  private createGrowthService(): void {
    this.growth = new GrowthService({
      dataDir: aiDataDir(),
      logger: this.loggerFactory.create('Growth'),
      getClient: () => this.aiService?.llmClient ?? null,
      isLLMUsable: () => this.aiService?.status().usable === true,
      getChatTurns: (date) => this.aiService?.memoryStore.turnsOn(date) ?? [],
      getMoodCurve: (date) => this.aiService?.emotionService.moodCurve(date) ?? { start: 60, end: 60, low: 60 },
      getSceneCounts: (date) => this.sceneCountsFor(date),
      getHabitSamples: () => this.perception?.habitSamples() ?? 0,
      getCurrentScene: () => this.perception?.status().lastObservation?.scene ?? 'other',
      getPerceptionSettings: () => this.perception?.settings ?? DEFAULT_PERCEPTION_SETTINGS,
      onPolicyChanged: (overlay) => this.perception?.setPolicyOverlay(overlay),
      onStatus: (status) => this.ipcManager?.notifyGrowthStatus(status),
      onSpeak: (text, animation) => this.handleSpeak({ text, animation, kind: 'proactive' }),
    });
    this.growth.load();
    this.logger.info('growth module ready', { data: { nodes: this.growth.getNodes().length } });
  }

  /**
   * 触发动画的信号源（需求 6.2 的"触发动画"）。
   *
   * 五路信号全部喂给纯规则（shared/pet-triggers.ts）：
   *   鼠标靠近 -> catch_down / catch_right
   *   GPU 温度 -> overheat
   *   心情过低 -> sad
   *   饿      -> hungry（余额优先，见 AIService.refreshBalance）
   *   掉线    -> offline（没配 key / key 无效 / 余额不足）
   *
   * 感知类触发（shy / work / read / remind / talk）不在这里：
   * 它们由感知服务在拿到观察结果时判定（那里才有场景稳定性与切换频率）。
   */
  private createTriggerService(): void {
    if (this.triggers !== null) return;
    this.triggers = new TriggerService({
      logger: this.loggerFactory.create('Triggers'),
      trigger: (animationId, reason) => {
        // 收起/隐藏状态下不打扰：她自己有 sleep/peek 那套随机动画
        if (this.display.hidden || this.display.dock !== 'free') return;
        this.triggerAnimation(animationId, reason, 'system');
      },
      /*
       * 「暂停行为」= **不要自己动**：随机池、鼠标靠近的接住、心情/饿/掉线的表达
       * 全都属于"她主动演"，暂停时一律不做（用户点她仍然照常有反应）。
       * 这也让"验收里动画断言不被真实光标位置影响"有一个正经开关可用
       * （实测：鼠标恰好停在宠物附近时，catch_right 会插进动画断言里）。
       */
      isPaused: () => this.behaviorPaused,
      getPetRect: () => {
        if (!(this.windowManager?.isVisible() ?? false)) return null;
        return this.petRectOnScreen();
      },
      getEmotion: () => {
        const status = this.aiService?.status();
        return status ? { mood: status.emotion.mood, hunger: status.emotion.hunger } : null;
      },
      getOfflineReason: () => this.aiService?.offlineReason().reason ?? '',
      // 过热阈值来自感知设置（面板「采样与频率」里可改）；服务没起来时用默认 80 度
      getOverheatThresholdC: () =>
        this.perception?.settings.overheatThresholdC ?? DEFAULT_PERCEPTION_SETTINGS.overheatThresholdC,
    });
    this.triggers.start();
  }

  /** 某天的场景分布（用感知服务当天的观察记录统计；没有就返回空）。 */
  private sceneCountsFor(date: string): Record<string, number> {
    const observations = this.perception?.observationsOn(date) ?? [];
    const counts: Record<string, number> = {};
    for (const observation of observations) {
      counts[observation.scene] = (counts[observation.scene] ?? 0) + 1;
    }
    return counts;
  }

  private growthStatus(): GrowthStatus {
    if (this.growth) return this.growth.status();
    return {
      settings: DEFAULT_GROWTH_SETTINGS,
      palace: { nodes: [], byMonth: [], updatedAt: '', dataDir: aiDataDir(), markdownFile: '', stats: { total: 0, daysTogether: 0, since: '' } },
      todayReflection: null,
      recentReflections: [],
      policy: { minIntervalFactor: 1, maxPerHourFactor: 1, sceneFactors: {}, updatedAt: '', reason: '', adjustments: 0 },
      policyEffect: '成长模块未就绪',
      responseStats: [],
      dataDir: aiDataDir(),
      lastError: '',
    };
  }

  /* ------------------------------------------------------------------ */
  /* AI 认知与人格（2.1~2.4）                                             */
  /* ------------------------------------------------------------------ */

  /**
   * 装配 AI 服务。
   *
   * 三个回调决定了"AI 模块如何影响桌宠本体"：
   * - `onSpeak`   ：她说的话 -> 气泡；挑中的动画 -> 播放；同时推给聊天窗口；
   * - `onStatus`  ：状态变化 -> 推设置/聊天窗口 + 刷新托盘（菜单里的心情是活的）；
   * - `getAvailableAnimations`：只能播放 Manifest 里真实存在的动画。
   */
  private createAIService(): void {
    this.aiService = new AIService({
      // 数据目录默认在 userData；验收脚本用环境变量指到临时目录，
      // 这样"自动验收"不会污染用户真实的记忆与日记。
      dataDir: aiDataDir(),
      logger: this.loggerFactory.create('AI'),
      getAvailableAnimations: () => this.animationSummaries().map((item) => item.id),
      onSpeak: (request) => this.handleSpeak(request),
      onStatus: () => this.refreshAISurfaces(),
      /*
       * 「今天在做什么」喂给聊天与日记。
       *
       * 为什么由感知模块提供、而不是让 AI 模块自己去读文件：数据的真相在感知模块内存里
       * （时间线是增量聚合的），而且这条线要能在感知关掉时**自然消失**（返回空串即可）。
       * 用回调而不是启动时快照：每轮对话/每次写日记都取当时最新的那一段。
       */
      getDailyTimeline: () => this.perception?.dailyTimelineText() ?? '',
    });
    this.aiService.load();
    this.logger.info('ai module ready', { data: { dataDir: aiDataDir() } });
  }

  private createChatWindow(): void {
    this.chatWindow = new ChatWindowManager({
      config: this.config,
      logger: this.loggerFactory.create('ChatWindow'),
      getHistory: () => this.aiService?.history() ?? [],
      getStatus: () => this.aiStatus(),
    });
  }

  /** 她说一句话：气泡 + 动画 + 推给聊天窗口。 */
  /**
   * 触发一条动画（感知 / AI / 系统来源）。
   *
   * 与托盘「播放动画（测试）」的 `setAnimation` 分开：那条会强制切换并绕过冷却，
   * 这条走普通优先级仲裁 —— 触发的动画（work / read / sad / shy…）不该硬切掉
   * 用户正在看的点击反应，也不该绕过防刷屏的冷却。
   *
   * ⚠️ **收起 / 隐藏 / 暂停行为时一律不触发**（用户点托盘菜单仍可手动播）。
   * 为什么必须在这里拦：收起状态的默认动画是 watch / lie，而它是三段式 ——
   * 每来一条触发动画都要"先播它的 end 再播新的"，然后结束后又要重新起默认动画。
   * 也就是说在她安静待着的时候，任何自动来源的动画都会让她**反复播收尾段**
   * （实测表现："右侧一直在循环 end"）。收起 = 安静待着，就不该有这些动画。
   */
  private triggerAnimation(animationId: string, reason: string, source: string): void {
    if (!animationId) return;
    if (this.display.hidden || this.display.dock !== 'free') {
      this.logger.debug('trigger animation skipped: pet is docked or hidden', {
        data: { animationId, reason, dock: this.display.dock, hidden: this.display.hidden },
      });
      return;
    }
    if (this.behaviorPaused) {
      this.logger.debug('trigger animation skipped: behaviors paused', { data: { animationId, reason } });
      return;
    }
    this.ipcManager?.triggerAnimation({ animationId, reason, source });
  }

  /**
   * 收起（贴边）或隐藏时，她**不开口**（用户要求："收起时不应该发生对话"）。
   *
   * 判定本身在 `shared/behavior-config.ts` 的 `isQuietDisplay()`（纯函数，验收钉死）。
   */
  private isQuiet(): boolean {
    return isQuietDisplay(this.display);
  }

  /**
   * 用户主动要她开口（托盘 / 聊天窗口的「让她说句话」、各种摘要、日记…）：
   * 收起或隐藏时**先把她请回桌面**，再让气泡出现在桌面上。
   *
   * 为什么用户主动的那些不直接静音：菜单点了却一声不吭，看起来就是坏了。
   * 先展开（和"点一下展开"是同一套逻辑）既满足"收起时不发生对话"，
   * 也让对话发生在桌面上 —— 展开是同步的状态变化，窗口位置照旧由渲染层
   * 在收尾段播完之后再挪（见 `handleUndock` / CommandMoveWhenSettled）。
   */
  private expandForSpeech(reason: string): void {
    if (!this.isQuiet()) return;
    this.logger.info('expanding pet before speaking (user asked)', {
      data: { reason, dock: this.display.dock, hidden: this.display.hidden },
    });
    if (this.display.hidden) this.setDisplay({ hidden: false }, `${reason}:unhide`);
    if (this.display.dock !== 'free') this.handleUndock();
  }

  private handleSpeak(request: { text: string; animation: string | null; kind: string; level?: 'info' | 'warn' | 'error' }): void {
    /*
     * 收起 / 隐藏 = 安静模式（用户要求："收起时不应该发生对话"）：
     *   - `proactive` / `system`（她自己想说话、日记提醒、系统提示）：**整条丢弃** ——
     *     连聊天窗口都不推，因为她本来就不该在这时候开口；
     *   - `reply`（用户刚在聊天窗口说了话）：**回复照常给聊天窗口**，只是不在屏幕
     *     边上冒泡、也不演开口动画 —— 对话发生在聊天窗口里，收起状态下她不"出声"。
     */
    if (this.isQuiet()) {
      const automatic = request.kind !== 'reply';
      this.logger.info('speech suppressed: pet is collapsed or hidden', {
        data: {
          kind: request.kind,
          automatic,
          dock: this.display.dock,
          hidden: this.display.hidden,
          text: request.text.slice(0, 20),
        },
      });
      if (automatic) return;
      if (request.text.trim() !== '') {
        this.chatWindow?.pushMessage({
          role: 'pet',
          text: request.text,
          at: new Date().toISOString(),
          ...(request.level ? { level: request.level } : {}),
        });
      }
      return;
    }
    if (request.text.trim() !== '') {
      this.applyBubble({ visible: true, text: request.text, ready: false });
    }
    if (request.animation) {
      /*
       * 走"触发动画"通道而不是 `setAnimation`：
       * 前者是自动来源（普通优先级仲裁 + 冷却，会被点击动画礼貌挡住），
       * 后者是"用户在托盘挑动画测试"（强制切换 + 绕过冷却）。
       * 她说话时演 talk，不该把用户正在看的点击反应硬切掉。
       */
      this.triggerAnimation(request.animation, `speak:${request.kind}`, 'ai');
    }
    this.chatWindow?.pushMessage({
      role: request.kind === 'system' ? 'system' : 'pet',
      text: request.text,
      at: new Date().toISOString(),
      ...(request.level ? { level: request.level } : {}),
    });
  }

  /** AI 状态快照（含情绪与在场状态）。 */
  private aiStatus(): AIStatusView {
    if (this.aiService) {
      const status = this.aiService.status();
      // 在场状态以主进程为准（窗口是显示还是隐藏，只有这里知道）
      return { ...status, presence: this.presence };
    }
    const fallback = createDefaultAIStatus(aiDataDir());
    return { ...fallback, presence: this.presence };
  }

  /** 状态变化后刷新三处 UI：托盘菜单、设置窗口、聊天窗口。 */
  private refreshAISurfaces(): void {
    this.refreshTray();
    this.settingsWindow?.pushAIStatus();
    this.chatWindow?.pushStatus(this.aiStatus());
  }

  private openPath(target: string): boolean {
    if (!target) return false;
    try {
      void shell.openPath(target);
      return true;
    } catch (error) {
      this.logger.warn('opening path failed', { error: describeError(error), data: { target } });
      return false;
    }
  }

  private openChatWindow(): boolean {
    this.chatWindow?.open();
    return this.chatWindow?.exists() ?? false;
  }

  /**
   * "她记住了什么？"——把长期记忆整理成一段可读文本显示在气泡里。
   *
   * 记忆必须是**可审计**的：用户点一下就能看到她在记什么，
   * 而不是只能去翻 JSON 文件。记错了也才能被发现。
   */
  private memoryDigest(): string {
    const snapshot = this.aiService?.memorySnapshot();
    if (!snapshot || snapshot.profile.facts.length === 0) {
      return '我现在还没记住什么。多和我说说话吧～\n（记忆日志：' + (this.aiService?.memoryLogFile ?? '-') + '）';
    }
    const label: Record<string, string> = {
      name: '名字',
      interest: '兴趣',
      routine: '作息',
      activity: '常做的事',
      project: '在做的项目',
      preference: '偏好',
      relation: '提到的人',
      note: '其它',
    };
    const lines = snapshot.profile.facts.slice(0, 12).map((fact) => `· ${label[fact.key] ?? fact.key}：${fact.value}`);
    return [
      `我记住了 ${snapshot.stats.facts} 件事（对话 ${snapshot.stats.turns} 轮）：`,
      ...lines,
      '',
      '记忆日志：' + snapshot.logFile,
    ].join('\n');
  }

  /** 立刻写一篇日记（托盘菜单与设置界面共用）。 */
  private async writeDiaryNow(): Promise<DiaryEntry> {
    if (!this.aiService) {
      throw new Error('AI 模块未就绪');
    }
    const entry = await this.aiService.writeDiary(undefined, true);
    // 写完把正文冒泡出来 —— 用户点菜单就是想看内容
    this.expandForSpeech('write-diary');
    this.applyBubble({ visible: true, text: entry.body, ready: false });
    this.refreshTray();
    return entry;
  }

  /**
   * 切换"收起（贴边）"—— **托盘/右键菜单的勾选项**用这条（真正的开/关切换）。
   *
   * ⚠️ 语义已经改过一轮（用户明确要求）：
   * 以前这个菜单项是"**原地不动 + 整窗点击穿透 + 暂停行为**"，
   * 现在它等于"**贴到最近的边缘收起**"：
   *   - 她还在屏幕上、仍然能点（点一下就是展开）；
   *   - 默认动画换成 lie（下方）/ watch（右侧），随机动画只剩一个且间隔更长；
   *   - "完全看不到 / 不打扰" 改由「隐藏桌宠」承担（原来的收起行为其实就是隐藏）。
   *
   * 注意与 `dockToNearestEdge()` 的区别：那是**幂等的"收起"动作**
   * （`ai:set-presence('collapsed')` 这种"设为某状态"的接口要用它，
   * 否则"已经收起了再设一次"会变成展开 —— 语义就反了）。
   */
  private toggleCollapsed(): boolean {
    if (this.display.dock !== 'free') {
      this.handleUndock();
      return false;
    }
    return this.dockToNearestEdge();
  }

  /**
   * 贴到最近的边缘收起（幂等：已经收起时什么都不做）。
   *
   * 托盘/右键进来的"收起"没有鼠标落点，按"离哪条边近就收哪边"：
   * 下边缘按剩余空间判断，右边同理；两边都远就收下方（桌面宠物最常见的姿势）。
   */
  private dockToNearestEdge(): boolean {
    if (this.display.dock !== 'free') return false;
    const area = this.workAreaRect();
    const pet = this.petRectOnScreen();
    if (!area || !pet) return false;
    const rightGap = area.x + area.width - (pet.x + pet.width);
    const bottomGap = area.y + area.height - (pet.y + pet.height);
    const dock: Exclude<PetDock, 'free'> = rightGap < bottomGap ? 'right' : 'bottom';
    this.snapToDock(dock);
    this.setDisplay({ dock }, 'dock:nearest-edge');
    return true;
  }

  /**
   * 同步"行为暂停"的**实际生效值** = 用户显式暂停 ∪ 已被隐藏。
   *
   * 两个来源各自独立：用户的暂停是**持久的**（不该被"她隐藏了一下又显示"清掉），
   * 隐藏带来的暂停是**暂时的**（显示回来就该恢复她原来的设置）。
   */
  private syncBehaviorPause(): void {
    const effective = this.behaviorsPausedByUser || this.presence === 'hidden';
    if (effective === this.behaviorPaused) return;
    this.behaviorPaused = effective;
    this.ipcManager?.setBehaviorPaused(effective);
    this.logger.info('behavior pause changed', {
      data: { paused: effective, byUser: this.behaviorsPausedByUser, hidden: this.presence === 'hidden' },
    });
  }

  /**
   * 应用在场状态（情绪衰减三档 + 窗口显隐 + 行为暂停）。
   *
   * 由显示状态**推导**，不再由菜单直接设置 —— 两个来源各自改状态是上一版
   * 状态不一致的根源（收起靠边了、情绪却还以为自己是"正常在场"）。
   */
  private applyPresence(presence: PetPresence): void {
    const wasHidden = this.presence === 'hidden';
    this.presence = presence;

    if (presence === 'hidden') {
      this.windowManager?.hide();
      this.windowVisible = false;
    } else {
      this.windowManager?.show();
      this.windowVisible = true;
    }

    /*
     * 收起（贴边）**不**暂停行为：她有自己的随机池（sleep / peek，3–8 分钟一次），
     * 暂停了反而"收起之后就彻底死了"。只有隐藏才暂停 —— 看不到就不该浪费电。
     *
     * ⚠️ 但**不能覆盖用户显式按下的「暂停行为」**：早期实现这里直接
     * `this.behaviorPaused = (presence === 'hidden')`，于是"用户暂停了行为 ->
     * 她隐藏/显示一次 -> 暂停被静默解除"，随机动画与触发动画又冒出来。
     * 现在两件事分开记：用户意图 (`behaviorsPausedByUser`) 与显示状态取"或"。
     */
    this.syncBehaviorPause();

    this.aiService?.setPresence(presence);
    if (wasHidden !== (presence === 'hidden')) {
      this.aiService?.recordEvent('presence', presence === 'collapsed' ? '收起（贴边）' : presence === 'hidden' ? '隐藏桌宠' : '展开桌宠');
    }
    this.logger.info('pet presence changed', { data: { presence } });
  }

  private createTray(): void {
    /*
     * 对话气泡控制器：窗口尺寸与气泡布局必须在同一处决策
     * （气泡在宠物上方，窗口不够大就会被裁掉）。见 main/bubble-controller.ts。
     */
    this.bubbleController = new BubbleController({
      logger: this.loggerFactory.create('Bubble'),
      getPetSize: () => {
        const size = this.resolveWindowSize();
        return { width: size.width, height: size.height };
      },
      hasWindow: () => this.windowManager?.exists() ?? false,
      /*
       * 含气泡的窗口高度上限 = 显示器工作区高度。
       * 超限时气泡等比缩小 —— 否则窗口会被顶出屏幕、位置被 clamp 拉回，
       * 宠物在屏幕上会一路漂移（实测踩过）。
       */
      getMaxWindowHeight: () => {
        try {
          return screen.getPrimaryDisplay().workArea.height;
        } catch {
          return Number.POSITIVE_INFINITY;
        }
      },
      resizeWindow: (previousPet, nextPet, nextWindow, previousOffset, nextOffset) => {
        this.windowManager?.setSizeAnchoredToPet(previousPet, nextPet, nextWindow, previousOffset, nextOffset);
      },
      notify: (payload) => this.ipcManager?.notifyBubble(payload),
    });

    this.trayManager = new TrayManager({
      config: this.config,
      logger: this.loggerFactory.create('TrayManager'),
      callbacks: {
        onToggleVisible: () => {
          const visible = this.windowManager?.toggle() ?? false;
          this.windowVisible = visible;
          this.refreshTray();
          return visible;
        },
        onShow: () => this.showPet(),
        onHide: () => this.hidePet(),
        onToggleBehavior: () => {
          this.behaviorsPausedByUser = !this.behaviorsPausedByUser;
          this.syncBehaviorPause();
          this.refreshTray();
          return this.behaviorPaused;
        },
        onReloadPlugins: () => {
          this.triggerPluginReload();
        },
        onResetAnimation: () => {
          this.ipcManager?.setAnimation('idle');
        },
        onPlayAnimation: (animationId) => {
          this.ipcManager?.setAnimation(animationId);
        },
        onShowBubble: (text) => {
          /* ready 交给控制器按"是否需要等测量"决定，这里随便给个值 */
          this.applyBubble({ visible: true, text, ready: false });
        },
        onHideBubble: () => {
          this.applyBubble(null);
        },
        onSetAlwaysOnTop: (value) => {
          this.applyAlwaysOnTop(value);
        },
        onSetDockOnEdge: (value) => {
          this.applyDockOnEdge(value);
        },
        onOpenSettings: () => this.settingsWindow?.open(),

        /* ------------------ AI 认知与人格（2.1~2.4） ------------------ */
        onOpenChat: () => {
          this.openChatWindow();
        },
        onSpeakUp: () => {
          this.expandForSpeech('tray-speak-up');
          void this.aiService?.speakUp('tray');
        },
        onWriteDiary: () => {
          void this.writeDiaryNow().catch((error: unknown) => {
            this.logger.warn('writing diary from tray failed', { error: describeError(error) });
          });
        },
        onOpenDiaryFolder: () => {
          this.openPath(this.aiService?.diaryService.dataDir ?? '');
        },
        onShowMemoryDigest: () => {
          this.expandForSpeech('tray-memory-digest');
          this.applyBubble({ visible: true, text: this.memoryDigest(), ready: false });
        },
        onToggleCollapsed: () => this.toggleCollapsed(),
        onResetEmotion: () => {
          this.aiService?.resetEmotion();
          this.refreshTray();
        },
        onOpenAISettings: () => this.settingsWindow?.open(),

        /* ------------------ 环境与用户感知（3.1~3.6） ------------------ */
        onLookScreen: (mode) => {
          void this.viewScreen(mode);
        },
        onTogglePrivacyMode: () => {
          // 这句确认也是"她开口"：收起/隐藏时先请回桌面再说
          this.expandForSpeech('tray-privacy-mode');
          const before = this.perception?.settings.privacyMode ?? false;
          const status = this.perception?.setSettings({ privacyMode: !before }) ?? this.perceptionStatus();
          this.applyBubble({
            visible: true,
            text: status.settings.privacyMode
              ? '好，我不看了（隐私模式已开启）。'
              : '隐私模式关掉了，我又可以陪着你了。',
            ready: false,
          });
          return status.settings.privacyMode;
        },
        onShowPerceptionDigest: () => {
          this.expandForSpeech('tray-perception-digest');
          this.applyBubble({ visible: true, text: this.perceptionDigest(), ready: false });
        },
        onOpenPerceptionLog: () => {
          this.openPath(this.perception?.logPath ?? '');
        },
        onSamplePerception: () => {
          // force = true：菜单点「立刻感知一次」就是要**现在**采一次，
          // 不能被采样节流挡掉（否则用户点了没反应，只有行为数字动了一下）
          void this.perception?.tick(Date.now(), true);
        },
        onToggleCameraConsent: () => {
          const authorized = this.perception?.settings.cameraAuthorized === true;
          this.perception?.authorizeCamera(!authorized);
          if (!authorized) this.ipcManager?.requestCameraFrame();
          return !authorized;
        },

        /* ------------------ 成长、记忆与反思（4.1 / 4.2） ------------------ */
        onShowPalaceDigest: () => {
          this.expandForSpeech('tray-palace-digest');
          this.applyBubble({ visible: true, text: this.growth?.digest() ?? '成长模块未就绪', ready: false });
        },
        onOpenPalaceFile: () => {
          this.openPath(this.growth?.palacePath ?? '');
        },
        onReflectNow: () => {
          this.expandForSpeech('tray-reflect-now');
          void this.growth?.reflectNow().then((entry) => {
            this.applyBubble({ visible: true, text: entry.body, ready: false });
            this.refreshTray();
          });
        },
        onResetGrowthPolicy: () => {
          this.growth?.resetPolicy();
          this.refreshTray();
        },
        onOpenGrowthSettings: () => this.settingsWindow?.open(),

        onQuit: () => this.quit(),
      },
    });
    this.trayManager.create();
    this.refreshTray();
  }

  /* ------------------------------------------------------------------ */
  /* 配置 / Manifest                                                     */
  /* ------------------------------------------------------------------ */

  private loadAnimationManifest(): void {
    const file = join(this.config.configPath, 'animations.json');
    if (!existsSync(file)) {
      this.logger.error('animation manifest missing; no animations available', { data: { file } });
      this.animationManifest = {};
      return;
    }
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const result = validateManifest(parsed);
      for (const issue of result.issues) {
        const log = issue.level === 'error' ? this.logger.error : this.logger.warn;
        log.call(this.logger, `Manifest 校验: ${issue.message}`, { data: { id: issue.id } });
      }
      this.animationManifest = manifestToRecord(result.animations) as AnimationManifest;
      this.logger.info('animation manifest loaded', {
        data: { file, animations: result.animations.size, fallback: result.fallbackId ?? '(none)' },
      });
    } catch (error) {
      // Manifest 损坏不能让主进程崩溃：记录并空载运行（renderer 会显示启动失败提示）
      this.logger.error('animation manifest parse failed', { error: describeError(error), data: { file } });
      this.animationManifest = {};
    }
  }

  /**
   * 读取显示状态与随机池配置（`assets/config/behavior.json`）。
   *
   * 缺文件 / 坏了都退回内置默认（与需求给定的池与间隔一致），
   * 因为"随机动画没了"属于静默失败，比"配置没读到"严重得多。
   */
  private loadBehaviorConfig(): void {
    const file = join(this.config.configPath, 'behavior.json');
    let parsed: unknown;
    if (existsSync(file)) {
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        this.logger.error('behavior config parse failed; using defaults', { error: describeError(error), data: { file } });
      }
    } else {
      this.logger.warn('behavior.json missing; using built-in defaults', { data: { file } });
    }
    const { config, issues } = parseBehaviorConfig(parsed);
    for (const issue of issues) {
      const log = issue.level === 'error' ? this.logger.error : this.logger.warn;
      log.call(this.logger, `behavior 配置: ${issue.message}`);
    }
    this.behaviorConfig = config;
    this.logger.info('behavior config loaded', {
      data: {
        file,
        states: Object.keys(config.states).length,
        pools: Object.keys(config.pools).length,
      },
    });
  }

  /**
   * 由素材宽高比 + 用户设定的 scale 计算窗口尺寸。
   *
   * 基准高度固定为 PET_BASE_HEIGHT(480)，实际高度 = 480 × scale，
   * 并受显示器工作区限制（超出时自动收敛）。详见 main/pet-size.ts。
   */
  private resolveWindowSize(): PetSizeInfo {
    if (!this.sizeInfo) {
      this.sizeInfo = resolvePetSize({
        requestedScale: this.settings.scale,
        aspectRatio: this.aspectRatio(),
        logger: this.logger,
      });
    }
    return this.sizeInfo;
  }

  /** 重新计算尺寸（scale 变化或显示器变化后调用）。 */
  private recomputeSize(): PetSizeInfo {
    this.sizeInfo = null;
    return this.resolveWindowSize();
  }

  /**
   * 素材宽高比：取 Manifest 里第一个 video 定义，查 media-meta.json 的分辨率。
   * 本项目素材为 834x1112 / 720x966，比例一致；查不到时使用兜底比例。
   */
  private aspectRatio(): number {
    const definitions = Object.values(this.animationManifest) as readonly AnimationDefinition[];
    const firstVideo = definitions.find((definition) => definition.type === 'video');
    const ratio = this.aspectRatioFromSource(firstVideo?.source);
    if (ratio === null) {
      this.logger.debug('media meta missing; using fallback aspect ratio', {
        data: { source: firstVideo?.source ?? '(no video)', fallback: FALLBACK_ASPECT_RATIO },
      });
      return FALLBACK_ASPECT_RATIO;
    }
    return ratio;
  }

  /** 从 sidecar 元数据文件（assets/config/media-meta.json）读取分辨率；缺省时返回 null。 */
  private aspectRatioFromSource(source: string | undefined): number | null {
    if (!source) return null;
    const name = source.split('/').pop() ?? '';
    const metaFile = join(this.config.configPath, 'media-meta.json');
    if (!existsSync(metaFile)) return null;
    try {
      const raw = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, { width?: number; height?: number }>;
      const entry = raw[name];
      if (!entry || typeof entry.width !== 'number' || typeof entry.height !== 'number' || entry.height === 0) {
        return null;
      }
      return entry.width / entry.height;
    } catch (error) {
      this.logger.warn('media-meta.json read failed; using fallback aspect ratio', { error: describeError(error) });
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 尺寸 / 设置                                                         */
  /* ------------------------------------------------------------------ */

  /** 当前尺寸 + 设置快照（IPC 与托盘共用）。 */
  private settingsState(): PetSettingsState {
    return {
      size: this.resolveWindowSize(),
      alwaysOnTop: this.settings.alwaysOnTop,
      dockOnEdge: this.settings.dockOnEdge,
    };
  }

  /**
   * 拖到边缘是否自动收起（`shared/dock.ts`）。
   *
   * 关掉后 `handleDragEnd` 不再判贴边（拖动就只是拖动），
   * 托盘/右键的「收起（贴边）」仍然可用 —— 那是用户显式要求的动作，
   * 与"手滑推到边缘"不是一回事。
   */
  private applyDockOnEdge(value: boolean): PetSettingsState {
    this.settings = this.settingsStore?.update({ dockOnEdge: value }) ?? { ...this.settings, dockOnEdge: value };
    this.logger.info('dock-on-edge setting updated', { data: { dockOnEdge: value } });
    // 关掉时顺手把"已经收起"的状态解开：否则她会一直贴着边，用户以为没生效
    if (!value && this.display.dock !== 'free') this.handleUndock();
    this.refreshTray();
    return this.settingsState();
  }

  /**
   * 应用缩放系数。
   *
   * 锚点策略：**默认尺寸中心不动**。
   * 早先用的是右下角锚点，但那是为"屏幕右下角的桌宠"设计的：
   * 一旦用户拖动滑块连续调尺寸，右下角锚点会让桌宠朝右下方向"爬"，
   * 放大到一定程度还会被窗口边界收敛挤回屏幕里 —— 表现为桌宠乱跑。
   * 以中心为锚点，桌宠在原地变大变小，符合"滚动条调大小"的直觉。
   */
  private applyScale(requested: number): PetSettingsState {
    const scale = clampPetScale(requested);
    const beforeSize = this.resolveWindowSize();
    // 用窗口实时位置而不是 selfTest 快照：滑块会连续调用，必须基于当前位置增量移动
    const before = this.windowManager?.getPosition() ?? { x: 0, y: 0 };

    this.settings = this.settingsStore?.update({ scale }) ?? { ...this.settings, scale };
    const size = this.recomputeSize();

    if (this.windowManager?.exists()) {
      this.windowManager.setSize(size.width, size.height, this.bubbleController?.getLayout().petBottomOffset ?? 0);
      const targetX = before.x + (beforeSize.width - size.width) / 2;
      const targetY = before.y + (beforeSize.height - size.height) / 2;
      this.windowManager.setPosition(targetX, targetY);
    }

    this.logger.info('pet size updated', {
      data: {
        requested,
        scale: size.scale,
        size: `${size.width}x${size.height}`,
        clampedByDisplay: size.clampedByDisplay,
      },
    });

    /*
     * 气泡要跟着宠物一起缩放：尺寸变了就重算气泡布局并再次调整窗口
     * （上面刚把窗口设成"纯宠物"尺寸，这里会在其基础上再叠上气泡）。
     */
    this.bubbleController?.onPetSizeChanged({ width: beforeSize.width, height: beforeSize.height });
    this.ipcManager?.notifySizeChanged(size);
    this.refreshTray();
    return this.settingsState();
  }

  private applyAlwaysOnTop(value: boolean): PetSettingsState {
    this.settings = this.settingsStore?.update({ alwaysOnTop: value }) ?? { ...this.settings, alwaysOnTop: value };
    this.windowManager?.setAlwaysOnTop(value);
    this.logger.info('always-on-top setting updated', { data: { alwaysOnTop: value } });
    this.refreshTray();
    return this.settingsState();
  }

  /**
   * 显示/隐藏对话气泡（`null` = 隐藏）。
   *
   * 气泡尺寸与窗口尺寸都在 `BubbleController` 里一体决策：
   * 气泡在宠物上方，桌宠窗口是按宠物裁剪的透明窗口，不放大窗口就会被裁掉。
   */
  private applyBubble(state: BubbleState | null): BubblePayload {
    const payload = state === null
      ? this.bubbleController?.hide()
      : this.bubbleController?.show(state.text);
    this.refreshTray();
    // 控制器缺失（极早调用）时返回一个保守的空布局，避免调用方拿到 null
    return payload ?? {
      state: { visible: false, text: '', ready: false },
      layout: resolveBubbleLayout({ petWidth: 1, petHeight: 1 }),
    };
  }

  private createRuntimeInfo(): RuntimeInfo {
    return {
      version: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      platform: process.platform,
      mode: this.mode,
      assetsPath: this.config.assetsPath,
      animationManifest: this.animationManifest,
      behaviorConfig: this.behaviorConfig,
      display: this.display,
    };
  }

  private createBootstrap(): PetBootstrap {
    const size = this.resolveWindowSize();
    const position = this.windowManager?.getPosition() ?? { x: 0, y: 0 };
    return {
      runtime: this.createRuntimeInfo(),
      plugins: this.pluginManager?.discoverPlugins() ?? [],
      window: { width: size.width, height: size.height, x: position.x, y: position.y },
      size,
      /*
       * 气泡状态随 bootstrap 一起下发：气泡可能在 Renderer 就绪前就已打开，
       * 只靠 IPC 推送会漏掉那一次。
       */
      ...(this.bubbleController ? { bubble: this.bubbleController.payload() } : {}),
      // 显示状态同理：可能启动时就已经是收起/隐藏
      display: this.display,
    };
  }

  private encodeBootstrapArg(bootstrap: PetBootstrap): string {
    const json = JSON.stringify(bootstrap);
    return `--pet-bootstrap=${Buffer.from(json, 'utf8').toString('base64')}`;
  }

  /* ------------------------------------------------------------------ */
  /* 窗口 / 托盘                                                         */
  /* ------------------------------------------------------------------ */

  private showPet(): void {
    this.windowManager?.show();
    this.windowVisible = true;
    // 隐藏是"显示状态"的一部分，必须一起改：否则渲染层仍以为自己被藏着，
    // 默认动画与随机池都不对。
    this.setDisplay({ hidden: false }, 'show-pet');
    this.refreshTray();
  }

  private hidePet(): void {
    this.windowManager?.hide();
    this.windowVisible = false;
    this.setDisplay({ hidden: true }, 'hide-pet');
    this.refreshTray();
  }

  /* ------------------------------------------------------------------ */
  /* 显示状态：收起（贴边）/ 隐藏                                         */
  /* ------------------------------------------------------------------ */

  /**
   * 主进程侧的显示状态（单一事实来源）。
   *
   * 为什么放在主进程：贴边判定要用工作区（`screen.workArea`）与窗口真实位置，
   * 只有主进程拿得到；渲染层只需要"在这个状态下默认播什么、随机池有哪些"。
   */
  private display: PetDisplayState = { ...DEFAULT_DISPLAY_STATE };
  /**
   * 最近一次"没贴边"时的窗口位置。
   *
   * 用途：点一下展开时回到这里。**不能**用"贴边前那一刻的位置" ——
   * 那一刻用户正把她往屏幕外拖（Windows 的边界收敛允许窗口只剩 60px 在屏内），
   * 回到那里等于"点一下反而更看不见了"（实测：点完只剩 60px 露在屏幕里）。
   * 因此只记"判定为没贴边"的位置：它一定在她好好待在桌面上的时候产生。
   */
  private lastFreePosition: WindowPosition | null = null;

  /**
   * 设置界面的"在场状态"入口（`ai:set-presence`）。
   *
   * 显示状态现在是**主进程**的事实来源，所以这里把三档映射成显示动作，
   * 而不是反过来直接改在场字段：
   *   visible   -> 展开（贴边则回到收起前的位置）
   *   collapsed -> 收起（贴最近的边）
   *   hidden    -> 隐藏窗口
   */
  private applyPresenceFromUI(presence: PetPresence): void {
    if (presence === 'hidden') {
      this.setDisplay({ hidden: true }, 'presence-api:hidden');
      return;
    }
    if (presence === 'collapsed') {
      if (this.display.hidden) this.setDisplay({ hidden: false }, 'presence-api:collapsed');
      // 幂等：已经是收起状态就什么都不做（"设为收起"不该把她展开）
      this.dockToNearestEdge();
      return;
    }
    if (this.display.hidden) this.setDisplay({ hidden: false }, 'presence-api:visible');
    if (this.display.dock !== 'free') this.handleUndock();
  }

  /**
   * 更新显示状态并广播给渲染层（不变则不广播，避免无谓的状态重置）。
   *
   * @param reason **谁**改的（`drag-end:dock` / `dock:nearest-edge` / `show-pet`…）。
   *   这个参数是为排查加的：显示状态牵动默认动画、随机池、在场状态与行为暂停，
   *   一旦出现"她自己突然收起来了"这类问题，日志里必须一眼看出是哪条路径干的。
   */
  private setDisplay(patch: Partial<PetDisplayState>, reason: string): PetDisplayState {
    const next: PetDisplayState = { ...this.display, ...patch };
    if (next.dock === this.display.dock && next.hidden === this.display.hidden) return this.display;
    const before = this.display;
    this.display = next;

    // 在场状态（情绪衰减三档）跟着显示状态走：收起 = 安静待着，隐藏 = 看不到主人
    const presence: PetPresence = next.hidden ? 'hidden' : next.dock === 'free' ? 'visible' : 'collapsed';
    this.applyPresence(presence);

    /*
     * 变安静（收起 / 隐藏）时**正在冒的泡也要收掉**（用户要求："收起时不应该发生对话"）。
     *
     * 只拦"新的开口"不够：她可能正说着话的时候被拖到边上，
     * 气泡会一直挂在屏幕边缘（实测：窗口被气泡撑到 396×330 挂在右边不动）。
     * 这里只处理"从能说话变成不能说话"这一跳 —— 展开时不会反过来乱冒泡。
     */
    if (isQuietDisplay(next) && !isQuietDisplay(before) && (this.bubbleController?.isVisible() ?? false)) {
      this.applyBubble(null);
      this.logger.info('bubble hidden: pet is collapsed or hidden now', {
        data: { reason, dock: next.dock, hidden: next.hidden },
      });
    }

    this.ipcManager?.notifyDisplayState(next);
    this.logger.info('pet display state changed', {
      data: {
        from: `${before.dock}${before.hidden ? '+hidden' : ''}`,
        to: `${next.dock}${next.hidden ? '+hidden' : ''}`,
        state: resolveDisplayState(next),
        reason,
      },
    });
    this.refreshTray();
    return next;
  }

  /** 当前宠物矩形（屏幕坐标）——贴边判定与"点击宠物"命中都用它。 */
  private petRectOnScreen(): Rect | null {
    const window = this.windowManager;
    if (!window?.exists()) return null;
    const size = this.resolveWindowSize();
    const bounds = window.describe();
    return petRectIn(
      { x: bounds.position.x, y: bounds.position.y, width: bounds.size.width, height: bounds.size.height },
      { width: size.width, height: size.height },
      this.bubbleController?.getLayout().petBottomOffset ?? 0,
    );
  }

  private workAreaRect(): Rect | null {
    try {
      const area = screen.getPrimaryDisplay().workArea;
      return { x: area.x, y: area.y, width: area.width, height: area.height };
    } catch (error) {
      this.logger.warn('reading work area failed; docking disabled this time', { error: describeError(error) });
      return null;
    }
  }

  /**
   * 拖拽结束：按最终位置决定是否收起（需求："拖动宠物放到最右边或者最下边时触发收起宠物状态"）。
   *
   * @returns 新的显示状态（渲染层据此换默认动画）
   */
  private handleDragEnd(): PetDisplayState {
    /*
     * 关掉"拖到边缘自动收起"时：拖动就只是拖动。
     * 顺手记下"她现在好好待在桌面上"的位置（点一下展开时要用）。
     */
    if (!this.settings.dockOnEdge) {
      if (this.display.dock !== 'free') return this.setDisplay({ dock: 'free' }, 'drag-end:disabled');
      this.lastFreePosition = this.windowManager?.getPosition() ?? this.lastFreePosition;
      return this.display;
    }

    const pet = this.petRectOnScreen();
    const area = this.workAreaRect();
    if (!pet || !area) return this.display;

    const evaluation = evaluateDock(pet, area);
    if (evaluation.dock === 'free') {
      // 放在中间 = 展开（拖动离开边缘即展开，与"点一下展开"是同一结果）
      this.lastFreePosition = this.windowManager?.getPosition() ?? this.lastFreePosition;
      return this.setDisplay({ dock: 'free' }, 'drag-end:free');
    }

    this.snapToDock(evaluation.dock);
    return this.setDisplay({ dock: evaluation.dock }, 'drag-end:dock');
  }

  /** 把宠物贴平到边缘（只挪窗口位置）。 */
  private snapToDock(dock: Exclude<PetDock, 'free'>): void {
    const window = this.windowManager;
    const area = this.workAreaRect();
    if (!window?.exists() || !area) return;
    const size = this.resolveWindowSize();
    const bounds = window.describe();
    const target = dockTargetPosition({
      dock,
      petSize: { width: size.width, height: size.height },
      windowSize: bounds.size,
      workArea: area,
      current: { x: bounds.position.x, y: bounds.position.y },
      petBottomOffset: this.bubbleController?.getLayout().petBottomOffset ?? 0,
    });
    window.setPosition(target.x, target.y);
  }

  /**
   * 收起状态下拖动窗口：拖离边缘就自动展开。
   *
   * 在每次 `setWindowPosition` 里顺手判定，而不是等松手 ——
   * "拖出来一半就恢复"比"松手才恢复"更跟手。
   */
  /** 收起（贴边）状态下拖动窗口：拖离边缘就自动展开。 */
  private checkUndockWhileDragging(): void {
    if (this.display.dock === 'free') return;
    const pet = this.petRectOnScreen();
    const area = this.workAreaRect();
    if (!pet || !area) return;
    if (!shouldUndock(this.display.dock, pet, area)) return;
    this.setDisplay({ dock: 'free' }, 'drag-away');
  }

  /** 请求展开（收起状态下点了宠物）：回到最近一次"好好待在桌面上"的位置。 */
  private handleUndock(): PetDisplayState {
    if (this.display.dock === 'free') return this.display;
    const dock = this.display.dock;
    const restore = this.lastFreePosition;
    const next = this.setDisplay({ dock: 'free' }, 'undock-request');
    /*
     * ⚠️ 位置**不在这里**改：她此刻正开始播默认姿势的收尾段（watch-end / sleep-end），
     * 需求要求"播 end 时不要移动位置"。所以只把目标坐标发给渲染层，
     * 由它在收尾段播完、新默认动画真正开始时才挪窗口（见 CommandMoveWhenSettled）。
     */
    const target = restore ?? this.nudgeTarget(dock);
    if (target) this.ipcManager?.moveWhenSettled({ x: target.x, y: target.y, reason: 'undock' });
    return next;
  }

  /** 没有"上次自由位置"可回退时（例如启动即收起）的兜底目标：从贴边位置往里挪一点。 */
  private nudgeTarget(dock: Exclude<PetDock, 'free'>): WindowPosition | null {
    const current = this.windowManager?.getPosition();
    if (!current) return null;
    return nudgeInward(dock, current);
  }

  private applyTrayState(state: TrayStatePayload): void {
    /*
     * ⚠️ **不**接受渲染层上报的 `behaviorPaused`。
     *
     * 暂停状态由主进程持有（托盘菜单改它、隐藏时它也参与），渲染层只是被通知方；
     * 早期实现把渲染层的值写回主进程，形成回路 —— 主进程刚暂停，
     * 渲染层下一条状态快照又把"未暂停"报回来，于是暂停时有时无。
     */
    if (state.currentAnimation !== undefined) this.currentAnimation = state.currentAnimation;
    if (typeof state.currentState === 'string') this.currentState = state.currentState;
    if (state.plugins) this.pluginRecords = state.plugins;
    // 尺寸与置顶以主进程为准：这里忽略 renderer 上报的同名字段，避免来回覆盖
    this.refreshTray();
  }

  private pluginRecords: readonly PluginRecord[] = [];

  private refreshTray(): void {
    this.trayManager?.updateState({
      visible: this.windowManager?.isVisible() ?? this.windowVisible,
      behaviorPaused: this.behaviorPaused,
      currentAnimation: this.currentAnimation,
      currentState: this.currentState as TrayStatePayload['currentState'],
      // 显示状态（收起方向）也要给菜单：它决定显示"收起（贴边）"还是"展开"
      display: this.display,
      plugins: this.pluginRecords,
      // 尺寸与置顶由主进程自己持有，不需要 renderer 上报
      size: this.resolveWindowSize(),
      alwaysOnTop: this.settings.alwaysOnTop,
      // 「播放动画」菜单需要全部动画清单，主进程自己解析 Manifest 即可
      animations: this.animationSummaries(),
      // 「AI（认知与人格）」子菜单需要状态与在场状态（心情会随心跳变化）
      ai: this.aiStatus(),
      presence: this.presence,
      // 「感知（环境与用户）」子菜单需要当前场景/打扰次数/隐私模式
      perception: this.perceptionStatus(),
      // 「成长与记忆」子菜单需要记忆节点数、今天的反思与当前策略
      growth: this.growthStatus(),
    });
  }

  /**
   * 动画清单（供托盘/右键菜单的「播放动画」子菜单）。
   *
   * 列出 Manifest 中**全部**动画：这样菜单本身就是一份"动画总览"，
   * 方便逐个点开测试（新增动画只需要改 Manifest，菜单自动跟着变）。
   * 排序：优先级从高到低，方便先看到反应类动画。
   */
  private animationSummaries(): AnimationSummary[] {
    return (Object.values(this.animationManifest) as readonly AnimationDefinition[])
      .map((definition) => ({
        id: definition.id,
        label: definition.label ?? definition.id,
        priority: definition.priority ?? 0,
        loop: definition.loop === true,
        type: definition.type,
      }))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }

  private triggerPluginReload(): void {
    this.logger.info('plugin reload requested');
    try {
      // 重新发现（会重读 plugins.json），把新清单放进 bootstrap，再让 renderer 重载
      const discovered = this.pluginManager?.discoverPlugins() ?? [];
      if (this.bootstrapData) {
        this.bootstrapData = { ...this.bootstrapData, plugins: discovered };
      }
      this.ipcManager?.requestPluginReload();
      this.pluginRecords = this.pluginManager?.getLoadedPlugins() ?? [];
      this.refreshTray();
    } catch (error) {
      this.logger.error('plugin reload failed', { error: describeError(error) });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Renderer 上报                                                       */
  /* ------------------------------------------------------------------ */

  private handleRendererLog(payload: LogPayload): void {
    // 使用统一格式输出到主进程终端（这样 main/renderer 日志在同一处可读）
    const entry: LogEntry = {
      level: payload.level,
      module: payload.module,
      message: payload.message,
      ...(payload.event !== undefined ? { fields: { event: payload.event, data: payload.data } } : {}),
      line: '',
    };
    this.loggerFactory.create(payload.module)[payload.level](payload.message, {
      ...(payload.event !== undefined ? { event: payload.event } : {}),
      ...(payload.data !== undefined ? { data: payload.data } : {}),
    });
    this.pendingLogs.push(entry);
    if (this.pendingLogs.length > 200) this.pendingLogs.shift();
  }

  private handleAnimationChanged(payload: AnimationChangedPayload): void {
    this.currentAnimation = payload.animationId;
    this.refreshTray();
  }

  private handleStateChanged(payload: StateChangedPayload): void {
    this.currentState = payload.to;
    this.refreshTray();
  }

  /**
   * Renderer 也可以发 Action（例如未来设置界面）。
   * 第一版统一转成指令再回到 renderer 执行，保证 Action Pipeline 只有一条。
   */
  private handleRendererAction(action: PetAction): void {
    this.logger.debug('action submitted by renderer', { data: { type: action.type } });
    this.ipcManager?.sendAction(action);
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期 / 退出                                                     */
  /* ------------------------------------------------------------------ */

  public quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.logger.info('shutting down');
    // AI 侧要收尾：停心跳/日记定时器，并把情绪写盘（下次打开接着掉）
    this.aiService?.dispose();
    // 感知侧要收尾：停采样与摄像头请求（摄像头句柄由渲染层随窗口销毁释放）
    this.perception?.dispose();
    // 成长侧要收尾：停反思定时器（记忆与策略都已落盘）
    this.growth?.dispose();
    this.windowManager?.markQuitting();
    this.ipcManager?.notifyShutdown();
    this.settingsWindow?.destroy();
    this.chatWindow?.destroy();
    this.trayManager?.destroy();
    this.ipcManager?.unregister();

    // 给 renderer 一点时间收尾，然后退出
    setTimeout(() => {
      this.windowManager?.destroy();
      this.settingsWindow?.destroy();
      this.chatWindow?.destroy();
      app.exit(0);
    }, 120);
  }

  public requestQuit(): void {
    this.quit();
  }

  /** 单实例场景下把桌宠显示出来（第二次启动时调用）。 */
  public focusPet(): void {
    this.showPet();
  }

  /** 进程级异常兜底：记录 + 提示，绝不静默崩溃。 */
  private wireProcessGuards(): void {
    process.on('uncaughtException', (error) => {
      this.logger.error('uncaught exception (main process continues)', { error: describeError(error) });
    });
    process.on('unhandledRejection', (reason) => {
      this.logger.error('unhandled promise rejection', { error: describeError(reason) });
    });
    app.on('render-process-gone', (_event, _contents, details) => {
      this.logger.error('renderer process gone', { error: details.reason, data: { exitCode: details.exitCode } });
    });
    app.on('child-process-gone', (_event, details) => {
      this.logger.error('child process gone', { error: details.reason, data: { type: details.type } });
    });
  }

  /** 启动自检信息（--self-test 时输出）。 */
  public selfTest(): Record<string, unknown> {
    return {
      mode: this.mode,
      appRoot: this.config.appRoot,
      distPath: this.config.distPath,
      assetsPath: this.config.assetsPath,
      assetsExists: existsSync(this.config.assetsPath),
      configPath: this.config.configPath,
      animations: Object.keys(this.animationManifest).length,
      pluginsPath: this.config.pluginsPath,
      pluginsExists: existsSync(this.config.pluginsPath),
      discoveredPlugins: this.pluginManager?.discoverPlugins().map((plugin) => plugin.id) ?? [],
      // 默认尺寸恰好等于 834x1112 素材按 480 高度缩放的结果（360），
      // 因此额外打印推导用的比例，避免"看起来像兜底值"的误判
      windowRatio: this.aspectRatioFromSource(
        (Object.values(this.animationManifest) as readonly AnimationDefinition[]).find(
          (definition) => definition.type === 'video',
        )?.source,
      ),
      windowSize: this.resolveWindowSize(),
      windowActual: this.windowManager?.describe() ?? null,
      compiledPluginsPath: this.config.compiledPluginsPath,
      pluginsCompiled: existsSync(this.config.compiledPluginsPath),
      preload: join(this.config.distPath, 'preload', 'preload.js'),
      preloadExists: existsSync(join(this.config.distPath, 'preload', 'preload.js')),
      renderer: join(this.config.distPath, 'renderer', 'index.html'),
      rendererExists: existsSync(join(this.config.distPath, 'renderer', 'index.html')),
      settingsRenderer: this.config.settingsHtmlPath,
      settingsRendererExists: existsSync(this.config.settingsHtmlPath),
      chatRenderer: this.config.chatHtmlPath,
      chatRendererExists: existsSync(this.config.chatHtmlPath),
      userData: app.getPath('userData'),
      // AI 认知与人格（2.1~2.4）：自检里带上关键路径与开关，便于排查"为什么她不理我"
      ai: this.aiStatus(),
      aiSettingsFile: join(app.getPath('userData'), 'ai-settings.json'),
      aiMemoryDir: join(app.getPath('userData'), 'memory'),
      aiDiaryDir: join(app.getPath('userData'), 'diary'),
      // 环境与用户感知（3.1~3.6）：开关状态与数据目录
      perception: this.perceptionStatus(),
      perceptionSettingsFile: join(app.getPath('userData'), 'perception-settings.json'),
      perceptionDir: join(app.getPath('userData'), 'perception'),
      // 成长、记忆与反思（4.1/4.2）
      growth: this.growthStatus(),
      growthSettingsFile: join(app.getPath('userData'), 'growth-settings.json'),
      memoryNodesFile: join(app.getPath('userData'), 'memory', 'nodes.json'),
      reflectionDir: join(app.getPath('userData'), 'reflection'),
    };
  }

  /** 把自检结果写入日志与控制台（打包后的 GUI 进程也能留痕）。 */
  public selfTestReport(): void {
    const report = this.selfTest();
    this.logger.info('SELF_TEST=' + JSON.stringify(report));
    console.log('SELF_TEST=' + JSON.stringify(report));
  }
}

/* -------------------------------------------------------------------------- */
/* 模块级兜底                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * AI 数据目录（记忆 / 日记 / 配置 / 情绪）。
 *
 * 默认是 `%APPDATA%\DesktopPet`；环境变量 `DESKTOP_PET_AI_DATA_DIR` 可以改到
 * 别处 —— 自动化验收靠它把测试数据隔离到临时目录，不污染用户真实的记忆。
 */
function aiDataDir(): string {
  const override = process.env.DESKTOP_PET_AI_DATA_DIR;
  if (typeof override === 'string' && override.trim() !== '') return override;
  return app.getPath('userData');
}

/**
 * "捂住眼睛躲起来"持续多久后自动回来（毫秒）。
 *
 * 取 20 秒：足够表达"我不看"，又不至于让用户以为她崩了。
 * 期间用户从托盘点「显示桌宠」会更早回来（定时器里会检查当前状态）。
 */
const SELF_HIDE_MS = 20000;

/**
 * AI 服务尚未装配时的兜底回复。
 *
 * 为什么不在 IPC 层抛异常：桌宠的所有能力都必须是"可降级"的 ——
 * 聊天窗口在极端时序下（服务还没起来）点发送，用户应该看到一句人话，
 * 而不是一个红色报错。
 */
function localChatFallback(reason: string): {
  ok: false;
  reply: string;
  mode: 'local';
  tokens: number;
  error: string;
  mood: number;
  hunger: number;
} {
  return { ok: false, reply: '我还没准备好……等我一下下。', mode: 'local', tokens: 0, error: reason, mood: 62, hunger: 0 };
}

function emptyMemorySnapshot(): {  profile: { userName: string; petName: string; facts: never[]; summary: string; updatedAt: string };
  todayEvents: never[];
  recentChat: never[];
  logFile: string;
  dataDir: string;
  stats: { events: number; turns: number; facts: number };
} {
  return {
    profile: { userName: '', petName: '', facts: [], summary: '', updatedAt: '' },
    todayEvents: [],
    recentChat: [],
    logFile: '',
    dataDir: '',
    stats: { events: 0, turns: 0, facts: 0 },
  };
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

/*
 * 统一应用名与 userData 目录 —— 必须早于任何 `app.getPath('userData')`。
 *
 * 两个坑（都实测过）：
 * 1. 未打包且未设置 name 时 Electron 用 "Electron" 作为应用名；
 * 2. **`app.setName()` 不会改变已经解析过的 userData 路径** ——
 *    实测 setName 之后 `getPath('userData')` 仍是 `%APPDATA%\Electron`。
 *
 * 因此这里显式 setPath：开发模式把 userData 固定到 `%APPDATA%\DesktopPet`，
 * 保证"手工启动"与"自动化验收"读到的是同一份日志，也保证文档里写的路径是真的。
 * 打包后 productName 已是 DesktopPet，Electron 给的路径本来就正确，无需干预。
 */
app.setName('DesktopPet');
{
  const defaultUserData = app.getPath('userData');
  // 仅当 Electron 用的是（未命名的）默认目录时才纠正
  if (/(\\|\/)Electron$/.test(defaultUserData)) {
    const appData = app.getPath('appData');
    app.setPath('userData', join(appData, 'DesktopPet'));
  }
}

const devMode = process.argv.includes('--dev') || !app.isPackaged;
const isSelfTest = process.argv.includes('--self-test');

/**
 * 启动时把**这一版是什么时候构建的**打进日志。
 *
 * 为什么需要（真实踩过）：桌宠带单实例锁 —— 已经有一个在跑时，`npm start` 起的新进程
 * 会**静默退出**（退出码 0，什么都不打印），跑着的还是旧代码。用户改了东西却"看不到效果"
 * 时，这条 `build:` 日志是第一件要核对的事：它比"我觉得我重启了"可靠。
 */
function logBuildStamp(): void {
  try {
    // 注意：main 被打包成 dist/main/main.js，所以构建戳在**上一级**目录
    const info = JSON.parse(readFileSync(join(__dirname, '..', 'build-info.json'), 'utf8')) as { builtAt?: unknown };
    const builtAt = typeof info.builtAt === 'string' ? info.builtAt : 'unknown';
    console.log(`[Main] build: ${builtAt}（dist/build-info.json）`);
  } catch (error) {
    // 打包产物里可能没有这个文件：不影响启动，只提示"无法判断版本"
    console.log('[Main] build: unknown（读不到 dist/build-info.json）');
  }
}

// 单实例锁：桌宠只需要一个（第二次启动时把已存在的桌宠显示出来）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  registerAssetScheme();

  const application = new DesktopPetApplication(devMode);

  app.on('second-instance', () => {
    // 第二次启动：把已存在的桌宠显示出来，而不是开第二个实例
    application.focusPet();
  });

  app.whenReady().then(async () => {
    try {
      logBuildStamp();
      application.bootstrap();
      if (isSelfTest) {
        // 自检模式：输出关键信息后退出，便于 CI / 手工验收。
        // 走 Logger（而不是只 console.log），这样打包后的 GUI 进程也能留下证据。
        application.selfTestReport();
        app.exit(0);
        return;
      }
      await application.onReady();
    } catch (error) {
      const message = describeError(error);
      console.error('[Main] startup failed', message);
      dialog.showErrorBox('桌宠启动失败', message);
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => {
    // 桌宠驻留托盘：关闭窗口不退出程序
    // 只有显式退出（托盘菜单/quit）才会结束进程
  });

  app.on('before-quit', () => {
    application.requestQuit();
  });
}

