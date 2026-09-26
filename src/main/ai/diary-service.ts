/**
 * 日记系统（2.4）—— 每天把"用户与宠物之间的互动"沉淀成一篇第一视角日记。
 *
 * 分工：
 * - **本文件**：取当天数据（对话/事件/心情曲线）、去重写盘、索引、定时调度；
 * - **ai-service**：把数据交给大模型（或本地模板）生成正文 ——
 *   日记的"叙事"必须有模型的语义能力，但"数据"必须来自真实记录。
 *
 * 落盘（`%APPDATA%\DesktopPet\diary\`）：
 *   YYYY-MM-DD.md   人可读的日记（带元信息尾巴，方便回溯）
 *   index.json      列表页用的索引（标题/预览/心情）
 *
 * 生成时机（两条路，互为补偿）：
 * 1. **当天到点**：`diaryHour`（默认 22 点）之后每分钟检查一次；
 * 2. **补写昨天**：程序不是 24 小时开着的 —— 启动时若发现有活动的某天
 *    还没日记，就补一篇（否则"昨天"永远缺席，而她本该记得昨天）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatTurn, DiaryEntry, DiaryIndexItem, DiarySnapshot, MemoryEvent } from '../../shared/ai-types';
import { moodLabel } from '../../shared/emotion';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

/** 一篇日记的"素材"（全部来自真实记录）。 */
export interface DiaryContext {
  readonly date: string;
  readonly userName: string;
  /** 宠物自称（人格设定里可改）。 */
  readonly petName: string;
  readonly turns: readonly ChatTurn[];
  readonly events: readonly MemoryEvent[];
  readonly mood: { readonly start: number; readonly end: number; readonly low: number };
  readonly satiety: number;
  readonly highlights: {
    readonly chat: readonly string[];
    readonly event: readonly string[];
  };
}

/** 生成正文（由 ai-service 提供：优先大模型，失败走本地模板）。 */
export type DiaryComposer = (
  context: DiaryContext,
) => Promise<{ title: string; body: string; source: DiaryEntry['source']; tokens: number }>;

export interface DiaryServiceOptions {
  /** 数据根目录（`%APPDATA%\DesktopPet`）。 */
  readonly dataDir: string;
  readonly logger: Logger;
  /** 取某天的素材（由 ai-service 组装：记忆 + 情绪）。 */
  readonly getContext: (date: string) => DiaryContext;
  readonly compose: DiaryComposer;
  /** 自动写日记的时刻（0~23）。 */
  readonly getHour: () => number;
  /** 日记系统是否打开。 */
  readonly isEnabled: () => boolean;
  /** 写完之后通知外部（推 UI / 记一条记忆事件）。 */
  readonly onWritten?: (entry: DiaryEntry) => void;
  /** 调度检查间隔（毫秒，默认 60s）。 */
  readonly checkMs?: number;
}

export class DiaryService {
  private readonly options: DiaryServiceOptions;
  private readonly logger: Logger;
  private readonly dir: string;
  private readonly indexPath: string;
  private index: DiaryIndexItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** 正在生成的日期（避免定时器与人手点击同时写同一天）。 */
  private readonly inFlight = new Set<string>();

  public constructor(options: DiaryServiceOptions) {
    this.options = options;
    this.logger = options.logger;
    this.dir = join(options.dataDir, 'diary');
    this.indexPath = join(this.dir, 'index.json');
  }

  public load(): void {
    /*
     * 只读索引，**不建目录**：日记开关关着时不该在磁盘上留下 diary/。
     * 真正需要目录的地方（write / snapshot）自己会 mkdir。
     */
    this.index = this.readIndex();
    this.logger.info('diary service loaded', { data: { dir: this.dir, entries: this.index.length } });
  }

  public get dataDir(): string {
    return this.dir;
  }

  public has(date: string): boolean {
    return existsSync(this.entryFile(date));
  }

  /** 列表（按日期倒序）。**只读**：不建目录、不写索引。 */
  public snapshot(date: string = todayKey()): DiarySnapshot {
    return {
      items: [...this.index].sort((a, b) => b.date.localeCompare(a.date)),
      dataDir: this.dir,
      todayWritten: this.has(date),
      diaryHour: this.options.getHour(),
    };
  }

