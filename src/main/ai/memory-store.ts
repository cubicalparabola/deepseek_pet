/**
 * 记忆系统（2.2）—— 本地文件版"长期记忆"。
 *
 * 目录结构（全部在 `%APPDATA%\DesktopPet\memory\`，**不进仓库**）：
 *
 *   profile.json                长期事实（名字/兴趣/作息/项目…），人可读
 *   events-YYYY-MM-DD.jsonl     当天的原始事件流水（互动、对话、开关…）
 *   chat-YYYY-MM-DD.jsonl       当天的对话记录（一问一答各一行）
 *   memory-log.md               **记忆日志**：上面两者的可读版，按时间追加
 *
 * 为什么用"JSONL 流水 + 事实快照"两套：
 * - 流水是**事实来源**（append-only，永不修改，方便回溯"我什么时候记住的"）；
 * - 事实快照是**检索用**的索引（按 key 去重、带置信度与命中次数），
 *   两者职责不同，混在一张表里早晚会互相污染。
 *
 * 为什么不用数据库：第一版的数据量（每天几十条）用文件足够，
 * 而且用户随时能打开 `memory/` 看她在记什么 —— 记忆必须是**可审计**的。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ChatTurn,
  MemoryEvent,
  MemoryEventKind,
  MemoryFact,
  MemoryProfile,
  MemorySnapshot,
} from '../../shared/ai-types';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import { matchScore, queryTokens, type ExtractedFact } from './fact-extract';

export interface MemoryStoreOptions {
  /** 数据根目录（`%APPDATA%\DesktopPet`）。 */
  readonly dataDir: string;
  readonly logger: Logger;
  /** 检索时最多回顾多少天（默认 7 天）。 */
  readonly lookbackDays?: number;
}

export interface MemoryContext {
  /** 与当前这句话相关的长期事实（已按相关度排序）。 */
  readonly facts: readonly MemoryFact[];
  /** 过去几天里与这句话相关的片段（"昨天你说要做完论文…"的素材）。 */
  readonly pastSnippets: readonly string[];
  /** 今天发生过什么（最近的几条）。 */
  readonly todayEvents: readonly MemoryEvent[];
  /** 最近的对话轮。 */
  readonly recentTurns: readonly ChatTurn[];
  /** 记忆总数（prompt 里可以提一句"我记得你 N 件事"）。 */
  readonly factCount: number;
}

const MAX_FACTS = 200;
const MAX_SNIPPETS = 4;

export class MemoryStore {
  private readonly options: MemoryStoreOptions;
  private readonly logger: Logger;
  /** `memory/` 目录。 */
  private readonly dir: string;
  private readonly profileFile: string;
  private readonly logFile: string;
  private profile: MemoryProfile;
  /** 今天的事件与对话（内存缓存，避免每次检索都读盘）。 */
  private today = '';
  private todayEvents: MemoryEvent[] = [];
  private todayTurns: ChatTurn[] = [];

  public constructor(options: MemoryStoreOptions) {
    this.options = options;
    this.logger = options.logger;
    this.dir = join(options.dataDir, 'memory');
    this.profileFile = join(this.dir, 'profile.json');
    this.logFile = join(this.dir, 'memory-log.md');
    this.profile = emptyProfile();
  }

  /** 是否允许写盘（记忆开关关闭时必须为 false）。 */
  private enabled = false;

  /**
   * 开关状态由 AIService 同步过来。
   *
   * 为什么需要它：`rollDayIfNeeded()` 这类"顺手写一行"的路径会在
   * 用户**刚把开关关掉**之后仍然落盘（内存里 `today` 还记着上一次加载的日期），
   * 于是"关掉开关不落盘"这条承诺就被绕过了 —— 实测被验收抓到。
   * 因此所有写路径都先问一句 `enabled`。
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /* ------------------------------------------------------------------ */
  /* 初始化 / 路径                                                        */
  /* ------------------------------------------------------------------ */

