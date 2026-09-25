/**
 * 感知服务（3.1~3.6 的中枢）—— 采样、理解、决策、干预。
 *
 * 决策链严格按需求 3.4 的四步走：
 *
 *   环境观察   tick() 每 captureIntervalMs 截一帧 -> VisionAnalyzer.analyzeScene
 *      ↓
 *   状态推测   BehaviorSnapshot（空闲秒数 / 连续使用 / 切换次数 / 深夜）
 *      ↓
 *   判断是否干预 planIntervention(...) -> gateIntervention(...)（频率闸门）
 *      ↓
 *   选择行为表达 onIntervene(plan)：说什么、演哪个动画、要不要躲起来
 *
 * 两条"没有大模型也要能用"的降级路径（本地信号不依赖任何网络）：
 * - **连续使用过久**：`powerMonitor` 的空闲时间 + 会话计时；
 * - **深夜提醒**：本地时间。
 * 也就是说：没配密钥时她依然会提醒你起来活动、早点睡，只是看不懂你在干什么。
 *
 * 隐私三闸（见 perception-types 的文件头）在本文件的具体落点：
 * - `capturePermission()` 在每次采样前判定，隐私模式/开关关闭直接不动摄像头与屏幕；
 * - 图像只在 `tick()` 内部活一次（传完就丢），`ObservationStore` 只收文本；
 * - `cameraAuthorized` 未授权时**从不请求帧**（渲染层也就不会打开摄像头）。
 */

import { powerMonitor } from 'electron';
import { readFileSync } from 'node:fs';
import type {
  BehaviorSnapshot,
  CameraFrameResult,
  HabitProfile,
  PerceptionLogItem,
  PerceptionSettings,
  PerceptionSettingsPatch,
  PerceptionStatus,
  PerceptionViewMode,
  PerceptionViewResult,
  PresenceState,
  SceneKind,
  ScreenObservation,
} from '../../shared/perception-types';
import {
  buildBehaviorSnapshot,
  capturePermission,
  emptyHabitProfile,
  gateIntervention,
  habitPredictionText,
  isPlanEnabled,
  isSensitive,
  learnHabit,
  planIntervention,
  refineSceneByWindow,
  sceneLabel,
  topSceneAtHour,
  describeWindowContext,
  withoutOwnWindows,
  type InterventionPlan,
} from '../../shared/perception';
import type { PolicyOverlay } from '../../shared/growth-types';
import { defaultPolicyOverlay } from '../../shared/growth';
import { clampOverlay, describePolicy, effectivePerception } from '../../shared/growth';
import type { LLMClient } from '../ai/llm-client';
import { LLMError } from '../ai/llm-client';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import { ObservationStore, localDay } from './observation-store';
import { PerceptionSettingsStore } from './settings-store';
import { ScreenCapture } from './screen-capture';
import { VisionAnalyzer } from './vision';
import { WindowContextProbe } from './window-context';

export interface PerceptionServiceOptions {
  /** 数据根目录（`%APPDATA%\DesktopPet`）。 */
  readonly dataDir: string;
  readonly logger: Logger;
  /** 视觉能力来自 AI 模块的同一个客户端（配置热更新立即生效）。 */
  readonly getClient: () => LLMClient | null;
  /** 大模型是否可用（没密钥时只跑本地行为信号）。 */
  readonly isLLMUsable: () => boolean;
  /** 当前存在的动画 id（挑不出对应动画就返回 null）。 */
  readonly getAvailableAnimations: () => readonly string[];
  /** 决策落地：说话 + 动画 + （敏感内容）躲起来。 */
  readonly onIntervene: (plan: InterventionPlan, reason: string) => void;
  readonly onStatus?: (status: PerceptionStatus) => void;
  /** 向渲染层要一帧摄像头画面（由渲染层 getUserMedia 采集后回传）。 */
  readonly requestCameraFrame?: () => void;
  /** 隐私模式变化 / 开关变化时的副作用（例如内容保护、行为暂停）。 */
  readonly onSettingsChanged?: (settings: PerceptionSettings) => void;
}

/** 内存里保留的观察条数（用于切换频率统计）。 */
const OBSERVATION_MEMORY = 120;

/**
 * 摄像头失败后的退避时间（5 分钟）。
 *
 * 不永久放弃、也不立刻重试：设备被占用往往几十秒就恢复，
 * 但每秒重试会刷日志、还会反复触发系统权限提示。
 */
const CAMERA_RETRY_MS = 5 * 60000;

export class PerceptionService {
  private readonly options: PerceptionServiceOptions;
  private readonly logger: Logger;
  private readonly settingsStore: PerceptionSettingsStore;
  private readonly store: ObservationStore;
  private readonly capture: ScreenCapture;
  private readonly vision: VisionAnalyzer;
  /** 窗口上下文（"开着什么 / 最上层是哪个"）。 */
  private readonly windows: WindowContextProbe;

