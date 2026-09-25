/**
 * 成长服务（4.1 记忆宫殿 + 4.2 自我反思）—— 编排层。
 *
 * 需求给的流程：
 *
 *   Interaction ──► Memory ──► Reflection ──► Behavior Update
 *      │             │            │                 │
 *      │             │            │                 └─ PolicyOverlay -> 感知模块的频率闸门
 *      │             │            └─ 每天 23 点（可配）+ 启动补写昨天 + 手动触发
 *      │             └─ 记忆节点（记忆宫殿）+ 当天素材（对话/情绪/场景/深夜）
 *      └─ 主动开口的反馈：主人有没有在 3 分钟内回应（回应率是她反思的依据）
 *
 * 与其他模块的边界（刻意用回调注入，服务之间不互相 import）：
 * - 素材来自 AI 模块（对话）、情绪模块（心情曲线）、感知模块（场景/习惯）；
 * - 结论送回感知模块（`onPolicyChanged`）—— **只收紧**，见 shared/growth.ts 的说明。
 */

import type {
  GrowthSettings,
  GrowthSettingsPatch,
  GrowthStatus,
  MemoryNode,
  MemoryNodeDraft,
  MemoryNodeKind,
  PolicyOverlay,
  ReflectionEntry,
  ReflectionInsight,
} from '../../shared/growth-types';
import { DEFAULT_GROWTH_SETTINGS, NODE_KINDS } from '../../shared/growth-types';
import {
  applyInsights,
  daysBetween,
  compressPalaceNodes,
  defaultPolicyOverlay,
  describePolicy,
  groupByMonth,
  heuristicInsights,
  localReflection,
  mergeNodes,
  parseReflection,
  reflectionSystemPrompt,
  renderPalaceMarkdown,
  responseStats,
  sceneName,
  suggestNodes,
} from '../../shared/growth';
import type { PerceptionSettings } from '../../shared/perception-types';
import type { ChatTurn } from '../../shared/ai-types';
import type { LLMClient } from '../ai/llm-client';
import { LLMError } from '../ai/llm-client';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import { GrowthStore, sanitizeGrowthSettings } from './growth-store';

/** 主动开口后，多久之内用户有反应算"被回应"。 */
const RESPONSE_WINDOW_MS = 3 * 60000;

export interface GrowthServiceOptions {
  /** 数据根目录（`%APPDATA%\DesktopPet`）。 */
  readonly dataDir: string;
  readonly logger: Logger;
  /** 大模型（没配密钥时反思走本地模板）。 */
  readonly getClient: () => LLMClient | null;
  readonly isLLMUsable: () => boolean;
  /* -------- 素材来源（由 main 注入） -------- */
  readonly getChatTurns: (date: string) => readonly ChatTurn[];
  readonly getMoodCurve: (date: string) => { readonly start: number; readonly end: number; readonly low: number };
  readonly getSceneCounts: (date: string) => Readonly<Record<string, number>>;
  readonly getHabitSamples: () => number;
  readonly getCurrentScene: () => string;
  /** 策略变化 -> 主进程转给感知服务（只收紧）。 */
  readonly onPolicyChanged: (overlay: PolicyOverlay, perception: PerceptionSettings) => void;
  /** 感知的用户设置（用于把倍率换算成"人话"）。 */
  readonly getPerceptionSettings: () => PerceptionSettings;
  readonly onStatus?: (status: GrowthStatus) => void;
  /** 她"回忆"某个节点时要说的话（进气泡）。 */
  readonly onSpeak?: (text: string, animation: string | null) => void;
}

export class GrowthService {
  private readonly options: GrowthServiceOptions;
  private readonly logger: Logger;
  private readonly store: GrowthStore;

  private settings: GrowthSettings = { ...DEFAULT_GROWTH_SETTINGS };
  private nodes: MemoryNode[] = [];
  private policy: PolicyOverlay = defaultPolicyOverlay();
  /** 待判定的主动开口（还没到窗口期）。 */
  private pending: { at: number; key: string; kind: string; text: string; scene: string }[] = [];
  private lastError = '';
  private timer: NodeJS.Timeout | null = null;
  /** 上次做"记忆宫殿压缩"的日子（每天一次）。 */
  private lastCompressDay = '';
  private busy = false;

