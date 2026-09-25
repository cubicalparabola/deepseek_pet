/**
 * 感知数据落盘（3.1/3.4/3.6）—— **只存文本，永不存图像**。
 *
 * `<userData>/perception/` 下：
 *   observations-YYYY-MM-DD.jsonl   每次屏幕观察的结构化结果（场景/应用/摘要）
 *   habits.json                     3.6 的习惯画像（按小时直方图）
 *   perception-log.md               **可审计的感知日志**：她看见了什么、为什么开口
 *
 * 为什么坚持"图像不落盘"：
 * 截图是这个模块里最敏感的数据，而它对功能的价值是"当下这一刻"——
 * 用完即弃即可。留下的文本足够支撑习惯统计与"她为什么说话"的复盘，
 * 用户打开 perception/ 就能完整看到她掌握的信息（不多不少）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  HabitProfile,
  PerceptionLogItem,
  ScreenObservation,
} from '../../shared/perception-types';
import { emptyHabitProfile, formatLogTimestamp, formatObservationLogLine } from '../../shared/perception';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export interface ObservationStoreOptions {
  /** 数据根目录（`%APPDATA%\DesktopPet`）。 */
  readonly dataDir: string;
  readonly logger: Logger;
}

export class ObservationStore {
  private readonly logger: Logger;
  private readonly dir: string;
  private readonly habitsFile: string;
  private readonly logFile: string;
  private habits: HabitProfile = emptyHabitProfile();

  public constructor(options: ObservationStoreOptions) {
    this.logger = options.logger;
    this.dir = join(options.dataDir, 'perception');
    this.habitsFile = join(this.dir, 'habits.json');
    this.logFile = join(this.dir, 'perception-log.md');
  }

  public get dataDir(): string {
    return this.dir;
  }

  public get logPath(): string {
    return this.logFile;
  }