  private timer: NodeJS.Timeout | null = null;
  private cameraTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastObservation: ScreenObservation | null = null;
  private observations: ScreenObservation[] = [];
  private behavior: BehaviorSnapshot;
  private presence: PresenceState;
  private habits: HabitProfile = emptyHabitProfile();
  private sessionStartedAt = Date.now();
  private lastIntervention: PerceptionStatus['lastIntervention'] = null;
  private interventionTimes: number[] = [];
  private lastError = '';
  /** 最近一次真的截到"窗口特写"的尺寸与时间（状态里给面板/验收看）。 */
  private lastCloseUp: PerceptionStatus['lastCloseUp'] = null;
  private cameraReady = false;
  /** 摄像头上次失败的时间（0 = 没失败过）；失败后按 CAMERA_RETRY_MS 退避重试。 */
  private cameraFailedAt = 0;
  private cameraBusy = false;
  private lastPauseReason = '';
  /** 上次真正采样的时间（节流用；0 = 还没采过）。 */
  private lastCaptureAt = 0;
  private powerHooked = false;

  public constructor(options: PerceptionServiceOptions) {
    this.options = options;
    this.logger = options.logger;
    this.settingsStore = new PerceptionSettingsStore({ dataDir: options.dataDir, logger: options.logger });
    this.store = new ObservationStore({ dataDir: options.dataDir, logger: options.logger });
    this.capture = new ScreenCapture({ logger: options.logger, getSettings: () => this.settings });
    this.vision = new VisionAnalyzer({
      getClient: options.getClient,
      logger: options.logger,
      getSensitiveKeywords: () => this.settings.sensitivityKeywords,
      getSceneFixes: () => this.settings.sceneFixes,
      storeFullUrl: () => this.settings.storeFullUrl,
      getForegroundWindow: () => this.windows.current()?.foreground ?? null,
    });
    this.windows = new WindowContextProbe({
      logger: options.logger,
      isEnabled: () => this.settings.windowContext && !this.settings.privacyMode,
      ttlMs: this.settings.windowProbeTtlMs,
    });
    this.behavior = buildBehaviorSnapshot({
      idleSeconds: 0,
      sessionStartedAt: this.sessionStartedAt,
      observations: [],
      now: Date.now(),
      settings: this.settings,
    });
    this.presence = { present: true, source: 'unknown', at: new Date().toISOString() };
  }

  public get settings(): PerceptionSettings {
    return this.settingsStore.get();
  }

  /**
   * 4.2 反思得出的**行为策略叠加层**（只能收紧，见 shared/growth.ts 的 clampOverlay）。
   *
   * 为什么不直接改用户设置：用户的配置是"上限/底线"，反思只在她允许的范围内
   * 变得更克制。因此这里另存一份 overlay，所有决策走 `effectiveSettings()`。
   */
  private policyOverlay: PolicyOverlay = defaultPolicyOverlay();

  /** 主进程在成长模块调整策略后调它（立即生效，不需要重启）。 */
  public setPolicyOverlay(overlay: PolicyOverlay): void {
    this.policyOverlay = clampOverlay(overlay);
    const before = this.lastEffectiveKey;
    const after = this.effectiveKey();
    if (before !== after) {
      this.lastEffectiveKey = after;
      this.store.log('system', `行为策略已更新：${describePolicy(this.settings, this.policyOverlay)}`);
      this.logger.info('perception policy overlay updated', {
        data: {
          minFactor: this.policyOverlay.minIntervalFactor,
          maxFactor: this.policyOverlay.maxPerHourFactor,
          scenes: Object.keys(this.policyOverlay.sceneFactors).length,
        },
      });
    }
    this.emitStatus();
  }

  /** 当前场景下**实际生效**的设置（用户设置 + 策略叠加层）。 */
  public effectiveSettings(): PerceptionSettings {
    return effectivePerception(this.settings, this.policyOverlay, this.lastObservation?.scene ?? 'other');
  }

  /** 叠加层是否需要重新计算（场景变化或策略变化时）。 */
  private effectiveKey(): string {
    return `${this.policyOverlay.updatedAt}|${this.lastObservation?.scene ?? 'other'}|${this.policyOverlay.adjustments}`;
  }

  private lastEffectiveKey = '';

  public get observationDir(): string {
    return this.store.dataDir;
  }

  public get logPath(): string {
    return this.store.logPath;
  }

  /** 某个日期的观察记录（成长模块统计场景分布用）。 */
  public observationsOn(date: string): readonly ScreenObservation[] {
    // 今天的记录在内存里（还没落盘的也算），历史日期读文件
    if (date === localDay()) return this.observations;
    return this.store.readObservations(date);
  }

