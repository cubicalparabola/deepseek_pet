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
import { registerAssetProtocolHandler, registerAssetScheme } from './asset-protocol';
import { AIService } from './ai/ai-service';
import { ChatWindowManager } from './chat-window-manager';
import { IpcManager } from './ipc-manager';
import { PluginManager } from './plugin-manager';
import { TrayManager } from './tray-manager';
import { WindowManager } from './window-manager';
import { BubbleController } from './bubble-controller';

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
  /** 环境与用户感知（3.1~3.6）：屏幕/内容理解/行为/摄像头/习惯。 */
  private perception: PerceptionService | null = null;
  private chatWindow: ChatWindowManager | null = null;
  /** 桌宠"在不在场"（影响情绪衰减与是否接收点击）。 */
  private presence: PetPresence = 'visible';
  /** "捂住眼睛躲起来"后的自动恢复定时器（见 handleIntervention）。 */
  private revealTimer: NodeJS.Timeout | null = null;

  private animationManifest: AnimationManifest = {};
  private bootstrapData: PetBootstrap | null = null;
  private settingsStore: SettingsStore | null = null;
  private settings: PetSettings = { ...DEFAULT_PET_SETTINGS };
  private sizeInfo: PetSizeInfo | null = null;
  private quitting = false;
  private readonly pendingLogs: LogEntry[] = [];
  private behaviorPaused = false;
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

    this.bootstrapData = this.createBootstrap();

    this.ipcManager = new IpcManager({
      logger: this.loggerFactory.create('IpcManager'),
      getRuntimeInfo: () => this.bootstrapData?.runtime ?? this.createRuntimeInfo(),
      getBootstrap: () => this.bootstrapData ?? this.createBootstrap(),
      getSettingsState: () => this.settingsState(),
      setScale: (scale) => this.applyScale(scale),
      setAlwaysOnTop: (value) => this.applyAlwaysOnTop(value),
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
      setWindowPosition: (x, y) => this.windowManager?.setPosition(x, y) ?? { x, y },
      getWindowPosition: () => this.windowManager?.getPosition() ?? { x: 0, y: 0 },
      setWindowSize: (width, height) => this.windowManager?.setSize(width, height),
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
        this.behaviorPaused = paused;
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
      aiChat: async (text) => this.aiService?.chat(text, 'chat-window') ?? localChatFallback('AI 模块未就绪'),
      aiSpeakUp: async () => this.aiService?.speakUp('tray') ?? localChatFallback('AI 模块未就绪'),
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
      aiInteraction: (kind) => this.aiService?.notifyInteraction(kind),
      aiResetEmotion: () => this.aiService?.resetEmotion() ?? this.aiStatus(),
      aiSetPresence: (presence) => {
        this.setPresence(presence);
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
      perceptionCameraFrame: (dataUrl) => {
        void this.perception?.ingestCameraFrame(dataUrl);
      },
      perceptionCameraReady: (ready, error) => this.perception?.setCameraReady(ready, error),
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
      onStatus: (status) => this.ipcManager?.notifyPerceptionStatus(status),
      requestCameraFrame: () => this.ipcManager?.requestCameraFrame(),
      onSettingsChanged: (settings) => this.applyCapturePrivacy(settings),
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
  private handleIntervention(plan: { text: string; animation: string | null; hide: boolean }, reason: string): void {
    this.logger.info('perception intervention', { data: { reason, text: plan.text.slice(0, 40) } });
    if (plan.text.trim() !== '') {
      this.applyBubble({ visible: true, text: plan.text, ready: false });
    }
    if (plan.animation) {
      this.ipcManager?.setAnimation(plan.animation);
    }
    if (plan.hide) {
      /*
       * "捂住眼睛躲起来"：把桌宠藏起来一小会儿。
       *
       * ⚠️ 必须有**自动恢复**：早期版本只 hide 不 restore，她会一直藏着直到用户
       * 自己去托盘点「显示桌宠」—— 用户会以为她崩了（文档评审抓到）。
       * 这里 20 秒后自动回来；期间用户手动显示过就不再干预。
       */
      this.setPresence('hidden');
      if (this.revealTimer !== null) clearTimeout(this.revealTimer);
      this.revealTimer = setTimeout(() => {
        this.revealTimer = null;
        if (this.presence === 'hidden') {
          this.logger.info('pet reveals itself after hiding for sensitive content');
          this.setPresence('visible');
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
      dataDir: aiDataDir(),
      lastError: '',
    };
  }

  /** 3.2 按需看屏幕：结果同时进气泡与聊天窗口（和 AI 回复走同一套展示）。 */
  private async viewScreen(mode: PerceptionViewMode): Promise<void> {
    if (!this.perception) return;
    const result = await this.perception.viewNow(mode);
    const prefix = mode === 'scene' ? '' : `【${viewModeLabel(mode)}】\n`;
    this.handleSpeak({ text: `${prefix}${result.text}`, animation: this.animationForScene(result.scene), kind: 'reply' });
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
  private handleSpeak(request: { text: string; animation: string | null; kind: string; level?: 'info' | 'warn' | 'error' }): void {
    if (request.text.trim() !== '') {
      this.applyBubble({ visible: true, text: request.text, ready: false });
    }
    if (request.animation) {
      this.ipcManager?.setAnimation(request.animation);
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
    this.applyBubble({ visible: true, text: entry.body, ready: false });
    this.refreshTray();
    return entry;
  }

  /**
   * 切换"收起（不打扰）"。
   *
   * 收起的语义（与 2.3 的衰减三档一致）：
   * - 她还在屏幕上，但**整窗点击穿透**，不接收任何点击/拖动；
   * - 行为暂停（不会自己跳动画打扰你）；
   * - 情绪衰减加快（1.0/分钟，隐藏是 2.2）。
   */
  private toggleCollapsed(): boolean {
    const next: PetPresence = this.presence === 'collapsed' ? 'visible' : 'collapsed';
    this.setPresence(next);
    return next === 'collapsed';
  }

  private setPresence(presence: PetPresence): void {
    if (presence === this.presence) return;
    const wasCollapsed = this.presence === 'collapsed';
    this.presence = presence;

    if (presence === 'hidden') {
      this.windowManager?.hide();
      this.windowVisible = false;
    } else {
      this.windowManager?.show();
      this.windowVisible = true;
    }

    const collapsed = presence === 'collapsed';
    this.windowManager?.setIgnoreMouseEvents(collapsed, true);
    if (collapsed !== wasCollapsed) {
      this.behaviorPaused = collapsed;
      this.ipcManager?.setBehaviorPaused(collapsed);
    }

    this.aiService?.setPresence(presence);
    this.aiService?.recordEvent('presence', presence === 'collapsed' ? '收起（不打扰）' : presence === 'hidden' ? '隐藏桌宠' : '展开桌宠');
    this.logger.info('pet presence changed', { data: { presence } });
    this.refreshTray();
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
          this.behaviorPaused = !this.behaviorPaused;
          this.ipcManager?.setBehaviorPaused(this.behaviorPaused);
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
        onOpenSettings: () => this.settingsWindow?.open(),

        /* ------------------ AI 认知与人格（2.1~2.4） ------------------ */
        onOpenChat: () => {
          this.openChatWindow();
        },
        onSpeakUp: () => {
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
    };
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
    this.refreshTray();
  }

  private hidePet(): void {
    this.windowManager?.hide();
    this.windowVisible = false;
    this.refreshTray();
  }

  private applyTrayState(state: TrayStatePayload): void {
    if (typeof state.behaviorPaused === 'boolean') this.behaviorPaused = state.behaviorPaused;
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

