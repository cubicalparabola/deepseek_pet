/**
 * 每日时间线（需求：「统计每天用户在做什么 …… 记录下来每天的使用时间区间，形成记忆」）。
 *
 * 分工：
 * - **纯聚合规则**在 `shared/timeline.ts`（合并/切分/汇总/文案/叙述提示词，可被验收断言）；
 * - 这里只做**副作用**：读盘写盘、跨天收尾、调一次模型写"她记得的今天"。
 *
 * 落盘（`<userData>/perception/`，仍然**只有文本**）：
 *   timeline-YYYY-MM-DD.json   当天的区间 + 汇总 + 叙述（机器用，面板/聊天也读它）
 *   daily-YYYY-MM-DD.md        人可读：一天的区间表 + 她的叙述（她"记得"的东西）
 *
 * 三条纪律：
 * 1. **日期用本地日**（跨零点按用户时区切天，否则 UTC+8 凌晨会写到昨天）；
 * 2. **数组全量重写**（一天最多几百段，写全文比增量补丁更不容易写坏；先写 .tmp 再 rename）；
 * 3. **没有观察就不建文件**（关掉屏幕感知 ⇒ 目录里什么都不该多出来，验收钉住了这一点）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScreenObservation } from '../../shared/perception-types';
import type { TimelineStatusView, TimelineTextResult, DayTimeline } from '../../shared/timeline-types';
import {
  appendObservation,
  buildNarrativeMessages,
  formatSegmentLine,
  formatTimelineText,
  localDayOf,
  summarizeDay,
} from '../../shared/timeline';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import type { LLMClient } from '../ai/llm-client';
import { LLMError } from '../ai/llm-client';

export interface TimelineServiceOptions {
  readonly dataDir: string;
  readonly logger: Logger;
  /** 取当前的大模型客户端（没配密钥时返回 null → 只写确定性部分，不写叙述）。 */
  readonly getClient: () => LLMClient | null;
  readonly isLLMUsable: () => boolean;
  /** 人格名/主人名（写叙述时用；从 AI 设置里读）。 */
  readonly getNames: () => { readonly petName: string; readonly userName: string };
}

export class TimelineService {
  private readonly options: TimelineServiceOptions;
  private readonly logger: Logger;
  private readonly dir: string;
  /** 当前这一天的区间（内存就是真相，落盘是它的镜像）。 */
  private segments: DayTimeline['segments'] = [];
  private date = localDayOf();
  private narrative = '';
  private updatedAt = '';

  public constructor(options: TimelineServiceOptions) {
    this.options = options;
    this.logger = options.logger;
    this.dir = join(options.dataDir, 'perception');
  }

  /** 读盘：把"今天"已有的区间接回来（重启后不丢当天记录），并顺手补上昨天没收尾的部分。 */
  public load(): void {
    this.date = localDayOf();
    const loaded = this.readDay(this.date);
    if (loaded) {
      this.segments = loaded.segments;
      this.narrative = loaded.narrative;
      this.updatedAt = loaded.updatedAt;
      this.logger.info('timeline loaded', {
        data: { date: this.date, segments: loaded.segments.length, minutes: loaded.totals.activeMinutes },
      });
    }
    this.catchUpPreviousDay();
  }

  /**
   * 启动时补昨天。
   *
   * 为什么需要：跨天收尾只发生在"午夜那一刻正好在采样"的情况下。如果桌宠当时没开
   * （很常见），昨天就只写了 `timeline-<昨天>.json`（每次观察都会 persist），
   * 而 `daily-<昨天>.md` 与她写的那段叙述会缺 —— 记忆就断在这一天。
   * 所以启动时检查一次：有区间但没收尾/没叙述的，补上（叙述仍然"尽力"，失败不影响数据）。
   */
  private catchUpPreviousDay(): void {
    try {
      const yesterday = localDayOf(Date.now() - 86400000);
      const previous = this.readDay(yesterday);
      if (!previous || previous.segments.length === 0) return;
      this.finalize(yesterday);
      if (previous.narrative.trim() === '') {
        this.logger.info('timeline catch-up: narrating previous day', { data: { date: yesterday } });
        void this.narrate(yesterday).catch(() => undefined);
      }
    } catch (error) {
      this.logger.warn('timeline catch-up failed', { error: describeError(error) });
    }
  }