  /**
   * 没模型时的降级观察：只凭最上层窗口的进程名 + 标题判断场景。
   *
   * 返回 null 表示"认不出来"（那就**不记观察**，宁可不写也不要写一条 other 污染习惯统计）。
   */
  private localObservationFromWindow(now: number): ScreenObservation | null {
    const foreground = this.windows.current()?.foreground ?? null;
    if (!foreground) return null;
    const refined = refineSceneByWindow({ process: foreground.process, title: foreground.title, scene: 'other' });
    if (refined.reason === '' || refined.scene === 'other') return null;
    return {
      at: new Date(now).toISOString(),
      scene: refined.scene,
      // 进程名当应用名（没有视觉模型时这是最接近"在用哪个应用"的信息）
      app: foreground.process.slice(0, 60),
      activity: refined.reason.slice(0, 120),
      sensitive: false,
      // 本地路径只有窗口标题，**看不见画面内容**：内容一律不落（readable=false 的含义）
      readable: false,
      focus: 'unknown',
      summary: '',
      suggestion: '',
      mode: 'local',
      tokens: 0,
      windowTitle: foreground.title.slice(0, 120),
    };
  }

  /**
   * 窗口上下文 -> 提示词文本（并把快照留给 `refineScene`/状态用）。
   *
   * 窗口列表会**过滤掉我们自己的窗口**（设置窗口、聊天窗口）：它们的标题
   * （"桌宠设置"）混进去只会干扰判断，而且它们常常正好是前台窗口。
   */
  private async windowContextText(force = false): Promise<string | null> {
    if (!this.settings.windowContext || this.settings.privacyMode) return null;
    const snapshot = await this.windows.probe(force);
    if (!snapshot) return null;
    return describeWindowContext({
      foreground: snapshot.foreground,
      windows: withoutOwnWindows(snapshot.windows),
      limit: this.settings.windowListLimit,
    });
  }

  /** 习惯采样总数（成长模块判断"养成的习惯"用）。 */
  public habitSamples(): number {
    return this.habits.samples;
  }