  public load(): MemoryProfile {
    this.ensureDir();
    this.profile = this.readProfile();
    this.today = todayKey();
    this.todayEvents = this.readDayFile<MemoryEvent>(this.eventsFile(this.today));
    this.todayTurns = this.readDayFile<ChatTurn>(this.chatFile(this.today));
    this.logger.info('memory store loaded', {
      data: {
        dir: this.dir,
        facts: this.profile.facts.length,
        todayEvents: this.todayEvents.length,
        todayTurns: this.todayTurns.length,
      },
    });
    return this.profile;
  }

  public get dataDir(): string {
    return this.options.dataDir;
  }

  /** 记忆子目录（UI 上「打开记忆目录」用）。 */
  public get memoryDir(): string {
    return this.dir;
  }

  /** 记忆日志文件绝对路径（人可读的那份）。 */
  public get memoryLogFile(): string {
    return this.logFile;
  }

  public getProfile(): MemoryProfile {
    return this.profile;
  }

  /* ------------------------------------------------------------------ */
  /* 写入                                                                */
  /* ------------------------------------------------------------------ */

  /** 记一条事件（互动、开关、情绪突变…）。记忆关闭时**不写盘**。 */
  public recordEvent(kind: MemoryEventKind, text: string, data?: Record<string, unknown>): MemoryEvent | null {
    if (!this.enabled) return null;
    const event: MemoryEvent = {
      at: new Date().toISOString(),
      kind,
      text: text.slice(0, 400),
      ...(data ? { data } : {}),
    };
    this.rollDayIfNeeded();
    this.todayEvents.push(event);
    this.appendJsonl(this.eventsFile(this.today), event);
    this.appendLog(formatEventLine(event));
    return event;
  }

  /** 记一轮对话（用户 / 宠物各调一次）。记忆关闭时**不写盘**。 */
  public recordTurn(turn: ChatTurn): ChatTurn | null {
    if (!this.enabled) return null;
    const entry: ChatTurn = { ...turn, text: turn.text.slice(0, 2000) };
    this.rollDayIfNeeded();
    this.todayTurns.push(entry);
    this.appendJsonl(this.chatFile(this.today), entry);
    this.appendLog(formatTurnLine(entry));
    return entry;
  }

  /**
   * 合并抽取到的事实。
   *
   * 合并规则：
   * - 同 key + 同值 → 只累加 `hits` 并刷新 `lastSeenAt`（"她又确认了一次"）；
   * - `name` 这类**唯一**事实 → 新值置信度不低于旧值时替换（改名字要能改过来）；
   * - 其它 → 追加为新条目；
   * - 超过上限时按 `confidence * hits` 淘汰最弱的（记忆也有取舍）。
   */
  public mergeFacts(facts: readonly ExtractedFact[]): { added: number; updated: number } {
    if (!this.enabled) return { added: 0, updated: 0 };
    if (facts.length === 0) return { added: 0, updated: 0 };
    const now = new Date().toISOString();
    const next = [...this.profile.facts];
    let added = 0;
    let updated = 0;

    for (const fact of facts) {
      const index = next.findIndex(
        (existing) => existing.key === fact.key && normalize(existing.value) === normalize(fact.value),
      );
      if (index >= 0) {
        const existing = next[index];
        if (existing) {
          next[index] = {
            ...existing,
            hits: existing.hits + 1,
            lastSeenAt: now,
            confidence: Math.max(existing.confidence, fact.confidence),
          };
          updated += 1;
          continue;
        }
      }
      const uniqueKey = fact.key === 'name';
      const sameKeyIndex = uniqueKey ? next.findIndex((existing) => existing.key === fact.key) : -1;
      const sameKeyFact = sameKeyIndex >= 0 ? next[sameKeyIndex] : undefined;
      if (sameKeyFact && sameKeyFact.confidence <= fact.confidence) {
        next[sameKeyIndex] = {
          key: fact.key,
          value: fact.value,
          confidence: fact.confidence,
          source: fact.source,
          firstSeenAt: sameKeyFact.firstSeenAt,
          lastSeenAt: now,
          hits: sameKeyFact.hits + 1,
        };
        updated += 1;
        continue;
      }
      next.push({
        key: fact.key,
        value: fact.value,
        confidence: fact.confidence,
        source: fact.source,
        firstSeenAt: now,
        lastSeenAt: now,
        hits: 1,
      });
      added += 1;
    }

    const trimmed = next
      .sort((a, b) => score(b) - score(a) || b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, MAX_FACTS);
    this.profile = { ...this.profile, facts: trimmed, updatedAt: now };
    this.saveProfile();
    if (added > 0 || updated > 0) {
      this.appendLog(
        `- ${stamp()} · 记忆更新：新增 ${added} 条、确认 ${updated} 条` +
          (facts.length > 0 ? `（${facts.map((fact) => `${fact.key}=${fact.value}`).join('，')}）` : ''),
      );
    }
    return { added, updated };
  }