  /**
   * 收一条观察进时间线（每轮采样调用一次）。
   *
   * 顺序很关键：
   * 1. **跨天**先把昨天收尾（写确定性部分），再**尽力补一段叙述**；
   * 2. 然后把新观察并进今天的区间。
   *
   * 叙述为什么放在这里"尽力"而不是等用户点按钮：需求是"**每天**再让模型写一段叙述"，
   * 而一天结束时如果没人点按钮，那段记忆就永远缺了。所以跨天时补一次；
   * 失败（没密钥/网络）只记日志，确定性区间不受影响 —— `narrate()` 内部已经保证这一点。
   * 注意它是**异步且不 await**：跨天那一刻不能让采样卡住。
   */
  public observe(observation: ScreenObservation, nowMs: number = Date.now()): void {
    const day = localDayOf(nowMs);
    if (day !== this.date) {
      const finishedDay = this.date;
      this.finalize(finishedDay);
      void this.narrate(finishedDay).catch(() => undefined);
      this.date = day;
      this.segments = [];
      this.narrative = '';
      this.updatedAt = '';
    }
    this.segments = appendObservation(this.segments, observation);
    this.updatedAt = new Date(nowMs).toISOString();
    this.persist();
  }

  /** 今天的时间线（含汇总）。 */
  public today(): DayTimeline {
    return {
      date: this.date,
      segments: this.segments,
      totals: summarizeDay(this.segments),
      narrative: this.narrative,
      updatedAt: this.updatedAt,
    };
  }

  /** 状态里给面板用的精简视图（只带最近几段，别把整天的区间都推进 IPC 推送）。 */
  public statusView(recentLimit = 8): TimelineStatusView {
    const timeline = this.today();
    return {
      date: timeline.date,
      activeMinutes: timeline.totals.activeMinutes,
      idleMinutes: timeline.totals.idleMinutes,
      byScene: timeline.totals.byScene,
      byApp: timeline.totals.byApp,
      recent: timeline.segments.slice(-recentLimit),
      narrative: timeline.narrative,
    };
  }

  /** 给聊天/日记/面板的紧凑文本；今天没有记录时返回空串。 */
  public text(date?: string): TimelineTextResult {
    const timeline = date === undefined || date === this.date ? this.today() : this.readDay(date);
    if (!timeline) return { date: date ?? this.date, text: '', narrative: '', hasData: false };
    const text = formatTimelineText(timeline);
    return { date: timeline.date, text, narrative: timeline.narrative, hasData: text !== '' };
  }

  /**
   * 让模型写（或重写）某天的叙述 —— 需求里的"每天再让模型写一段叙述"。
   *
   * 失败一律不抛：没密钥/请求失败时只记日志，确定性部分照样在盘上。
   */
  public async narrate(date?: string, force = false): Promise<TimelineTextResult> {
    const timeline = date === undefined || date === this.date ? this.today() : this.readDay(date);
    if (!timeline) return { date: date ?? this.date, text: '', narrative: '', hasData: false };
    if (timeline.totals.activeMinutes <= 0 && timeline.totals.idleMinutes <= 0) {
      return { date: timeline.date, text: '', narrative: timeline.narrative, hasData: false };
    }
    if (!force && timeline.narrative.trim() !== '') {
      return { date: timeline.date, text: formatTimelineText(timeline), narrative: timeline.narrative, hasData: true };
    }
    const client = this.options.getClient();
    if (!client || !this.options.isLLMUsable()) {
      this.logger.debug('timeline narrative skipped (no llm)');
      return { date: timeline.date, text: formatTimelineText(timeline), narrative: timeline.narrative, hasData: true };
    }
    const names = this.options.getNames();
    const messages = buildNarrativeMessages({ timeline, petName: names.petName, userName: names.userName });
    try {
      const result = await client.complete({
        messages: [
          { role: 'system', content: messages.system },
          { role: 'user', content: messages.user },
        ],
        temperature: 0.8,
        maxTokens: 300,
      });
      const narrative = stripWrappingQuotes(result.text).slice(0, 400);
      if (narrative !== '') {
        if (timeline.date === this.date) this.narrative = narrative;
        this.writeDay({ ...timeline, narrative });
        this.logger.info('timeline narrative written', { data: { date: timeline.date, chars: narrative.length, tokens: result.totalTokens } });
      }
      return { date: timeline.date, text: formatTimelineText(timeline), narrative, hasData: true };
    } catch (error) {
      const message = error instanceof LLMError ? error.message : describeError(error);
      this.logger.warn('timeline narrative failed', { error: message, data: { date: timeline.date } });
      return { date: timeline.date, text: formatTimelineText(timeline), narrative: timeline.narrative, hasData: true };
    }
  }