  /**
   * 让桌宠与设置/聊天窗口"不进任何截屏/录屏"（Windows 的内容保护）。
   *
   * 由主进程在感知设置变化时调用：窗口的生命周期属于主进程，
   * 感知服务只负责"该不该隐藏"这个判断（见 settings.hideFromCapture）。
   */
  public applyContentProtection(windows: readonly Electron.BrowserWindow[], enabled: boolean): void {
    this.capture.applyContentProtection(windows, enabled);
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  public load(): void {
    this.settingsStore.load();
    this.habits = this.store.load();
    this.hookPowerMonitor();
    this.logger.info('perception ready', {
      data: {
        screen: this.settings.screen,
        camera: this.settings.camera,
        cameraAuthorized: this.settings.cameraAuthorized,
        intervalMs: this.settings.captureIntervalMs,
        habitSamples: this.habits.samples,
      },
    });
    this.store.log('system', '感知模块已加载');
    this.options.onSettingsChanged?.(this.settings);
  }

  /** 启动采样循环（桌宠启动时调用一次）。 */
  public start(): void {
    if (this.running) return;
    this.running = true;
    this.sessionStartedAt = Date.now();
    /*
     * ⚠️ 心跳周期与"采样间隔"是两件事。
     *
     * `tick()` 只负责"到点了就看看"，真正的节流在 tick 内部按 `captureIntervalMs` 判断。
     * 心跳固定取一个较短的周期（最多 30s），这样：
     * - 用户把间隔调成 5 分钟时，心跳仍然 30s 一次（只更新行为快照，不截屏）；
     * - 用户把间隔调成 10s 时，心跳也能跟得上。
     *
     * 早期版本直接用 `captureIntervalMs / 2` 当心跳周期，于是默认 30000 变成**每 15 秒截一帧**，
     * token 成本翻倍、面板提示的"默认 30000"与实际不符（文档评审抓到）。
     */
    const tickMs = Math.max(5000, Math.min(30000, this.settings.captureIntervalMs));
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.warn('perception tick failed', { error: describeError(error) });
      });
    }, tickMs);
    this.timer.unref?.();

    this.cameraTimer = setInterval(() => this.requestCameraFrame(), Math.max(10000, this.settings.cameraIntervalMs));
    this.cameraTimer.unref?.();
    this.logger.info('perception loop started', { data: { tickMs, captureIntervalMs: this.settings.captureIntervalMs } });
  }

  public dispose(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.cameraTimer) clearInterval(this.cameraTimer);
    this.cameraTimer = null;
    this.store.log('system', '感知模块已停止');
  }

  /* ------------------------------------------------------------------ */
  /* 配置                                                                */
  /* ------------------------------------------------------------------ */

  public setSettings(patch: PerceptionSettingsPatch): PerceptionStatus {
    const before = this.settings;
    const after = this.settingsStore.update(patch);

    if (patch.privacyMode !== undefined && patch.privacyMode !== before.privacyMode) {
      this.store.log('privacy', after.privacyMode ? '隐私模式已开启（停止一切采集）' : '隐私模式已关闭（恢复采集）');
      this.logger.info('privacy mode changed', { data: { on: after.privacyMode } });
    }
    if (patch.cameraAuthorized === true && before.cameraAuthorized !== true) {
      this.store.log('camera', '用户已授权摄像头');
      this.logger.info('camera authorized by user');
    }
    if (patch.cameraAuthorized === false && before.cameraAuthorized === true) {
      this.store.log('camera', '用户已撤销摄像头授权');
      this.cameraReady = false;
    }
    this.options.onSettingsChanged?.(after);
    this.emitStatus();
    return this.status();
  }

  /** 摄像头授权（只能由界面上的显式按钮置为 true）。 */
  public authorizeCamera(authorized: boolean): PerceptionStatus {
    return this.setSettings({ cameraAuthorized: authorized });
  }

  /** 渲染层报告摄像头是否就绪（getUserMedia 成功/失败）。 */
  public setCameraReady(ready: boolean, error = '', now: number = Date.now()): void {
    this.cameraReady = ready;
    if (ready) {
      this.cameraFailedAt = 0;
      this.store.log('camera', '摄像头已就绪（帧只用于当次分析，不落盘）');
    } else {
      // 记下失败时刻：`requestCameraFrame` 据此做退避重试，而不是永久放弃
      this.cameraFailedAt = now;
      if (error !== '') {
        this.lastError = `摄像头不可用：${error}（${Math.round(CAMERA_RETRY_MS / 60000)} 分钟后会自动重试）`;
        this.store.log('camera', `摄像头不可用：${error}`);
      }
    }
    this.emitStatus();
  }

  /* ------------------------------------------------------------------ */
  /* 采样                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 一次采样（公开给验收/手动触发；定时器与"看屏幕"都走它）。
   *
   * @param force true = 忽略采样间隔（手动"立刻感知一次"用）
   */
  public async tick(now: number = Date.now(), force = false): Promise<PerceptionStatus> {
    const permission = capturePermission(this.settings);
    if (!permission.allowed) {
      if (this.lastPauseReason !== permission.reason) {
        this.lastPauseReason = permission.reason;
        this.logger.debug('perception paused', { data: { reason: permission.reason } });
      }
      this.refreshBehavior(now);
      this.emitStatus();
      return this.status();
    }
    this.lastPauseReason = '';

    // 节流：真正的采样频率由 captureIntervalMs 决定（心跳只是"来看看"）
    if (!force && this.lastCaptureAt > 0 && now - this.lastCaptureAt < this.settings.captureIntervalMs) {
      this.refreshBehavior(now);
      this.emitStatus();
      return this.status();
    }
    this.lastCaptureAt = now;

    // 长时间空闲后重新开始计时（"离开过"就不算连续使用）
    const idleSeconds = this.idleSeconds();
    if (idleSeconds >= 600) this.sessionStartedAt = now;

    const llmUsable = this.options.isLLMUsable();
    let observation: ScreenObservation | null = null;

    /*
     * 窗口上下文**独立于大模型**先取一次。
     *
     * 为什么不能放在 `if (llmUsable)` 里：窗口信息本来是纯本地的
     * （一次 Windows 枚举），没配密钥时也拿得到 ——
     * 面板要能显示"她现在看到的是什么窗口"，而且它能支撑**无需模型**的粗粒度场景判断
     * （见下面的本地降级路径）。早期版本把它塞进 LLM 分支，导致没密钥时这一路完全不工作。
     */
    const windowContext = await this.windowContextText();

    if (llmUsable) {
      const frame = await this.capture.grab();
      if (frame) {
        // 地址栏横条：与整屏同一轮截取，只为让模型读出网址（读不到就整条不传）
        const addressBar = await this.capture.grabAddressBar();
        /*
         * 最上层窗口的**特写**：终端/编辑器整屏都是文字，整屏缩到 640 宽读不出来，
         * 模型就只好猜（用户实测："终端里在跑什么"她瞎说）。按原分辨率补一张窗口特写，
         * 文字才真的可读；拿不准的内容她不许回答（见 vision 的 contentReadable 闸门）。
         */
        const closeUp = await this.capture.grabWindowCloseUp(this.windows.current()?.foregroundRect ?? null);
        if (closeUp) this.lastCloseUp = { at: new Date(now).toISOString(), width: closeUp.width, height: closeUp.height };
        const analysis = await this.vision.analyzeScene(frame.dataBase64, frame.mimeType, addressBar, windowContext, closeUp);
        if (analysis) {
          observation = analysis.observation;
          this.lastObservation = observation;
          this.observations.push(observation);
          if (this.observations.length > OBSERVATION_MEMORY) this.observations.shift();
          const label =
            `${sceneLabel(observation.scene)}${observation.app ? `（${observation.app}）` : ''}` +
            `${observation.url ? ` ${observation.url}` : ''}` +
            `${observation.sensitive ? ' · 判定为私人内容' : ''}` +
            `${observation.readable ? '' : ' · 内容未看清（只做分类）'}`;
          this.store.recordObservation(observation, label);
          if (this.settings.habits) {
            this.habits = learnHabit(this.habits, observation);
            this.store.saveHabits(this.habits);
          }
          this.lastError = '';
        } else {
          this.lastError = '场景分析失败（模型不可用或返回异常）';
        }
      } else {
        this.lastError = '截屏失败（桌面捕获不可用）';
      }
    } else {
      /*
       * 没模型时的**本地降级**：只凭"最上层窗口的进程名 + 标题"判断场景。
       *
       * 这一路完全离线：`Typora` -> 写东西、`Code` -> 写代码、标题带 `.pdf` -> 读论文…
       * 因此没配密钥时习惯统计与"她在做什么"也能有基本信号，
       * 而不是功能全哑（只是精度不如视觉模型）。
       */
      observation = this.localObservationFromWindow(now);
      if (observation) {
        this.lastObservation = observation;
        this.observations.push(observation);
        if (this.observations.length > OBSERVATION_MEMORY) this.observations.shift();
        this.store.recordObservation(observation, `${sceneLabel(observation.scene)}（仅窗口信息）`);
        if (this.settings.habits) {
          this.habits = learnHabit(this.habits, observation);
          this.store.saveHabits(this.habits);
        }
      }
      this.lastError = '';
    }

    this.refreshBehavior(now);
    /*
     * 干预只走**模型判定的那一路**（`observation.mode === 'llm'`）。
     *
     * 为什么本地降级不主动开口：离线路径只凭窗口标题猜场景（"标题里有 Code 就当写代码"），
     * 猜错了就会冒出一句莫名其妙的"主人开始写代码了" —— 主动开口是用户可见的行为，
     * 只应该建立在更可靠的证据上。
     * 本地观察仍然**记录**（喂习惯统计/状态/日志），而"久坐/深夜"这类**行为信号**
     * 不依赖模型（传 null 也照样会触发），所以没密钥时她依然会提醒你休息。
     */
    this.decide(observation && observation.mode === 'llm' ? observation : null, now);
    this.emitStatus();
    return this.status();
  }

  /**
   * 手动"看屏幕"。
   *
   * 3.2 只保留「看我在做什么（场景）」这一个动作：读屏幕文字 / 总结内容 / 看报错 /
   * 看代码这四个内容理解动作已按用户要求删除。因此这里的门槛就是**屏幕感知**本身
   * （`capturePermission` 已经涵盖隐私模式与 screen 开关），不再有单独的内容理解开关。
   */
  public async viewNow(mode: PerceptionViewMode): Promise<PerceptionViewResult> {
    const permission = capturePermission(this.settings);
    if (!permission.allowed) {
      return { ok: false, mode, text: `现在不能看屏幕：${permission.reason}`, scene: 'other', sensitive: false, tokens: 0, error: 'paused' };
    }
    /*
     * 没接上大模型时给一句**温柔**的话，而不是把 HTTP 层的报错甩给用户。
     * 这条必须在截图之前判断：既省一次没意义的截屏，也避免日志里刷 "未配置 API Key"。
     */
    if (!this.options.isLLMUsable()) {
      return { ok: false, mode, text: '我还没接上大模型，看不懂屏幕内容（去设置里填个密钥就行）。', scene: 'other', sensitive: false, tokens: 0, error: 'no-llm' };
    }
    const frame = await this.capture.grab();
    if (!frame) {
      return { ok: false, mode, text: '截屏失败了，可能被系统或安全软件拦住了。', scene: 'other', sensitive: false, tokens: 0, error: 'capture-failed' };
    }
    this.store.log('observation', `用户请求「${viewModeLabel(mode)}」`);
    /*
     * 按需看屏幕也带上地址栏横条：知道"在哪个网站"能让她说准"你在做什么"。
     * 放在"确认能用大模型"之后取，避免白截一张图。
     */
    const addressBar = await this.capture.grabAddressBar();
    // 按需"立刻看一次"要拿最新的窗口信息（并顺手刷新缓存）
    const windowContext = await this.windowContextText(true);
    // 与周期采样同一条证据：最上层窗口的原分辨率特写（终端里的字靠它才读得清）
    const closeUp = await this.capture.grabWindowCloseUp(this.windows.current()?.foregroundRect ?? null);
    if (closeUp) this.lastCloseUp = { at: new Date().toISOString(), width: closeUp.width, height: closeUp.height };
    const result = await this.vision.view(mode, frame.dataBase64, frame.mimeType, addressBar, windowContext, closeUp);
    if (result.ok) {
      this.store.log('observation', `「${viewModeLabel(mode)}」结果：${result.text.slice(0, 80)}`);
    }
    this.emitStatus();
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* 摄像头（3.5）                                                        */
  /* ------------------------------------------------------------------ */

  /** 向渲染层要一帧（未授权/未开启/隐私模式时什么都不做）。 */
  public requestCameraFrame(now: number = Date.now()): void {
    if (!this.settings.camera || !this.settings.cameraAuthorized) return;
    if (this.settings.privacyMode) return;
    if (this.cameraBusy) return;
    /*
     * 摄像头失败后**允许重试**（例如设备被占用一会儿、或者用户刚插回来）。
     *
     * 早期版本是"失败就把 cameraReady 置假，之后再也不请求" —— 用户得重新授权一次
     * 才能恢复，体验很差（文档评审抓到）。现在改成：失败后等 5 分钟再试一次，
     * 期间不刷请求（渲染层也会把相同的错误去重）。
     */
    if (this.cameraFailedAt > 0 && now - this.cameraFailedAt < CAMERA_RETRY_MS) return;
    // 人明显不在（空闲很久）时不必开摄像头 —— 省电也省心
    if (this.idleSeconds() >= 1200) return;
    this.cameraBusy = true;
    try {
      this.options.requestCameraFrame?.();
    } catch (error) {
      this.cameraBusy = false;
      this.logger.warn('requesting camera frame failed', { error: describeError(error) });
      return;
    }
    // 渲染层没回帧时解锁，避免一次失败把摄像头永久卡住
    setTimeout(() => {
      this.cameraBusy = false;
    }, 15000).unref?.();
  }

  /** 渲染层回传一帧（base64 JPEG；不带 data URL 前缀也行）。 */
  public async ingestCameraFrame(dataUrl: string): Promise<CameraFrameResult | null> {
    this.cameraBusy = false;
    if (!this.settings.camera || !this.settings.cameraAuthorized || this.settings.privacyMode) return null;
    const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
    if (base64.length < 64) return null;

    const result = await this.vision.analyzeCamera(base64);
    const now = Date.now();
    const previousPresent = this.presence.present;

    if (result.ok) {
      this.presence = {
        present: result.present,
        source: 'camera',
        at: new Date(now).toISOString(),
        ...(result.expression ? { expression: result.expression } : {}),
        stranger: result.stranger,
      };
      this.store.log('camera', `在场=${result.present} 表情="${result.expression}" 姿态="${result.posture}"${result.stranger ? ' · 检测到陌生人' : ''}`);

      if (result.stranger) {
        this.interveneIfAllowed(
          {
            kind: 'stranger',
            text: '主人，画面里好像有别人……我先躲一下。',
            animation: 'peek',
            hide: true,
          },
          now,
        );
      } else if (!previousPresent && result.present) {
        this.interveneIfAllowed({ kind: 'presence', text: '你回来啦！', animation: 'cute', hide: false }, now);
      } else if (previousPresent && !result.present) {
        this.interveneIfAllowed({ kind: 'presence', text: '主人不在呀……我在这儿等你。', animation: 'lie', hide: false }, now);
      }
    } else {
      // 没有模型：用"收到帧"当成"人在"（真正的判断交给空闲时间）
      this.presence = { present: true, source: 'idle', at: new Date(now).toISOString() };
      if (result.error !== 'no-llm') this.lastError = `摄像头分析失败：${result.error}`;
    }
    this.emitStatus();
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* 状态 / 日志                                                         */
  /* ------------------------------------------------------------------ */

  public status(now: number = Date.now()): PerceptionStatus {
    const permission = capturePermission(this.settings);
    this.refreshBehavior(now, false);
    const hour = new Date(now).getHours();
    return {
      settings: this.settings,
      capturing: permission.allowed && (this.settings.screen || this.settings.camera),
      pausedReason: permission.allowed ? '' : permission.reason,
      lastObservation: this.lastObservation,
      behavior: this.behavior,
      presence: this.presence,
      habits: {
        samples: this.habits.samples,
        activeDays: this.habits.activeDays,
        latestActiveHour: this.habits.latestActiveHour,
        earliestActiveHour: this.habits.earliestActiveHour,
        typicalNow: this.settings.habits ? topSceneAtHour(this.habits, hour) : null,
      },
      lastIntervention: this.lastIntervention,
      interventionsToday: this.interventionTimes.filter((at) => localDay(new Date(at)) === localDay(new Date(now))).length,
      cameraReady: this.cameraReady && this.settings.cameraAuthorized && this.settings.camera,
      windowContext: (() => {
        const snapshot = this.windows.current();
        const list = snapshot ? withoutOwnWindows(snapshot.windows) : [];
        return {
          count: list.length,
          foregroundTitle: snapshot?.foreground?.title ?? '',
          foregroundProcess: snapshot?.foreground?.process ?? '',
          sample: list.slice(0, 5).map((item) => `${item.title}（${item.process || '未知'}）`),
          foregroundRect: snapshot?.foregroundRect ?? null,
          backingOff: this.windows.backingOff,
        };
      })(),
      lastCloseUp: this.lastCloseUp,
      dataDir: this.store.dataDir,
      lastError: this.lastError,
    };
  }

  /**
   * 感知日志（可审计："她看见了什么、为什么开口"）。
   *
   * 两路合并：
   * - **内存**里最近的观察与最近一次干预（含完整的原因文字，比文件里更详细）；
   * - **文件** `perception-log.md` 的尾部 —— 这样重启之后日志依然查得到
   *   （用户真正会去看的是这份文件，UI 只是它的一个视图）。
   */
  public log(limit = 60): PerceptionLogItem[] {
    const items: PerceptionLogItem[] = [];
    for (const observation of this.observations.slice(-Math.max(1, limit))) {
      items.push({
        at: observation.at,
        kind: 'observation',
        text: `${sceneLabel(observation.scene)}${observation.app ? `（${observation.app}）` : ''} ${observation.activity}${observation.readable ? '' : '（内容未看清）'}`.trim(),
      });
    }
    if (this.lastIntervention) {
      items.push({
        at: this.lastIntervention.at,
        kind: 'intervention',
        text: `${this.lastIntervention.text}（原因：${this.lastIntervention.reason}）`,
      });
    }
    const permission = capturePermission(this.settings);
    if (!permission.allowed) items.push({ at: new Date().toISOString(), kind: 'privacy', text: permission.reason });

    for (const item of this.readLogFile(limit)) items.push(item);

    // 去重（内存与文件里会有同一条）+ 按时间倒序
    const seen = new Set<string>();
    const merged: PerceptionLogItem[] = [];
    for (const item of items.sort((a, b) => b.at.localeCompare(a.at))) {
      const key = `${item.at}|${item.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= limit) break;
    }
    return merged;
  }

  /** 读感知日志文件的尾部（`- HH:MM · [kind] text`）。 */
  private readLogFile(limit: number): PerceptionLogItem[] {
    try {
      const raw = readFileSync(this.store.logPath, 'utf8');
      const lines = raw.split('\n').filter((line) => line.startsWith('- '));
      const day = localDay();
      return lines.slice(-limit).map((line) => {
        const matched = /^- (\d{2}:\d{2}) · \[([a-z]+)\] (.*)$/.exec(line);
        const time = matched?.[1] ?? '00:00';
        const kind = (matched?.[2] ?? 'system') as PerceptionLogItem['kind'];
        return {
          at: `${day}T${time}:00.000Z`,
          kind,
          text: (matched?.[3] ?? line.slice(2)).slice(0, 200),
        };
      });
    } catch {
      return [];
    }
  }

  public clearData(): PerceptionStatus {
    this.observations = [];
    this.lastObservation = null;
    this.habits = emptyHabitProfile();
    this.store.clear();
    this.logger.info('perception data cleared by user');
    this.emitStatus();
    return this.status();
  }

  public describe(): string {
    const status = this.status();
    return [
      `capturing=${status.capturing}${status.pausedReason ? `(${status.pausedReason})` : ''}`,
      `idle=${status.behavior.idleSeconds}s session=${status.behavior.sessionMinutes}min switches=${status.behavior.switchesLastHour} state=${status.behavior.userState}`,
      `scene=${status.lastObservation?.scene ?? '-'} habits=${status.habits.samples}`,
      `interventions today=${status.interventionsToday}`,
    ].join(' · ');
  }

  /* ------------------------------------------------------------------ */
  /* 内部                                                                */
  /* ------------------------------------------------------------------ */

  /** 干预的统一出口：**开关归属检查** + 频率闸门 + 记录 + 回调。 */
  private decide(observation: ScreenObservation | null, now: number): void {
    if (!this.settings.behavior && !this.settings.habits) return;
    const plan = planIntervention({
      observation,
      behavior: this.behavior,
      settings: this.settings,
      previousScene: this.previousScene(observation),
      habitText: this.settings.habits ? habitPredictionText({ profile: this.habits, now, settings: this.settings, behavior: this.behavior }) : null,
    });
    if (!plan) return;
    this.interveneIfAllowed(plan, now);
  }

  /**
   * 这一条干预是否属于"已打开的那个子系统"（规则在 shared/perception.ts 的
   * `isPlanEnabled` 里，纯函数、可被验收直接断言）。
   */
  private isPlanEnabled(kind: InterventionPlan['kind']): boolean {
    return isPlanEnabled(kind, this.settings);
  }

  /**
   * 过一遍闸门再开口。
   *
   * 摄像头路径（在场/陌生人）也必须走这里：`stranger`/`sensitive` 是紧急类，
   * 会跳过"最小间隔/每小时上限"，但仍然保留 60 秒硬下限 —— 否则"躲"这个动作可能被刷屏。
   */
  private interveneIfAllowed(plan: InterventionPlan, now: number): void {
    if (!this.isPlanEnabled(plan.kind)) {
      this.logger.debug('intervention skipped: owning switch is off', { data: { kind: plan.kind } });
      return;
    }
    /*
     * 频率闸门用**实际生效的设置**（用户设置 + 反思策略叠加层）：
     * 这是 4.2 的"Behavior Update"真正起作用的地方 ——
     * 她反思后变得更克制，体现在这里的间隔与上限上。
     */
    const effective = this.effectiveSettings();
    const decision = gateIntervention({
      now,
      kind: plan.kind,
      settings: effective,
      lastInterventionAt: this.lastIntervention ? Date.parse(this.lastIntervention.at) : 0,
      lastHourCount: this.interventionTimes.filter((at) => now - at < 3600000).length,
      behavior: this.behavior,
    });
    if (!decision.allow) {
      this.logger.debug('intervention suppressed', { data: { kind: plan.kind, reason: decision.reason } });
      this.store.log('intervention', `放弃开口（${plan.kind}）：${decision.reason}`);
      return;
    }
    this.intervene(plan, decision.reason, now);
  }

  private intervene(plan: InterventionPlan, reason: string, now: number): void {
    this.lastIntervention = { at: new Date(now).toISOString(), kind: plan.kind, reason, text: plan.text };
    this.interventionTimes.push(now);
    if (this.interventionTimes.length > 200) this.interventionTimes.shift();
    this.store.log('intervention', `开口（${plan.kind}）：${plan.text} · 通过：${reason}`);
    this.logger.info('perception intervention', { data: { kind: plan.kind, reason } });
    try {
      this.options.onIntervene(plan, reason);
    } catch (error) {
      this.logger.warn('intervention handler failed', { error: describeError(error) });
    }
  }

  /** 上一个"非空"场景（用于判断场景变化）。 */
  private previousScene(observation: ScreenObservation | null): SceneKind | null {
    if (!observation) return null;
    for (let index = this.observations.length - 2; index >= 0; index -= 1) {
      const item = this.observations[index];
      if (item && item.at !== observation.at) return item.scene;
    }
    return null;
  }

  private refreshBehavior(now: number, withIdle = true): void {
    const idleSeconds = withIdle ? this.idleSeconds() : this.behavior.idleSeconds;
    this.behavior = buildBehaviorSnapshot({
      idleSeconds,
      sessionStartedAt: this.sessionStartedAt,
      observations: this.observations,
      now,
      settings: this.settings,
    });
  }

  private idleSeconds(): number {
    try {
      return Math.max(0, powerMonitor.getSystemIdleTime());
    } catch {
      return 0;
    }
  }

  /**
   * 挂在电源/锁屏事件上：
   * - 锁屏/休眠 = 用户离开 -> 立刻更新在场状态并记日志；
   * - 解锁 = 回来 -> 交由下一次摄像头采样或空闲时间自然恢复。
   */
  private hookPowerMonitor(): void {
    if (this.powerHooked) return;
    this.powerHooked = true;
    const mark = (present: boolean, text: string): void => {
      this.presence = { present, source: 'idle', at: new Date().toISOString() };
      this.sessionStartedAt = Date.now();
      this.store.log('presence', text);
      this.emitStatus();
    };
    try {
      powerMonitor.on('lock-screen', () => mark(false, '屏幕已锁定（用户离开）'));
      powerMonitor.on('unlock-screen', () => mark(true, '屏幕已解锁（用户回来）'));
      powerMonitor.on('suspend', () => mark(false, '系统休眠'));
      powerMonitor.on('resume', () => mark(true, '系统唤醒'));
    } catch (error) {
      this.logger.warn('hooking power monitor failed', { error: describeError(error) });
    }
  }

  private emitStatus(): void {
    try {
      this.options.onStatus?.(this.status());
    } catch (error) {
      this.logger.warn('perception onStatus failed', { error: describeError(error) });
    }
  }
}

/** 3.2 动作的中文名（日志与日志文件里用）。 */
export function viewModeLabel(_mode: PerceptionViewMode): string {
  return '看我在做什么（场景）';
}

/** 供日志/调试：把 LLM 错误翻译成一句话。 */
export function describeVisionError(error: unknown): string {
  return error instanceof LLMError ? error.message : describeError(error);
}

/** 供 main 判断"现在能不能真的截图"（例如窗口隐藏时不必采）。 */
export function canCapture(settings: PerceptionSettings): boolean {
  return capturePermission(settings).allowed;
}

/** 敏感内容命中时的处理提示（供 main 决定是否要窗口躲起来）。 */
export function shouldHideForObservation(observation: ScreenObservation | null, settings: PerceptionSettings): boolean {
  return observation !== null && isSensitive(observation, settings.sensitivityKeywords);
}
