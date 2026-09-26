/**
 * 情绪服务（2.3）—— 把纯函数模型（shared/emotion.ts）接到持久化与定时器上。
 *
 * 职责边界：
 * - **模型**只做状态转移（可被验收直接调用，见 shared/emotion.ts）；
 * - **本文件**负责"什么时候结算"：每分钟心跳、互动即时上涨、开关关闭时冻结；
 * - token 用量归 AI 配置所有（ai-config-store），这里只接收"剩余比例"。
 *
 * 持久化：`<userData>/emotion.json`。程序关掉再打开，心情是接着掉的
 * （`decayEmotion` 里对单次衰减时长有上限，避免一夜之间掉到 0）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmotionState, InteractionKind, PetPresence } from '../../shared/ai-types';
import {
  applyInteraction,
  applyTokens,
  clampMood,
  decayEmotion,
  initialEmotion,
  tokensRemainingRatio,
} from '../../shared/emotion';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export interface EmotionServiceOptions {
  /** 数据根目录（`%APPDATA%\DesktopPet`）。 */
  readonly dataDir: string;
  readonly logger: Logger;
  /** 情绪开关是否打开（关闭时冻结：不涨也不掉）。 */
  readonly isEnabled: () => boolean;
  /** token 预算（用于推导"饿"）。 */
  readonly getBudget: () => { readonly budget: number; readonly used: number };
  /** 状态变化回调（推 UI / 写记忆）。 */
  readonly onChange?: (state: EmotionState, presence: PetPresence) => void;
  /** 心跳间隔（毫秒，默认 60s）。 */
  readonly heartbeatMs?: number;
  /** 采样间隔（毫秒，默认 5 分钟）——日记的心情曲线靠它。 */
  readonly sampleMs?: number;
}

/** 一条心情采样（日记用，`mood/mood-YYYY-MM-DD.jsonl`）。 */
export interface MoodSample {
  readonly at: string;
  readonly mood: number;
  readonly satiety: number;
  readonly presence: PetPresence;
}

export class EmotionService {
  private readonly options: EmotionServiceOptions;
  private readonly logger: Logger;
  private readonly file: string;
  private state: EmotionState;
  private currentPresence: PetPresence = 'visible';
  private timer: NodeJS.Timeout | null = null;
  /** 上次心情采样时间（节流用）。 */
  private lastSampleAt = 0;
  /**
   * 余额推出的饥饿度（0~100）；`null` = 没有余额信息，退回本地累计 token。
   *
   * 为什么要这个覆盖：需求明确"余额优先于本地预算" ——
   * 本地累计 token 只统计这台机器上我们发出去的请求，
   * 而余额才是"账号还剩多少额度"的真相（换机器、别的程序也在用）。
   */
  private balanceSatiety: number | null = null;

  public constructor(options: EmotionServiceOptions) {
    this.options = options;
    this.logger = options.logger;
    this.file = join(options.dataDir, 'emotion.json');
    this.state = initialEmotion();
  }

  /** 读盘（缺失/损坏都用初始值）。 */
  public load(now: number = Date.now()): EmotionState {
    this.state = this.read(now);
    this.logger.info('emotion state loaded', { data: { mood: this.state.mood, satiety: this.state.satiety } });
    this.refreshTokens(now);
    return this.state;
  }

  public get(): EmotionState {
    return this.state;
  }

  public get presence(): PetPresence {
    return this.currentPresence;
  }

  /** 切换在场状态（可见 / 收起 / 隐藏）。 */
  public setPresence(presence: PetPresence, now: number = Date.now()): EmotionState {
    if (presence === this.currentPresence) return this.state;
    const previous = this.currentPresence;
    this.currentPresence = presence;
    this.logger.info('presence changed', { data: { from: previous, to: presence } });
    // 立刻按新状态结算一次：不能等一分钟心跳，"收起/隐藏立刻掉得更快"要马上成立
    this.tick(now);
    return this.state;
  }

