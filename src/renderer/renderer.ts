/**
 * renderer.ts —— Renderer 的组合根（composition root）。
 *
 * 这里是唯一允许「把各模块拼起来」的地方：
 *   1. 建立 EventBus / Logger / RuntimeCapabilities（能力来自 preload，而不是 Node）；
 *   2. 建立各 Manager（Animation / State / Action / Behavior / Interaction / Plugin）；
 *   3. 把管理器之间的事件接线集中在这一处 —— 管理器彼此不 import，避免循环依赖；
 *   4. 处理 main 进程下发的指令与系统级事件。
 *
 * 本文件刻意保持“薄”：业务逻辑都在 core/ 下，避免变成“上帝文件”。
 */

import { validateManifest } from '../shared/animation-config';
import { PetEvents, type PetClickPayload } from '../shared/events';
import { describeError } from '../shared/errors';
import type { PetAction } from '../shared/action-types';
import type { DiscoveredPlugin } from '../shared/plugin-types';
import type { PetState } from '../shared/state-types';
import type { RuntimeInfo } from '../shared/ipc';
import type { PetSizeInfo } from '../shared/pet-size';
import { resolveBubbleLayout, type BubblePayload } from '../shared/bubble';
import {
  EMOTION,
  applyInteraction,
  applyTokens,
  decayEmotion,
  hungerFromTokens,
  initialEmotion,
  moodLabel,
} from '../shared/emotion';
import type { AIChatReply, AIStatusView, InteractionKind } from '../shared/ai-types';
import type { PerceptionStatus } from '../shared/perception-types';
import { DEFAULT_PERCEPTION_SETTINGS } from '../shared/perception-types';
import type { GrowthStatus } from '../shared/growth-types';
import { NODE_KINDS, POLICY_MIN_FACTOR } from '../shared/growth-types';
import {
  applyInsights,
  clampOverlay,
  defaultPolicyOverlay,
  describePolicy,
  effectivePerception,
  groupByMonth,
  heuristicInsights,
  mergeNodes,
  nodeId,
  nodeLabel,
  parseReflection,
  responseStats,
  sceneName,
  suggestNodes,
} from '../shared/growth';
import {
  BROWSER_APPS,
  TERMINAL_PROCESSES,
  URL_SCENE_RULES,
  appKind,
  capturePermission,
  describeWindowContext,
  emptyHabitProfile,
  gateIntervention,
  habitPredictionText,
  inferUserState,
  isLateNight,
  isPlanEnabled,
  isQuietHour,
  isSensitive,
  isTerminalProcess,
  isUrlLike,
  learnHabit,
  matchesAppName,
  matchesSensitiveKeywords,
  normalizeScene,
  normalizeWindowTitle,
  parseSceneFixes,
  planIntervention,
  redactTerminalSecrets,
  refineScene,
  refineSceneByUrl,
  refineSceneByWindow,
  safeHost,
  sceneLabel,
  stripAnsiEscape,
  tailTerminalText,
  topSceneAtHour,
  withoutOwnWindows,
} from '../shared/perception';
import { createLoggerFactory } from '../shared/logging';
import { EventBus } from './core/event-bus';
import { AnimationManager } from './core/animation-manager';
import { StateMachine } from './core/state-machine';
import { ActionManager } from './core/action-manager';
import { BehaviorManager } from './core/behavior-manager';
import { InteractionManager, type InteractionIntent, type PetRegion } from './core/interaction-manager';
import { PluginHost } from './core/plugin-host';
import { PetLayers } from './core/layers';
import { BubbleView } from './core/bubble-view';
import { RuntimeCapabilities, readBridge } from './core/runtime';
import { CameraSensor } from './core/camera-sensor';

/**
 * 区域 -> 互动动画（第一版默认映射；插件可用更高的 Action 覆盖）。
 * 抚摸类反应统一用 `stroke`（原先的 `touch` 已合并进来）。
 */
const REGION_ANIMATIONS: Readonly<Record<PetRegion, string>> = {
  head: 'cute',
  face: 'cute',
  ear: 'fawning',
  body: 'stroke',
  belly: 'stroke',
  skirt: 'fawning',
  legs: 'stroke',
  tail: 'fawning',
  outside: 'stroke',
};

/** preload 注入的启动数据（避免 renderer 启动时再往返一次 IPC）。 */
interface BootstrapPayload {
  readonly runtime: RuntimeInfo;
  readonly plugins: readonly DiscoveredPlugin[];
  readonly window: { readonly width: number; readonly height: number; readonly x: number; readonly y: number };
  readonly size?: PetSizeInfo;
  /** 当前对话气泡状态与布局（可能在 Renderer 就绪前就已打开）。 */
  readonly bubble?: BubblePayload;
}

function readBootstrap(): BootstrapPayload | null {
  const injected = (window as unknown as { petBootstrap?: BootstrapPayload }).petBootstrap;
  return injected ?? null;
}

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少必需的 DOM 元素: #${id}（index.html 与 renderer 不匹配）`);
  return element as T;
}

class PetApplication {
  private readonly stage: HTMLElement;
  private readonly layers: PetLayers;
  private readonly bubble: BubbleView;
  private readonly runtime: RuntimeCapabilities;
  private readonly loggerFactory = createLoggerFactory({ level: 'debug' });
  private readonly logger = this.loggerFactory.create('App');
  private readonly eventBus: EventBus;
  private readonly animationManager: AnimationManager;
  private readonly stateMachine: StateMachine;
  private readonly actionManager: ActionManager;
  private readonly behaviorManager: BehaviorManager;
  private readonly interactionManager: InteractionManager;
  private readonly pluginHost: PluginHost;
  /** 摄像头采集（3.5）：只在主进程要求时采一帧并回传。 */
  private readonly cameraSensor: CameraSensor;

  private plugins: readonly DiscoveredPlugin[] = [];
  private currentRegion: PetRegion = 'outside';
  private currentSize: PetSizeInfo | null = null;
  /** 拖拽令牌：每次拖拽 +1，用于作废竞态中的异步结果。 */
  private dragToken = 0;
  private dragOriginReady = false;
  private dragOriginWindow = { x: 0, y: 0 };
  private dragOriginScreen = { x: 0, y: 0 };
  private started = false;