  /** 读某一篇（从 markdown 反解出结构化字段）。 */
  public get(date: string): DiaryEntry | null {
    const file = this.entryFile(date);
    if (!existsSync(file)) return null;
    try {
      return parseEntry(date, readFileSync(file, 'utf8'));
    } catch (error) {
      this.logger.warn('diary read failed', { error: describeError(error), data: { date } });
      return null;
    }
  }

  /**
   * 写某一天的日记。
   *
   * @param force 已写过时是否覆盖（设置界面「重新写今天的日记」用 true）
   * @returns 写好的日记；已有且 `force=false` 时返回原有日记
   */
  public async write(date: string = todayKey(), force = false): Promise<DiaryEntry> {
    if (!force && this.has(date)) {
      const existing = this.get(date);
      if (existing) return existing;
    }
    if (this.inFlight.has(date)) {
      // 已有一次在写：等它写完再读（避免两条并发生成把文件写坏）
      await new Promise((resolve) => setTimeout(resolve, 300));
      return this.get(date) ?? this.emptyEntry(date);
    }

    this.inFlight.add(date);
    try {
      const context = this.options.getContext(date);
      const composed = await this.options.compose(context);
      const entry: DiaryEntry = {
        date,
        title: composed.title,
        body: composed.body,
        createdAt: new Date().toISOString(),
        source: composed.source,
        mood: context.mood,
        tokens: composed.tokens,
        highlights: [...context.highlights.chat.slice(0, 3), ...context.highlights.event.slice(0, 3)],
      };
      this.writeFiles(entry);
      this.logger.info('diary written', {
        data: { date, source: entry.source, tokens: entry.tokens, turns: context.turns.length },
      });
      try {
        this.options.onWritten?.(entry);
      } catch (error) {
        this.logger.warn('diary onWritten handler failed', { error: describeError(error) });
      }
      return entry;
    } catch (error) {
      this.logger.error('diary write failed', { error: describeError(error), data: { date } });
      throw error;
    } finally {
      this.inFlight.delete(date);
    }
  }

  /**
   * 调度检查（每分钟一次）。
   *
   * 三种情况会写日记：
   * 1. 今天已过 `diaryHour` 且今天还没写（有互动才写，空白天不写日记）；
   * 2. 昨天有互动但没写过日记（补写，解决"程序不是 24 小时开着"）；
   * 3. 开关刚打开时的历史补写交给调用方手动触发（不做无限回溯）。
   */
  public async dueCheck(now: Date = new Date()): Promise<DiaryEntry | null> {
    if (!this.options.isEnabled()) return null;
    const today = todayKey(now);

    if (now.getHours() >= this.options.getHour() && !this.has(today) && this.hasActivity(today)) {
      return this.write(today, false);
    }

    const yesterday = todayKey(new Date(now.getTime() - 86400000));
    if (!this.has(yesterday) && this.hasActivity(yesterday)) {
      return this.write(yesterday, false);
    }
    return null;
  }

  public startScheduler(): void {
    if (this.timer !== null) return;
    const interval = Math.max(10000, this.options.checkMs ?? 60000);
    this.timer = setInterval(() => {
      void this.dueCheck().catch((error: unknown) => {
        this.logger.warn('diary scheduler tick failed', { error: describeError(error) });
      });
    }, interval);
    this.timer.unref?.();
  }

  public stopScheduler(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /* ------------------------------------------------------------------ */

  /** 那天是否有"值得写日记"的活动（有对话或 ≥3 条事件）。 */
  private hasActivity(date: string): boolean {
    try {
      const context = this.options.getContext(date);
      return context.turns.length > 0 || context.events.length >= 3;
    } catch {
      return false;
    }
  }

  private writeFiles(entry: DiaryEntry): void {
    this.ensureDir();
    const file = this.entryFile(entry.date);
    const temp = `${file}.tmp`;
    writeFileSync(temp, renderEntry(entry), 'utf8');
    renameSync(temp, file);

    const item: DiaryIndexItem = {
      date: entry.date,
      title: entry.title,
      preview: entry.body.replace(/\s+/g, ' ').slice(0, 60),
      source: entry.source,
      mood: entry.mood,
    };
    this.index = [item, ...this.index.filter((existing) => existing.date !== entry.date)];
    const indexTemp = `${this.indexPath}.tmp`;
    writeFileSync(indexTemp, `${JSON.stringify(this.index, null, 2)}\n`, 'utf8');
    renameSync(indexTemp, this.indexPath);
  }

  private readIndex(): DiaryIndexItem[] {
    if (!existsSync(this.indexPath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.indexPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => sanitizeIndexItem(item))
        .filter((item): item is DiaryIndexItem => item !== null);
    } catch (error) {
      this.logger.warn('diary index parse failed; rebuilding from files', { error: describeError(error) });
      return [];
    }
  }

  private ensureDir(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      this.logger.error('creating diary dir failed', { error: describeError(error), data: { dir: this.dir } });
    }
  }

