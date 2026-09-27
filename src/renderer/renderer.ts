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
  initialEmotion,
  moodLabel,
  satietyFromBalance,
  satietyFromTokens,
} from '../shared/emotion';
import type { AIChatReply, AIStatusView, InteractionKind } from '../shared/ai-types';
import {
  DEFAULT_BEHAVIOR_CONFIG,
  DEFAULT_DISPLAY_STATE,
  DOCKED_FIDGET_INTERVAL_MS,
  NORMAL_RANDOM_INTERVAL_MS,
  SAD_POOL_ANIMATION,
  SAD_POOL_MOOD_BELOW,
  defaultAnimationFor,
  fidgetFor,
  isQuietDisplay,
  parseBehaviorConfig,
  pickPoolAnimation,
  poolsFor,
  resolveDisplayState,
  sadPoolAnimation,
  type BehaviorConfig,
  type PetDisplayState,
} from '../shared/behavior-config';
import {
  DOCK_EDGE_THRESHOLD_PX,
  UNDOCK_DISTANCE_PX,
  dockTargetPosition,
  evaluateDock,
  petRectIn,
  shouldUndock,
} from '../shared/dock';
import {
  ANIMATION_CATEGORIES,
  CLICK_REACTIONS,
  inferAnimationCategory,
  pickClickReaction,
  resolveLoopCount,
  resolvePlayLoopCount,
} from '../shared/animation-types';
import {
  APPROACH_COOLDOWN_MS,
  APPROACH_RADIUS_PX,
  CONDITION_REPEAT_RANGE_MS,
  HUNGRY_SATIETY_THRESHOLD,
  OVERHEAT_TEMP_C,
  SAD_MOOD_THRESHOLD,
  classifyApproach,
  classifyOffline,
  evaluateHungry,
  evaluateOffline,
  evaluateOverheat,
  evaluateSad,
  evaluateSceneTrigger,
  pickRepeatDelayMs,
  sceneTriggerAnimation,
} from '../shared/pet-triggers';
import {
  balanceEndpoint,
  formatBalance,
  parseBalance,
  supportsBalanceQuery,
} from '../shared/balance';
import type { PerceptionStatus } from '../shared/perception-types';
import {
  DEFAULT_PERCEPTION_SETTINGS,
  isRecognizedScene,
} from '../shared/perception-types';
import { buildSmallTalk, pickSmallTalk } from '../shared/small-talk';
import { migrateNote } from '../shared/notes';
import { formatPalaceRecall, recallTokens, selectPalaceMatches } from '../shared/memory-recall';
import type { GrowthStatus } from '../shared/growth-types';
import { NODE_KINDS, POLICY_MIN_FACTOR } from '../shared/growth-types';
import {
  applyInsights,
  clampOverlay,
  compressPalaceNodes,
  defaultPolicyOverlay,
  describePolicy,
  effectivePerception,
  formatLocalDate,
  groupByMonth,
  heuristicInsights,
  localMonthKey,
  mergeNodes,
  nodeId,
  nodeLabel,
  parseReflection,
  renderPalaceMarkdown,
  responseStats,
  sceneName,
  suggestNodes,
} from '../shared/growth';
import {
  BROWSER_APPS,
  HABIT_KIND_ANY,
  HABIT_MIN_DAYS,
  HABIT_MIN_SCENE_DAYS,
  HABIT_WINDOW_DAYS,
  TERMINAL_ACTIVITY_TEXT,
  TERMINAL_PROCESSES,
  URL_SCENE_RULES,
  appKind,
  capturePermission,
  describeHour,
  describeWindowContext,
  emptyHabitProfile,
  formatLogTimestamp,
  formatObservationLogLine,
  gateIntervention,
  habitBucketKey,
  habitActiveDays,
  habitCounts,
  habitDayKindOf,
  habitPredictionText,
  habitStatsLines,
  habitWindowCutoff,
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
  migrateHabitProfile,
  normalizeScene,
  normalizeWindowTitle,
  parseSceneFixes,
  planIntervention,
  refineScene,
  refineSceneByUrl,
  refineSceneByWindow,
  appDisplayName,
  normalizeProcessName,
  safeHost,
  sceneLabel,
  terminalObservationFor,
  topSceneAtHour,
  withoutOwnWindows,
} from '../shared/perception';
import {
  buildHabitModelMessages,
  buildHabitRoutines,
  habitModelDigest,
  localHabitModel,
  parseHabitModel,
  sanitizeHabitLine,
} from '../shared/habit-model';
import { createLoggerFactory } from '../shared/logging';
import {
  SUMMARY_MAX_CHARS,
  buildRollingSummaryMessages,
  fallbackRollingSummary,
  sanitizeSummary,
} from '../shared/memory-summary';
import {
  SEGMENT_GAP_MS,
  appendObservation,
  buildNarrativeMessages,
  formatArchiveLine,
  formatDuration,
  formatSegmentLine,
  formatTimelineText,
  localDayOf,
  recognizedSegments,
  selectExpiredDays,
  summarizeDay,
} from '../shared/timeline';
import { EventBus } from './core/event-bus';
import { AnimationManager } from './core/animation-manager';
import { StateMachine } from './core/state-machine';
import { ActionManager } from './core/action-manager';
import { BehaviorManager } from './core/behavior-manager';
import { InteractionManager, type InteractionIntent } from './core/interaction-manager';
import { PluginHost } from './core/plugin-host';
import { PetLayers } from './core/layers';
import { BubbleView } from './core/bubble-view';
import { RuntimeCapabilities, readBridge } from './core/runtime';
import { CameraSensor } from './core/camera-sensor';

/**
 * 点击反应动画不再按身体区域区分（需求）：点一下从 `CLICK_REACTIONS`
 * （cute / fawning / stroke）里随机挑一条，见 `handleIntent`。
 *
 * 挑选逻辑是共享层的纯函数 `pickClickReaction`，验收可以直接钉死。
 */