  public constructor() {
    this.stage = requireElement('pet-stage');
    const videoA = requireElement<HTMLVideoElement>('pet-video');
    const videoB = requireElement<HTMLVideoElement>('pet-video-b');
    const image = requireElement<HTMLImageElement>('pet-image');

    this.layers = new PetLayers({
      stage: this.stage,
      videoA,
      videoB,
      image,
      logger: this.loggerFactory.create('Layers'),
    });

    this.bubble = new BubbleView({
      stage: this.stage,
      element: requireElement('pet-bubble'),
      textElement: requireElement('pet-bubble-text'),
      bodyElement: requireElement('pet-bubble-body'),
      ackElement: requireElement('pet-bubble-ack'),
      ackBandElement: requireElement('pet-bubble-ack-band'),
      /*
       * 点"知道了"关闭气泡：走与托盘菜单「隐藏气泡」**同一条**实现，
       * 由 Main 进程收起窗口并广播新状态（气泡状态与窗口尺寸必须成对更新）。
       */
      onAcknowledge: () => {
        this.logger.info('bubble acknowledged by user');
        this.runtime.hideBubble();
      },
    });

    this.runtime = new RuntimeCapabilities({
      bridge: readBridge(),
      logger: this.loggerFactory.create('Runtime'),
    });

    this.eventBus = new EventBus({ logger: this.loggerFactory.create('EventBus') });

    this.animationManager = new AnimationManager({
      logger: this.loggerFactory.create('AnimationManager'),
      eventBus: this.eventBus,
      layers: this.layers,
      resolveAsset: (relative) => this.runtime.resolveAsset(relative),
    });

    this.stateMachine = new StateMachine({
      logger: this.loggerFactory.create('StateMachine'),
      eventBus: this.eventBus,
    });

    this.actionManager = new ActionManager({
      logger: this.loggerFactory.create('ActionManager'),
      eventBus: this.eventBus,
      stateMachine: this.stateMachine,
      animationManager: this.animationManager,
      status: { paused: false },
    });

    this.behaviorManager = new BehaviorManager({
      logger: this.loggerFactory.create('BehaviorManager'),
      eventBus: this.eventBus,
      dispatch: (action) => {
        void this.execute(action);
      },
      getState: () => this.stateMachine.get(),
    });

    this.interactionManager = new InteractionManager({
      logger: this.loggerFactory.create('InteractionManager'),
      eventBus: this.eventBus,
      stage: this.stage,
      onIntent: (intent) => this.handleIntent(intent),
      onContextMenu: ({ region }) => this.openContextMenu(region),
      onDragStart: (x, y) => {
        void this.beginDrag(x, y);
      },
      onDragMove: (x, y) => this.moveDrag(x, y),
      onDragEnd: () => this.endDrag(),
      /*
       * 互动上报给主进程（2.3 情绪系统）：
       * 情绪状态住在 Main（要持久化、要随窗口显隐变化衰减），
       * 渲染层只负责"在用户真的碰她时喊一声"。
       * 用可选调用避免在极早/极晚时序下（petAPI 缺失）把交互打断。
       */
      onInteraction: (kind) => {
        this.runtime.ai()?.notifyInteraction(kind);
      },
    });

    this.pluginHost = new PluginHost({
      logger: this.loggerFactory.create('PluginHost'),
      eventBus: this.eventBus,
      state: this.stateMachine,
      animations: this.animationManager,
      actions: this.actionManager,
      behaviors: this.behaviorManager,
      runtime: {
        version: this.runtime.version,
        platform: this.runtime.platform,
        updatePluginRecords: (records) => this.runtime.updatePluginRecords(records),
        notifyActivated: (payload) => {
          this.runtime.pluginBridge()?.notifyActivated(payload);
        },
        notifyDeactivated: (payload) => {
          this.runtime.pluginBridge()?.notifyDeactivated(payload);
        },
        fetchPluginCode: (id) => this.runtime.fetchPluginCode(id),
      },
    });

    /*
     * 摄像头传感器（3.5）：渲染层只负责"被要求时采一帧并回传"。
     * 是否该采、采到的帧意味着什么，全部由主进程的感知服务决定。
     */
    this.cameraSensor = new CameraSensor({
      logger: this.loggerFactory.create('CameraSensor'),
      getApi: () => this.runtime.perception(),
    });
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.logger.info('pet renderer starting');
    this.layers.disableNativeDrag();
    this.interactionManager.attach();
    this.cameraSensor.attach();
    this.wireManagers();
    this.wireCommands();

    const bootstrap = readBootstrap();

    const manifest = validateManifest(bootstrap?.runtime.animationManifest ?? {});
    for (const issue of manifest.issues) {
      this.logger.warn(`manifest validation: ${issue.message}`, { data: { id: issue.id, level: issue.level } });
    }

    const registered = this.animationManager.registerAll([...manifest.animations.values()]);
    if (manifest.fallbackId) this.animationManager.setFallbackId(manifest.fallbackId);

    if (bootstrap === null) {
      this.logger.error('bootstrap unavailable (preload missing or IPC failed); animations may not load');
    }

    this.stage.classList.remove('hidden');
    // 初始尺寸：主进程已在 bootstrap 里算好；缺失时用窗口尺寸兜底
    if (bootstrap) {
      const scale = bootstrap.window.height / 480;
      this.currentSize = bootstrap.size ?? {
        width: bootstrap.window.width,
        height: bootstrap.window.height,
        scale,
        requestedScale: scale,
        windowScale: scale,
        clampedByDisplay: false,
        aspectRatio: bootstrap.window.width / Math.max(1, bootstrap.window.height),
        baseHeight: 480,
      };
    }

    this.logger.info('bootstrap complete', {
      data: {
        animations: registered,
        fallback: manifest.fallbackId ?? '(none)',
        plugins: bootstrap?.plugins.length ?? 0,
        assetsPath: this.runtime.assetsPath,
      },
    });

    /*
     * 对话气泡：**宠物渲染尺寸由这里确定**。
     *
     * 显示气泡时窗口会变大，若宠物仍用 100% 就会跟着拉伸，所以宠物的像素尺寸
     * 必须显式写成 CSS 变量。尺寸来自主进程（bootstrap.size），
     * 这里只做落地；气泡本身多大也由主进程算好一起下发。
     */
    if (bootstrap?.bubble) {
      // 同样先状态、再布局，最后量行数（见 onBubble 的说明）
      this.bubble.applyState(bootstrap.bubble.state);
      this.applyBubbleLayout(bootstrap.bubble);
    } else {
      this.applyBubbleLayout(null);
    }

    this.eventBus.emit(PetEvents.AppReady, {
      version: bootstrap?.runtime.version ?? '0.0.0',
      platform: String(bootstrap?.runtime.platform ?? 'unknown'),
      animations: registered,
      plugins: bootstrap?.plugins.length ?? 0,
      mode: String(bootstrap?.runtime.mode ?? 'unknown'),
    });

    // 先播放兜底动画（idle 循环），让桌宠“活起来”
    await this.animationManager.playFallback({ reason: 'startup', source: 'system' });

    this.behaviorManager.start();
    // 画面看门狗：保证任何播放层故障都能在几秒内自愈
    this.startWatchdog();

    this.plugins = bootstrap?.plugins ?? [];
    if (this.plugins.length > 0) {
      await this.pluginHost.bootstrap(this.plugins);
    }

    this.pushTrayState();
    this.logger.info('pet ready');

    window.addEventListener('beforeunload', () => this.shutdown());
  }