  private entryFile(date: string): string {
    return join(this.dir, `${date}.md`);
  }

  private emptyEntry(date: string): DiaryEntry {
    return {
      date,
      title: `${date} 的日记`,
      body: '',
      createdAt: new Date().toISOString(),
      source: 'template',
      mood: { start: 0, end: 0, low: 0 },
      tokens: 0,
      highlights: [],
    };
  }
}

/* -------------------------------------------------------------------------- */
/* 文件格式                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * markdown 结构（人可读优先，元信息放在末尾的分隔线之后）：
 *
 *   # 标题
 *
 *   正文……
 *
 *   ---
 *   <!-- meta: {json} -->
 *
 * 为什么把 JSON 塞进注释而不是用 front-matter：用户在记事本里打开时，
 * 第一眼看到的就是日记本身，而不是一堆键值对。
 */
function renderEntry(entry: DiaryEntry): string {
  const meta = {
    source: entry.source,
    createdAt: entry.createdAt,
    tokens: entry.tokens,
    mood: entry.mood,
    highlights: entry.highlights,
    generator: 'DesktopPet 鲸鱼娘桌宠',
  };
  const footer = [
    '',
    '---',
    '',
    `> 生成方式：${entry.source === 'llm' ? '大模型' : '本地模板'} · ` +
      `心情 ${entry.mood.start} → ${entry.mood.end}（最低 ${entry.mood.low}，${moodLabel(entry.mood.end).label}） · ` +
      `token ${entry.tokens}`,
    '<!-- meta: ' + JSON.stringify(meta) + ' -->',
    '',
  ].join('\n');
  return `# ${entry.title}\n\n${entry.body}\n${footer}`;
}

function parseEntry(date: string, raw: string): DiaryEntry {
  const metaMatch = /<!-- meta: (\{.*?\}) -->/s.exec(raw);
  let meta: Record<string, unknown> = {};
  const metaJson = metaMatch?.[1];
  if (metaJson) {
    try {
      meta = JSON.parse(metaJson) as Record<string, unknown>;
    } catch {
      meta = {};
    }
  }
  const withoutMeta = raw.replace(/<!-- meta: .*? -->/s, '');
  const separatorIndex = withoutMeta.lastIndexOf('\n---\n');
  const head = separatorIndex >= 0 ? withoutMeta.slice(0, separatorIndex) : withoutMeta;
  const titleMatch = /^#\s*(.+)$/m.exec(head);
  const body = head.replace(/^#\s*.+\n?/, '').trim();

  const mood = (meta.mood ?? {}) as Record<string, unknown>;
  return {
    date,
    title: titleMatch?.[1]?.trim() ?? `${date} 的日记`,
    body,
    createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
    source: meta.source === 'llm' ? 'llm' : 'template',
    mood: {
      start: typeof mood.start === 'number' ? mood.start : 0,
      end: typeof mood.end === 'number' ? mood.end : 0,
      low: typeof mood.low === 'number' ? mood.low : 0,
    },
    tokens: typeof meta.tokens === 'number' ? meta.tokens : 0,
    highlights: Array.isArray(meta.highlights) ? (meta.highlights as unknown[]).filter((item): item is string => typeof item === 'string') : [],
  };
}

function sanitizeIndexItem(raw: unknown): DiaryIndexItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) return null;
  const mood = (typeof record.mood === 'object' && record.mood !== null ? record.mood : {}) as Record<string, unknown>;
  return {
    date: record.date,
    title: typeof record.title === 'string' ? record.title : `${record.date} 的日记`,
    preview: typeof record.preview === 'string' ? record.preview : '',
    source: record.source === 'llm' ? 'llm' : 'template',
    mood: {
      start: typeof mood.start === 'number' ? mood.start : 0,
      end: typeof mood.end === 'number' ? mood.end : 0,
      low: typeof mood.low === 'number' ? mood.low : 0,
    },
  };
}

/** 本地日期键。 */
export function todayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