/** preload 注入的启动数据（避免 renderer 启动时再往返一次 IPC）。 */
interface BootstrapPayload {
  readonly runtime: RuntimeInfo;
  readonly plugins: readonly DiscoveredPlugin[];
  readonly window: { readonly width: number; readonly height: number; readonly x: number; readonly y: number };
  readonly size?: PetSizeInfo;
  /** 当前对话气泡状态与布局（可能在 Renderer 就绪前就已打开）。 */
  readonly bubble?: BubblePayload;
  /** 当前显示状态（收起方向 / 隐藏），可能在 Renderer 就绪前就已确定。 */
  readonly display?: PetDisplayState;
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
  private currentSize: PetSizeInfo | null = null;
  /**
   * 显示状态（正常 / 下方收起 / 右侧收起 / 隐藏）。
   *
   * 事实来源是**主进程**（贴边判定要用工作区），这里只持有镜像并据此
   * 切换默认动画与随机池。初值取自 bootstrap，避免"启动时已收起却先播了 idle"。
   */
  private displayState: PetDisplayState = { ...DEFAULT_DISPLAY_STATE };
  /** 随机池与间隔配置（来自 `behavior.json`）。 */
  private behaviorConfig: BehaviorConfig = DEFAULT_BEHAVIOR_CONFIG;
  /**
   * 当前心情的镜像（0–100）。
   *
   * 真相在主进程（情绪要持久化、按在场状态衰减）；渲染层只需要它来决定
   * "心情过低时随机池是不是该全演 sad"（需求）。
   * 初值给满值 = "还没收到状态推送前不算难过"，避免启动瞬间误判。
   */
  private mood = 100;
  /** 拖拽令牌：每次拖拽 +1，用于作废竞态中的异步结果。 */
  private dragToken = 0;
  private dragOriginReady = false;
  private dragOriginWindow = { x: 0, y: 0 };
  private dragOriginScreen = { x: 0, y: 0 };
  private started = false;

  /* --- 互动 -> 心情（需求：互动动画播放结束才能加 mood 值） ------------- */