  /* ------------------------------------------------------------------ */
  /* 事件接线（管理器之间协作的唯一集中点）                                */
  /* ------------------------------------------------------------------ */

  private wireManagers(): void {
    // 动画开始 -> 状态机进入 PLAYING
    this.eventBus.onFrom('App', PetEvents.AnimationStart, (payload) => {
      this.runtime.notifyAnimationChanged({
        animationId: payload.animationId,
        priority: payload.priority,
        ...(payload.source !== undefined ? { source: payload.source } : {}),
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      });

      // SLEEPING 由 ActionManager 的 stateHint 负责；BUSY 结束后自行回到 PLAYING
      if (this.stateMachine.is('PLAYING') || this.stateMachine.is('SLEEPING') || this.stateMachine.is('BUSY')) {
        this.pushTrayState();
        return;
      }
      this.stateMachine.request('PLAYING', `animation-start:${payload.animationId}`, payload.source ?? 'system');
      this.pushTrayState();
    });

    // 动画结束 -> 回到 IDLE（“WebM 播放结束自动回到 IDLE”就实现在这里）
    this.eventBus.onFrom('App', PetEvents.AnimationEnd, (payload) => {
      /*
       * 优先接上"延后执行的点击反应"（点击持续动画时记下的那条）。
       * 必须在这里、且在状态迁 IDLE 之前处理：状态一变 IDLE 就会触发
       * `resumeFallbackLoop` 去接兜底 idle，反应会被它顶掉。
       * 此时状态仍是 PLAYING，接上反应后状态自然保持 PLAYING，不必再迁 IDLE。
       */
      if (this.playPendingReactionAfterEnd()) {
        this.pushTrayState();
        return;
      }
      if (payload.completed && (this.stateMachine.is('PLAYING') || this.stateMachine.is('SLEEPING'))) {
        this.stateMachine.request('IDLE', `animation-end:${payload.animationId}`, payload.source ?? 'system');
      }
      this.pushTrayState();
    });

    this.eventBus.onFrom('App', PetEvents.AnimationRejected, (payload) => {
      this.logger.debug('animation request rejected', {
        data: { id: payload.animationId, rejection: payload.rejection, source: payload.source ?? 'system' },
      });
    });

    // 状态变化 -> 同步 main 进程与托盘；并且「回到 IDLE 就恢复兜底循环」
    this.eventBus.onFrom('App', PetEvents.StateChange, (payload) => {
      this.runtime.notifyStateChanged({
        from: payload.from,
        to: payload.to,
        reason: payload.reason,
        ...(payload.source !== undefined ? { source: payload.source } : {}),
      });
      // 关键：任何非循环动画结束后状态回到 IDLE，此时必须把兜底（idle）循环接回来，
      // 否则会出现「点击一次之后 idle 就再也不循环了」（只剩最后一帧停住）。
      if (payload.to === 'IDLE') {
        void this.resumeFallbackLoop(payload.reason);
      }
      this.pushTrayState();
    });

    this.eventBus.onFrom('App', PetEvents.PluginError, (payload) => {
      this.runtime.pluginBridge()?.notifyError({
        id: payload.pluginId,
        hook: payload.hook,
        message: payload.message,
      });
    });

    // 用户交互 -> 重置 idle timeout
    for (const event of [PetEvents.PetClick, PetEvents.PetDoubleClick, PetEvents.PetRegion] as const) {
      this.eventBus.onFrom('App', event, () => {
        this.behaviorManager.notifyInteraction();
      });
    }
  }

  private wireCommands(): void {
    this.runtime.onCommandAction((action) => {
      void this.execute(action);
    });
    this.runtime.onSetBehaviorPaused((paused) => {
      if (paused) this.behaviorManager.pause();
      else this.behaviorManager.resume();
    });
    this.runtime.onSetAnimation((animationId) => {
      this.handleMenuAnimation(animationId);
    });
    this.runtime.onShutdown(() => this.shutdown());
    this.runtime.onSizeChanged((size) => {
      this.handleSizeChanged(size);
    });
    this.runtime.onBubble((payload) => {
      /*
       * 顺序很重要：先落状态（把文本写进 DOM），再落布局（宽度/字号生效），
       * 最后才量行数 —— measureTextLines 依赖已生效的宽度与字号。
       */
      this.bubble.applyState(payload.state);
      this.applyBubbleLayout(payload);
      this.logger.info('bubble updated', {
        data: { visible: payload.state.visible, textLength: payload.state.text.length },
      });
    });
    this.runtime.pluginBridge()?.onReloadRequested(() => {
      void this.pluginHost.reloadAll(this.plugins);
    });
  }

  /**
   * 尺寸变化：窗口已由主进程调整。
   * Renderer 只需要记录新尺寸并刷新托盘 ——
   * 图层是 100% 自适应窗口的，因此不需要重新加载动画或改样式。
   */
  private handleSizeChanged(size: PetSizeInfo): void {
    this.currentSize = size;
    this.logger.info('pet size changed', {
      data: {
        size: `${size.width}x${size.height}`,
        scale: size.scale,
        clampedByDisplay: size.clampedByDisplay,
      },
    });
    /*
     * 宠物尺寸变了 -> 气泡也要跟着缩放。
     * 主进程随后会推一条气泡布局（含新的气泡尺寸），但在它到达之前
     * 先用本地算出的布局顶上，避免出现"宠物已变大、气泡还是旧尺寸"的一帧。
     */
    this.applyBubbleLayout(null);
    this.pushTrayState();
  }