  /** 更新主人的称呼（名字由对话里抽取，也允许手动改）。记忆关闭时不写盘。 */
  public setUserName(name: string): MemoryProfile {
    if (!this.enabled) return this.profile;
    const now = new Date().toISOString();
    this.profile = { ...this.profile, userName: name.slice(0, 40), updatedAt: now };
    this.saveProfile();
    return this.profile;
  }

  /** 保存模型整理出的记忆摘要（供 prompt 用）。记忆关闭时不写盘。 */
  public setSummary(summary: string): MemoryProfile {
    if (!this.enabled) return this.profile;
    const now = new Date().toISOString();
    this.profile = { ...this.profile, summary: summary.slice(0, 2000), updatedAt: now };
    this.saveProfile();
    return this.profile;
  }

  /* ------------------------------------------------------------------ */
  /* 检索                                                                */
  /* ------------------------------------------------------------------ */

  /** 最近的对话（倒序）。 */
  public recentTurns(limit = 20): ChatTurn[] {
    this.rollDayIfNeeded();
    return [...this.todayTurns].slice(-limit).reverse();
  }

  /** 今天的事件（倒序）。 */
  public todayEventList(limit = 50): MemoryEvent[] {
    this.rollDayIfNeeded();
    return [...this.todayEvents].slice(-limit).reverse();
  }