  /** 清空（用户在面板上一键抹掉感知数据时调用）。 */
  public clear(nowMs: number = Date.now()): void {
    const date = this.date;
    this.date = localDayOf(nowMs);
    this.segments = [];
    this.narrative = '';
    this.updatedAt = '';
    /*
     * 只清**今天**的两个文件：清空按钮的语义是"抹掉她观察到的东西"，
     * 而历史日期属于用户自己的记录（`ObservationStore.clear()` 同样按文件清空、
     * 不删除文件本身），这里保持一致：把内容写成空串而不是删文件。
     */
    try {
      if (!existsSync(this.dir)) return;
      writeFileSync(this.timelineFile(date), '', 'utf8');
      writeFileSync(this.dailyFile(date), '', 'utf8');
    } catch (error) {
      this.logger.warn('clearing timeline failed', { error: describeError(error) });
    }
  }

  /** 一天的收尾：写人可读的 markdown（跨天时自动调用；也可手动）。 */
  public finalize(date?: string): void {
    const timeline = date === undefined || date === this.date ? this.today() : this.readDay(date);
    if (!timeline) return;
    if (timeline.segments.length === 0) return;
    this.writeDay(timeline);
    this.logger.info('timeline finalized', {
      data: { date: timeline.date, segments: timeline.segments.length, minutes: timeline.totals.activeMinutes },
    });
  }

  /* ------------------------------------------------------------------ */
  /* 文件                                                                */
  /* ------------------------------------------------------------------ */

  private timelineFile(date: string): string {
    return join(this.dir, `timeline-${date}.json`);
  }

  private dailyFile(date: string): string {
    return join(this.dir, `daily-${date}.md`);
  }

  private readDay(date: string): DayTimeline | null {
    const file = this.timelineFile(date);
    if (!existsSync(file)) return null;
    try {
      const raw = readFileSync(file, 'utf8').trim();
      if (raw === '') return null;
      const parsed = JSON.parse(raw) as Partial<DayTimeline>;
      const segments = Array.isArray(parsed.segments) ? (parsed.segments as DayTimeline['segments']) : [];
      return {
        date: typeof parsed.date === 'string' ? parsed.date : date,
        segments,
        totals: summarizeDay(segments),
        narrative: typeof parsed.narrative === 'string' ? parsed.narrative : '',
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      };
    } catch (error) {
      this.logger.warn('timeline read failed', { error: describeError(error), data: { file } });
      return null;
    }
  }

  /** 落盘：json（机器）+ md（人/记忆）。空的一天不建文件。 */
  private persist(): void {
    if (this.segments.length === 0) return;
    const timeline = this.today();
    this.writeDay(timeline);
  }

  private writeDay(timeline: DayTimeline): void {
    try {
      this.ensureDir();
      const json = `${JSON.stringify(timeline, null, 1)}\n`;
      const temp = `${this.timelineFile(timeline.date)}.tmp`;
      writeFileSync(temp, json, 'utf8');
      renameSync(temp, this.timelineFile(timeline.date));
      writeFileSync(this.dailyFile(timeline.date), this.renderMarkdown(timeline), 'utf8');
    } catch (error) {
      this.logger.warn('timeline write failed', { error: describeError(error), data: { date: timeline.date } });
    }
  }

  /** 人可读的一天（她"记得"的东西）。 */
  private renderMarkdown(timeline: DayTimeline): string {
    const { totals } = timeline;
    const lines = [
      `# ${timeline.date} 在做什么`,
      '',
      `> 由周期观察聚合而来，**只有文本**（场景/程序/时间），没有任何截图。`,
      '',
      `- 在电脑前：${totals.activeMinutes} 分钟`,
      `- 判为离开/没动：${totals.idleMinutes} 分钟`,
      '',
      '## 时间线',
      '',
    ];
    for (const segment of timeline.segments) {
      lines.push(`- ${formatSegmentLine(segment)}`);
    }
    if (timeline.narrative.trim() !== '') {
      lines.push('', '## 她记得的今天', '', timeline.narrative.trim());
    }
    lines.push('');
    return lines.join('\n');
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }
}

/** 叙述里偶尔会带引号/前缀，去掉再存。 */
function stripWrappingQuotes(text: string): string {
  return text
    .trim()
    .replace(/^["'“”「『]+/, '')
    .replace(/["'“”」』]+$/, '')
    .trim();
}