  /**
   * 把气泡布局落到 DOM。
   *
   * @param payload 主进程下发的"状态 + 布局"；null 表示只按当前宠物尺寸重算布局
   *                （用于尺寸变化后先顶上，不等 IPC 往返）
   */
  private applyBubbleLayout(payload: BubblePayload | null): void {
    const size = this.currentSize;
    const layout = payload?.layout
      ?? (size ? resolveBubbleLayout({ petWidth: size.width, petHeight: size.height }) : null);
    if (!layout) return;
    this.bubble.applyLayout(layout);
    /*
     * 量出"当前文本在当前宽度下占几行"回报主进程 —— 气泡高度按它贴合文本。
     * 必须先 applyLayout（字号与宽度已生效）再量，否则量到的是上一次的尺寸。
     * 行数只依赖宽度与字号，主进程一次重算即可收敛；两边相等时主进程会直接忽略。
     */
    const text = this.bubble.getText();
    if (text === '') return;
    const lines = this.bubble.measureTextLines(text);
    if (lines <= 0) return;
    /*
     * 往返：主进程按行数重算气泡高度并调整窗口，顺手把新布局返回。
     * 落地前先比对行数，避免"重算后又被自己再次触发"的无谓往返。
     */
    void this.runtime.reportBubbleTextLines(text, lines).then((payload) => {
      if (payload === null) return;
      if (payload.layout.textLines === lines && payload.layout.bubbleHeight === this.bubble.getBubbleHeight()) {
        return;
      }
      this.bubble.applyLayout(payload.layout);
    });
  }

