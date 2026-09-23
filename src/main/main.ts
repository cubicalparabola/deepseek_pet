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

import { app, dialog } from 'electron';
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
import { registerAssetProtocolHandler, registerAssetScheme } from './asset-protocol';
import { IpcManager } from './ipc-manager';
import { PluginManager } from './plugin-manager';
import { TrayManager } from './tray-manager';
import { WindowManager } from './window-manager';

class DesktopPetApplication {
  private config!: PetConfig;
  private loggerFactory!: LoggerFactory;
  private logger!: Logger;

  private windowManager: WindowManager | null = null;
  private trayManager: TrayManager | null = null;
  private settingsWindow: SettingsWindowManager | null = null;
  private ipcManager: IpcManager | null = null;
  private pluginManager: PluginManager | null = null;

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

    this.bootstrapData = this.createBootstrap();

    this.ipcManager = new IpcManager({
      logger: this.loggerFactory.create('IpcManager'),
      getRuntimeInfo: () => this.bootstrapData?.runtime ?? this.createRuntimeInfo(),
      getBootstrap: () => this.bootstrapData ?? this.createBootstrap(),
      getSettingsState: () => this.settingsState(),
      setScale: (scale) => this.applyScale(scale),
      setAlwaysOnTop: (value) => this.applyAlwaysOnTop(value),
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
    });
    this.ipcManager.register();
    this.ipcManager.setSenderProvider(() => this.windowManager?.getWindow() ?? null);

    this.createWindow();
    this.createTray();
    this.createSettingsWindow();

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
    });
  }

  private createTray(): void {
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
        onSetAlwaysOnTop: (value) => {
          this.applyAlwaysOnTop(value);
        },
        onOpenSettings: () => this.settingsWindow?.open(),
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
      this.windowManager.setSize(size.width, size.height);
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
    this.windowManager?.markQuitting();
    this.ipcManager?.notifyShutdown();
    this.settingsWindow?.destroy();
    this.trayManager?.destroy();
    this.ipcManager?.unregister();

    // 给 renderer 一点时间收尾，然后退出
    setTimeout(() => {
      this.windowManager?.destroy();
      this.settingsWindow?.destroy();
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
      userData: app.getPath('userData'),
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