  /** 一次互动：心情上涨（关闭情绪时不动）。 */
  public interact(kind: InteractionKind, now: number = Date.now()): EmotionState {
    if (!this.options.isEnabled()) return this.state;
    this.state = applyInteraction(this.state, kind, now);
    this.save();
    this.emit();
    return this.state;
  }

  /** token 用量变化后刷新"饱腹度"。 */
  public refreshTokens(now: number = Date.now()): EmotionState {
    const ratio = this.remainingRatio();
    const next = applyTokens(this.state, ratio, now);
    if (next.satiety !== this.state.satiety) {
      this.state = next;
      this.save();
      this.emit();
    }
    return this.state;
  }

  /**
   * 设置"余额推出的饱腹度"（`null` = 没有余额信息，退回本地预算）。
   *
   * 立刻结算一次：余额查回来就该马上反映在 satiety 上，
   * 而不是等下一次心跳（否则"没钱了"这件事要一分钟才生效）。
   */
  public setBalanceSatiety(satiety: number | null, now: number = Date.now()): EmotionState {
    this.balanceSatiety = satiety === null || !Number.isFinite(satiety)
      ? null
      : Math.min(100, Math.max(0, Math.round(satiety)));
    return this.refreshTokens(now);
  }

  public hasBalanceSatiety(): boolean {
    return this.balanceSatiety !== null;
  }

  /** 当前用于推导"饱腹度"的剩余比例：余额优先，其次本地累计 token。 */
  private remainingRatio(): number {
    if (this.balanceSatiety !== null) return this.balanceSatiety / 100;
    return tokensRemainingRatio(this.options.getBudget());
  }

  /**
   * 结算一次衰减。
   *
   * 情绪开关关闭时**只推进 lastUpdateAt**：不然关掉开关半小时再打开，
   * 会把关闭期间的时间一次性算成衰减（用户会觉得"关了还掉"）。
   */
  public tick(now: number = Date.now()): EmotionState {
    if (!this.options.isEnabled()) {
      this.state = { ...this.state, lastUpdateAt: now };
      return this.state;
    }
    const ratio = this.remainingRatio();
    const before = this.state.mood;
    this.state = decayEmotion(this.state, { presence: this.currentPresence, now, tokensRemainingRatio: ratio });
    if (this.state.mood !== before) this.save();
    this.emit();
    return this.state;
  }