  /**
   * 恢复兜底（idle）循环。
   *
   * 场景：点击 -> 播放反应动画 -> 动画结束 -> 状态回到 IDLE。
   * 这时如果什么都不做，`<video>` 会停在反应动画的最后一帧，
   * 表现为「点击之后就不循环了」。
   *
   * 注意必须以**动画本身**为准来判断，而不是只看状态：
   * 打断旧动画时也会触发状态变化，此时新动画已经在播，不能再去抢一次。
   *
   * 另外加了一层 **自愈保险**：
   * 「动画结束 -> 回 IDLE -> 接回兜底」这条链路上存在异步竞态
   * （例如 `end` 事件恰好在新的 play 请求之后到达，把 playback 置空），
   * 一旦丢失就会永久卡在"没有动画在播"的状态。
   * 因此这里延迟一小段时间再确认一次：只要已经回到 IDLE 却没有任何动画在播，
   * 就无条件接回兜底循环。正常情况下第一个 await 已经让动画在播，这里不会触发。
   */
  private async resumeFallbackLoop(reason: string): Promise<void> {
    const fallbackId = this.animationManager.getFallbackId();
    if (!fallbackId) return;

    // 取消上一次尚未执行的自愈检查，避免堆积
    if (this.recoveryTimer !== null) {
      window.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    if (this.animationManager.getCurrentAnimation() !== fallbackId) {
      this.logger.info('resuming fallback loop', { data: { fallbackId, reason } });
      await this.animationManager.playFallback({
        reason: `resume-after:${reason}`,
        source: 'system',
      });
    }

    // 自愈保险：等异步链路走完后再确认一次。
    // 只检查"有没有动画在播"是不够的 —— 缓冲可能停在 readyState=0 的
    // "看起来在播、其实没有画面"状态，因此这里直接检查**可见画面的健康度**。
    this.recoveryTimer = window.setTimeout(() => {
      if (this.isVisuallyStuck()) {
        this.healStuckAnimation(reason);
        return;
      }
      this.checkVideoHealth(reason);
    }, 600);
  }

  private recoveryTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private recoveryAttempts = 0;
  private recovering = false;

  /**
   * 待播的点击反应（"先播持续动画的收尾段，再播这个"）。
   *
   * 由 `deferReactionUntilPersistentEnd` 写入，收尾段的 `AnimationEnd`
   * 里由 `playPendingReactionAfterEnd` 消费。只存一条：用户连点只保留最后一次意图。
   */
  private pendingReaction: { animationId: string; priority: number; metadata: Record<string, unknown> } | null = null;

  /**
   * 画面健康检查 + 自愈。
   *
   * 为什么需要它：`<video>` 偶发会停在 `readyState = 0`（有 src、没解码数据、
   * 且不一定触发 error）的僵死状态。一旦发生，桌宠就永久没有画面。
   * 这不是"动画播完了"这种业务问题，而是播放层故障，
   * 因此这里做两件事：
   *   1. 强制清空并重新加载视频缓冲；
   *   2. 让 AnimationManager 重新播一次兜底动画。
   *
   * 用 `recovering` 做互斥，避免看门狗与延时检查同时触发导致重入。
   */
  private checkVideoHealth(reason: string): void {
    if (this.recovering) return;
    if (!this.stateMachine.is('IDLE')) return;
    if (this.layers.isVideoRenderable()) {
      this.recoveryAttempts = 0;
      return;
    }

    this.recovering = true;
    this.recoveryAttempts += 1;
    this.logger.warn('video not renderable; self-healing', {
      data: {
        reason,
        attempt: this.recoveryAttempts,
        animation: this.animationManager.getCurrentAnimation(),
      },
    });

    // 每隔一次做一次"硬重载"，避免在解码器已经正常时反复打断
    if (this.recoveryAttempts % 2 === 1) {
      this.layers.forceReloadActiveVideo();
    }
    void this.animationManager
      .playFallback({ reason: `self-heal-after:${reason}`, source: 'system' })
      .finally(() => {
        this.recovering = false;
      });
  }

  /**
   * 是否"卡住"：**没有任何动画在播，但画面上停着一帧不动的缓冲**。
   *
   * 为什么单独判定它：`checkVideoHealth` 用的是 `isVideoRenderable()`（只要求
   * `readyState >= 2` 且有尺寸）—— 停住的缓冲**完全满足**这个条件，
   * 于是自愈不会触发，桌宠就永久冻在那一帧。
   *
   * 实测踩过的形态：点击 idle 播 stroke，若 stroke 被插件/行为中途抢占
   * （发 `completed=false`，状态不迁 IDLE），兜底 idle 就再也接不回来 ——
   * 可见缓冲会停在**播放中途**（实测 0.6s / 6.04s）且永久 paused。
   * 注意"停在片尾"只是其中一种，不能只判片尾。
   *
   * 误报风险很低：正常交接窗口里动画管理器**已经有** active（新动画进入
   * 加载中），而这里的第一个条件就是"没有 active"；延后执行的点击反应
   * 那段刻意留白由 `pendingReaction` 排除。
   */
  private isVisuallyStuck(): boolean {
    if (this.recovering) return false;
    if (this.pendingReaction !== null) return false;
    if (this.animationManager.getCurrentAnimation() !== null) return false;

    const visible = this.layers.allVideos.filter(
      (video) => video.classList.contains('layer-active') && video.readyState >= 2 && video.videoWidth > 0,
    );
    if (visible.length === 0) return false;

    // 有画面却全都不在播 = 卡住（正在播的缓冲说明动画还在推进）
    return visible.every((video) => video.paused);
  }

  /**
   * 卡死自愈：把兜底循环接回来。
   *
   * 与 `checkVideoHealth` 的分工：那个负责"缓冲僵死（没有可用帧）"，
   * 这个负责"有可用帧但没有动画在播"。两者的触发条件互斥。
   */
  private healStuckAnimation(reason: string): void {
    if (this.recovering) return;
    this.recovering = true;
    this.recoveryAttempts += 1;
    this.logger.warn('no active animation but a frozen frame is visible; resuming fallback', {
      data: { reason, attempt: this.recoveryAttempts, state: this.stateMachine.get() },
    });
    void this.animationManager
      .playFallback({ reason: `self-heal-stuck:${reason}`, source: 'system' })
      .finally(() => {
        this.recovering = false;
      });
  }

  /**
   * 手动跑一次兜底健康检查（看门狗用的就是这一条逻辑）。
   *
   * 公开是为了让自动化验收能**确定性地**驱动自愈，而不必等 2.5s 的定时器；
   * 真实运行仍由 {@link startWatchdog} 的定时器调用。
   */
  public runHealthCheck(reason = 'manual'): void {
    if (this.isVisuallyStuck()) {
      this.healStuckAnimation(reason);
      return;
    }
    if (this.stateMachine.is('IDLE')) this.checkVideoHealth(reason);
  }

  /**
   * 对话气泡的只读快照（验收断言用）。
   *
   * 气泡布局由**主进程**决定并下发，这里只报告渲染层的实际结果：
   * 尺寸、字号、文字区是否出现滚动。三个需求（跟随缩放 / 长文本滚动 /
   * 文字落在留白区内）都靠这份数据断言。
   */
  public describeBubble(): Record<string, unknown> {
    const size = this.currentSize;
    return {
      ...this.bubble.describe(),
      petSize: size ? { width: size.width, height: size.height } : null,
      windowInner: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  /**
   * 自愈链路状态（只读，供自动化验收定位"为什么没自愈"）。
   * 不参与任何业务逻辑。
   */
  public describeRecovery(): Record<string, unknown> {
    const videos = this.layers.allVideos.map((video) => ({
      id: video.id,
      active: video.classList.contains('layer-active'),
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      paused: video.paused,
      loop: video.loop,
      currentTime: Number(video.currentTime.toFixed(2)),
      duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
      src: String(video.currentSrc || video.src || '').split('/').pop() ?? '',
    }));
    return {
      state: this.stateMachine.get(),
      animation: this.animationManager.getCurrentAnimation(),
      recovering: this.recovering,
      recoveryAttempts: this.recoveryAttempts,
      hasPendingReaction: this.pendingReaction !== null,
      visuallyStuck: this.isVisuallyStuck(),
      renderable: this.layers.isVideoRenderable(),
      videos,
    };
  }

  /**
   * 兜底看门狗：周期性确认画面仍然可用。
   * 这是最后一道保险 —— 无论动画链路因为什么竞态丢掉了一次衔接，
   * 桌宠都会在几秒内自己恢复，而不是永久卡成一帧空白。
   *
   * ⚠️ 注意这里**不能**只在状态为 IDLE 时检查（旧实现就是这样，于是恰好漏掉了
   * 最常见的卡死形态：状态停在 PLAYING、却没有任何动画在播）。
   */
  private startWatchdog(): void {
    if (this.watchdogTimer !== null) return;
    this.watchdogTimer = window.setInterval(() => {
      /*
       * 顺序：先看"有可用帧但没动画在播"（状态无关），再看"缓冲僵死"（仅 IDLE）。
       * 前者是更常见的卡死形态，且它的判定本身就排除了正常交接窗口。
       */
      this.runHealthCheck('watchdog');
    }, 2500);
    this.logger.info('video watchdog started');
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer === null) return;
    window.clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /**
   * 托盘/右键菜单的「播放动画（测试）」处理器。
   *
   * 两条菜单（托盘菜单与右键上下文菜单）在 Main 侧都最终调用
   * `IpcManager.setAnimation(id)` -> `CommandSetAnimation`，因此**必然**走到这里 ——
   * 也就是说这一处逻辑同时决定两条菜单的行为，不存在"托盘能用、右键不能用"的分叉。
   * （曾经怀疑过两条路径不同，用 tools/diag-menu-click.cjs 拦截
   * `Menu.buildFromTemplate` 并直接调用菜单项的 click 回调验证过：两者一致。）
   *
   * 行为：
   * - 再次点击**正在播放的同一个动画** -> 结束它。持续动画立刻进收尾段
   *   （收尾段中途再点则立刻收干净回 idle），其余直接停；
   * - 点了**其它**动画 -> 强制切换。
   */
  public handleMenuAnimation(animationId: string): void {
    if (this.animationManager.getCurrentAnimation() === animationId) {
      this.logger.info('menu: same animation re-selected; ending it', {
        data: { animationId, persistent: this.animationManager.isPersistentPlaying(animationId) },
      });
      // 持续动画走 endPersistent（立刻进收尾段 / 收尾段立刻收干净）；其余直接停
      if (!this.animationManager.endPersistent('menu-toggle')) {
        this.animationManager.stop('menu-toggle');
      }
      return;
    }

    void this.execute({
      type: 'animation',
      animationId,
      priority: 70,
      interrupt: 'force',
      source: 'user',
      reason: 'tray-menu',
      /*
       * 用户在托盘/右键菜单里**手动**挑的动画：
       * - `interrupt: 'force'`：必须真的切过去。原来只给优先级（60）+ auto 仲裁，
       *   而菜单对**所有**动画都给同一个优先级，于是"当前 60 vs 目标 60"
       *   命中 equal-priority 被拒 —— 表现就是"watch 播放时选别的动画没反应"
       *   （实测所有动画都被拒，不只是 watch）。用户明确点了这一条，就该生效。
       * - `bypassCooldown`：长冷却的动画（bomb 5 分钟）点第二次否则毫无反应，
       *   看起来像"只能播一次"。自动化来源（行为/插件/AI）不享受这两条。
       * 注意：`force` 仍然无法抢占 `interruptible: false` 的动画（这是硬约束）。
       */
      bypassCooldown: true,
    });
  }

  /* ------------------------------------------------------------------ */
  /* 交互 -> Action Pipeline                                             */
  /* ------------------------------------------------------------------ */

  /**
   * 交互意图入口（`InteractionManager` 的唯一回调）。
   *
   * 声明为 public 是为了让自动化验收能走**真实点击路径**（命中区域 -> 映射动画 ->
   * 提交动作），而不是在测试里复刻一遍这段映射逻辑 —— 复刻过的断言曾经漏掉
   * 真实 bug（菜单 equal-priority 那次）。
   */
  public handleIntent(intent: InteractionIntent): void {
    this.currentRegion = intent.region;
    if (intent.kind === 'region-enter') return;

    const payload: PetClickPayload = intent.payload;

    if (intent.kind === 'double-click') {
      this.logger.info('double click', { data: { region: intent.region } });
      if (this.deferReactionUntilPersistentEnd('play', 60, { region: intent.region })) return;
      void this.execute({
        type: 'animation',
        animationId: 'play',
        priority: 60,
        source: 'user',
        reason: 'user-double-click',
      });
      return;
    }

    const animationId = REGION_ANIMATIONS[intent.region] ?? 'stroke';
    this.logger.info('click', {
      data: { region: intent.region, nx: payload.nx.toFixed(2), ny: payload.ny.toFixed(2), animationId },
    });
    /*
     * 点击是**瞬时反应**：如果当前是一只低优先级的持续动画（发呆/看书/看着你…），
     * 先让它把收尾段播完，再把反应动画接上 —— 而不是硬切掉它。
     * 高优先级的持续动画（如 bomb 100）不受影响，仍然立刻让位。
     */
    if (
      this.deferReactionUntilPersistentEnd(animationId, 50, {
        region: intent.region,
        nx: payload.nx,
        ny: payload.ny,
      })
    ) {
      return;
    }
    void this.execute({
      type: 'animation',
      animationId,
      priority: 50,
      source: 'user',
      reason: `user-click:${intent.region}`,
      metadata: { region: intent.region, nx: payload.nx, ny: payload.ny },
    });
  }

  /**
   * 点击反应遇到持续动画时：**先播它的收尾段，再把反应接上**。
   *
   * 为什么要这样（用户明确要求）：持续动画在 loop 阶段被点击时，原先是硬切 ——
   * 收尾段完全被跳过，动作"断"得很突兀。现在改成两步：
   *   1. `endPersistent()` 让它**立刻**进收尾段（不等本轮循环播完）；
   *   2. 把点击反应记在 `pendingReaction`，等收尾段结束的 `AnimationEnd`
   *      里直接接上（见 `wireManagers`），而不是接回 idle。
   *
   * 为什么不用动画管理器的 `interrupt: 'queue'`：那条路径要和"动画结束后接回
   * 兜底 idle"抢同一时刻 —— `playFallback` 带 `interrupt: 'force'`，会把
   * 排队项顶掉。而"结束后谁接上"本来就是 renderer 这一层的职责，放这里更直白，
   * 也避免两个机制在同一 tick 里互相清空。
   *
   * 只对"优先级不高于 `maxPriority`"的持续动画生效：
   * 瞬时反应不该让位于高优先级的动画（例如 `bomb` priority 100），
   * 那种情况仍然走原来的立刻抢占。
   *
   * @returns true = 已改为"等收尾段播完再播"，调用方不要再提交抢占动作
   */
  private deferReactionUntilPersistentEnd(
    animationId: string,
    maxPriority: number,
    metadata: Record<string, unknown>,
  ): boolean {
    if (!this.animationManager.isPersistentPlayingWithin(maxPriority)) return false;

    const persisting = this.animationManager.getCurrentAnimation();
    if (!this.animationManager.endPersistent('interaction-defer')) return false;

    this.pendingReaction = { animationId, priority: maxPriority, metadata };
    this.logger.info('click deferred until persistent end segment finishes', {
      data: {
        reaction: animationId,
        persisting,
        phase: this.animationManager.getPersistentPhase(),
      },
    });
    return true;
  }

  /**
   * 收尾段结束后接上待播的点击反应。
   *
   * @returns true = 已经接上（调用方不要再接回兜底 idle）
   */
  private playPendingReactionAfterEnd(): boolean {
    const pending = this.pendingReaction;
    if (!pending) return false;
    this.pendingReaction = null;

    this.logger.info('playing deferred click reaction', { data: { animationId: pending.animationId } });
    void this.execute({
      type: 'animation',
      animationId: pending.animationId,
      priority: pending.priority,
      source: 'user',
      reason: 'user-click:after-persistent-end',
      metadata: pending.metadata,
    });
    return true;
  }

  /** 所有行为来源统一入口。 */
  private async execute(action: PetAction): Promise<void> {
    try {
      await this.actionManager.execute(action);
    } catch (error) {
      this.logger.error('action execution error (ignored)', { error: describeError(error) });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 窗口拖拽                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 拖拽开始。
   *
   * ⚠️ 这里必须是「异步取窗口位置」，但 `moveDrag` 是同步被调用的：
   * 一旦用户在 `getWindowPosition()` 返回之前就移动了鼠标（非常常见，
   * 因为指针抖动就会超过 5px 阈值），`moveDrag` 会用**上一次拖拽残留的**
   * `dragOriginWindow` 去算目标位置 —— 结果就是窗口"瞬移一下"再跟上鼠标。
   *
   * 修复：用 token 标记本次拖拽，`moveDrag` 若发现原点还没就绪就**直接丢弃**这一帧，
   * 而不是拿旧值去算。丢弃 1~2 帧肉眼无感，但避免了可见的瞬移。
   */
  private async beginDrag(screenX: number, screenY: number): Promise<void> {
    const token = ++this.dragToken;
    this.dragOriginScreen = { x: screenX, y: screenY };
    this.dragOriginReady = false;
    try {
      const position = await this.runtime.getWindowPosition();
      // 拖拽可能已经结束、或被新的拖拽取代
      if (token !== this.dragToken) return;
      this.dragOriginWindow = position;
      this.dragOriginReady = true;
    } catch (error) {
      if (token !== this.dragToken) return;
      this.logger.warn('get window position failed; drag ignored', { error: describeError(error) });
      this.dragOriginReady = false;
    }
  }

  private moveDrag(screenX: number, screenY: number): void {
    // 原点未就绪：丢弃这一帧，绝不用陈旧的原点去算（否则会瞬移）
    if (!this.dragOriginReady) return;
    const targetX = this.dragOriginWindow.x + (screenX - this.dragOriginScreen.x);
    const targetY = this.dragOriginWindow.y + (screenY - this.dragOriginScreen.y);
    void this.runtime.setWindowPosition(Math.round(targetX), Math.round(targetY)).catch(() => undefined);
  }

  private endDrag(): void {
    // 作废本次拖拽的原点，避免下一次拖拽误用（配合 moveDrag 的就绪判断）
    this.dragToken += 1;
    this.dragOriginReady = false;
    this.logger.debug('drag end');
  }

  /* ------------------------------------------------------------------ */
  /* 托盘 / 右键菜单                                                     */
  /* ------------------------------------------------------------------ */

  private openContextMenu(region: PetRegion): void {
    this.currentRegion = region;
    this.runtime.showContextMenu({
      region,
      animationId: this.animationManager.getCurrentAnimation(),
    });
  }

  private pushTrayState(): void {
    this.runtime.updateTrayState({
      visible: true,
      behaviorPaused: this.behaviorManager.isPaused(),
      currentAnimation: this.animationManager.getCurrentAnimation(),
      currentState: this.stateMachine.get(),
      plugins: this.pluginHost.getLoadedPlugins(),
    });
  }

  /* ------------------------------------------------------------------ */
  /* 退出                                                                */
  /* ------------------------------------------------------------------ */

  public shutdown(): void {
    this.logger.info('pet renderer shutting down');
    try {
      this.stopWatchdog();
      if (this.recoveryTimer !== null) {
        window.clearTimeout(this.recoveryTimer);
        this.recoveryTimer = null;
      }
      this.behaviorManager.stop();
      this.interactionManager.detach();
      this.pluginHost.deactivateAll();
      this.animationManager.dispose();
      this.eventBus.clear();
    } catch (error) {
      this.logger.error('shutdown cleanup failed', { error: describeError(error) });
    }
  }

  /** 供调试/未来设置界面查询运行状态。 */
  public describe(): {
    readonly state: PetState;
    readonly animation: string | null;
    readonly region: PetRegion;
    readonly plugins: number;
    readonly behaviorsPaused: boolean;
    readonly animations: number;
    readonly size: PetSizeInfo | null;
  } {
    return {
      state: this.stateMachine.get(),
      animation: this.animationManager.getCurrentAnimation(),
      region: this.currentRegion,
      plugins: this.pluginHost.getLoadedPlugins().length,
      behaviorsPaused: this.behaviorManager.isPaused(),
      animations: this.animationManager.list().length,
      size: this.currentSize,
    };
  }

  /**
   * 调试句柄：暴露各管理器的只读引用。
   * 仅用于开发期自查 / 自动化验收脚本，不参与任何业务逻辑，
   * 也不通过 IPC 暴露给其它进程。
   */
  public debugHandles(): {
    readonly bus: EventBus;
    readonly anim: AnimationManager;
    readonly state: StateMachine;
    readonly actions: ActionManager;
    readonly behaviors: BehaviorManager;
    readonly interactions: InteractionManager;
    readonly plugins: PluginHost;
    readonly events: EventBus;
    /**
     * 情绪模型（2.3）与 AI 状态。
     *
     * 为什么把纯函数模型挂到这里：这些规则（互动涨幅、三档衰减、token -> 饿）
     * 是**可以被断言**的，验收脚本需要一个确定的入口去直接跑它们，
     * 而不是只能通过 UI 间接观察。模型本身零副作用，暴露它是安全的。
     */
    readonly emotion: {
      readonly applyInteraction: typeof applyInteraction;
      readonly decayEmotion: typeof decayEmotion;
      readonly applyTokens: typeof applyTokens;
      readonly initialEmotion: typeof initialEmotion;
      readonly moodLabel: typeof moodLabel;
      readonly hungerFromTokens: typeof hungerFromTokens;
      readonly EMOTION: typeof EMOTION;
    };
    /** 读取主进程的 AI 状态（异步）。 */
    readonly aiStatus: () => Promise<AIStatusView | null>;    /** 让桌宠说一句话（异步，走与聊天窗口同一条链路）。 */
    readonly aiChat: (text: string) => Promise<AIChatReply | null>;
    /** 上报一次互动（与真实点击同一条路径）。 */
    readonly aiInteract: (kind: InteractionKind) => void;
    /**
     * 感知模型（3.1~3.6）与状态。
     *
     * 与情绪同理：频率闸门、深夜判定、习惯预测这些规则**必须能被断言**，
     * 所以把纯函数暴露给验收脚本；采集与截图仍然只在主进程发生。
     */    readonly perception: {
      readonly DEFAULT_PERCEPTION_SETTINGS: typeof DEFAULT_PERCEPTION_SETTINGS;
      readonly gateIntervention: typeof gateIntervention;
      readonly planIntervention: typeof planIntervention;
      readonly inferUserState: typeof inferUserState;
      readonly isLateNight: typeof isLateNight;
      readonly isQuietHour: typeof isQuietHour;
      readonly learnHabit: typeof learnHabit;
      readonly emptyHabitProfile: typeof emptyHabitProfile;
      readonly habitPredictionText: typeof habitPredictionText;
      readonly topSceneAtHour: typeof topSceneAtHour;
      readonly matchesSensitiveKeywords: typeof matchesSensitiveKeywords;
      readonly capturePermission: typeof capturePermission;
      readonly isPlanEnabled: typeof isPlanEnabled;
      readonly isSensitive: typeof isSensitive;
      readonly normalizeScene: typeof normalizeScene;
      readonly sceneLabel: typeof sceneLabel;
      /** 场景纠正（"浏览器被认成笔记软件"这类误判的确定性补救）。 */
      readonly refineScene: typeof refineScene;
      readonly appKind: typeof appKind;
      readonly matchesAppName: typeof matchesAppName;
      readonly parseSceneFixes: typeof parseSceneFixes;
      /** 网址线索（读地址栏 -> 域名规则 -> 场景纠正）。 */
      readonly isUrlLike: typeof isUrlLike;
      readonly safeHost: typeof safeHost;
      readonly refineSceneByUrl: typeof refineSceneByUrl;
      readonly URL_SCENE_RULES: typeof URL_SCENE_RULES;
      /** 窗口上下文（最上层窗口 + 打开的窗口列表）。 */
      readonly normalizeWindowTitle: typeof normalizeWindowTitle;
      readonly refineSceneByWindow: typeof refineSceneByWindow;
      readonly describeWindowContext: typeof describeWindowContext;
      readonly withoutOwnWindows: typeof withoutOwnWindows;
      readonly BROWSER_APPS: typeof BROWSER_APPS;
      /** 终端文本（"终端里到底在跑什么"的证据）：只有这些进程才读，且先打码再截尾。 */
      readonly TERMINAL_PROCESSES: typeof TERMINAL_PROCESSES;
      readonly isTerminalProcess: typeof isTerminalProcess;
      readonly stripAnsiEscape: typeof stripAnsiEscape;
      readonly redactTerminalSecrets: typeof redactTerminalSecrets;
      readonly tailTerminalText: typeof tailTerminalText;
    };
    readonly perceptionStatus: () => Promise<PerceptionStatus | null>;
    /**
     * 成长与反思模型（4.1 / 4.2）。
     *
     * 重点在"策略只能收紧"这条不变量：`clampOverlay` / `applyInsights` /
     * `effectivePerception` 必须是可断言的纯函数 —— 一个会自己变吵的桌宠
     * 是不可接受的，所以这条规则值得被直接钉死。
     */
    readonly growth: {
      readonly clampOverlay: typeof clampOverlay;
      readonly applyInsights: typeof applyInsights;
      readonly effectivePerception: typeof effectivePerception;
      readonly defaultPolicyOverlay: typeof defaultPolicyOverlay;
      readonly describePolicy: typeof describePolicy;
      readonly mergeNodes: typeof mergeNodes;
      readonly suggestNodes: typeof suggestNodes;
      readonly groupByMonth: typeof groupByMonth;
      readonly nodeId: typeof nodeId;
      readonly heuristicInsights: typeof heuristicInsights;
      readonly parseReflection: typeof parseReflection;
      readonly responseStats: typeof responseStats;
      readonly nodeLabel: typeof nodeLabel;
      readonly sceneName: typeof sceneName;
      readonly POLICY_MIN_FACTOR: typeof POLICY_MIN_FACTOR;
      readonly NODE_KINDS: typeof NODE_KINDS;
    };
    readonly growthStatus: () => Promise<GrowthStatus | null>;
  } {
    return {
      bus: this.eventBus,
      anim: this.animationManager,
      state: this.stateMachine,
      actions: this.actionManager,
      behaviors: this.behaviorManager,
      interactions: this.interactionManager,
      plugins: this.pluginHost,
      events: this.eventBus,
      emotion: {
        applyInteraction,
        decayEmotion,
        applyTokens,
        initialEmotion,
        moodLabel,
        hungerFromTokens,
        EMOTION,
      },
      aiStatus: () => this.runtime.aiStatus(),
      aiChat: async (text: string) => {
        const bridge = this.runtime.ai();
        if (!bridge) return null;
        try {
          return await bridge.chat(text);
        } catch (error) {
          this.logger.warn('ai chat from debug handle failed', { error: describeError(error) });
          return null;
        }
      },
      aiInteract: (kind: InteractionKind) => this.runtime.ai()?.notifyInteraction(kind),
      perception: {
        DEFAULT_PERCEPTION_SETTINGS,
        gateIntervention,
        planIntervention,
        inferUserState,
        isLateNight,
        isQuietHour,
        learnHabit,
        emptyHabitProfile,
        habitPredictionText,
        topSceneAtHour,
        matchesSensitiveKeywords,
        capturePermission,
        isPlanEnabled,
        isSensitive,
        normalizeScene,
        sceneLabel,
        refineScene,
        appKind,
        matchesAppName,
        parseSceneFixes,
        isUrlLike,
        safeHost,
        refineSceneByUrl,
        URL_SCENE_RULES,
        normalizeWindowTitle,
        refineSceneByWindow,
        describeWindowContext,
        withoutOwnWindows,
        BROWSER_APPS,
        TERMINAL_PROCESSES,
        isTerminalProcess,
        stripAnsiEscape,
        redactTerminalSecrets,
        tailTerminalText,
      },
      perceptionStatus: async () => {
        const bridge = this.runtime.perception();
        if (!bridge) return null;
        try {
          return await bridge.status();
        } catch (error) {
          this.logger.warn('reading perception status failed', { error: describeError(error) });
          return null;
        }
      },
      growth: {
        clampOverlay,
        applyInsights,
        effectivePerception,
        defaultPolicyOverlay,
        describePolicy,
        mergeNodes,
        suggestNodes,
        groupByMonth,
        nodeId,
        heuristicInsights,
        parseReflection,
        responseStats,
        nodeLabel,
        sceneName,
        POLICY_MIN_FACTOR,
        NODE_KINDS,
      },
      growthStatus: async () => {
        const bridge = this.runtime.growth();
        if (!bridge) return null;
        try {
          return await bridge.status();
        } catch (error) {
          this.logger.warn('reading growth status failed', { error: describeError(error) });
          return null;
        }
      },
    };
  }
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const logger = createLoggerFactory({ level: 'debug' }).create('Bootstrap');
  try {
    const app = new PetApplication();
    await app.start();
    window.petApp = app;
    // 调试句柄（仅本进程可见，方便 DevTools 与自动化验收脚本）
    window.petDebug = app.debugHandles();
  } catch (error) {
    // 启动失败必须留下痕迹，且不能让白屏无声无息
    logger.error('pet startup failed', { error: describeError(error) });
    document.getElementById('pet-stage')?.classList.add('startup-failed');
  }
}

void main();