  /**
   * 为"当前这句话"组装记忆上下文（2.2 的跨时间能力就靠这里）。
   *
   * 三路召回：
   * 1. **长期事实**：与这句话关键词重合的排序靠前，其余按置信度补位；
   * 2. **过去几天的片段**：在 events/chat 文件里按关键词找，命中就带日期
   *    （"昨天你说…"这类表达需要日期，所以片段里带 `MM-DD`）；
   * 3. **今天的事件**：数量限制得比较小，避免 prompt 变成流水账。
   */
  public buildContext(query: string, options?: { now?: Date; factLimit?: number }): MemoryContext {
    this.rollDayIfNeeded();
    const now = options?.now ?? new Date();
    const factLimit = options?.factLimit ?? 6;
    const tokens = queryTokens(query);

    const facts = [...this.profile.facts]
      .map((fact) => ({ fact, score: matchScore(`${fact.key} ${fact.value}`, tokens) * 2 + score(fact) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, factLimit)
      .map((entry) => entry.fact);

    const pastSnippets = this.searchPast(tokens, now);
    return {
      facts,
      pastSnippets,
      todayEvents: this.todayEvents.slice(-6),
      recentTurns: this.recentTurns(6),
      factCount: this.profile.facts.length,
    };
  }

  /** 在最近 N 天的流水里找与关键词相关的片段。 */
  private searchPast(tokens: readonly string[], now: Date): string[] {
    if (tokens.length === 0) return [];
    const days = this.availableDays().filter((day) => day !== this.today);
    const lookback = Math.max(1, this.options.lookbackDays ?? 7);
    const limit = new Date(now.getTime() - lookback * 86400000).toISOString().slice(0, 10);

    const hits: { score: number; day: string; text: string }[] = [];
    for (const day of days) {
      if (day < limit) break;
      for (const turn of this.readDayFile<ChatTurn>(this.chatFile(day)).slice(-60)) {
        const scoreValue = matchScore(turn.text, tokens);
        if (scoreValue > 0) hits.push({ score: scoreValue, day, text: `${turn.role === 'user' ? '主人' : '她'}：${turn.text}` });
      }
      for (const event of this.readDayFile<MemoryEvent>(this.eventsFile(day)).slice(-60)) {
        const scoreValue = matchScore(event.text, tokens);
        if (scoreValue > 0) hits.push({ score: scoreValue, day, text: event.text });
      }
    }
    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SNIPPETS)
      .map((hit) => `[${hit.day.slice(5)}] ${hit.text.slice(0, 120)}`);
  }

  /** 某一天的事件（顺序）。日记按天写，需要按日期取数。 */
  public eventsOn(date: string): MemoryEvent[] {
    if (date === this.today) {
      this.rollDayIfNeeded();
      return [...this.todayEvents];
    }
    return this.readDayFile<MemoryEvent>(this.eventsFile(date));
  }

  /** 某一天的对话（顺序）。 */
  public turnsOn(date: string): ChatTurn[] {
    if (date === this.today) {
      this.rollDayIfNeeded();
      return [...this.todayTurns];
    }
    return this.readDayFile<ChatTurn>(this.chatFile(date));
  }

  /** 有多少天的流水（倒序，`YYYY-MM-DD`）。 */
  public availableDays(): string[] {
    try {
      const days = new Set<string>();
      for (const file of readdirSync(this.dir)) {
        const matched = /^(?:events|chat)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
        if (matched?.[1]) days.add(matched[1]);
      }
      return [...days].sort().reverse();
    } catch {
      return [];
    }
  }

  public stats(): { events: number; turns: number; facts: number } {
    let events = 0;
    let turns = 0;
    for (const day of this.availableDays()) {
      events += this.readDayFile<MemoryEvent>(this.eventsFile(day)).length;
      turns += this.readDayFile<ChatTurn>(this.chatFile(day)).length;
    }
    return { events, turns, facts: this.profile.facts.length };
  }

  /** UI 用快照。**只读**：不建目录、不写文件（开关关着时不该留下任何痕迹）。 */
  public snapshot(): MemorySnapshot {
    this.rollDayIfNeeded();
    return {
      profile: this.profile,
      todayEvents: this.todayEventList(50),
      recentChat: this.recentTurns(20),
      logFile: this.logFile,
      dataDir: this.options.dataDir,
      stats: this.stats(),
    };
  }

  /** 清空记忆（事实 + 流水 + 日志），目录保留。 */
  public clear(): MemorySnapshot {
    try {
      for (const file of readdirSync(this.dir)) {
        rmSync(join(this.dir, file), { force: true });
      }
    } catch (error) {
      this.logger.warn('clearing memory files failed', { error: describeError(error) });
    }
    this.profile = emptyProfile();
    this.todayEvents = [];
    this.todayTurns = [];
    this.saveProfile();
    this.appendLog(`- ${stamp()} · 记忆已清空`);
    this.logger.info('memory cleared');
    return this.snapshot();
  }

  /* ------------------------------------------------------------------ */
  /* 文件细节                                                            */
  /* ------------------------------------------------------------------ */

  private ensureDir(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      if (!existsSync(this.logFile)) {
        writeFileSync(
          this.logFile,
          `# 鲸鱼娘的记忆日志\n\n> 这里按时间记录她记住的每一件事。文件由桌宠自动追加，可直接编辑/删除。\n\n`,
          'utf8',
        );
      }
    } catch (error) {
      this.logger.error('creating memory dir failed', { error: describeError(error), data: { dir: this.dir } });
    }
  }

  /**
   * 跨天时把内存缓存切到新的一天（长跑不能一直往昨天写）。
   *
   * ⚠️ 只有"记忆系统真的加载过"（`this.today !== ''`）才写跨天分隔线：
   * 否则设置界面的"只读快照"也会顺手创建 `memory/` 目录 ——
   * 开关关着时在用户磁盘上留目录，会被理解成"它一直在记我"。
   */
  private rollDayIfNeeded(): void {
    const key = todayKey();
    if (key === this.today) return;
    const wasLoaded = this.today !== '';
    this.today = key;
    this.todayEvents = [];
    this.todayTurns = [];
    // 只有"记忆系统当前是打开的"才写跨天分隔线（否则只读快照也会建目录/写文件）
    if (wasLoaded && this.enabled) this.appendLog(`\n## ${key}\n`);
  }