  /** 心跳：每分钟结算一次（这样 UI 上的心情会自己缓慢变化）。 */
  public startHeartbeat(): void {
    if (this.timer !== null) return;
    const interval = Math.max(5000, this.options.heartbeatMs ?? 60000);
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.logger.warn('emotion heartbeat failed', { error: describeError(error) });
      }
    }, interval);
    // 心跳不该阻止进程退出
    this.timer.unref?.();
  }

  public stopHeartbeat(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 重置为初始值（UI 上的"重置情绪"）。 */
  public reset(now: number = Date.now()): EmotionState {
    this.state = initialEmotion(now);
    this.refreshTokens(now);
    this.save();
    this.emit();
    return this.state;
  }

  /* ------------------------------------------------------------------ */

  private read(now: number): EmotionState {
    if (!existsSync(this.file)) return initialEmotion(now);
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return initialEmotion(now);
      const record = parsed as Record<string, unknown>;
      const fallback = initialEmotion(now);
      return {
        mood: clampNumber(record.mood, fallback.mood),
        /*
         * 迁移：老版本存的是 `hunger`（饥饿值，越大越饿），
         * 现在是 `satiety`（饱腹值，越大越饱）—— 数值**反过来**：
         * `satiety = 100 - hunger`。不做这一步的话，用户升上来会看到
         * "本来很饱的宠物突然饿得说不出话"（旧文件里 hunger=0 会被读成 satiety=0）。
         */
        satiety: record.satiety === undefined && record.hunger !== undefined
          ? clampMood(100 - clampNumber(record.hunger, 0))
          : clampNumber(record.satiety, fallback.satiety),
        lastInteractionAt: clampNumber(record.lastInteractionAt, now),
        lastUpdateAt: clampNumber(record.lastUpdateAt, now),
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(now).toISOString(),
      };
    } catch (error) {
      this.logger.error('emotion state parse failed; using initial', { error: describeError(error) });
      return initialEmotion(now);
    }
  }

  private save(): void {
    /*
     * 情绪开关关闭时**不写盘**：需求要求"可配置开关"，关掉就不该在用户磁盘上
     * 留下 emotion.json / mood-*.jsonl（不然用户会以为关不掉）。
     * 内存里的数值照常变化，只是不持久化。
     */
    if (!this.options.isEnabled()) return;
    try {
      mkdirSync(this.options.dataDir, { recursive: true });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      renameSync(temp, this.file);
      this.sample();
    } catch (error) {
      this.logger.warn('emotion state save failed', { error: describeError(error) });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 心情采样（日记的心情曲线）                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 采样当前心情到 `mood/mood-YYYY-MM-DD.jsonl`。
   *
   * 为什么要单独存一条时间线：日记里"早上还只是平静，被陪着陪着就开心了"
   * 这种叙述需要**当天的心情变化**，只存一个最终值写不出来。
   * 采样间隔默认 5 分钟 —— 足够画出曲线，又不会把文件写爆。
   */
  private sample(now: number = Date.now()): void {
    if (now - this.lastSampleAt < Math.max(30000, this.options.sampleMs ?? 300000)) return;
    this.lastSampleAt = now;
    const date = localDateKey(new Date(now));
    const file = join(this.options.dataDir, 'mood', `mood-${date}.jsonl`);
    const entry: MoodSample = {
      at: new Date(now).toISOString(),
      mood: this.state.mood,
      satiety: this.state.satiety,
      presence: this.currentPresence,
    };
    try {
      mkdirSync(join(this.options.dataDir, 'mood'), { recursive: true });
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      this.logger.debug('mood sample append failed', { error: describeError(error) });
    }
  }

  /** 读某天的心情采样（老的 `hunger` 字段按 `100 - hunger` 迁移成 `satiety`）。 */
  public samplesFor(date: string): MoodSample[] {
    const file = join(this.options.dataDir, 'mood', `mood-${date}.jsonl`);
    if (!existsSync(file)) return [];
    try {
      return readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line): MoodSample | null => {
          try {
            const raw = JSON.parse(line) as Record<string, unknown>;
            const mood = clampNumber(raw.mood, this.state.mood);
            const satiety = raw.satiety === undefined && raw.hunger !== undefined
              ? clampMood(100 - clampNumber(raw.hunger, 0))
              : clampNumber(raw.satiety, this.state.satiety);
            return {
              at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
              mood,
              satiety,
              presence: (raw.presence === 'collapsed' || raw.presence === 'hidden' ? raw.presence : 'visible'),
            };
          } catch {
            return null;
          }
        })
        .filter((item): item is MoodSample => item !== null);
    } catch (error) {
      this.logger.debug('mood samples read failed', { error: describeError(error) });
      return [];
    }
  }

  /**
   * 某天的情绪曲线；没有采样时退化为"用当前情绪当首尾值"。
   *
   * 这样即使情绪开关刚打开、还没攒够采样，日记里也不会出现 `mood: 0 → 0`。
   */
  public moodCurve(date: string): { start: number; end: number; low: number } {
    const samples = this.samplesFor(date);
    if (samples.length === 0) {
      return { start: this.state.mood, end: this.state.mood, low: this.state.mood };
    }
    const values = samples.map((sample) => sample.mood);
    const first = values[0] ?? this.state.mood;
    const last = values[values.length - 1] ?? first;
    return { start: first, end: last, low: Math.min(...values) };
  }

  private emit(): void {
    try {
      this.options.onChange?.(this.state, this.currentPresence);
    } catch (error) {
      this.logger.warn('emotion onChange handler failed', { error: describeError(error) });
    }
  }
}

function clampNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

/** 本地日期键（不用 UTC：日记与采样都按用户所在时区分天）。 */
function localDateKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
