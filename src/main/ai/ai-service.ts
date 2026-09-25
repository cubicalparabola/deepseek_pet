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
  moodLabel,
  preferredAnimation,
  tokensRemainingRatio,
} from '../../shared/emotion';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import { AIConfigStore } from './ai-config-store';
import { DiaryService, todayKey, type DiaryContext } from './diary-service';
import { EmotionService } from './emotion-service';
import { extractFactsFromModelOutput, extractFactsHeuristic } from './fact-extract';
import { LLMClient, LLMError, type LLMMessage } from './llm-client';
import { localDiary, localReply } from './local-replies';
import { MemoryStore } from './memory-store';

/** 桌宠"要说话"时的回调（由 controller 接到气泡 + 动画上）。 */
export interface SpeakRequest {
  readonly text: string;
  readonly animation: string | null;
  /** 回复 / 主动搭话 / 系统提示。 */
  readonly kind: 'reply' | 'proactive' | 'system';
  /** 消息级别（系统消息用）。 */
  readonly level?: 'info' | 'warn' | 'error';
}

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
}

export class AIService {
  private readonly options: AIServiceOptions;
  private readonly logger: Logger;
  private readonly config: AIConfigStore;
  private readonly memory: MemoryStore;
  private readonly emotion: EmotionService;
  private readonly diary: DiaryService;
  private readonly llm: LLMClient;

  private busy = false;
  private lastError = '';
  private calls = 0;
  /** 自上次记忆整理以来新增的对话轮数。 */
  private turnsSinceConsolidate = 0;

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
    this.llm = new LLMClient(this.config.get().provider, options.logger);
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  public load(): void {
    this.config.load();
    this.memory.load();
    this.memory.setUserName(this.memory.getProfile().userName || this.settings.userName);
    this.emotion.load();
    this.diary.load();
    this.llm.updateConfig(this.settings.provider);
    this.memory.recordEvent('system', 'AI 模块已加载', {
      enabled: this.settings.enabled,
      chat: this.settings.chat,
      memory: this.settings.memory,
      emotion: this.settings.emotion,
      diary: this.settings.diary,
    });
    this.emotion.startHeartbeat();
    this.diary.startScheduler();
    // 启动时补一次"昨天没写的日记"（程序不是 24 小时开着的）
    void this.diary.dueCheck().catch((error: unknown) => {
      this.logger.warn('diary catch-up failed', { error: describeError(error) });
    });
    this.emitStatus();
  }

  public dispose(): void {
    this.emotion.stopHeartbeat();
    this.diary.stopScheduler();
  }

  public get settings(): AISettings {
    return this.config.get();
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
      dataDir: this.options.dataDir,
      emotion: this.emotion.get(),
      presence: this.emotion.presence,
    };
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
      this.memory.recordEvent('system', '记忆系统已开启');
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

  public notifyInteraction(kind: InteractionKind): AIStatusView {
    const before = this.emotion.get().mood;
    this.emotion.interact(kind);
    const after = this.emotion.get();
    if (this.settings.memory) {
      const label: Record<InteractionKind, string> = {
        click: '主人点了点我',
        doubleclick: '主人双击了我',
        drag: '主人拖着我换了个位置',
        chat: '主人和我说了句话',
        diary: '主人看了日记',
        gift: '主人给了我好东西',
      };
      this.memory.recordEvent('interaction', label[kind] ?? '主人互动了一下', { moodBefore: before, moodAfter: after.mood });
    }
    // 心情掉破 20 或涨破 80 时额外记一笔（日记里能看出起伏）
    if (before >= 20 && after.mood < 20) {
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

  /* ------------------------------------------------------------------ */
  /* 2.1 对话                                                            */
  /* ------------------------------------------------------------------ */

  /** 发一句话给桌宠。**永不抛异常**：失败也返回一条兜底回复。 */
  public async chat(text: string, source: 'chat-window' | 'tray' | 'plugin' | 'system' = 'chat-window'): Promise<AIChatReply> {
    const message = sanitizeMessage(text);
    if (message === '') {
      return { ok: false, reply: '（没听清，主人再说一次？）', mode: 'local', tokens: 0, error: '空消息', mood: this.emotion.get().mood, hunger: this.emotion.get().hunger };
    }

    // 说话也算互动（2.3）
    this.notifyInteraction('chat');
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
        const result = await this.llm.complete({
          messages: this.buildMessages(message),
          maxTokens: this.settings.provider.maxTokens,
        });
        reply = sanitizeReply(result.text);
        mode = 'llm';
        tokens = result.totalTokens;
        this.calls += 1;
        this.config.addUsage(tokens);
        this.emotion.refreshTokens();
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
      hunger: this.emotion.get().hunger,
    };
  }

  /** 组装 messages：人格 + 情绪 + 记忆 + 输出约束 + 最近对话。 */
  private buildMessages(userText: string): LLMMessage[] {
    const settings = this.settings;
    const context = settings.memory
      ? this.memory.buildContext(userText)
      : { facts: [], pastSnippets: [], todayEvents: [], recentTurns: [], factCount: 0 };

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
        snippetLines.length > 0 ? '过去几天相关的片段（可用于"你之前说过…"这类自然的提起）：' : '',
        ...snippetLines,
      ].filter((line) => line !== '');
      if (memoryBlock.length > 0) systemLines.push('', '【你记得的事】', ...memoryBlock);
    }
    systemLines.push(
      '',
      '【输出要求】',
      '只输出你对主人说的那句话本身，1~3 句，可以用颜文字；',
      '不要写旁白、不要加引号、不要用 Markdown、不要提"作为 AI"。',
    );

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
          maxTokens: 400,
        });
        this.calls += 1;
        this.config.addUsage(result.totalTokens);
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
    this.emitStatus();
    return { added, updated };
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
      hunger: this.emotion.get().hunger,
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
        hunger: context.hunger,
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
              `互动片段：`,
              context.highlights.event.length > 0 ? context.highlights.event.join('\n') : '（无）',
            ].join('\n'),
          },
        ],
        temperature: 0.9,
        maxTokens: 600,
      });
      this.calls += 1;
      this.config.addUsage(result.totalTokens);
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
    this.emitStatus();
  }

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
        maxTokens: 60,
        timeoutMs: Math.min(15000, this.settings.provider.timeoutMs),
      });
      this.calls += 1;
      this.config.addUsage(result.totalTokens);
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
      return { ok: true, reply: text, mode: 'local', tokens: 0, mood: this.emotion.get().mood, hunger: this.emotion.get().hunger, ...(animation ? { animation } : {}) };
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
      hunger: this.emotion.get().hunger,
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

  /** 记录一条自定义事件（controller 用）。 */
  public recordEvent(kind: MemoryEventKind, text: string, data?: Record<string, unknown>): void {
    if (!this.settings.memory && kind !== 'system') return;
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
