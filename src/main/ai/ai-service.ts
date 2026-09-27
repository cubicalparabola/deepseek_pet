/**
 * AI 服务（2.1~2.4 的中枢）—— 把四个子系统串成"一次对话"。
 *
 * 一次对话的真实流程（每一步都有明确的降级出口）：
 *
 *   用户打字
 *     ├─ 记忆：落一条 user 对话（2.2）
 *     ├─ 情绪：mood += 9（2.3）
 *     ├─ 检索：相关事实 + 过去几天的相关片段 + 最近对话（2.2）
 *     ├─ 组装 prompt：人格设定 + 情绪描述 + 记忆 + 输出约束
 *     ├─ 大模型（2.1）──失败/未配置──► 本地兜底文案（仍然受情绪与记忆影响）
 *     ├─ token 用量 → 预算 → "饿"（2.3）
 *     ├─ 记忆：落一条 pet 对话，规则抽取事实，必要时让模型整理（2.2）
 *     └─ 表演：按情绪挑动画 + 冒泡显示（语言/行为/动画一致）
 *
 * 日记（2.4）复用同一条链路的产物：当天对话 + 事件 + 心情曲线 → 第一视角日记。
 *
 * 设计底线：**任何一步失败都不能让桌宠卡住** —— 所有外部调用都有超时，
 * 所有异常都被收敛成"降级 + 一条 lastError"。
 */

import type {
  AIBalanceState,
  AIChatReply,
  MemoryEventKind,
  AISettings,
  AISettingsPatch,
  AIStatusView,
  AITestResult,
  ChatTurn,
  DiaryEntry,
  DiarySnapshot,
  InteractionKind,
  MemorySnapshot,
} from '../../shared/ai-types';
import { evaluateAIUsability, toAISettingsView } from '../../shared/ai-types';
import {
  applyInteraction,
  describeEmotionForPrompt,
  formatEmotion,
  satietyFromBalance,
  moodLabel,
  preferredAnimation,
  tokensRemainingRatio,
} from '../../shared/emotion';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import { net } from 'electron';
import { AIConfigStore } from './ai-config-store';
import { DiaryService, todayKey, type DiaryContext } from './diary-service';
import { buildRollingSummaryMessages, fallbackRollingSummary, sanitizeSummary } from '../../shared/memory-summary';
import { EmotionService } from './emotion-service';
import { extractFactsFromModelOutput, extractFactsHeuristic } from './fact-extract';
import {
  LLMClient,
  LLMError,
  type LLMCompletionResult,
  type LLMMessage,
  type LLMPurpose,
  type LLMToolResult,
} from './llm-client';
import { MEMORY_TOOLS, TOOL_HINT, executeTool } from './tools';
import { NoteService, type MailDelivery, type MailDeliveryResult, type NoteChange } from './note-service';
import type { NoteBox } from '../../shared/notes';
import {
  buildNoteMessages,
  localNoteDraft,
  sanitizeNote,
  splitNoteOutput,
  type NoteContext,
} from '../../shared/notes';
import { supportsBalanceQuery } from '../../shared/balance';
import { classifyOffline } from '../../shared/pet-triggers';
import type { MemoryNode } from '../../shared/growth-types';
import { localDiary, localReply } from './local-replies';
import { MemoryStore } from './memory-store';

/** 桌宠"要说话"时的回调（由 controller 接到气泡 + 动画上）。 */
export interface SpeakRequest {  readonly text: string;
  readonly animation: string | null;
  /** 回复 / 主动搭话 / 系统提示。 */
  readonly kind: 'reply' | 'proactive' | 'system';
  /** 消息级别（系统消息用）。 */
  readonly level?: 'info' | 'warn' | 'error';
}

/**
 * 一次对话里最多允许几轮工具调用。
 *
 * 取 2：绝大多数情况一轮就够（查一次 → 回答）；模型偶尔会"再查一次确认细节"，
 * 给两轮即可。再多就是烧 token + 用户干等，而收益极小。
 */
const MAX_TOOL_ROUNDS = 2;

export interface AIServiceOptions {
  /** 数据根目录（`%APPDATA%\DesktopPet`）。 */
  readonly dataDir: string;
  readonly logger: Logger;
  /** 当前 Manifest 里存在的动画 id（挑不出对应动画时回退 null）。 */
  readonly getAvailableAnimations: () => readonly string[];
  /** 说话回调（气泡 + 动画 + 记忆事件都在 controller 里落地）。 */
  readonly onSpeak?: (request: SpeakRequest) => void;
  /** 状态变化回调（推给设置窗口/聊天窗口）。 */
  readonly onStatus?: (status: AIStatusView) => void;
  /**
   * 新日记写完的回调（推给「交互」窗口的日记页）。
   *
   * 为什么需要它：日记现在有两处入口 —— 设置窗口的 AI 面板与「交互」窗口，
   * 而且每天到点还会自动写一篇。没有这条回调的话，正开着的日记页会一直停在旧清单上
   * （"刚写完的那篇看不见"），直到窗口重开。
   */
  readonly onDiaryWritten?: (entry: DiaryEntry) => void;
  /**
   * 「主人今天在做什么」的一段紧凑文本（由感知模块的时间线提供）。
   *
   * 用回调而不是缓存：每轮对话都要**当时最新**的那一段；感知模块被关掉/还没数据时
   * 返回空串，聊天与日记里就自然没有这一块（不硬塞"今天没有记录"这种噪声）。
   */
  readonly getDailyTimeline?: () => string;
  /**
   * 记忆宫殿的节点（"她记得的经历"）。
   *
   * 只在**模型主动调用 `recall_memory` 工具时**才会被读（需求 7.3）——
   * 平时不注入提示词，也不进上下文。
   */
  readonly getPalaceNodes?: () => readonly MemoryNode[];
}

export class AIService {
  private readonly options: AIServiceOptions;
  private readonly logger: Logger;
  private readonly config: AIConfigStore;
  private readonly memory: MemoryStore;
  private readonly emotion: EmotionService;
  private readonly diary: DiaryService;
  private readonly notes: NoteService;
  private readonly llm: LLMClient;

  private busy = false;
  private lastError = '';
  private calls = 0;
  /**
   * **本次运行**的大模型用量（进程启动起算，关掉就清零）。
   *
   * 与 `budget.used`（持久化的累计）分开：用户既想知道"这个月花了多少"，
   * 也想知道"这次开着它花了多少、花在哪"。按用途分档由 `sessionUsage` 记。
   */
  private sessionTokens = 0;
  private sessionUsage: Partial<Record<LLMPurpose, number>> = {};
  /** 自上次记忆整理以来新增的对话轮数。 */
  private turnsSinceConsolidate = 0;
  /** 余额快照（DeepSeek 官方 `GET /user/balance`）；没查过时为 null。 */
  private balance: AIBalanceState | null = null;
  private balanceError = '';
  private balanceTimer: NodeJS.Timeout | null = null;