  private readProfile(): MemoryProfile {
    if (!existsSync(this.profileFile)) return emptyProfile();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.profileFile, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return emptyProfile();
      const record = parsed as Record<string, unknown>;
      const facts: MemoryFact[] = Array.isArray(record.facts)
        ? (record.facts as unknown[])
            .map((item) => sanitizeFact(item))
            .filter((fact): fact is MemoryFact => fact !== null)
        : [];
      return {
        userName: typeof record.userName === 'string' ? record.userName : '',
        petName: typeof record.petName === 'string' ? record.petName : '',
        facts,
        summary: typeof record.summary === 'string' ? record.summary : '',
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
      };
    } catch (error) {
      this.logger.error('memory profile parse failed; starting empty', { error: describeError(error) });
      return emptyProfile();
    }
  }

  private saveProfile(): void {
    try {
      this.ensureDir();
      // 先写临时文件再改名：中途失败也不会留下半个 JSON（与 settings-store 一致）
      const temp = `${this.profileFile}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.profile, null, 2)}\n`, 'utf8');
      renameSync(temp, this.profileFile);
    } catch (error) {
      this.logger.error('memory profile save failed', { error: describeError(error) });
    }
  }

  private readDayFile<T>(file: string): T[] {
    if (!existsSync(file)) return [];
    try {
      const lines = readFileSync(file, 'utf8').split('\n');
      const out: T[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          out.push(JSON.parse(trimmed) as T);
        } catch {
          /* 单行坏了就跳过，不影响整天的记忆 */
        }
      }
      return out;
    } catch (error) {
      this.logger.warn('memory day file read failed', { error: describeError(error), data: { file } });
      return [];
    }
  }

  private appendJsonl(file: string, value: unknown): void {
    try {
      this.ensureDir();
      appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
    } catch (error) {
      this.logger.warn('memory append failed', { error: describeError(error), data: { file } });
    }
  }

  /** 追加到人可读的记忆日志（写失败只告警，绝不影响对话）。 */
  private appendLog(line: string): void {
    try {
      this.ensureDir();
      appendFileSync(this.logFile, `${line}\n`, 'utf8');
    } catch (error) {
      this.logger.warn('memory log append failed', { error: describeError(error) });
    }
  }

  private eventsFile(day: string): string {
    return join(this.dir, `events-${day}.jsonl`);
  }

  private chatFile(day: string): string {
    return join(this.dir, `chat-${day}.jsonl`);
  }
}

/* -------------------------------------------------------------------------- */
/* 辅助                                                                        */
/* -------------------------------------------------------------------------- */

function emptyProfile(): MemoryProfile {
  return { userName: '', petName: '', facts: [], summary: '', updatedAt: '' };
}

/** 本地日期键（**不用 UTC**：日记/记忆是按用户所在时区的"今天"分的）。 */
export function todayKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function stamp(now: Date = new Date()): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}

function formatEventLine(event: MemoryEvent): string {
  const time = event.at.slice(11, 16);
  return `- ${event.at.slice(0, 10)} ${time} · [${event.kind}] ${event.text}`;
}

function formatTurnLine(turn: ChatTurn): string {
  const time = turn.at.slice(11, 16);
  const who = turn.role === 'user' ? '主人' : '她';
  return `- ${turn.at.slice(0, 10)} ${time} · ${who}：${turn.text.replace(/\n/g, ' ')}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function score(fact: MemoryFact): number {
  return fact.confidence * Math.min(5, fact.hits);
}

function sanitizeFact(raw: unknown): MemoryFact | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.key !== 'string' || typeof record.value !== 'string' || record.value.trim() === '') return null;
  const now = new Date().toISOString();
  return {
    key: record.key as MemoryFact['key'],
    value: record.value.slice(0, 80),
    confidence: typeof record.confidence === 'number' ? Math.min(1, Math.max(0, record.confidence)) : 0.6,
    source: record.source === 'llm' || record.source === 'manual' ? record.source : 'heuristic',
    firstSeenAt: typeof record.firstSeenAt === 'string' ? record.firstSeenAt : now,
    lastSeenAt: typeof record.lastSeenAt === 'string' ? record.lastSeenAt : now,
    hits: typeof record.hits === 'number' && record.hits > 0 ? Math.round(record.hits) : 1,
  };
}