  /** 读盘（缺失/损坏都用空画像）。 */
  public load(): HabitProfile {
    if (!existsSync(this.habitsFile)) {
      this.habits = emptyHabitProfile();
      return this.habits;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.habitsFile, 'utf8'));
      this.habits = sanitizeHabits(parsed);
      this.logger.info('habit profile loaded', {
        data: { samples: this.habits.samples, hours: this.habits.observedHours, days: this.habits.activeDays },
      });
    } catch (error) {
      this.logger.warn('habit profile parse failed; starting empty', { error: describeError(error) });
      this.habits = emptyHabitProfile();
    }
    return this.habits;
  }

  public getHabits(): HabitProfile {
    return this.habits;
  }

  /**
   * 记录一次观察（追加 JSONL + 写一行可读日志）。
   *
   * 日志行**自己按观察内容拼**（`formatObservationLogLine`），不再由调用方传一句摘要：
   * 以前每个调用点各拼一句，于是面板那路和文件那路措辞不一致、字段也少
   * （用户报"感知日志不如对话框详细"）。现在文件与面板共用同一个纯函数。
   *
   * 时间戳用 `formatLogTimestamp()`（**本地时间 + 秒**）：原来是 `iso.slice(11,16)`，
   * 那是 UTC 时分，UTC+8 下整份日志差 8 小时（用户报的"时间不对"）。
   */
  public recordObservation(observation: ScreenObservation): void {
    /*
     * 文件名用**本地日期**：`observation.at` 是 ISO(UTC) 字符串，
     * 直接 `slice(0,10)` 会在 UTC+8 的凌晨把记录写到"昨天"的文件里，
     * 而 UI 的"今天有多少条"是用本地日期算的 —— 两边会不一致（文档评审抓到）。
     */
    const day = localDay(new Date(observation.at));
    try {
      this.ensureDir();
      appendFileSync(join(this.dir, `observations-${day}.jsonl`), `${JSON.stringify(observation)}\n`, 'utf8');
      this.appendLog(`- ${formatLogTimestamp(observation.at)} · [observation] ${formatObservationLogLine(observation)}`);
    } catch (error) {
      this.logger.warn('recording observation failed', { error: describeError(error) });
    }
  }

  /** 保存习惯画像（每次学习后调用；写盘失败不影响运行）。 */
  public saveHabits(profile: HabitProfile): void {
    this.habits = profile;
    try {
      this.ensureDir();
      const temp = `${this.habitsFile}.tmp`;
      writeFileSync(temp, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
      renameSync(temp, this.habitsFile);
    } catch (error) {
      this.logger.warn('habit profile save failed', { error: describeError(error) });
    }
  }

  /** 记一条感知日志（干预/隐私/摄像头等）。时间同样是**本地时间 + 秒**。 */
  public log(kind: PerceptionLogItem['kind'], text: string, at: string = new Date().toISOString()): void {
    try {
      this.ensureDir();
      this.appendLog(`- ${formatLogTimestamp(at)} · [${kind}] ${text}`);
    } catch (error) {
      this.logger.warn('perception log append failed', { error: describeError(error) });
    }
  }

  /** 读某天的观察记录（成长模块统计场景分布用）。 */
  public readObservations(date: string): ScreenObservation[] {
    return this.readJsonl<ScreenObservation>(join(this.dir, `observations-${date}.jsonl`));
  }

  /** JSONL 读取（坏行跳过，与记忆模块同一套宽容策略）。 */
  private readJsonl<T>(file: string): T[] {
    if (!existsSync(file)) return [];
    try {
      const out: T[] = [];
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          out.push(JSON.parse(trimmed) as T);
        } catch {
          /* 单行坏了跳过 */
        }
      }
      return out;
    } catch (error) {
      this.logger.warn('observation file read failed', { error: describeError(error), data: { file } });
      return [];
    }
  }

  /** 今天的观察条数（状态展示用）。 */
  public todayCount(day: string = localDay()): number {
    const file = join(this.dir, `observations-${day}.jsonl`);
    if (!existsSync(file)) return 0;
    try {
      return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
    } catch {
      return 0;
    }
  }

  /** 有多少天的观察记录（倒序）。 */
  public availableDays(): string[] {
    try {
      const days = new Set<string>();
      for (const file of readdirSync(this.dir)) {
        const matched = /^observations-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
        if (matched?.[1]) days.add(matched[1]);
      }
      return [...days].sort().reverse();
    } catch {
      return [];
    }
  }

  /** 清空（隐私要求：用户可以一键抹掉她观察到的一切）。 */
  public clear(): void {
    try {
      for (const file of readdirSync(this.dir)) {
        if (file === 'perception-log.md') continue;
        try {
          writeFileSync(join(this.dir, file), '', 'utf8');
        } catch {
          /* 单个文件失败就跳过 */
        }
      }
    } catch (error) {
      this.logger.warn('clearing observations failed', { error: describeError(error) });
    }
    this.habits = emptyHabitProfile();
    this.saveHabits(this.habits);
    this.appendLog(`- ${formatLogTimestamp(new Date().toISOString())} · [privacy] 用户清空了感知记录`);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.logFile)) {
      writeFileSync(
        this.logFile,
        `# 鲸鱼娘的感知日志\n\n> 这里记录她**看见过什么**（纯文本）以及**为什么开口/开口说了什么**。\n> 截图与摄像头画面从不写入磁盘。可直接编辑或删除。\n\n`,
        'utf8',
      );
    }
  }

  private appendLog(line: string): void {
    this.ensureDir();
    appendFileSync(this.logFile, `${line}\n`, 'utf8');
  }
}

/* -------------------------------------------------------------------------- */

export function localDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 画像清洗：只保留合法的小时键与非负计数。 */
function sanitizeHabits(raw: unknown): HabitProfile {
  if (typeof raw !== 'object' || raw === null) return emptyHabitProfile();
  const record = raw as Record<string, unknown>;
  const hours: Record<string, Record<string, number>> = {};
  const rawHours = typeof record.hours === 'object' && record.hours !== null ? (record.hours as Record<string, unknown>) : {};
  for (const [hour, bucket] of Object.entries(rawHours)) {
    const hourNumber = Number(hour);
    if (!Number.isInteger(hourNumber) || hourNumber < 0 || hourNumber > 23) continue;
    if (typeof bucket !== 'object' || bucket === null) continue;
    const clean: Record<string, number> = {};
    for (const [scene, count] of Object.entries(bucket as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) clean[scene.slice(0, 24)] = Math.round(count);
    }
    if (Object.keys(clean).length > 0) hours[hour] = clean;
  }
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
  return {
    hours,
    observedHours: Object.keys(hours).length,
    samples: typeof record.samples === 'number' && record.samples > 0 ? Math.round(record.samples) : 0,
    activeDays: typeof record.activeDays === 'number' && record.activeDays > 0 ? Math.round(record.activeDays) : 0,
    latestActiveHour: numberOrNull(record.latestActiveHour),
    earliestActiveHour: numberOrNull(record.earliestActiveHour),
    lastActiveDate: typeof record.lastActiveDate === 'string' ? record.lastActiveDate : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  };
}