  public constructor(options: AIServiceOptions) {
    this.options = options;
    this.logger = options.logger;
    this.config = new AIConfigStore({ dataDir: options.dataDir, logger: options.logger });
    this.memory = new MemoryStore({ dataDir: options.dataDir, logger: options.logger });
    this.emotion = new EmotionService({
      dataDir: options.dataDir,
      logger: options.logger,
      isEnabled: () => this.settings.emotion || this.settings.enabled,
      getBudget: () => this.settings.budget,
      onChange: () => this.emitStatus(),
    });
    this.diary = new DiaryService({
      dataDir: options.dataDir,
      logger: options.logger,
      getContext: (date) => this.buildDiaryContext(date),
      compose: (context) => this.composeDiary(context),
      getHour: () => this.settings.diaryHour,
      isEnabled: () => this.isDiaryEnabled(),
      onWritten: (entry) => this.handleDiaryWritten(entry),
    });
    /*
     * 记账挂在这里：`LLMClient` 是所有大模型请求的唯一出口，
     * 因此视觉理解、每日反思、习惯建模这些**别的模块**发的请求也会被算进来
     * （以前它们不进预算，面板上的数字是偏乐观的）。
     */
    this.llm = new LLMClient(this.config.get().provider, {
      logger: options.logger,
      onUsage: (usage) => this.recordUsage(usage.tokens, usage.purpose),
    });
    /*
     * 小纸条（留言箱）：落盘 + 生成她的回信。
     *
     * 放在最后构造，因为它要用到 `llm`（她怎么说话）、`memory`（她记得什么）
     * 与 `emotion`（她现在的状态）—— 也就是"她能说什么"的全部来源。
     */
    this.notes = new NoteService({
      dataDir: options.dataDir,
      logger: options.logger,
      composeDraft: () => this.composeNoteDraft(),
      onChanged: (box, change) => this.handleNotesChanged(box, change),
    });
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  public load(): void {
    this.config.load();
    /*
     * 记忆：**开关关着就不加载、不建目录、不写文件**。
     *
     * 为什么较真：需求要求"可配置开关"，那么关掉时就不该在用户磁盘上
     * 留下痕迹 —— 否则第一次装上桌宠就会多出一个 memory/ 目录和一堆日志，
     * 用户会以为"它一直在记我"。开关打开时才真正落盘（见 setSettings）。
     */
    if (this.settings.memory) {
      this.memory.setEnabled(true);
      this.memory.load();
      this.memory.setUserName(this.memory.getProfile().userName || this.settings.userName);
    } else {
      // 关着就明确告诉记忆层"别写盘"（它会拦住 recordEvent / 跨天分隔线等所有写路径）
      this.memory.setEnabled(false);
    }
    this.emotion.load();
    // 日记同理：没打开就不建目录（load 只读索引，不 mkdir）
    this.diary.load();
    /*
     * 小纸条：**无条件加载**。
     *
     * 与记忆/日记不同，纸条是**用户自己写下的内容**（不是"她在记你"）：
     * 关掉 AI 总开关时把它藏起来，用户会以为"我的留言丢了"。
     * 她的回信会退化成模板文案（大模型不可用时），但你的字一定还在。
     */
    this.notes.load();
    this.llm.updateConfig(this.settings.provider);
    if (this.settings.memory) {
      this.memory.recordEvent('system', 'AI 模块已加载', {
        enabled: this.settings.enabled,
        chat: this.settings.chat,
        memory: this.settings.memory,
        emotion: this.settings.emotion,
        diary: this.settings.diary,
      });
    }
    this.emotion.startHeartbeat();
    this.diary.startScheduler();
    this.startBalanceScheduler();
    // 启动时清一次超期的记忆流水（每天最多一次；0 天 = 用户选了永久保留）
    this.pruneMemory();
    // 启动时补一次"昨天没写的日记"（程序不是 24 小时开着的）
    void this.diary.dueCheck().catch((error: unknown) => {
      this.logger.warn('diary catch-up failed', { error: describeError(error) });
    });
    /*
     * 有未读纸条就提醒一句（**一次**，不重复刷屏）：纸条是"她留给你的"，
     * 你若一直没看，她该说一声。
     */
    const unread = this.notes.unread;
    if (unread > 0) {
      this.options.onSpeak?.({
        text: unread === 1 ? '我给你留了一张小纸条，记得看哦～' : `我给你留了 ${unread} 张小纸条，记得看哦～`,
        animation: this.pickAnimation('greeting'),
        kind: 'proactive',
      });
    }
    this.emitStatus();
  }

  public dispose(): void {
    this.emotion.stopHeartbeat();
    this.diary.stopScheduler();
    this.stopBalanceScheduler();
  }

  public get settings(): AISettings {
    return this.config.get();
  }

  /**
   * 大模型客户端（只读）。
   *
   * 感知模块（3.1/3.2/3.5 的视觉理解）复用**同一个**客户端：
   * 密钥与网关只配一次，视觉能力立刻跟着生效；也避免出现"两个客户端两套配置"。
   */
  public get llmClient(): LLMClient {
    return this.llm;
  }

  public get memoryStore(): MemoryStore {
    return this.memory;
  }

  public get emotionService(): EmotionService {
    return this.emotion;
  }

  public get diaryService(): DiaryService {
    return this.diary;
  }

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  public status(): AIStatusView {
    const settings = this.settings;
    const usability = evaluateAIUsability(settings);
    return {
      settings: toAISettingsView(settings),
      usable: usability.usable,
      mode: usability.usable ? 'llm' : 'local',
      lastError: this.lastError || (usability.usable ? '' : usability.reason),
      busy: this.busy,
      calls: this.calls,
      tokensUsed: settings.budget.used,
      sessionTokens: this.sessionTokens,
      sessionUsage: Object.entries(this.sessionUsage)
        .map(([purpose, tokens]) => ({ purpose, tokens: tokens ?? 0 }))
        .sort((a, b) => b.tokens - a.tokens),
      dataDir: this.options.dataDir,
      emotion: this.emotion.get(),
      presence: this.emotion.presence,
      balance: this.balance,
      balanceError: this.balanceError,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 余额（DeepSeek 官方唯一的额度接口）                                   */
  /* ------------------------------------------------------------------ */

  /**
   * 查询余额（`GET /user/balance`）。
   *
   * 只在 DeepSeek 官方域名下发请求：one-api / Ollama 这类兼容网关没有这个接口，
   * 对它们请求只会得到 404 噪音，反而把"最近错误"刷成红的。
   *
   * 结果同时驱动两件事：
   *   1. **饿**：余额优先于本地累计 token（用户要求）；
   *   2. **掉线（offline）**：key 无效 / 余额不足 -> 主进程据此演 offline 动画。
   */
  public async refreshBalance(): Promise<AIBalanceState | null> {
    const settings = this.settings;
    /*
     * 余额查询**永远开着**（用户要求："删掉余额计算选项（默认开启）"）：
     * 原先那个 `balance.enabled` 开关已删除。总开关关着时当然还是不查；
     * 非 DeepSeek 官方域名下也会跳过（那里没有这个接口，见 supportsBalanceQuery）。
     */
    if (!settings.enabled) return this.balance;
    if (settings.provider.apiKey.trim() === '') {
      this.balanceError = '未配置 API Key';
      this.balance = null;
      this.applyBalanceSatiety();
      this.emitStatus();
      return null;
    }
    if (!supportsBalanceQuery(settings.provider.baseUrl)) {
      /*
       * 不是 DeepSeek 官方地址：不查询、保留上一次结果（可能是空的）。
       * 记一条**说明性**的错误而不是网络错误 —— 让用户知道"这不是坏了，是这家没有这个接口"。
       */
      this.balanceError = '当前服务商不提供余额查询（余额只在 DeepSeek 官方地址下可用）';
      this.balance = null;
      this.applyBalanceSatiety();
      this.emitStatus();
      return null;
    }

    try {
      const result = await this.llm.fetchBalance();
      this.balance = {
        isAvailable: result.isAvailable,
        currency: result.currency,
        totalBalance: result.totalBalance,
        grantedBalance: result.grantedBalance,
        toppedUpBalance: result.toppedUpBalance,
        fetchedAt: result.fetchedAt,
        drivesSatiety: true,
      };
      this.balanceError = '';
      this.applyBalanceSatiety();
      this.logger.info('balance refreshed', {
        data: {
          currency: result.currency,
          total: result.totalBalance,
          available: result.isAvailable,
        },
      });
      this.emitStatus();
      return this.balance;
    } catch (error) {
      const message = error instanceof Error ? error.message : describeError(error);
      this.balanceError = message;
      this.logger.warn('balance query failed', { data: { message } });
      // 查失败不改动上一次的余额（网络抖一下不该让她立刻变"饿"）
      this.emitStatus();
      return this.balance;
    }
  }

  /** 把余额映射成饱腹度并交给情绪服务（余额优先于本地 token 预算）。 */
  private applyBalanceSatiety(): void {
    const settings = this.settings;
    const satiety = this.balance === null
      ? null
      : satietyFromBalance(this.balance.totalBalance, {
          low: settings.balance.lowBalance,
          full: settings.balance.fullBalance,
        });
    this.emotion.setBalanceSatiety(satiety);
    // 余额不足（官方 `is_available=false`）等价于"没额度了"：直接拉到最低（饱腹 0）
    if (this.balance !== null && !this.balance.isAvailable) this.emotion.setBalanceSatiety(0);
  }

  /**
   * 余额查询是否表明"用不了"（用于 offline 动画）。
   *
   * 规则本身在 `shared/pet-triggers.ts` 的 `classifyOffline()`（纯函数，可逐条钉死）；
   * 这里只负责**取事实**：
   *   - `no-key`      还没填密钥（最该先告诉用户的那条）
   *   - `network`     **断网**：系统层面没有网络连接，或最近一次请求在
   *                   DNS/连接阶段就失败了（`LLMError('NETWORK')`）
   *   - `invalid-key` 密钥无效（接口 401/403）
   *   - `no-balance`  余额不足（官方 `is_available = false`）
   *
   * 为什么把"断网"也算进来：需求里 offline 是"掉线动画"，
   * 而用户真正会遇到的掉线有两种 —— 没配 key 和**网断了**。
   * 只看余额/密钥的话，拔网线时她一声不响（余额还是上次那个），
   * 反而在最该表达的时候没表达。
   */
  public offlineReason(): { readonly offline: boolean; readonly reason: string } {
    const settings = this.settings;
    const reason = classifyOffline({
      enabled: settings.enabled,
      hasKey: settings.provider.apiKey.trim() !== '',
      // 系统层面就没网（Chromium 的网络状态，拔网线/关 Wi-Fi 立刻为 false）
      networkOnline: this.isNetworkOnline(),
      // 没查过余额（null）时按"可用"处理：不知道就别报掉线
      balanceAvailable: this.balance === null ? true : this.balance.isAvailable,
      balanceError: this.balanceError,
      lastError: this.lastError,
    });
    return { offline: reason !== '', reason };
  }

  /** 系统层面是否连着网；读不出来时按"有网"处理（不谎报掉线）。 */
  private isNetworkOnline(): boolean {
    try {
      return net.isOnline();
    } catch (error) {
      this.logger.debug('net.isOnline() unavailable', { error: describeError(error) });
      return true;
    }
  }

  public startBalanceScheduler(): void {
    if (this.balanceTimer !== null) return;
    const interval = Math.max(60_000, this.settings.balance.intervalMs);
    this.balanceTimer = setInterval(() => {
      void this.refreshBalance().catch(() => undefined);
    }, interval);
    this.balanceTimer.unref?.();
    // 启动时查一次（余额决定了"饿"和"掉线"，等 30 分钟太久）
    void this.refreshBalance().catch(() => undefined);
  }

  public stopBalanceScheduler(): void {
    if (this.balanceTimer === null) return;
    clearInterval(this.balanceTimer);
    this.balanceTimer = null;
  }

  public setSettings(patch: AISettingsPatch): AIStatusView {
    const before = this.settings;
    const after = this.config.update(patch);
    this.llm.updateConfig(after.provider);

    // 主人称呼可以在设置里手填，手填优先（记忆里抽到的不会覆盖手填的非空值）
    if (typeof patch.userName === 'string' && patch.userName.trim() !== '') {
      this.memory.setUserName(patch.userName.trim());
    }
    if (after.memory && !before.memory) {
      // 打开记忆系统时才真正开始落盘（加载 + 建目录 + 记一条系统事件）
      this.memory.setEnabled(true);
      this.memory.load();
      if (after.userName.trim() !== '') this.memory.setUserName(after.userName.trim());
      this.memory.recordEvent('system', '记忆系统已开启');
    } else if (!after.memory && before.memory) {
      // 关掉立刻停止落盘（连跨天分隔线都不写）
      this.memory.setEnabled(false);
    }
    if (after.emotion && !before.emotion) {
      this.emotion.refreshTokens();
    }
    if (after.diary && !before.diary) {
      // 打开日记系统时补写昨天（开关是刚打开的，不算"历史补写"）
      void this.diary.dueCheck().catch(() => undefined);
    }
    this.logger.info('ai settings updated', {
      data: {
        enabled: after.enabled,
        chat: after.chat,
        memory: after.memory,
        emotion: after.emotion,
        diary: after.diary,
      },
    });
    this.lastError = '';
    this.emitStatus();
    return this.status();
  }

  public setPresence(presence: 'visible' | 'collapsed' | 'hidden'): void {
    const before = this.emotion.presence;
    if (before === presence) return;
    this.emotion.setPresence(presence);
    if (this.settings.memory) {
      const label = presence === 'visible' ? '主人把桌宠显示出来了' : presence === 'collapsed' ? '桌宠被收起（安静待着）' : '桌宠被隐藏了';
      this.memory.recordEvent('presence', label, { from: before, to: presence });
    }
    this.emitStatus();
  }

  /**
   * 记录一次互动：**只记互动本身**（记忆事件 + 回应统计），不加心情。
   *
   * 心情为什么拆出去：需求要求"互动动画播放结束才能加 mood 值"，
   * 而用户碰她的这一刻动画才刚开始请求/加载 —— 加心情由
   * `settleInteraction()` 在动画播完后完成（渲染层通过 `AIInteractionSettled` 上报）。
   */
  public notifyInteraction(kind: InteractionKind): AIStatusView {
    if (this.settings.memory) {
      const label: Record<InteractionKind, string> = {
        click: '主人点了点我',
        doubleclick: '主人双击了我',
        drag: '主人拖着我换了个位置',
        chat: '主人和我说了句话',
        diary: '主人看了日记',
        gift: '主人给了我好东西',
      };
      // 这里只记"互动当时的情绪"，mood 的涨落由 settleInteraction 记（那时才算得出来）
      this.memory.recordEvent('interaction', label[kind] ?? '主人互动了一下', {
        mood: this.emotion.get().mood,
      });
    }
    this.emitStatus();
    return this.status();
  }

  /**
   * 结算一次互动：**真正加心情**（互动动画播完后由渲染层调用）。
   *
   * 与 `notifyInteraction` 分开是刻意的：拖动、收起状态下点击、动画请求被冷却拒绝
   * 这些"没有动画可等"的互动也照样要涨心情 —— 所以"记互动"与"加心情"
   * 必须能各自独立发生，而不是捆在一次调用里。
   */
  public settleInteraction(kind: InteractionKind): AIStatusView {
    const before = this.emotion.get().mood;
    this.emotion.interact(kind);
    const after = this.emotion.get();
    // 心情掉破 20 时额外记一笔（日记里能看出起伏）
    if (this.settings.memory && before >= 20 && after.mood < 20) {
      this.memory.recordEvent('emotion', `心情掉到 ${after.mood}（${moodLabel(after.mood).label}）`);
    }
    this.emitStatus();
    return this.status();
  }

  public resetEmotion(): AIStatusView {
    this.emotion.reset();
    if (this.settings.memory) this.memory.recordEvent('system', '情绪已重置');
    this.emitStatus();
    return this.status();
  }

  /**
   * 记一笔 token 到"总账"和"本次运行"。
   *
   * 由 `LLMClient` 的 `onUsage` 回调触发，所以**每一次**成功的大模型调用都会走到这里；
   * 各调用点不需要（也不应该）再自己 `addUsage` —— 那样会重复计数。
   *
   * 两份账：
   * - `budget.used`：**持久化**的累计（跨重启，用来执行用户的 token 预算）；
   * - `sessionTokens` / `sessionUsage`：**本次运行**的用量（按用途分档），
   *   回答"她这一次开着花了多少、花在哪" —— 关掉程序就清零。
   */
  public recordUsage(tokens: number, purpose: LLMPurpose = 'other'): AIStatusView {
    if (!Number.isFinite(tokens) || tokens <= 0) return this.status();
    const value = Math.round(tokens);
    this.config.addUsage(value);
    this.sessionTokens += value;
    this.sessionUsage[purpose] = (this.sessionUsage[purpose] ?? 0) + value;
    this.emitStatus();
    return this.status();
  }

  /* ------------------------------------------------------------------ */
  /* 2.1 对话                                                            */
  /* ------------------------------------------------------------------ */

  /** 发一句话给桌宠。**永不抛异常**：失败也返回一条兜底回复。 */
  public async chat(text: string, source: 'chat-window' | 'tray' | 'plugin' | 'system' = 'chat-window'): Promise<AIChatReply> {
    const message = sanitizeMessage(text);
    if (message === '') {
      return { ok: false, reply: '（没听清，主人再说一次？）', mode: 'local', tokens: 0, error: '空消息', mood: this.emotion.get().mood, satiety: this.emotion.get().satiety };
    }

    /*
     * 说话也算互动（2.3）。
     *
     * 聊天的心情**立刻加**（不等动画）：她的回复动画要等模型回来之后才挑
     * （见 `pickAnimation('reply')`），而且挑哪一条本身依赖心情 ——
     * 等它播完再涨心情会变成"这次回复的反应按上一次的心情挑"。
     * 「等动画播完再加」只针对点击/双击那类**互动反应动画**。
     */
    this.notifyInteraction('chat');
    this.settleInteraction('chat');
    if (this.settings.memory) {
      this.memory.recordTurn({ at: new Date().toISOString(), role: 'user', text: message });
    }

    const usability = evaluateAIUsability(this.settings);
    let reply = '';
    let mode: 'llm' | 'local' = 'local';
    let tokens = 0;
    let error = '';

    if (usability.usable) {
      this.busy = true;
      this.emitStatus();
      try {
        const result = await this.completeWithTools(this.buildMessages(message));
        reply = sanitizeReply(result.text);
        mode = 'llm';
        tokens = result.totalTokens;
        this.lastError = '';
      } catch (llmError) {
        error = llmError instanceof LLMError ? llmError.message : describeError(llmError);
        this.lastError = error;
        this.logger.warn('llm chat failed; falling back to local reply', { error, data: { source } });
      } finally {
        this.busy = false;
      }
    } else {
      error = usability.reason;
      this.lastError = '';
    }

    if (reply === '') {
      reply = this.localReplyFor(message);
      mode = 'local';
      tokens = 0;
    }

    if (this.settings.memory) {
      this.memory.recordTurn({ at: new Date().toISOString(), role: 'pet', text: reply, tokens });
      // 规则抽取：不联网也能记住"我叫X""我在写论文"这类明确信息
      const heuristic = extractFactsHeuristic(message);
      if (heuristic.length > 0) this.memory.mergeFacts(heuristic);
      this.turnsSinceConsolidate += 1;
      void this.maybeConsolidate();
      // 长跑时也会跨天：顺手确认一次"今天清过没有"（内部有日期标记，开销可忽略）
      this.pruneMemory();
    }

    const animation = this.pickAnimation('reply');
    this.options.onSpeak?.({ text: reply, animation, kind: 'reply' });
    this.memory.recordEvent('chat', `主人：${message.slice(0, 60)} / 她：${reply.slice(0, 60)}`, {
      mode,
      tokens,
    });
    this.emitStatus();

    return {
      ok: reply !== '',
      reply,
      mode,
      tokens,
      ...(error !== '' && mode === 'local' ? { error } : {}),
      ...(animation ? { animation } : {}),
      mood: this.emotion.get().mood,
      satiety: this.emotion.get().satiety,
    };
  }

  /**
   * 一次"带工具的对话"：模型可以先查记忆，再回答（需求 7.3）。
   *
   * 为什么不是每轮都把记忆宫殿塞进提示词：那会白白占上下文与 token，
   * 而她绝大多数时候并不需要回忆"过去一起经历的事"。改成工具调用后，
   * **只有用户提到相关内容时**模型才会去查一次，我们执行本地检索再把内容回传。
   *
   * 循环有**硬上限**（`MAX_TOOL_ROUNDS`）：模型偶尔会反复查同一个东西，
   * 不设上限就会一直烧 token、用户也一直等。到上限就用现有文本作答。
   *
   * 记账：每一轮请求都 `calls += 1` 并累计 usage（这一轮可能发了 2~3 次请求）。
   */
  private async completeWithTools(messages: LLMMessage[]): Promise<LLMCompletionResult> {
    const conversation: LLMMessage[] = [...messages];
    let result = await this.requestCompletion(conversation, true);
    let totalTokens = result.totalTokens;

    let rounds = 0;
    while (result.toolCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
      rounds += 1;
      const results: LLMToolResult[] = result.toolCalls.map((call) =>
        executeTool(call, {
          getPalaceNodes: () => this.options.getPalaceNodes?.() ?? [],
          onToolRun: (info) => {
            // 她查了什么、查到没有 —— 写进记忆事件，事后可审计
            this.memory.recordEvent('system', `她查了记忆宫殿（${info.query}）：${info.hits} 条相关`, {
              tool: info.name,
              hits: info.hits,
            });
          },
        }),
      );
      this.logger.info('memory tool executed', {
        data: {
          round: rounds,
          calls: result.toolCalls.map((call) => call.name).join(','),
          hits: results.map((item) => (item.ok ? 'ok' : 'miss')).join(','),
        },
      });
      conversation.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
      conversation.push({ role: 'user', content: '', toolResults: results });

      const next = await this.requestCompletion(conversation, true);
      totalTokens += next.totalTokens;
      result = next;
    }

    return { ...result, totalTokens };
  }

  /** 发一次请求并记账（工具调用会走多轮，所以独立出来）。 */
  private async requestCompletion(
    messages: readonly LLMMessage[],
    withTools: boolean,
  ): Promise<LLMCompletionResult> {
    /*
     * `reasoningEffort: 'none'` + 至少 480 token 的正文预算。
     *
     * 为什么：她的回复本来就要求"1~3 句中文"，但**推理模型会先写几百字思考**，
     * 而默认的 220 token 连思考都不够 —— 实测会出现"空内容"（回复直接消失，
     * 界面上看起来就是她不理人）。关掉推理既有正文预算，又更快更省。
     */
    const result = await this.llm.complete({
      messages,
      maxTokens: Math.max(this.settings.provider.maxTokens, 480),
      reasoningEffort: 'none',
      purpose: withTools ? 'chat-tools' : 'chat',
      ...(withTools ? { tools: MEMORY_TOOLS } : {}),
    });
    this.calls += 1;
    this.emotion.refreshTokens();
    return result;
  }

  /** 组装 messages：人格 + 情绪 + 记忆 + 输出约束 + 最近对话。 */
  private buildMessages(userText: string): LLMMessage[] {
    const settings = this.settings;
    const context = settings.memory
      ? this.memory.buildContext(userText)
      : { facts: [], pastSnippets: [], todayEvents: [], recentTurns: [], factCount: 0, summary: '' };

    const systemLines: string[] = [settings.persona.trim()];
    if (settings.emotion) {
      systemLines.push('', '【你现在的状态】', describeEmotionForPrompt(this.emotion.get(), this.emotion.presence));
    }
    if (settings.memory) {
      const nameLine = settings.userName.trim() !== '' ? `主人的名字：${settings.userName.trim()}` : '';
      const factLines = context.facts.map((fact) => `- ${fact.key}：${fact.value}`);
      const snippetLines = context.pastSnippets.map((snippet) => `- ${snippet}`);
      const memoryBlock = [
        nameLine,
        context.factCount > 0 ? `你一共记得 ${context.factCount} 件关于主人的事，以下是最相关的几条：` : '',
        ...factLines,
        /*
         * 滚动前情（更早的对话被压成的一段）：它补上"只带最近 6 轮"造成的遗忘。
         * 放在事实之后、片段之前 —— 先说"长期记得的"，再说"最近相关的"。
         */
        context.summary.trim() === '' ? '' : `更早的对话，你记在心里（前情摘要）：${context.summary.trim()}`,
        snippetLines.length > 0 ? '过去几天相关的片段（可用于"你之前说过…"这类自然的提起）：' : '',
        ...snippetLines,
      ].filter((line) => line !== '');
      if (memoryBlock.length > 0) systemLines.push('', '【你记得的事】', ...memoryBlock);
    }
    /*
     * 「今天在做什么」：由感知模块的时间线聚合而来（不是模型的推测）。
     * 放在这里她才能自然地说"你今天上午一直在写代码吧" —— 这是需求里"形成记忆"的落点。
     */
    const timeline = (this.options.getDailyTimeline?.() ?? '').trim();
    if (timeline !== '') {
      systemLines.push('', '【主人今天在做什么（由你观察到的活动时间线统计，不是猜的）】', timeline,
        '可以自然地在聊天里提起（例如"你上午一直在写代码呢"），但不要照读、不要说"根据记录"；',
        '时间线里没有的事不要编。');
    }
    systemLines.push(
      '',
      '【输出要求】',
      '只输出你对主人说的那句话本身，1~3 句，可以用颜文字；',
      '不要写旁白、不要加引号、不要用 Markdown、不要提"作为 AI"。',
    );
    // 告诉她"有工具可用、什么时候用"（不然模型不会主动去查记忆宫殿）
    systemLines.push('', TOOL_HINT);

    const history: LLMMessage[] = settings.memory
      ? context.recentTurns
          .slice(0, 6)
          .reverse()
          .map((turn) => ({ role: turn.role === 'user' ? ('user' as const) : ('assistant' as const), content: turn.text }))
      : [];

    return [
      { role: 'system', content: systemLines.join('\n') },
      ...history,
      { role: 'user', content: userText },
    ];
  }

  /** 本地兜底回复（受情绪/记忆影响，见 local-replies.ts）。 */
  private localReplyFor(text: string): string {
    const settings = this.settings;
    const context = settings.memory ? this.memory.buildContext(text) : { facts: [] };
    return localReply({
      text,
      emotion: this.emotion.get(),
      presence: this.emotion.presence,
      userName: settings.userName,
      petName: settings.petName,
      facts: context.facts,
      hour: new Date().getHours(),
    });
  }

  /** 挑一个与情绪一致的动画（没有匹配的返回 null）。 */
  private pickAnimation(kind: 'greeting' | 'reply' | 'idle-chat'): string | null {
    if (!this.settings.emotion) return null;
    return preferredAnimation(this.emotion.get(), kind, this.options.getAvailableAnimations());
  }

  /* ------------------------------------------------------------------ */
  /* 2.2 记忆整理                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * 每 N 轮对话整理一次长期记忆。
   *
   * 大模型可用时让它读最近对话、输出结构化事实；不可用时只靠规则抽取
   * （`chat()` 里已经做了）。整理是**后台动作**，失败静默。
   */
  public async consolidate(reason: string): Promise<{ added: number; updated: number }> {
    if (!this.settings.memory) return { added: 0, updated: 0 };
    const turns = this.memory.recentTurns(12);
    if (turns.length === 0) return { added: 0, updated: 0 };

    // 无论模型是否可用，先把规则抽取跑一遍（零成本、确定性）
    let added = 0;
    let updated = 0;
    for (const turn of turns.filter((item) => item.role === 'user')) {
      const facts = extractFactsHeuristic(turn.text);
      if (facts.length > 0) {
        const result = this.memory.mergeFacts(facts);
        added += result.added;
        updated += result.updated;
      }
    }

    if (evaluateAIUsability(this.settings).usable) {
      try {
        const transcript = turns
          .slice()
          .reverse()
          .map((turn) => `${turn.role === 'user' ? '主人' : '她'}：${turn.text}`)
          .join('\n');
        const result = await this.llm.complete({
          messages: [
            {
              role: 'system',
              content: [
                '你是一个记忆整理器。阅读主人与桌宠的对话，只提取**主人明确说过**的长期信息。',
                '输出严格的 JSON 数组，元素形如 {"key":"interest","value":"写代码","confidence":0.9}。',
                'key 只能是：name, interest, routine, activity, project, preference, relation, note。',
                '没有任何值得长期记住的信息时输出 []。不要输出任何解释文字。',
              ].join('\n'),
            },
            { role: 'user', content: transcript },
          ],
          temperature: 0,
          maxTokens: 640,
      reasoningEffort: 'none',
          purpose: 'facts',
        });
        this.calls += 1;
        this.emotion.refreshTokens();
        const facts = extractFactsFromModelOutput(result.text);
        if (facts.length > 0) {
          const merged = this.memory.mergeFacts(facts);
          added += merged.added;
          updated += merged.updated;
          this.logger.info('memory consolidated by model', { data: { reason, added, updated } });
        }
      } catch (error) {
        this.logger.warn('model-based memory consolidation failed; heuristic results kept', {
          error: describeError(error),
        });
      }
    }

    this.turnsSinceConsolidate = 0;
    /*
     * 顺手滚动一次**前情摘要**（对话的压缩机制）：
     * 把"更早的那些轮"（除了最近 6 轮之外）压成一段 ≤600 字的前情。
     * 与事实抽取同一次整理里做，避免再排一次调度；失败只记日志。
     */
    await this.rollSummary().catch((error: unknown) => {
      this.logger.warn('rolling summary failed', { error: describeError(error) });
    });
    this.emitStatus();
    return { added, updated };
  }

  /**
   * 滚动前情摘要：`旧摘要 + 更早的轮次 -> 新摘要`（写进 `profile.summary`，进聊天提示词）。
   *
   * 两个刻意的选择：
   * - **最近 6 轮不并入**：那几轮本来就会原样进 prompt（`recentTurns(6)`），压进去是浪费；
   * - **没模型也滚动**：用 `fallbackRollingSummary()`（抽取式），否则"没配密钥"时
   *   这条机制会静默失效，而它恰恰是长会话里最需要的。
   */
  public async rollSummary(): Promise<string> {
    if (!this.settings.memory) return '';
    const turns = this.memory.recentTurnsAcrossDays(60);
    const older = turns.slice(0, Math.max(0, turns.length - 6));
    const previous = this.memory.getProfile().summary;
    const covered = this.memory.getProfile().summaryTurns ?? 0;
    // 没有新的更早轮次就不重复摘要（同一个输入不该产生新的一次调用）
    if (older.length === 0 || older.length <= covered) return previous;

    // 与上面的事实抽取保持同一种模式：能不能用模型由 `evaluateAIUsability` 决定
    if (evaluateAIUsability(this.settings).usable) {
      const messages = buildRollingSummaryMessages({ previous, turns: older, petName: this.settings.petName });
      const result = await this.llm.complete({
        messages: [
          { role: 'system', content: messages.system },
          { role: 'user', content: messages.user },
        ],
        temperature: 0.3,
        maxTokens: 700,
      reasoningEffort: 'none',
        purpose: 'summary',
      });
      this.calls += 1;
      this.emotion.refreshTokens();
      const summary = sanitizeSummary(result.text);
      if (summary !== '') {
        this.memory.setSummary(summary, older.length);
        this.logger.info('rolling summary updated by model', { data: { turns: older.length, chars: summary.length } });
        return summary;
      }
    }
    const fallback = fallbackRollingSummary(previous, older);
    this.memory.setSummary(fallback, older.length);
    this.logger.info('rolling summary updated (local)', { data: { turns: older.length, chars: fallback.length } });
    return fallback;
  }

  /** 到点了就整理（不阻塞对话）。 */
  private async maybeConsolidate(): Promise<void> {
    const every = this.settings.consolidateEvery;
    if (every <= 0) return;
    if (this.turnsSinceConsolidate < every) return;
    await this.consolidate('auto');
  }

  public memorySnapshot(): MemorySnapshot {
    return this.memory.snapshot();
  }

  public clearMemory(): MemorySnapshot {
    const snapshot = this.memory.clear();
    this.turnsSinceConsolidate = 0;
    this.emitStatus();
    return snapshot;
  }

  public history(limit = 20): ChatTurn[] {
    return this.memory.recentTurns(limit);
  }

  public get memoryLogFile(): string {
    return this.memory.memoryLogFile;
  }

  /* ------------------------------------------------------------------ */
  /* 2.4 日记                                                            */
  /* ------------------------------------------------------------------ */

  private isDiaryEnabled(): boolean {
    return this.settings.enabled && this.settings.diary;
  }

  public diarySnapshot(): DiarySnapshot {
    return this.diary.snapshot();
  }

  public getDiary(date: string): DiaryEntry | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return this.diary.get(date);
  }

  public async writeDiary(date: string = todayKey(), force = true): Promise<DiaryEntry> {
    const entry = await this.diary.write(date, force);
    this.emitStatus();
    return entry;
  }

  /** 组装某天的日记素材（真实数据：对话 + 事件 + 心情曲线）。 */
  private buildDiaryContext(date: string): DiaryContext {
    const settings = this.settings;
    const turns = this.memory.turnsOn(date);
    const events = this.memory.eventsOn(date);
    const chatHighlights = turns
      .filter((turn) => turn.role === 'user')
      .slice(-6)
      .map((turn) => `主人说：${turn.text.slice(0, 60)}`);
    const eventHighlights = events
      .filter((event) => event.kind === 'interaction' || event.kind === 'emotion' || event.kind === 'presence')
      .slice(-6)
      .map((event) => `${event.at.slice(11, 16)} ${event.text}`);
    return {
      date,
      userName: settings.userName,
      petName: settings.petName,
      turns,
      events,
      mood: this.emotion.moodCurve(date),
      satiety: this.emotion.get().satiety,
      highlights: { chat: chatHighlights, event: eventHighlights },
    };
  }

  /** 生成日记正文：优先大模型，失败走本地模板（数据都是真的）。 */
  private async composeDiary(context: DiaryContext): Promise<{ title: string; body: string; source: 'llm' | 'template'; tokens: number }> {
    const settings = this.settings;
    const fallback = (): { title: string; body: string; source: 'template'; tokens: number } => {
      const draft = localDiary({
        date: context.date,
        userName: context.userName,
        turns: context.turns.filter((turn) => turn.role === 'user').length,
        chatHighlights: context.highlights.chat,
        eventHighlights: context.highlights.event,
        mood: context.mood,
        satiety: context.satiety,
        petName: context.petName,
      });
      return { ...draft, source: 'template', tokens: 0 };
    };

    if (!evaluateAIUsability(settings).usable) return fallback();

    const transcript = context.turns
      .slice(-40)
      .map((turn) => `${turn.role === 'user' ? '主人' : '我'}：${turn.text.slice(0, 200)}`)
      .join('\n');
    const factLines = this.memory
      .getProfile()
      .facts.slice(0, 10)
      .map((fact) => `- ${fact.key}：${fact.value}`)
      .join('\n');

    try {
      const result = await this.llm.complete({
        messages: [
          {
            role: 'system',
            content: [
              settings.persona,
              '',
              `现在请你写今天的日记：以「${settings.petName}」的第一视角，回顾今天和主人相处的一天。`,
              '要求：4~8 句中文，口语化，像小猫小狗一样的内心独白；有细节、有情绪起伏；',
              '不要写标题、不要用 Markdown 标题、不要分点、不要提"AI"或"数据"。',
              '如果主人今天很忙或没怎么理你，可以写一点小小的失落，但结尾要温暖。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `日期：${context.date}`,
              `今天的对话（可能为空）：`,
              transcript === '' ? '（今天没有说话）' : transcript,
              '',
              '今天记住的事：',
              factLines === '' ? '（无）' : factLines,
              '',
              `情绪：${context.mood.start} → ${context.mood.end}（最低 ${context.mood.low}）`,
              // 滚动前情：日记里也该带上"更早的那些天"，否则日记只看得到今天
              ...(this.memory.getProfile().summary.trim() === ''
                ? []
                : ['', '更早的对话（前情摘要）：', this.memory.getProfile().summary.trim()]),
              `互动片段：`,
              context.highlights.event.length > 0 ? context.highlights.event.join('\n') : '（无）',
              // 今天在做什么（感知模块的时间线）：日记里提一句会让"她记得主人"更具体
              ...(this.options.getDailyTimeline?.() ?? '').trim() === ''
                ? []
                : ['', '主人今天的活动时间线（统计而来，不是猜的）：', (this.options.getDailyTimeline?.() ?? '').trim()],
            ].join('\n'),
          },
        ],
        temperature: 0.9,
        maxTokens: 900,
      reasoningEffort: 'none',
        purpose: 'diary',
      });
      this.calls += 1;
      this.emotion.refreshTokens();
      const body = sanitizeDiary(result.text);
      if (body.trim() === '') return fallback();
      return {
        title: `${settings.petName}的日记 · ${context.date}`,
        body,
        source: 'llm',
        tokens: result.totalTokens,
      };
    } catch (error) {
      this.logger.warn('llm diary failed; using local template', { error: describeError(error) });
      this.lastError = describeError(error);
      this.emitStatus();
      return fallback();
    }
  }

  private handleDiaryWritten(entry: DiaryEntry): void {
    this.memory.recordEvent('diary', `写下了 ${entry.date} 的日记（${entry.source === 'llm' ? '大模型' : '本地模板'}）`, {
      mood: entry.mood,
      tokens: entry.tokens,
    });
    this.options.onSpeak?.({
      text: `我把今天的日记写好啦，要看看吗？`,
      animation: this.pickAnimation('greeting'),
      kind: 'proactive',
    });
    /*
     * 日记**不再**记进小纸条（需求："日记不要记到小纸条"）。
     * 日记留在 `diary/`（设置窗口与「交互」窗口都能看），小纸条只放她自己记的事与收好的文件。
     * 旧数据里已经记过的 `kind: 'diary'` 纸条仍然能读、能删，只是不再新增。
     */
    try {
      this.options.onDiaryWritten?.(entry);
    } catch (error) {
      // 推给界面的回调失败不该影响"日记已经写好"这件事
      this.logger.warn('onDiaryWritten handler failed', { error: describeError(error) });
    }
    this.emitStatus();
  }

  /* ------------------------------------------------------------------ */
  /* 小纸条（她的收纳夹）                                                 */
  /* ------------------------------------------------------------------ */

  public get noteService(): NoteService {
    return this.notes;
  }

  public noteBox(): NoteBox {
    return this.notes.snapshot();
  }

  /** 你点了「让她记一件」：让她自己挑一件重要的事记下来。 */
  public async composeNote(): Promise<NoteBox> {
    return this.notes.composeDraft();
  }

  public markNotesRead(): NoteBox {
    return this.notes.markAllRead();
  }

  public clearNotes(): NoteBox {
    return this.notes.clear();
  }

  /** 删掉一条纸条（只删记录，文件要单独在「文件」页签里删）。 */
  public removeNote(id: string): NoteBox {
    return this.notes.remove(id);
  }

  /**
   * 把一个文件收进收纳夹（`notes/files/`）并记一条纸条。
   *
   * 这是"后续整理的文件都放到这个系统里"的入口：文件被**复制**进收纳夹，
   * 纸条上带回新路径与大小。目前有两个调用方：
   * 「收纳文件…」按钮（你挑一个文件交给她收着）与将来的"整理文件"功能。
   */
  public async fileNote(input: {
    readonly sourcePath: string;
    readonly name?: string;
    readonly title?: string;
    readonly text?: string;
  }): Promise<NoteBox> {
    return this.notes.record({
      kind: 'file',
      title: input.title,
      text: input.text ?? '',
      files: [{ sourcePath: input.sourcePath, ...(input.name !== undefined ? { name: input.name } : {}) }],
    });
  }

  /**
   * 把一个**内存里的文件**投递到收件箱（插件路径，权限 `mail`）。
   *
   * 与 `fileNote` 的区别只有"内容从哪来"：那个复制磁盘上的源文件，
   * 这个直接写 Buffer —— 插件拿不到文件系统，只能把内容交上来。
   */
  public deliverMail(delivery: MailDelivery): MailDeliveryResult {
    return this.notes.deliver(delivery);
  }

  /**
   * 组装"记一件"的上下文：她此刻的状态 + 她记得的事 + 今天在做什么 + 已经记过的。
   *
   * 与聊天/日记用的是同一批真实数据源 —— 她记下来的东西也必须有出处。
   */
  private buildNoteContext(): NoteContext {
    const settings = this.settings;
    const context = settings.memory
      ? this.memory.buildContext('')
      : { facts: [], pastSnippets: [], todayEvents: [], recentTurns: [], factCount: 0, summary: '' };
    return {
      userName: settings.userName,
      petName: settings.petName,
      emotion: this.emotion.get(),
      facts: context.facts,
      timeline: this.options.getDailyTimeline?.() ?? '',
      recentNotes: this.notes.snapshot().notes
        .slice(0, 5)
        .map((note) => ({ title: note.title, text: note.text.slice(0, 60) })),
      hour: new Date().getHours(),
    };
  }

  /** 生成一条"她记的"纸条文案：优先大模型，不可用/失败走本地兜底。 */
  private async composeNoteDraft(): Promise<{ title: string; text: string; source: 'llm' | 'template'; tokens: number }> {
    const context = this.buildNoteContext();
    const fallback = (): { title: string; text: string; source: 'template'; tokens: number } => {
      const draft = localNoteDraft(`${context.hour}|${context.emotion.mood}|${context.petName}`);
      return { ...draft, source: 'template', tokens: 0 };
    };
    if (!evaluateAIUsability(this.settings).usable) return fallback();

    const messages = buildNoteMessages(context);
    try {
      const result = await this.llm.complete({
        messages: [
          { role: 'system', content: messages.system },
          { role: 'user', content: messages.user },
        ],
        temperature: 0.85,
        maxTokens: 400,
      reasoningEffort: 'none',
        purpose: 'note',
      });
      this.calls += 1;
      this.emotion.refreshTokens();
      const parsed = splitNoteOutput(sanitizeNote(result.text), '一件重要的事');
      if (parsed.text === '') return fallback();
      return { ...parsed, source: 'llm', tokens: result.totalTokens };
    } catch (error) {
      this.logger.warn('llm note draft failed; using local template', { error: describeError(error) });
      this.lastError = describeError(error);
      this.emitStatus();
      return fallback();
    }
  }

  /**
   * 收件箱变了：记一条记忆事件，必要时冒个泡。
   *
   * - **她自己记的**（`manual`）：冒一句"我记在收件箱里了"；
   * - **插件投递的**（`sender.kind === 'plugin'`）：不冒泡（插件自己可以用 `ui.say` 说），
   *   但要记进记忆，这样"某个插件往这里放了东西"在时间线上查得到；
   * - **文件/日记旧数据**：不冒泡（写日记时已经说过话了，避免连着两句）。
   */
  private handleNotesChanged(_box: NoteBox, change: NoteChange): void {
    const note = change.added[0];
    if (note) {
      const attachment = note.files.map((file) => file.name).join('、');
      this.memory.recordEvent('chat', `我在交互里记下了：${note.title}`, {
        kind: note.kind,
        source: note.source,
        from: note.sender.id ?? note.sender.kind,
        ...(attachment === '' ? {} : { files: attachment }),
      });
      if (note.kind === 'manual') {
        this.options.onSpeak?.({
          text: '我把这件事记在交互里啦～',
          animation: this.pickAnimation('greeting'),
          kind: 'proactive',
        });
      }
    }
    this.emitStatus();
  }

  /**
   * 记忆**明细流水**的保留期清理（每天最多一次）。
   *
   * 与感知的 `retentionDays`、反思的 `keepReflectionDays` 同一套路数：
   * 原始流水按天增长（实测 30–43KB/天），必须有清理；而"整理过的结论"
   * （长期事实、记忆宫殿）另有各自的容量控制，不在这里动。
   *
   * @param force 手动触发（调试/验收入口），忽略"今天已经清过"的标记
   */
  public pruneMemory(force = false): { days: number; logSections: number } {
    const keepDays = this.settings.keepMemoryDays;
    if (!force && keepDays <= 0) return { days: 0, logSections: 0 };
    const today = todayKey();
    if (!force && this.lastMemoryPruneDay === today) return { days: 0, logSections: 0 };
    this.lastMemoryPruneDay = today;
    const result = this.memory.pruneOldData(force ? keepDays : keepDays);
    if (result.days > 0 || result.logSections > 0) {
      this.memory.recordEvent('system', `按保留期（${keepDays} 天）清理了 ${result.days} 天的记忆流水`);
    }
    return result;
  }

  /** 记忆明细清理的日期标记（一天只做一次）。 */
  private lastMemoryPruneDay = '';

  /* ------------------------------------------------------------------ */
  /* 连通性自检                                                          */
  /* ------------------------------------------------------------------ */

  public async testConnection(): Promise<AITestResult> {
    const startedAt = Date.now();
    const usability = evaluateAIUsability(this.settings);
    if (!usability.usable) {
      return {
        ok: false,
        mode: 'local',
        latencyMs: 0,
        sample: '',
        error: usability.reason,
        tokens: 0,
      };
    }
    this.busy = true;
    this.emitStatus();
    try {
      const result = await this.llm.complete({
        messages: [
          { role: 'system', content: '你是一只桌宠。只回一句话。' },
          { role: 'user', content: '用一句话跟我打个招呼。' },
        ],
        maxTokens: 240,
      reasoningEffort: 'none',
        purpose: 'speak-up',
        timeoutMs: Math.min(15000, this.settings.provider.timeoutMs),
      });
      this.calls += 1;
      this.emotion.refreshTokens();
      this.lastError = '';
      return {
        ok: true,
        mode: 'llm',
        latencyMs: Date.now() - startedAt,
        sample: sanitizeReply(result.text),
        error: '',
        tokens: result.totalTokens,
      };
    } catch (error) {
      const message = error instanceof LLMError ? error.message : describeError(error);
      this.lastError = message;
      return { ok: false, mode: 'llm', latencyMs: Date.now() - startedAt, sample: '', error: message, tokens: 0 };
    } finally {
      this.busy = false;
      this.emitStatus();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 内部                                                                */
  /* ------------------------------------------------------------------ */

  /** 主动搭话（托盘菜单「让她说句话」/ 心情提醒都走这里）。 */
  public async speakUp(reason: 'tray' | 'greeting' | 'lonely'): Promise<AIChatReply> {
    if (!this.settings.enabled) {
      const text = '主人，我在的哦。';
      const animation = this.pickAnimation('greeting');
      this.options.onSpeak?.({ text, animation, kind: 'proactive' });
      return { ok: true, reply: text, mode: 'local', tokens: 0, mood: this.emotion.get().mood, satiety: this.emotion.get().satiety, ...(animation ? { animation } : {}) };
    }
    const promptText =
      reason === 'lonely'
        ? '（主人很久没理你了，主动说一句话找他，可以带一点点委屈）'
        : reason === 'greeting'
          ? '（主人刚把你叫出来，主动打个招呼）'
          : '（主人点了"让她说句话"，主动说点什么）';
    return this.chat(promptText, reason === 'tray' ? 'tray' : 'system');
  }

  /**
   * 情绪驱动的主动行为：心情过低时轻轻说一句（最多 30 分钟一次）。
   *
   * 这是"她有自己的状态"的关键体现 —— 不是只在你打字时才活过来。
   */
  private lastLonelyAt = 0;

  public maybeLonelySpeak(now: number = Date.now()): void {
    if (!this.settings.enabled || !this.settings.chat || !this.settings.emotion) return;
    if (this.emotion.presence !== 'visible') return;
    const mood = this.emotion.get().mood;
    if (mood >= 25) return;
    if (now - this.lastLonelyAt < 30 * 60000) return;
    this.lastLonelyAt = now;
    void this.speakUp('lonely');
  }

  public formatStatusLine(): string {
    const status = this.status();
    return `AI=${status.mode} · ${formatEmotion(status.emotion, status.presence)} · calls=${status.calls} · tokens=${status.tokensUsed}`;
  }

  /** 供日志/调试：当前 prompt 里注入的记忆摘要。 */
  public describeContext(query: string): string {
    const context = this.memory.buildContext(query);
    return JSON.stringify({
      facts: context.facts.map((fact) => `${fact.key}=${fact.value}`),
      past: context.pastSnippets,
      turns: context.recentTurns.length,
      mood: this.emotion.get().mood,
      satiety: this.emotion.get().satiety,
      tokensRemaining: Math.round(tokensRemainingRatio(this.settings.budget) * 100),
    });
  }

  private emitStatus(): void {
    try {
      this.options.onStatus?.(this.status());
    } catch (error) {
      this.logger.warn('ai onStatus handler failed', { error: describeError(error) });
    }
  }

  /** 强制按当前状态重新计算一次（供心跳/外部触发）。 */
  public heartbeat(now: number = Date.now()): void {
    this.emotion.tick(now);
    this.maybeLonelySpeak(now);
    this.emitStatus();
  }

  /** 记录一条自定义事件（controller 用）。记忆关闭时**不写盘**。 */
  public recordEvent(kind: MemoryEventKind, text: string, data?: Record<string, unknown>): void {
    if (!this.settings.memory) return;
    this.memory.recordEvent(kind, text, data);
  }
}

/* -------------------------------------------------------------------------- */
/* 文本清洗                                                                    */
/* -------------------------------------------------------------------------- */

/** 用户输入清洗：去掉控制字符、限长、压掉多余空白。 */
export function sanitizeMessage(text: string): string {
  return (typeof text === 'string' ? text : '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * 模型回复清洗：很多模型会加引号、加"她轻声说："这类旁白，甚至加 Markdown。
 * 桌宠的气泡只有一块小地方，所以这里把包装层剥掉并限长。
 */
export function sanitizeReply(text: string): string {
  let reply = (typeof text === 'string' ? text : '').trim();
  reply = reply.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  // 去掉整体包裹的引号/书名号
  reply = reply.replace(/^["'“”‘’「『]+/, '').replace(/["'“”‘’」』]+$/, '').trim();
  // 去掉"她轻声说："这类前缀（模型爱加）
  reply = reply.replace(/^[（(]?[^：:\n]{0,12}(轻声|小声|笑着|歪头)?(说|回答|道)[：:]\s*/, '').trim();
  return reply.slice(0, 300);
}

/** 日记正文清洗：去掉标题行与 Markdown 记号的干扰。 */
export function sanitizeDiary(text: string): string {
  let body = (typeof text === 'string' ? text : '').trim();
  body = body.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  body = body.replace(/^#+\s*.+$/gm, '').trim();
  return body.slice(0, 4000);
}

/** 情绪结算的便捷入口（供外部按需触发一次）。 */
export function emotionAfterInteraction(
  state: Parameters<typeof applyInteraction>[0],
  kind: InteractionKind,
  now: number = Date.now(),
): ReturnType<typeof applyInteraction> {
  return applyInteraction(state, kind, now);
}