  public constructor(options: GrowthServiceOptions) {
    this.options = options;
    this.logger = options.logger;
    this.store = new GrowthStore({ dataDir: options.dataDir, logger: options.logger });
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  public load(): void {
    const loaded = this.store.load();
    this.settings = loaded.settings;
    this.nodes = [...loaded.nodes];
    this.policy = loaded.policy;

    // `keepReflectionDays` 要真的生效：把超期的反思与反馈流水归档删掉（默认 180 天）。
    // 之前这个设置只存在于类型与面板里，属于"面板承诺了但代码没做"（文档评审抓到）。
    this.pruneOldReflections();

    /*
     * 记忆宫殿压缩：把"很久以前、同种类同标题、反复发生"的节点折成一条
     * （原始节点进 `memory/archive/palace-<年>.json`）。启动时做一次，
     * 之后每天由调度器做一次 —— 时间轴不该无限变长。
     */
    this.compressPalace();

    // 第一次见面节点：装上她就该有一笔"起点"（用户可以在设置里改日期）
    if (this.settings.palace && !this.nodes.some((node) => node.kind === 'first-meet')) {
      this.addDrafts([
        {
          kind: 'first-meet',
          title: '我们第一次见面',
          detail: '从这天起，我住进了你的桌面。',
          at: this.settings.firstMeetAt !== '' ? this.settings.firstMeetAt : new Date().toISOString(),
          source: 'auto',
          evidence: [],
        },
      ], { silent: true });
    }

    this.emitPolicy();
    this.startScheduler();
    this.logger.info('growth module ready', {
      data: { nodes: this.nodes.length, reflections: this.store.recentReflections(1).length, policy: this.policy.adjustments },
    });
  }

  public dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 压缩记忆宫殿（把很久以前的同类反复经历折成一条），原始节点留档。
   *
   * 触发点：启动时一次 + 调度器每天一次（跟反思检查同一个心跳）。
   * `palaceCompressMonths <= 0` 或宫殿开关关掉时**什么都不做**（不写盘）。
   */
  public compressPalace(now: number = Date.now()): GrowthStatus {
    if (!this.settings.palace || this.settings.palaceCompressMonths <= 0) return this.status();
    const result = compressPalaceNodes(this.nodes, { nowMs: now, months: this.settings.palaceCompressMonths });
    if (result.merged === 0 || result.removed.length === 0) return this.status();
    // 先把被折掉的原始节点写进归档，再落盘新节点 —— 顺序反了就有丢数据窗口
    this.store.appendPalaceArchive(result.removed, now);
    this.nodes = result.nodes;
    this.store.saveNodes(this.nodes);
    this.store.savePalaceMarkdown(renderPalaceMarkdown(this.nodes, this.daysTogether()));
    this.logger.info('palace compressed', {
      data: { merged: result.merged, removed: result.removed.length, nodes: this.nodes.length, months: this.settings.palaceCompressMonths },
    });
    this.emitStatus();
    return this.status();
  }

  /** 按 `keepReflectionDays` 清理超期反思（启动时一次；反思关掉时不动它的目录）。 */  private pruneOldReflections(now: number = Date.now()): void {
    if (!this.settings.reflection) return;
    const removed = this.store.pruneReflections(this.settings.keepReflectionDays, now);
    if (removed > 0) {
      this.store.logPolicyAdjustment([`按保留天数（${this.settings.keepReflectionDays} 天）清理了 ${removed} 个超期反思文件`], this.policy);
    }
  }

  /** 每分钟检查：反馈窗口到期 + 到点反思 + 补写昨天。 */
  private startScheduler(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.resolveFeedback(Date.now());
        void this.dueCheck();
        // 记忆宫殿压缩：每天一次（与反思检查同一个心跳）。
        // 跨天判断在 compressPalace 里没有，所以这里自己记一个"上次压缩的日子"。
        const today = todayKey();
        if (this.lastCompressDay !== today) {
          this.lastCompressDay = today;
          this.compressPalace();
        }
      } catch (error) {
        this.logger.warn('growth scheduler tick failed', { error: describeError(error) });
      }
    }, 60000);
    this.timer.unref?.();
    // 启动时立刻补一次（程序不是 24 小时开着的）
    void this.dueCheck().catch((error: unknown) => {
      this.logger.warn('growth catch-up failed', { error: describeError(error) });
    });
  }

  /* ------------------------------------------------------------------ */
  /* 4.2 反馈收集                                                        */
  /* ------------------------------------------------------------------ */

  /** 记录一次主动开口（由主进程的干预回调调用）。 */
  public recordIntervention(input: { at?: number; kind: string; text: string; scene: string }): void {
    if (!this.settings.reflection) return;
    const at = input.at ?? Date.now();
    const item = { at, key: `${at}|${input.text}`, kind: input.kind, text: input.text.slice(0, 120), scene: input.scene };
    this.pending.push(item);
    // 先落一条"未回应"，窗口到期或收到回应时再补一条覆盖记录
    this.store.appendFeedback({
      at: new Date(at).toISOString(),
      kind: item.kind,
      text: item.text,
      scene: item.scene,
      responded: false,
      responseSeconds: null,
    });
  }

  /** 用户有任何动作（互动/对话）都调它：可能命中某个待判定的开口。 */
  public recordUserActivity(now: number = Date.now()): void {
    if (this.pending.length === 0) return;
    const remaining: typeof this.pending = [];
    for (const item of this.pending) {
      const elapsed = now - item.at;
      if (elapsed > RESPONSE_WINDOW_MS) {
        remaining.push(item);
        continue;
      }
      this.store.appendFeedback({
        at: new Date(item.at).toISOString(),
        kind: item.kind,
        text: item.text,
        scene: item.scene,
        responded: true,
        responseSeconds: Math.max(0, Math.round(elapsed / 1000)),
      });
      this.logger.debug('intervention responded', { data: { kind: item.kind, seconds: Math.round(elapsed / 1000) } });
    }
    this.pending = remaining;
  }

  /** 窗口到期的开口判为"没被回应"并移出待判定队列。 */
  private resolveFeedback(now: number): void {
    if (this.pending.length === 0) return;
    this.pending = this.pending.filter((item) => now - item.at <= RESPONSE_WINDOW_MS);
  }

  /* ------------------------------------------------------------------ */
  /* 4.1 记忆宫殿                                                        */
  /* ------------------------------------------------------------------ */

  public getNodes(): readonly MemoryNode[] {
    return this.nodes;
  }

  /** 记忆宫殿的可读镜像文件（"打开"按钮用）。 */
  public get palacePath(): string {
    return this.store.palacePath;
  }

  /** 策略调整历史文件（"打开"按钮用）。 */
  public get policyLogPath(): string {
    return this.store.policyLogPath;
  }

  /** 今天（或指定日期）的素材 -> 规则抽取节点。 */
  public refreshPalace(date: string = todayKey()): GrowthStatus {
    if (!this.settings.palace) return this.status();
    const drafts = this.buildDraftsForDay(date);
    this.addDrafts(drafts, { silent: false });
    return this.status();
  }

  private buildDraftsForDay(date: string): MemoryNodeDraft[] {
    const turns = this.options.getChatTurns(date);
    const messages = turns.filter((turn) => turn.role === 'user').map((turn) => turn.text);
    const sceneCounts = this.options.getSceneCounts(date);
    const mood = this.options.getMoodCurve(date);
    const lateNight = lateNightActivity(turns);
    return suggestNodes({
      now: Date.now(),
      firstMeetAt: this.settings.firstMeetAt,
      messages,
      lateNight,
      existing: this.nodes,
      moodLow: mood.low,
      sceneCounts,
      habitSamples: this.options.getHabitSamples(),
    });
  }

  private addDrafts(drafts: readonly MemoryNodeDraft[], options: { silent: boolean }): void {
    if (drafts.length === 0) return;
    const result = mergeNodes(this.nodes, drafts);
    if (result.added.length === 0 && result.updated.length === 0) return;
    this.nodes = result.nodes;
    this.store.saveNodes(this.nodes);
    this.store.savePalaceMarkdown(renderPalaceMarkdown(this.nodes, this.daysTogether()));
    this.logger.info('memory palace updated', {
      data: { added: result.added.length, updated: result.updated.length, total: this.nodes.length },
    });
    if (!options.silent && result.added.length > 0) {
      const node = result.added[0];
      if (node) {
        this.options.onSpeak?.(`我把「${node.title}」记进记忆宫殿了。`, 'talk');
      }
    }
    this.emitStatus();
  }

  /** 手动记一笔（开关关掉时不写盘，并明确告诉用户为什么）。 */
  public addNode(input: { kind: MemoryNodeKind; title: string; detail: string }, now: number = Date.now()): GrowthStatus {
    if (!this.settings.palace) {
      // 与其它模块保持一致：开关关掉 = 不写盘。但**必须给出理由**，
      // 否则用户点"保存"没反应会以为是坏的。
      this.lastError = '记忆宫殿开关已关闭，这一笔没有写进去（设置 → 成长与反思）。';
      this.emitStatus();
      return this.status();
    }
    const kind: MemoryNodeKind = (Object.keys(NODE_KINDS) as MemoryNodeKind[]).includes(input.kind) ? input.kind : 'manual';
    const title = input.title.trim().slice(0, 120);
    if (title === '') return this.status();
    this.addDrafts(
      [
        {
          kind,
          title,
          detail: input.detail.trim().slice(0, 400),
          at: new Date(now).toISOString(),
          source: 'manual',
          evidence: [],
        },
      ],
      { silent: true },
    );
    return this.status();
  }

  public removeNode(id: string): GrowthStatus {
    const before = this.nodes.length;
    this.nodes = this.nodes.filter((node) => node.id !== id);
    if (this.nodes.length !== before) {
      this.store.saveNodes(this.nodes);
      this.store.savePalaceMarkdown(renderPalaceMarkdown(this.nodes, this.daysTogether()));
      this.logger.info('memory node removed', { data: { id } });
    }
    this.emitStatus();
    return this.status();
  }

  /** 钉住/取消钉住（"这段很重要"）。 */
  public pinNode(id: string, pinned: boolean): GrowthStatus {
    this.nodes = this.nodes.map((node) => (node.id === id ? { ...node, pinned } : node));
    this.nodes.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.at.localeCompare(a.at)));
    this.store.saveNodes(this.nodes);
    this.store.savePalaceMarkdown(renderPalaceMarkdown(this.nodes, this.daysTogether()));
    this.emitStatus();
    return this.status();
  }

  /**
   * 让她"回忆"某个节点。
   *
   * 接得上模型时用她自己的口吻说一句（受当前情绪影响的那种"回忆"），
   * 接不上就用模板 —— 但**内容一定来自这个节点本身**，不是编的。
   */
  public async recallNode(id: string): Promise<{ ok: boolean; text: string }> {
    const node = this.nodes.find((item) => item.id === id);
    if (!node) return { ok: false, text: '这段记忆找不到了。' };
    const client = this.options.getClient();
    const fallback = `我还记得${node.at.slice(0, 10)}那天：${node.title}。${node.detail}`;
    if (!client || !this.options.isLLMUsable()) {
      this.options.onSpeak?.(fallback, 'talk');
      return { ok: true, text: fallback };
    }
    try {
      const result = await client.complete({
        messages: [
          {
            role: 'system',
            content: [
              '你是一只桌面宠物，正在回忆你和主人共同经历的一件事。',
              '用第一人称说 1~2 句中文，具体、有温度，不要复述成"记录"。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `时间：${node.at.slice(0, 10)}\n标题：${node.title}\n细节：${node.detail}\n依据：${node.evidence.join(' / ')}`,
          },
        ],
        temperature: 0.8,
        maxTokens: 160,
      });
      const text = result.text.trim().slice(0, 300);
      this.options.onSpeak?.(text === '' ? fallback : text, 'talk');
      return { ok: true, text: text === '' ? fallback : text };
    } catch (error) {
      const message = error instanceof LLMError ? error.message : describeError(error);
      this.logger.warn('recalling a memory node failed; using template', { error: message });
      this.options.onSpeak?.(fallback, 'talk');
      return { ok: true, text: fallback };
    }
  }

  /* ------------------------------------------------------------------ */
  /* 4.2 反思                                                            */
  /* ------------------------------------------------------------------ */

  /** 到点/补写检查（每天 reflectionHour 之后写一次；启动时补昨天）。 */
  public async dueCheck(now: Date = new Date()): Promise<ReflectionEntry | null> {
    if (!this.settings.reflection) return null;
    const today = todayKey(now);
    if (now.getHours() >= this.settings.reflectionHour && !this.store.hasReflection(today)) {
      return this.reflect(today, now.getTime());
    }
    const yesterday = todayKey(new Date(now.getTime() - 86400000));
    if (!this.store.hasReflection(yesterday) && this.hasActivity(yesterday)) {
      return this.reflect(yesterday, now.getTime());
    }
    return null;
  }

  /** 立刻反思（UI 按钮 / 验收入口）。 */
  public async reflectNow(now: number = Date.now()): Promise<ReflectionEntry> {
    return this.reflect(todayKey(new Date(now)), now);
  }

  /**
   * 写某一天的反思，并按结论调整策略。
   *
   * 步骤：取素材 -> 算反馈统计 -> （模型或模板）生成正文与洞见 -> 写盘 -> 应用策略。
   * 任何一步失败都只记 lastError，不让主进程受影响。
   */
  public async reflect(date: string, now: number = Date.now()): Promise<ReflectionEntry> {
    if (!this.settings.reflection) {
      // 开关关掉 = 不写反思文件（手动点"立刻反思"也一样，并给出理由）
      this.lastError = '自我反思开关已关闭，这次没有写（设置 → 成长与反思）。';
      this.emitStatus();
      return this.store.readReflection(date) ?? this.emptyReflection(date);
    }
    if (this.busy) {
      // 已经有一次在跑：等它写完再返回已存在的结果
      await new Promise((resolve) => setTimeout(resolve, 300));
      return this.store.readReflection(date) ?? this.emptyReflection(date);
    }
    this.busy = true;
    try {
      const feedback = this.store.readFeedback(date);
      const stats = responseStats(feedback);
      const turns = this.options.getChatTurns(date);
      const moodCurve = this.options.getMoodCurve(date);
      const sceneCounts = this.options.getSceneCounts(date);
      const responded = feedback.filter((item) => item.responded).length;

      // 先用规则得出保守结论（模型不可用时就是最终结论）
      const heuristic = heuristicInsights(feedback, stats);
      let body = localReflection({
        date,
        stats: {
          interventions: feedback.length,
          responded,
          turnCount: turns.length,
          moodStart: moodCurve.start,
          moodEnd: moodCurve.end,
        },
        insights: heuristic,
        scenes: Object.entries(sceneCounts)
          .map(([scene, count]) => ({ scene, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 4),
        mood: { start: moodCurve.start, end: moodCurve.end },
        interventions: feedback,
      });
      let insights: ReflectionInsight[] = heuristic;
      let source: ReflectionEntry['source'] = 'template';
      let tokens = 0;

      const client = this.options.getClient();
      if (client && this.options.isLLMUsable()) {
        try {
          const transcript = feedback
            .map((item) => `${item.at.slice(11, 16)} 我说"${item.text}"（场景 ${item.scene}）→ ${item.responded ? '主人回应了' : '没有回应'}`)
            .join('\n');
          const result = await client.complete({
            messages: [
              { role: 'system', content: reflectionSystemPrompt('鲸鱼娘') },
              {
                role: 'user',
                content: [
                  `日期：${date}`,
                  `对话轮数：${turns.length}（主人说了 ${turns.filter((turn) => turn.role === 'user').length} 句）`,
                  `心情：${moodCurve.start} → ${moodCurve.end}（最低 ${moodCurve.low}）`,
                  `场景分布：${Object.entries(sceneCounts).map(([scene, count]) => `${sceneName(scene)} ${count}`).join('、') || '（无）'}`,
                  '我今天的主动开口与结果：',
                  transcript === '' ? '（今天没有主动开口）' : transcript,
                  '',
                  '主人今天说过的话（节选）：',
                  turns
                    .filter((turn) => turn.role === 'user')
                    .slice(-8)
                    .map((turn) => `- ${turn.text.slice(0, 60)}`)
                    .join('\n') || '（没有）',
                ].join('\n'),
              },
            ],
            temperature: 0.6,
            maxTokens: 500,
          });
          const parsed = parseReflection(result.text);
          if (parsed.body.trim() !== '') {
            body = parsed.body;
            source = 'llm';
            tokens = result.totalTokens;
          }
          // 模型的结论与规则结论取并集：规则是"保守底线"，模型可以补充场景洞见
          if (parsed.insights.length > 0) insights = [...parsed.insights, ...heuristic.filter((item) => !parsed.insights.some((other) => other.scene === item.scene))].slice(0, 6);
        } catch (error) {
          const message = error instanceof LLMError ? error.message : describeError(error);
          this.lastError = `反思用了本地模板：${message}`;
          this.logger.warn('llm reflection failed; using template', { error: message });
        }
      }

      const entry: ReflectionEntry = {
        date,
        body,
        insights,
        source,
        tokens,
        createdAt: new Date(now).toISOString(),
        stats: {
          interventions: feedback.length,
          responded,
          turnCount: turns.length,
          moodStart: moodCurve.start,
          moodEnd: moodCurve.end,
        },
      };
      this.store.saveReflection(entry);
      this.logger.info('reflection written', {
        data: { date, source, insights: insights.length, interventions: feedback.length, responded, tokens },
      });

      if (this.settings.policyAdapt && insights.length > 0) {
        this.applyPolicy(insights, now);
      }
      if (this.settings.palace) {
        // 反思时顺手把当天的经历沉淀进记忆宫殿（4.1 与 4.2 的天然衔接）
        this.addDrafts(this.buildDraftsForDay(date), { silent: true });
      }
      this.emitStatus();
      return entry;
    } catch (error) {
      this.lastError = describeError(error);
      this.logger.error('reflection failed', { error: this.lastError, data: { date } });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  /** 把洞见落成策略（只能收紧），并通知感知模块。 */
  private applyPolicy(insights: readonly ReflectionInsight[], now: number): void {
    const { overlay, applied } = applyInsights(this.policy, insights, new Date(now).toISOString());
    if (applied.length === 0) return;
    this.policy = overlay;
    this.store.savePolicy(overlay);
    this.store.logPolicyAdjustment(applied, overlay);
    this.logger.info('behavior policy adjusted by reflection', { data: { applied, min: overlay.minIntervalFactor, max: overlay.maxPerHourFactor } });
    this.emitPolicy();
  }

  /** 把当前策略推给感知模块。 */
  private emitPolicy(): void {
    try {
      this.options.onPolicyChanged(this.policy, this.options.getPerceptionSettings());
    } catch (error) {
      this.logger.warn('emitting policy failed', { error: describeError(error) });
    }
  }

  public resetPolicy(): GrowthStatus {
    this.policy = defaultPolicyOverlay();
    this.store.savePolicy(this.policy);
    this.store.logPolicyAdjustment(['用户手动重置了策略（回到原始设置）'], this.policy);
    this.logger.info('behavior policy reset by user');
    this.emitPolicy();
    this.emitStatus();
    return this.status();
  }

  /* ------------------------------------------------------------------ */
  /* 设置 / 状态                                                         */
  /* ------------------------------------------------------------------ */

  public setSettings(patch: GrowthSettingsPatch): GrowthStatus {
    const before = this.settings;
    this.settings = sanitizeGrowthSettings({ ...before, ...patch }, before);
    this.store.saveSettings(this.settings);
    if (!before.palace && this.settings.palace) {
      // 刚打开记忆宫殿：先把"第一次见面"补上
      this.load();
    }
    if (!before.policyAdapt && this.settings.policyAdapt) {
      this.emitPolicy();
    }
    if (!this.settings.policyAdapt) {
      // 关掉自动调整 -> 立刻回到用户原始设置（她说改就改，不能"残留"）
      this.policy = defaultPolicyOverlay();
      this.store.savePolicy(this.policy);
      this.emitPolicy();
    }
    this.emitStatus();
    return this.status();
  }

  public status(now: number = Date.now()): GrowthStatus {
    const palace = {
      nodes: this.nodes,
      byMonth: groupByMonth(this.nodes),
      // 最近一段经历的时间（不是"配置里的第一次见面日期" —— 那样会让 UI 显示一个
      // 与内容无关的时间；这里用时间轴最新的一条）
      updatedAt: this.nodes[0]?.at ?? '',
      dataDir: this.store.memoryDir,
      markdownFile: this.store.palacePath,
      stats: {
        total: this.nodes.length,
        daysTogether: this.daysTogether(now),
        since: this.firstMeetAt(),
      },
    };
    const feedback = this.store.readFeedback(todayKey(new Date(now)));
    return {
      settings: this.settings,
      palace,
      todayReflection: this.store.readReflection(todayKey(new Date(now))),
      recentReflections: this.store.recentReflections(7),
      policy: this.policy,
      policyEffect: describePolicy(this.options.getPerceptionSettings(), this.policy),
      responseStats: responseStats(feedback),
      dataDir: this.store.reflectDir,
      lastError: this.lastError,
    };
  }

  public async reflectAndStatus(now: number = Date.now()): Promise<{ entry: ReflectionEntry; status: GrowthStatus }> {
    const entry = await this.reflectNow(now);
    return { entry, status: this.status(now) };
  }

  /* ------------------------------------------------------------------ */

  private firstMeetAt(): string {
    const node = this.nodes.find((item) => item.kind === 'first-meet');
    return node?.at ?? this.settings.firstMeetAt;
  }

  private daysTogether(now: number = Date.now()): number {
    const since = this.firstMeetAt();
    return since === '' ? 0 : daysBetween(since, now);
  }

  private hasActivity(date: string): boolean {
    return this.options.getChatTurns(date).length > 0 || this.store.readFeedback(date).length > 0;
  }

  private emptyReflection(date: string): ReflectionEntry {
    return {
      date,
      body: '',
      insights: [],
      source: 'template',
      tokens: 0,
      createdAt: new Date().toISOString(),
      stats: { interventions: 0, responded: 0, turnCount: 0, moodStart: 0, moodEnd: 0 },
    };
  }

  private emitStatus(): void {
    try {
      this.options.onStatus?.(this.status());
    } catch (error) {
      this.logger.warn('growth onStatus failed', { error: describeError(error) });
    }
  }

  /** 供托盘/气泡用：记忆宫殿的一句话摘要。 */
  public digest(): string {
    const days = this.daysTogether();
    const lines = [
      `🧠 记忆宫殿：${this.nodes.length} 段经历 · 一起走过 ${days} 天`,
      ...this.nodes.slice(0, 5).map((node) => `${NODE_KINDS[node.kind]?.emoji ?? '📌'} ${node.at.slice(0, 10)} ${node.title}`),
      '',
      `今天的反思：${this.store.readReflection(todayKey())?.body.split('\n')[0] ?? '（还没写）'}`,
      `她的策略：${describePolicy(this.options.getPerceptionSettings(), this.policy)}`,
      `文件：${this.store.palacePath}`,
    ];
    return lines.join('\n');
  }
}

/* -------------------------------------------------------------------------- */

export function todayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 那天是否有深夜活动（0~5 点之间的对话）。 */
function lateNightActivity(turns: readonly ChatTurn[]): boolean {
  return turns.some((turn) => {
    const hour = new Date(turn.at).getHours();
    return hour >= 0 && hour < 5;
  });
}