  /**
   * 本次互动**期望**播出的反应动画 id（`handleIntent` 在派发请求之前登记）。
   *
   * 为什么要在派发之前登记：动画请求可能被**同步**拒绝（冷却 / 不可打断 / 优先级），
   * 那时 `animation:start` 永远不会来。先登记，"这次互动有没有动画可等"才判得准。
   */
  private expectedInteractionAnimation: string | null = null;
  /** 上面那条请求是否**同步被拒**（冷却 / 不可打断 / 优先级不足）→ 没有动画可等。 */
  private expectedInteractionRejected = false;
  /** 正在播放的互动反应动画（点击/双击）。null = 没有。 */
  private interactionAnimationId: string | null = null;
  /** 等互动动画播完后要结算的心情互动（可能攒了多次连点）。 */
  private pendingMoodKinds: InteractionKind[] = [];

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
      /*
       * 收起（贴边）时的"安静模式"：只允许她当前状态的默认姿势**与它的随机小动作**。
       *
       * 需求：收起时她安静地维持默认姿势（sleep / watch），只在默认姿势里随机插一小段
       * （lie / peek）—— 所以白名单必须把 **fidget 里的动画**也算进来，
       * 否则那两段会被这条规则以 `docked` 拒掉，表现为"收起后从来不换姿势"。
       *
       * 正常状态返回 null（不限制）。见 AnimationManagerOptions.getQuietPolicy ——
       * 这是"end 一直循环"的根治点。
       */
      getQuietPolicy: () => {
        const state = resolveDisplayState(this.displayState);
        if (state === 'normal' || state === 'hidden') return null;
        const fallback = defaultAnimationFor(this.behaviorConfig, state);
        const poolAnimations = poolsFor(this.behaviorConfig, state).flatMap((pool) => [...pool.animations]);
        const fidgetAnimations = fidgetFor(this.behaviorConfig, state)?.animations ?? [];
        return {
          allowed: [
            ...new Set([
              ...(fallback ? [fallback] : []),
              ...poolAnimations,
              ...fidgetAnimations,
            ]),
          ],
        };
      },
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
      // 随机动画按"当前显示状态"取池：正常 25–60 秒；收起状态没有池，改走"随机小动作"
      getDisplayState: () => resolveDisplayState(this.displayState),
      getKnownAnimations: () => new Set(this.animationManager.list()),
      // "随机小动作"的门槛：默认姿势正在播、且已在循环段（见 BehaviorManager.tickFidget）
      getCurrentAnimation: () => this.animationManager.getCurrentAnimation(),
      getPersistentPhase: () => this.animationManager.getPersistentPhase(),
      // 心情过低时随机池整体换成 sad（阈值来自 behavior.json 的 sadPool）
      getMood: () => this.mood,
      config: this.behaviorConfig,
    });

    this.interactionManager = new InteractionManager({
      logger: this.loggerFactory.create('InteractionManager'),
      eventBus: this.eventBus,
      stage: this.stage,
      onIntent: (intent) => this.handleIntent(intent),
      onContextMenu: () => this.openContextMenu(),
      onDragStart: (x, y) => {
        void this.beginDrag(x, y);
      },
      onDragMove: (x, y) => this.moveDrag(x, y),
      onDragEnd: (x, y) => this.endDrag(x, y),
      /*
       * 互动上报给主进程（2.3 情绪系统）：
       * 情绪状态住在 Main（要持久化、要随窗口显隐变化衰减），
       * 渲染层只负责"在用户真的碰她时喊一声"。
       * 用可选调用避免在极早/极晚时序下（petAPI 缺失）把交互打断。
       */
      onInteraction: (kind) => {
        // 互动本身立刻上报：记忆事件与"她主动开口有没有被回应"都要用**真实时刻**
        this.runtime.ai()?.notifyInteraction(kind);
        // 心情等互动动画播完再加（拖动这类没有动画的互动立刻加，见 queueInteractionMood）
        this.queueInteractionMood(kind);
      },
    });

    this.pluginHost = new PluginHost({
      logger: this.loggerFactory.create('PluginHost'),
      eventBus: this.eventBus,
      state: this.stateMachine,
      animations: this.animationManager,
      actions: this.actionManager,
      behaviors: this.behaviorManager,
      /*
       * preload 的插件桥：插件的系统能力（联网 / 起进程 / 通知 / 定时器 /
       * 菜单与面板）全部经它转给 Main —— 权限执法在那边，渲染层不掌握
       * "谁有权限"的真相（否则改一行渲染层的代码就能越权）。
       * preload 没注入时为 null：插件仍能加载，只是这些能力返回"不可用"。
       */
      bridge: this.runtime.pluginBridge() ?? null,
      // `ui.say` 的落地点：让桌宠冒个泡说一句话（气泡尺寸由 Main 算）
      say: (text) => {
        void this.runtime.bubble()?.set({ visible: true, text, ready: false });
      },
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

    /*
     * 随机池配置与显示状态：bootstrap 里带着，避免"先按默认状态播了 idle，
     * 再被一条 IPC 纠正成 lie/watch"的可见跳变。
     */
    if (bootstrap?.runtime.behaviorConfig) {
      this.behaviorConfig = bootstrap.runtime.behaviorConfig;
      this.behaviorManager.setConfig(this.behaviorConfig);
    }
    if (bootstrap?.display) this.displayState = { ...bootstrap.display };

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

    /*
     * 播放"当前状态的默认动画"：正常是 idle，下方收起是 sleep，右侧收起是 watch。
     * 不能一律 `playFallback`（那永远是 idle）—— 否则启动时就已收起时她会站在边上发呆。
     */
    await this.playDisplayDefault('startup');

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
      /*
       * 互动反应动画（点击/双击）开始播了：记下它，等它的 `animation:end`
       * 才是"加心情"的时机（见 `queueInteractionMood`）。
       * 托盘菜单手动播放也是 `source: 'user'`，但 reason 是 `tray-menu`，
       * 所以用 reason 前缀把它排除掉 —— 手动挑动画不该给心情。
       */
      if (this.isInteractionReaction(payload)) this.interactionAnimationId = payload.animationId;

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
       * 互动反应动画播完 = 加心情的时机（需求："互动动画播放结束才能加 mood 值"）。
       *
       * 放在状态机判定**之前**：心情结算与状态衔接是两件事，
       * 不该因为下面那条"已有新动画接手就提前 return"而被跳过。
       */
      if (this.interactionAnimationId !== null && payload.animationId === this.interactionAnimationId) {
        this.interactionAnimationId = null;
        this.flushPendingMood(payload.animationId, payload.completed ? 'completed' : 'interrupted');
      }

      /*
       * 收尾段结束时可能**已经**接上了打断它的那条动画
       * （AnimationManager 的 `pendingAfterEnd`，见 requestAnimation 第 5 步）。
       * 那种情况下不能再去迁 IDLE —— 一迁就会触发 resumeFallbackLoop，
       * 而 `playFallback` 带 `interrupt: 'force'`，会把刚接上的动画顶掉。
       *
       * 两条挂起路径都靠 `isHandoverPending()` 覆盖：挂起项是排到 `setTimeout(0)`
       * 才真正开始的，所以此刻 `getCurrentAnimation()` 还是 null ——
       * 只看它就判断"没有动画了"，会立刻接回默认姿势，于是多出一段
       * `默认 -> 默认 end -> 目标`（收起时表现为"刚趴下又要爬起来"）。
       */
      if (
        this.animationManager.getCurrentAnimation() !== null ||
        this.animationManager.isHandoverPending()
      ) {
        this.logger.info('animation end but a new animation already took over; keeping it', {
          data: {
            finished: payload.animationId,
            current: this.animationManager.getCurrentAnimation(),
            handover: this.animationManager.isHandoverPending(),
          },
        });
        this.pushTrayState();
        return;
      }
      if (payload.completed && (this.stateMachine.is('PLAYING') || this.stateMachine.is('SLEEPING'))) {
        this.stateMachine.request('IDLE', `animation-end:${payload.animationId}`, payload.source ?? 'system');
      }
      this.pushTrayState();
    });

    this.eventBus.onFrom('App', PetEvents.AnimationRejected, (payload) => {
      /*
       * 互动反应动画**被同步拒绝**（冷却 / 不可打断 / 优先级不足）：
       * 这次点击不会播任何动画，所以"等动画播完再加心情"的前置条件不成立 ——
       * 记下来，由 `queueInteractionMood` 在互动上报的那一刻立刻结算。
       *
       * 为什么需要这个标记：请求是在 `handleIntent` 里派发的，拒绝是**同步**发生的
       * （早于 `InteractionManager.onInteraction` 回调），光看 `animation:start`
       * 永远等不到，心情会被静默吞掉。
       */
      if (this.expectedInteractionAnimation !== null && payload.animationId === this.expectedInteractionAnimation) {
        this.expectedInteractionRejected = true;
      }
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
    for (const event of [PetEvents.PetClick, PetEvents.PetDoubleClick] as const) {
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
    /*
     * 触发动画（感知 / AI / 系统）：走普通优先级仲裁与冷却。
     * 和 `onSetAnimation`（托盘"播放动画（测试）"）严格区分 ——
     * 那条是用户显式挑选，允许 force + 绕过冷却。
     */
    this.runtime.onTriggerAnimation((payload) => {
      this.logger.info('trigger animation requested', {
        data: { animationId: payload.animationId, reason: payload.reason, source: payload.source ?? 'system' },
      });
      void this.execute({
        type: 'animation',
        animationId: payload.animationId,
        ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
        source: payload.source ?? 'system',
        reason: payload.reason,
      });
    });
    this.runtime.onDisplayState((payload) => {
      void this.applyDisplayState(payload, 'main-process');
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
      void this.reloadPluginsFromMain();
    });

    /*
     * 插件运行期三条指令（"插件可随时关闭"在渲染层的落点）：
     * - `onEnabled`：Main 要求启用/停用**某一个**插件（设置窗口或托盘点了开关）；
     * - `onUIEvent`：插件注册的菜单项被点、通知被点、或聊天窗口里的面板动作；
     * - `onTimer`：插件定时器到点（定时器由 Main 持有，隐藏窗口也不会被降频）。
     */
    this.runtime.pluginBridge()?.onEnabled((payload) => {
      void this.pluginHost.applyEnabledCommand(payload.id, payload.enabled, payload.entry);
    });
    this.runtime.pluginBridge()?.onUIEvent((event) => this.pluginHost.handleUIEvent(event));
    this.runtime.pluginBridge()?.onTimer((payload) => {
      this.pluginHost.handleTimerTick(payload.pluginId, payload.timerId, payload.kind);
    });
    /*
     * 插件被卸载（设置窗口里点了「卸载」）：渲染层要连记录一起忘掉，
     * 并清掉它的存储 —— 否则托盘菜单里会一直挂着一个已经不存在的插件。
     */
    this.runtime.pluginBridge()?.onRemoved((payload) => {
      void this.pluginHost.removePlugin(payload.id);
      this.plugins = this.plugins.filter((plugin) => plugin.id !== payload.id);
    });
    this.wireMoodMirror();
  }

  /**
   * 整体重载插件：**先向 Main 要最新清单**，再让宿主全部卸下重装。
   *
   * 为什么要重新问一遍：渲染层手里那份清单是启动时的快照，
   * 直接拿它重载的话，"刚放进 plugins/ 的新插件"与"刚被关掉的插件"
   * 都要等到重启才生效 —— 那「重载插件」这个按钮就名不副实了。
   */
  private async reloadPluginsFromMain(): Promise<void> {
    const bridge = this.runtime.pluginBridge();
    if (bridge) {
      try {
        this.plugins = await bridge.discover();
      } catch (error) {
        this.logger.warn('refreshing plugin list failed; reloading with the cached list', {
          error: describeError(error),
        });
      }
    }
    await this.pluginHost.reloadAll(this.plugins);
  }

  /**
   * 心情镜像（渲染层 -> 行为系统）。
   *
   * 为什么渲染层需要知道心情：需求是"心情低于阈值时，所有随机池的动画都变成 sad" ——
   * 池子在渲染层（BehaviorManager），所以至少要有一个"当前心情"的读数。
   *
   * 数据来源是主进程的状态推送（`ai.onStatus`，情绪心跳/互动/聊天后都会推一次）。
   * 这里**只读地缓存一个数**：不做任何 IPC 往返，也不参与情绪计算本身
   * （情绪的真相永远在主进程）。启动时补一次主动查询，避免等第一个心跳。
   */
  private wireMoodMirror(): void {
    const ai = this.runtime.ai();
    if (!ai) return;
    ai.onStatus((status) => {
      this.applyMood(status?.emotion?.mood);
    });
    void ai
      .status()
      .then((status) => this.applyMood(status?.emotion?.mood))
      .catch(() => undefined);
  }

  /** 落一次心情读数（非法值忽略：宁可保持上一次，也不要让它变成 NaN 影响判定）。 */
  private applyMood(mood: unknown): void {
    if (typeof mood !== 'number' || !Number.isFinite(mood)) return;
    this.mood = mood;
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
   * 恢复"当前显示状态的默认动画"。
   *
   * 场景：点击 -> 播放反应动画 -> 动画结束 -> 状态回到 IDLE。
   * 这时如果什么都不做，`<video>` 会停在反应动画的最后一帧，
   * 表现为「点击之后就不循环了」。
   *
   * ⚠️ 默认动画**不等于** idle：下方收起时是 sleep、右侧收起时是 watch。
   * 早期实现一律接回 `playFallback()`（idle），收起状态下她就会站起来 ——
   * 这正是"收起 = 默认动画 sleep/watch"这条需求最容易漏掉的地方。
   *
   * 注意必须以**动画本身**为准来判断，而不是只看状态：
   * 打断旧动画时也会触发状态变化，此时新动画已经在播，不能再去抢一次。
   *
   * 另外加了一层 **自愈保险**：
   * 「动画结束 -> 回 IDLE -> 接回默认」这条链路上存在异步竞态
   * （例如 `end` 事件恰好在新的 play 请求之后到达，把 playback 置空），
   * 一旦丢失就会永久卡在"没有动画在播"的状态。
   * 因此这里延迟一小段时间再确认一次：只要已经回到 IDLE 却没有任何动画在播，
   * 就无条件接回默认循环。正常情况下第一个 await 已经让动画在播，这里不会触发。
   */
  private async resumeFallbackLoop(reason: string): Promise<void> {
    const fallbackId = this.animationManager.getFallbackId();
    if (!fallbackId) return;

    // 取消上一次尚未执行的自愈检查，避免堆积
    if (this.recoveryTimer !== null) {
      window.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    const wanted = this.defaultAnimationId() ?? fallbackId;
    if (this.animationManager.getCurrentAnimation() !== wanted) {
      this.logger.info('resuming default loop', { data: { animationId: wanted, reason } });
      await this.playDisplayDefault(`resume-after:${reason}`);
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

  /** 当前显示状态该播的默认动画 id（没有 = null，例如隐藏状态）。 */
  private defaultAnimationId(): string | null {
    const state = resolveDisplayState(this.displayState);
    const configured = defaultAnimationFor(this.behaviorConfig, state);
    if (configured === null) return null;
    // 配置里写了但清单里没有（清单被改过）时退回兜底，避免"她突然不动了"
    if (!this.animationManager.getDefinition(configured)) return this.animationManager.getFallbackId();
    return configured;
  }

  /**
   * 播放当前显示状态的默认动画。
   *
   * 三个播放参数/守卫是关键：
   * - `loop: true`：一次性素材（idle）要一直循环；
   * - `loopCountRange: 'forever'`：**三段式**素材（watch / sleep）也要一直循环，
   *   只在离开这个状态时才播它的收尾段（需求："收起时点击先播 end 再播 idle"）；
   * - **幂等**：已经在播这条默认动画就什么都不做。
   *   这不是优化，而是**防死循环**：调用方（自愈链路、resumeFallbackLoop）
   *   可能在很短的间隔里重复调用，而"重复请求正在播的三段式动画"会走
   *   "loop 被打断 -> 先播 end" —— 那就是"end 一直循环、回不到 idle"。
   *   （AnimationManager 里也对 `same-animation` 做了同样的硬规则，这里是第一道。）
   */
  private async playDisplayDefault(reason: string): Promise<void> {
    const animationId = this.defaultAnimationId();
    if (!animationId) return;
    if (this.animationManager.getCurrentAnimation() === animationId) return;
    const isFallback = animationId === this.animationManager.getFallbackId();
    await this.animationManager.play(animationId, {
      interrupt: 'force',
      loop: true,
      loopCountRange: 'forever',
      reason,
      source: 'system',
      ...(isFallback ? {} : { priority: 5 }),
    });
  }

  /**
   * 应用显示状态（主进程判定后广播过来）。
   *
   * 三件事必须一起做，缺一个就会出现"收起了她还站着"这类不一致：
   *   1. 记住新状态；
   *   2. 切换到该状态的默认动画（idle / sleep / watch）；
   *   3. 让 BehaviorManager 换池并重新排期（收起后立刻蹦一下会很怪）。
   */
  private async applyDisplayState(next: PetDisplayState, reason: string): Promise<void> {
    const before = resolveDisplayState(this.displayState);
    const after = resolveDisplayState(next);
    this.displayState = { ...next };
    if (before === after) return;

    this.logger.info('display state applied', { data: { from: before, to: after, reason } });

    // 状态切换时旧的"等收尾段"意图不再适用（她已经在另一个姿势上了）
    this.animationManager.clearPendingAfterEnd();
    this.behaviorManager.onDisplayStateChanged();

    if (after === 'hidden') return; // 窗口都藏了，不必再播动画
    await this.playDisplayDefault(`display:${after}`);
  }

  private recoveryTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private recoveryAttempts = 0;
  private recovering = false;

  /**
   * 待落地的窗口位置（主进程要求"等当前过渡播完再挪"）。
   *
   * 场景：从收起状态展开时她正在播默认姿势的收尾段（watch-end / sleep-end）。
   * 那一刻就挪窗口 = "一边起身一边滑走"，需求要求播 end 时不要动。
   * 这里等新默认动画真正开始（`AnimationStart`）时再落地，另有超时兜底。
   */
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
    /*
     * ⚠️ 修的是这条：自愈要回到**当前显示状态的默认动画**，不是硬编码 idle。
     * 收起状态的默认是 watch / sleep（三段式）—— 回 idle 会让
     * `resumeFallbackLoop()` 再把默认动画接回来，形成
     * `watch -> end -> idle -> watch -> end ...` 的循环（用户报告"end 一直循环"）。
     * `playDisplayDefault()` 自身幂等，重复自愈也不会反复打断。
     */
    void this.playDisplayDefault(`self-heal-after:${reason}`)
      .catch((error: unknown) => {
        this.logger.warn('self-heal default play failed', { error: describeError(error) });
      })
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
   * 加载中），而这里的第一个条件就是"没有 active"；"等收尾段播完再播"的
   * 那段刻意留白由动画管理器的 `pendingAfterEnd` 排除。
   */
  private isVisuallyStuck(): boolean {
    if (this.recovering) return false;
    if (this.animationManager.hasPendingAfterEnd()) return false;
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
    this.logger.warn('no active animation but a frozen frame is visible; resuming default', {
      data: { reason, attempt: this.recoveryAttempts, state: this.stateMachine.get() },
    });
    // 同 checkVideoHealth：回到**当前显示状态的默认动画**（收起时是 watch/sleep）
    void this.playDisplayDefault(`self-heal-stuck:${reason}`)
      .catch((error: unknown) => {
        this.logger.warn('self-heal default play failed', { error: describeError(error) });
      })
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
      hasPendingReaction: this.animationManager.hasPendingAfterEnd(),
      displayState: this.displayState,
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
   * 声明为 public 是为了让自动化验收能走**真实点击路径**（点一下 -> 挑反应动画 ->
   * 提交动作），而不是在测试里复刻一遍这段映射逻辑 —— 复刻过的断言曾经漏掉
   * 真实 bug（菜单 equal-priority 那次）。
   *
   * 注意：这里**不再有"命中区域"**（head / belly / tail…）。那套分区从来没接进
   * 行为链：点击反应一律从 cute / fawning / stroke 里随机挑一条，与点在哪无关。
   */
  public handleIntent(intent: InteractionIntent): void {
    /*
     * 收起状态下点一下 = **只展开**（需求："点击宠物展开"，且
     * "收起时点击宠物应该先播放 end 再播放 idle"）。
     *
     * 所以这里**不再同时**播点击反应（cute/fawning/stroke）：
     * 收起状态的默认动画是 watch（右侧）/ sleep（下方），点一下的动作语义是"把我放出来"，
     * 应该由它自己的收尾段负责过渡 —— 现在走的是 AnimationManager 的三段式语义：
     *   watch 在 loop 段 -> 立刻进 end 段 -> 收尾播完 -> 接上 idle。
     * 之前"展开 + 点击反应"同时发生会有两个问题（实测）：
     *   1. 反应动画（priority 50）会和"接回默认动画"抢同一个挂起位，
     *      结果是 **end -> 反应 -> idle** 三段，比需求多一段、也更慢；
     *   2. 展开的 IPC 往返与点击动作谁先到不确定 —— 先到的那条会清掉另一条的挂起请求，
     *      表现为"有时有反应、有时没有"。
     * 现在只提交一个意图，顺序完全确定。
     *
     * 位置回退由主进程负责（回到最近一次"没贴边"的位置）。
     */
    if (this.displayState.dock !== 'free') {
      this.logger.info('click while docked: expanding (end -> idle)', {
        data: { dock: this.displayState.dock },
      });
      /*
       * 收起状态点击**没有反应动画**（只有默认姿势的收尾段）：
       * 期待值登记为 null，心情会在互动那一刻立刻结算（见 queueInteractionMood）。
       */
      this.expectInteractionAnimation(null);
      void this.runtime.requestUndock().then((display) => {
        if (display) void this.applyDisplayState(display, 'click-undock');
      });
      return;
    }

    const payload: PetClickPayload = intent.payload;

    if (intent.kind === 'double-click') {
      /*
       * 需求："去掉双击触发动画的代码"。
       * 双击不再播 `play`（也不播任何动画）—— 它仍然算一次互动
       * （InteractionManager 会照常上报 `doubleclick`，记忆与心情各自按既有规则处理），
       * 只是没有可等的"互动动画"，所以心情在互动那一刻就结算。
       */
      this.expectInteractionAnimation(null);
      this.logger.info('double click: no animation by design');
      return;
    }

    /*
     * 点击反应：从 cute / fawning / stroke 里随机挑一条（需求："不分区域"）。
     * 挑的时候避开正在冷却的那条，否则连点会出现"点了没反应"。
     */
    const animationId = pickClickReaction(
      this.animationManager.list(),
      Math.random,
      (id) => this.animationManager.isOnCooldown(id),
    );
    if (animationId === null) {
      this.logger.warn('click reaction unavailable: none of the candidates is registered', {
        data: { candidates: CLICK_REACTIONS.join('/') },
      });
      this.expectInteractionAnimation(null);
      return;
    }
    this.logger.info('click', {
      data: { nx: payload.nx.toFixed(2), ny: payload.ny.toFixed(2), animationId },
    });
    /*
     * 点击反应不再需要渲染层自己"等收尾段"：
     * AnimationManager 现在统一实现需求里的三段式打断语义
     * （loop/start 阶段被打断 -> 先播 end 再播这次请求；end 阶段被打断 -> 立刻让位）。
     * 放在动画管理器里，插件/AI/感知触发也能享受同一套语义，
     * 渲染层只负责提交意图（这也正是 Action Pipeline 的设计约定）。
     */
    this.expectInteractionAnimation(animationId);
    void this.execute({
      type: 'animation',
      animationId,
      priority: 50,
      source: 'user',
      reason: 'user-click',
      metadata: { nx: payload.nx, ny: payload.ny },
    });
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
  /* 互动 -> 心情（需求：互动动画播放结束才能加 mood 值）                    */
  /* ------------------------------------------------------------------ */

  /**
   * 登记"这次互动期望播出的反应动画"。
   *
   * 必须**在派发动画请求之前**调用：`AnimationManager.requestAnimation` 的拒绝
   * （冷却 / 不可打断 / 优先级）是同步发生的，而互动上报回调在它之后 ——
   * 事后再登记就永远看不到那次拒绝，心情会被静默吞掉。
   *
   * @param animationId 期望的反应动画；null = 这次互动没有动画（拖动 / 收起状态点击）
   */
  private expectInteractionAnimation(animationId: string | null): void {
    this.expectedInteractionAnimation = animationId;
    this.expectedInteractionRejected = false;
  }

  /**
   * 这次 `animation:start` 是不是"用户互动反应动画"（点击 / 双击）。
   *
   * 判据是 `source: 'user'` **加上** reason 前缀：托盘菜单手动挑动画也是
   * `source: 'user'`（reason = `tray-menu`），它不该参与心情结算。
   */
  private isInteractionReaction(payload: { source?: string; reason?: string }): boolean {
    if (payload.source !== 'user') return false;
    const reason = payload.reason ?? '';
    return reason.startsWith('user-click:') || reason === 'user-double-click';
  }

  /**
   * 用户碰了她之后，决定"心情什么时候加"。
   *
   * 四种真实形态，判定顺序不能换：
   * 1. **拖动 / 收起状态下点击**：本来就没有反应动画 —— 立刻结算；
   * 2. **已经有一条互动动画在播**：点击动画 `interruptible: false`（不可打断），
   *    这次请求会被拒；攒着等那条播完一起结算，连点不会白点；
   * 3. **请求被同步拒绝**（冷却 / 优先级不足）：没有动画可等 —— 立刻结算；
   * 4. **其余**：动画即将开始（视频加载是异步的）—— 等它的 `animation:end`。
   */
  private queueInteractionMood(kind: InteractionKind): void {
    const expected = this.expectedInteractionAnimation;
    const rejected = this.expectedInteractionRejected;
    this.expectedInteractionAnimation = null;
    this.expectedInteractionRejected = false;

    const hasReaction = kind !== 'drag' && expected !== null;
    if (!hasReaction || (this.interactionAnimationId === null && rejected)) {
      this.runtime.ai()?.notifyInteractionSettled(kind);
      return;
    }
    this.pendingMoodKinds.push(kind);
    this.logger.debug('interaction mood waits for animation end', {
      data: {
        kind,
        expected: expected ?? '-',
        playing: this.interactionAnimationId ?? '-',
        pending: this.pendingMoodKinds.length,
      },
    });
  }

  /**
   * 互动动画播完 -> 把攒下的互动一次性结算（连点会攒成多条，逐条加心情）。
   *
   * `interrupted` 也照样结算：那条动画确实播过（可能只播了一半），
   * 而用户是真的点了她 —— 心情按"碰过"算，比按"看完整段"算更符合直觉。
   */
  private flushPendingMood(animationId: string, reason: 'completed' | 'interrupted'): void {
    if (this.pendingMoodKinds.length === 0) return;
    const kinds = this.pendingMoodKinds;
    this.pendingMoodKinds = [];
    for (const kind of kinds) this.runtime.ai()?.notifyInteractionSettled(kind);
    this.logger.info('interaction mood settled after animation end', {
      data: { animationId, reason, kinds: kinds.join(',') },
    });
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

  private endDrag(screenX: number, screenY: number): void {
    // 作废本次拖拽的原点，避免下一次拖拽误用（配合 moveDrag 的就绪判断）
    this.dragToken += 1;
    this.dragOriginReady = false;
    /*
     * 拖完了 -> 交给主进程判定"要不要收起"。
     * 判定必须发生在主进程：只有它知道工作区（`screen.workArea`）与宠物在
     * 窗口里的实际位置（气泡会把窗口撑大，宠物并不贴着窗口边缘）。
     */
    void this.runtime.endDrag(screenX, screenY).then((display) => {
      if (display) void this.applyDisplayState(display, 'drag-end');
    });
    this.logger.debug('drag end');
  }

  /* ------------------------------------------------------------------ */
  /* 托盘 / 右键菜单                                                     */
  /* ------------------------------------------------------------------ */

  private openContextMenu(): void {
    this.runtime.showContextMenu();
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
    readonly plugins: number;
    readonly behaviorsPaused: boolean;
    readonly animations: number;
    readonly size: PetSizeInfo | null;
  } {
    return {
      state: this.stateMachine.get(),
      animation: this.animationManager.getCurrentAnimation(),
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
     * 走**真实点击路径**模拟一次点击（命中区域 -> 映射动画 -> 提交动作）。
     *
     * 与 `handleIntent` 完全同一条实现（它本来就是 InteractionManager 的回调），
     * 所以"收起状态下点一下就展开"这类行为能被真实验证，而不是在测试里复刻一遍。
     */
    readonly click: (nx?: number, ny?: number) => void;
    /** 显示状态（收起方向 / 隐藏）。 */
    readonly display: () => PetDisplayState;
    /** 心情镜像读数（渲染层缓存的主进程心情；用于验证推送链路）。 */
    readonly mood: () => number;
    /**
     * 动画与行为的**纯模型**（这一次大改的核心规则）。
     *
     * 为什么全暴露：分类、随机循环次数、随机池挑选、贴边几何、触发阈值
     * 都是纯函数，验收需要逐条钉死它们（真机跑一遍只能证明"这一条路径没坏"）。
     */
    readonly animationModel: {
      readonly resolveLoopCount: typeof resolveLoopCount;
      readonly resolvePlayLoopCount: typeof resolvePlayLoopCount;
      readonly inferAnimationCategory: typeof inferAnimationCategory;
      readonly ANIMATION_CATEGORIES: typeof ANIMATION_CATEGORIES;
      /** 点击反应动画的候选集与随机挑选（点击不再分区域）。 */
      readonly CLICK_REACTIONS: typeof CLICK_REACTIONS;
      readonly pickClickReaction: typeof pickClickReaction;
      readonly parseBehaviorConfig: typeof parseBehaviorConfig;
      readonly pickPoolAnimation: typeof pickPoolAnimation;
      readonly poolsFor: typeof poolsFor;
      readonly defaultAnimationFor: typeof defaultAnimationFor;
      /** 心情过低时随机池换成哪一条（需求："低于阈值全变 sad，高于阈值变回来"）。 */
      readonly sadPoolAnimation: typeof sadPoolAnimation;
      /** 内置的 sad 阈值与动画 id（与 pet-triggers 的"很难过"档保持一致）。 */
      readonly SAD_POOL_MOOD_BELOW: typeof SAD_POOL_MOOD_BELOW;
      readonly SAD_POOL_ANIMATION: typeof SAD_POOL_ANIMATION;
      /** 某个显示状态的"随机小动作"配置（收起时的 lie / peek）。 */
      readonly fidgetFor: typeof fidgetFor;
      readonly resolveDisplayState: typeof resolveDisplayState;
      /** 收起/隐藏 = 安静模式（这时她不该开口说话）。 */
      readonly isQuietDisplay: typeof isQuietDisplay;
      readonly DEFAULT_BEHAVIOR_CONFIG: typeof DEFAULT_BEHAVIOR_CONFIG;
      readonly NORMAL_RANDOM_INTERVAL_MS: typeof NORMAL_RANDOM_INTERVAL_MS;
      readonly DOCKED_FIDGET_INTERVAL_MS: typeof DOCKED_FIDGET_INTERVAL_MS;
      readonly evaluateDock: typeof evaluateDock;
      readonly dockTargetPosition: typeof dockTargetPosition;
      readonly shouldUndock: typeof shouldUndock;
      readonly petRectIn: typeof petRectIn;
      readonly DOCK_EDGE_THRESHOLD_PX: typeof DOCK_EDGE_THRESHOLD_PX;
      readonly UNDOCK_DISTANCE_PX: typeof UNDOCK_DISTANCE_PX;
      readonly classifyApproach: typeof classifyApproach;
  readonly classifyOffline: typeof classifyOffline;
      readonly evaluateOverheat: typeof evaluateOverheat;
      readonly evaluateSad: typeof evaluateSad;
      readonly evaluateHungry: typeof evaluateHungry;
      readonly evaluateOffline: typeof evaluateOffline;
      readonly evaluateSceneTrigger: typeof evaluateSceneTrigger;
      readonly sceneTriggerAnimation: typeof sceneTriggerAnimation;
      readonly satietyFromBalance: typeof satietyFromBalance;
      readonly APPROACH_RADIUS_PX: typeof APPROACH_RADIUS_PX;
  readonly APPROACH_COOLDOWN_MS: typeof APPROACH_COOLDOWN_MS;
      readonly OVERHEAT_TEMP_C: typeof OVERHEAT_TEMP_C;
      readonly SAD_MOOD_THRESHOLD: typeof SAD_MOOD_THRESHOLD;
      readonly HUNGRY_SATIETY_THRESHOLD: typeof HUNGRY_SATIETY_THRESHOLD;
      /** 「持续状态」（断网/过热）的重复间隔：3~8 分钟内随机。 */
      readonly CONDITION_REPEAT_RANGE_MS: typeof CONDITION_REPEAT_RANGE_MS;
      readonly pickRepeatDelayMs: typeof pickRepeatDelayMs;
    };
    /** DeepSeek 余额接口的纯解析（Money 是字符串、地址收敛、非官方域名跳过）。 */
    readonly balance: {
      readonly balanceEndpoint: typeof balanceEndpoint;
      readonly supportsBalanceQuery: typeof supportsBalanceQuery;
      readonly parseBalance: typeof parseBalance;
      readonly formatBalance: typeof formatBalance;
    };
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
      readonly satietyFromTokens: typeof satietyFromTokens;
      readonly EMOTION: typeof EMOTION;
    };
    /** 对话的滚动前情摘要（"更早说过的事"怎么压成一段）。 */
    readonly memorySummary: {
      readonly fallbackRollingSummary: typeof fallbackRollingSummary;
      readonly buildRollingSummaryMessages: typeof buildRollingSummaryMessages;
      readonly sanitizeSummary: typeof sanitizeSummary;
      readonly SUMMARY_MAX_CHARS: typeof SUMMARY_MAX_CHARS;
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
      /** 习惯 v2：分档读数 / 统计文本 / 常量（去重、衰减、可回落、平日周末）。 */
      readonly describeHour: typeof describeHour;
      readonly habitDayKindOf: typeof habitDayKindOf;
      readonly habitBucketKey: typeof habitBucketKey;
      readonly habitStatsLines: typeof habitStatsLines;
      readonly HABIT_WINDOW_DAYS: typeof HABIT_WINDOW_DAYS;
      readonly habitCounts: typeof habitCounts;
      readonly habitActiveDays: typeof habitActiveDays;
      readonly habitWindowCutoff: typeof habitWindowCutoff;
      /** v1 -> v2 画像迁移（纯函数；验收直接喂旧 JSON 断言）。 */
      readonly migrateHabitProfile: typeof migrateHabitProfile;
      readonly HABIT_MIN_DAYS: typeof HABIT_MIN_DAYS;
      readonly HABIT_MIN_SCENE_DAYS: typeof HABIT_MIN_SCENE_DAYS;
      readonly HABIT_KIND_ANY: typeof HABIT_KIND_ANY;
      /** 习惯建模：本地算条目 + 提示词 + 解析 + 模板（模型只写措辞，条目不经过模型）。 */
      readonly buildHabitRoutines: typeof buildHabitRoutines;
      readonly habitModelDigest: typeof habitModelDigest;
      readonly buildHabitModelMessages: typeof buildHabitModelMessages;
      readonly parseHabitModel: typeof parseHabitModel;
      readonly localHabitModel: typeof localHabitModel;
      readonly sanitizeHabitLine: typeof sanitizeHabitLine;
      /** 日常闲聊：候选组装与轮换挑选（问候 / 今天的活动 / 最近的事 / 习惯询问）。 */
      readonly buildSmallTalk: typeof buildSmallTalk;
      readonly pickSmallTalk: typeof pickSmallTalk;
      /** 纸条记录的**向下兼容迁移**（旧"邮箱"格式 -> 现在的收纳夹格式）。 */
      readonly migrateNote: typeof migrateNote;
      /** 记忆召回（她主动查记忆宫殿时的纯检索）：分词、打分、拼文本。 */
      readonly recallTokens: typeof recallTokens;
      readonly selectPalaceMatches: typeof selectPalaceMatches;
      readonly formatPalaceRecall: typeof formatPalaceRecall;
      readonly topSceneAtHour: typeof topSceneAtHour;
      /** 这个场景算不算"看懂了"（`other` = 没认出来，一律当作没看见）。 */
      readonly isRecognizedScene: typeof isRecognizedScene;
      /** 时间线上只留"看懂了"的段（老文件里可能存着 `other`）。 */
      readonly recognizedSegments: typeof recognizedSegments;
      readonly appendObservation: typeof appendObservation;
      readonly formatTimelineText: typeof formatTimelineText;
      readonly summarizeDay: typeof summarizeDay;
      readonly matchesSensitiveKeywords: typeof matchesSensitiveKeywords;
      readonly capturePermission: typeof capturePermission;
      readonly isPlanEnabled: typeof isPlanEnabled;
      readonly isSensitive: typeof isSensitive;
      readonly normalizeScene: typeof normalizeScene;
      readonly sceneLabel: typeof sceneLabel;
      /**
       * 界面显示用的程序名：已知进程名 -> 固定名字（同一个 Edge 不许叫三个名字）。
       * 纯函数，验收直接钉"msedge 永远显示成 Microsoft Edge"。
       */
      readonly appDisplayName: typeof appDisplayName;
      readonly normalizeProcessName: typeof normalizeProcessName;
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
      /**
       * 终端（需求："如果是终端，直接表示正在使用控制台就行，不用分析做什么"）。
       *
       * 这一路是**固定结论**而不是内容理解：前台是终端类进程时，场景钉成 `terminal`、
       * 文案固定，既不截图也不调模型。所以只暴露"进程判定 + 固定文案 + 观察构造函数"。
       */
      readonly TERMINAL_PROCESSES: typeof TERMINAL_PROCESSES;
      readonly isTerminalProcess: typeof isTerminalProcess;
      readonly TERMINAL_ACTIVITY_TEXT: typeof TERMINAL_ACTIVITY_TEXT;
      readonly terminalObservationFor: typeof terminalObservationFor;
      /** 感知日志的时间戳与一行观察的文案（本地时间 + 详细字段，文件与面板共用）。 */
      readonly formatLogTimestamp: typeof formatLogTimestamp;
      readonly formatObservationLogLine: typeof formatObservationLogLine;
      /**
       * 每天的时间线聚合（"今天 9:10–11:32 在写代码"）：合并/切分/汇总/文案/叙述提示词。
       * 全是纯函数，所以验收可以把"怎么合并、怎么跨天、idle 算不算"逐条钉死。
       */
      readonly timeline: {
        readonly appendObservation: typeof appendObservation;
        readonly summarizeDay: typeof summarizeDay;
        readonly formatDuration: typeof formatDuration;
        readonly formatSegmentLine: typeof formatSegmentLine;
        readonly formatTimelineText: typeof formatTimelineText;
        readonly buildNarrativeMessages: typeof buildNarrativeMessages;
        readonly localDayOf: typeof localDayOf;
        readonly SEGMENT_GAP_MS: typeof SEGMENT_GAP_MS;
        /** 明细保留期：挑出过期日 + 把一天压成归档的一行。 */
        readonly selectExpiredDays: typeof selectExpiredDays;
        readonly formatArchiveLine: typeof formatArchiveLine;
      };
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
      /** 节点时间的展示口径（本地日期/月份），面板与 palace.md 共用。 */
      readonly formatLocalDate: typeof formatLocalDate;
      readonly localMonthKey: typeof localMonthKey;
      readonly renderPalaceMarkdown: typeof renderPalaceMarkdown;
      /** 记忆宫殿压缩（"很久以前同种类的反复经历折成一条"）。 */
      readonly compressPalaceNodes: typeof compressPalaceNodes;
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
      click: (nx = 0.5, ny = 0.5) => {
        this.handleIntent({
          kind: 'click',
          payload: { button: 'left', x: 0, y: 0, nx, ny, detail: 1 },
        });
      },
      display: () => this.displayState,
      /**
       * 心情镜像读数（渲染层从主进程推送缓存下来的那个数）。
       *
       * 暴露出来是为了能验证"推送真的到了"：`petDebug.mood()` 与
       * `ai.status().emotion.mood` 必须一致 —— 镜像断了的话随机池的 sad 规则
       * 就会一直按启动时的旧值判定。
       */
      mood: () => this.mood,
      animationModel: {
        resolveLoopCount,
        resolvePlayLoopCount,
        inferAnimationCategory,
        ANIMATION_CATEGORIES,
        CLICK_REACTIONS,
        pickClickReaction,
        parseBehaviorConfig,
        pickPoolAnimation,
        poolsFor,
        defaultAnimationFor,
        sadPoolAnimation,
        SAD_POOL_MOOD_BELOW,
        SAD_POOL_ANIMATION,
        fidgetFor,
        resolveDisplayState,
        isQuietDisplay,
        DEFAULT_BEHAVIOR_CONFIG,
        NORMAL_RANDOM_INTERVAL_MS,
        DOCKED_FIDGET_INTERVAL_MS,
        evaluateDock,
        dockTargetPosition,
        shouldUndock,
        petRectIn,
        DOCK_EDGE_THRESHOLD_PX,
        UNDOCK_DISTANCE_PX,
        classifyApproach,
        classifyOffline,
        evaluateOverheat,
        evaluateSad,
        evaluateHungry,
        evaluateOffline,
        evaluateSceneTrigger,
        sceneTriggerAnimation,
        satietyFromBalance,
        APPROACH_RADIUS_PX,
        APPROACH_COOLDOWN_MS,
        OVERHEAT_TEMP_C,
        SAD_MOOD_THRESHOLD,
        HUNGRY_SATIETY_THRESHOLD,
        CONDITION_REPEAT_RANGE_MS,
        pickRepeatDelayMs,
      },
      balance: {
        balanceEndpoint,
        supportsBalanceQuery,
        parseBalance,
        formatBalance,
      },
      emotion: {
        applyInteraction,
        decayEmotion,
        applyTokens,
        initialEmotion,
        moodLabel,
        satietyFromTokens,
        EMOTION,
      },
      memorySummary: {
        fallbackRollingSummary,
        buildRollingSummaryMessages,
        sanitizeSummary,
        SUMMARY_MAX_CHARS,
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
        describeHour,
        habitDayKindOf,
        habitBucketKey,
        habitActiveDays,
        habitCounts,
        habitWindowCutoff,
        habitStatsLines,
        migrateHabitProfile,
        HABIT_WINDOW_DAYS,
        HABIT_MIN_DAYS,
        HABIT_MIN_SCENE_DAYS,
        HABIT_KIND_ANY,
        buildHabitRoutines,
        habitModelDigest,
        buildHabitModelMessages,
        parseHabitModel,
        localHabitModel,
        sanitizeHabitLine,
        buildSmallTalk,
        pickSmallTalk,
        migrateNote,
        recallTokens,
        selectPalaceMatches,
        formatPalaceRecall,
        topSceneAtHour,
        isRecognizedScene,
        recognizedSegments,
        appendObservation,
        formatTimelineText,
        summarizeDay,
        matchesSensitiveKeywords,
        capturePermission,
        isPlanEnabled,
        isSensitive,
        normalizeScene,
        sceneLabel,
        appDisplayName,
        normalizeProcessName,
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
        TERMINAL_ACTIVITY_TEXT,
        terminalObservationFor,
        formatLogTimestamp,
        formatObservationLogLine,
        timeline: {
          appendObservation,
          summarizeDay,
          formatDuration,
          formatSegmentLine,
          formatTimelineText,
          buildNarrativeMessages,
          localDayOf,
          SEGMENT_GAP_MS,
          selectExpiredDays,
          formatArchiveLine,
        },
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
        formatLocalDate,
        localMonthKey,
        renderPalaceMarkdown,
        compressPalaceNodes,
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
