/**
 * TriggerService —— 把**系统信号**喂给 `shared/pet-triggers.ts` 的纯规则，
 * 再通过回调触发动画（sad / hungry / offline / overheat / catch_down / catch_right）。
 *
 * 为什么放在主进程：
 *   - 光标位置（`screen.getCursorScreenPoint`）只有主进程能读；
 *   - 子进程探测（GPU 温度）需要 Node 能力；
 *   - 情绪与余额都在主进程的 AI 服务里。
 *
 * 渲染层只负责"把动画演出来"，判定与节流全在这里 ——
 * 这样"她为什么突然难过"在一条日志里就能回答完整。
 *
 * 设计约定（可测性）：
 *   - 所有阈值与"是否重新武装"的规则都在 shared/pet-triggers.ts（纯函数）；
 *   - 本文件只做"取数 + 保存武装状态 + 调用回调"，不写新的判定逻辑。
 */

import { execFile } from 'node:child_process';
import { screen } from 'electron';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import {
  APPROACH_COOLDOWN_MS,
  CONDITION_REPEAT_RANGE_MS,
  classifyApproach,
  evaluateHungry,
  evaluateOffline,
  evaluateOverheat,
  evaluateSad,
  OVERHEAT_TEMP_C,
  pickRepeatDelayMs,
  type TriggerAnimationId,
} from '../../shared/pet-triggers';
import type { Rect } from '../../shared/dock';

export interface TriggerServiceOptions {
  readonly logger: Logger;
  /** 触发一条动画（主进程 -> 渲染层，走普通优先级仲裁）。 */
  readonly trigger: (animationId: TriggerAnimationId, reason: string) => void;
  /**
   * 是否已被用户暂停（托盘「暂停行为」）。
   *
   * 暂停 = "不要自己动"：这些触发全是她主动演，暂停时一律不检查、不触发；
   * 用户点她仍然照常有反应（那走的是点击路径，不经过这里）。
   */
  readonly isPaused?: () => boolean;
  /** 宠物在屏幕上的矩形；窗口不可见时返回 null。 */
  readonly getPetRect: () => Rect | null;
  /** 情绪快照（mood / satiety 饱腹）。 */
  readonly getEmotion: () => { readonly mood: number; readonly satiety: number } | null;
  /** 掉线原因（空串 = 没掉线）。 */
  readonly getOfflineReason: () => string;
  /** 光标轮询间隔（毫秒，默认 250）。 */
  readonly cursorIntervalMs?: number;
  /** 两次"接住"之间的最短间隔（毫秒，默认 `APPROACH_COOLDOWN_MS`）。 */
  readonly approachCooldownMs?: number;
  /** 慢速状态轮询间隔（毫秒，默认 30 秒）：情绪 / 掉线。 */
  readonly stateIntervalMs?: number;
  /** GPU 温度轮询间隔（毫秒，默认 60 秒）。 */
  readonly gpuIntervalMs?: number;
  /**
   * GPU "算过热"的温度阈值（摄氏度，默认 80，来自感知设置）。
   *
   * 做成可配置而不是写死：不同机器/季节的耐热不一样（笔记本 75 度就该提醒了），
   * 而且**可配置才验证得了** —— 真机把阈值调到低于当前温度，就能看到
   * "真温度 -> 真触发 -> 真动画"这条链路（见 tools/probe-offline-overheat.cjs）。
   */
  readonly getOverheatThresholdC?: () => number;
  /**
   * 「持续状态」触发的重复间隔（毫秒，默认 `CONDITION_REPEAT_RANGE_MS` = 3~8 分钟）。
   *
   * 断网与过热只要还在持续，就按这个区间**随机**再演一次（用户要求）。
   * 做成可注入是为了验收能在几秒内看到"重复"这件事（见 probe-offline-overheat）。
   */
  readonly conditionRepeatRangeMs?: readonly [number, number];
  /** 随机源（默认 `Math.random`，验收可注入固定值）。 */
  readonly random?: () => number;
}

export class TriggerService {
  private readonly options: TriggerServiceOptions;
  private readonly logger: Logger;
  private cursorTimer: NodeJS.Timeout | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private gpuTimer: NodeJS.Timeout | null = null;

  /* --- 武装状态（true = 还没为这一次越界演过动画） --- */
  private approachArmed = true;
  private sadArmed = true;
  private hungryArmed = true;
  private offlineArmed = true;
  private overheatArmed = true;

  /** 上一次"接住"发生的时间（0 = 从没演过）；冷却靠它算。 */
  private approachLastTriggerAt = 0;

  /**
   * 「持续状态」下一次该重演的时间（0 = 还没进入坏状态）。
   *
   * 断网与过热共用这套：状态刚变坏时立刻演一次，之后每隔随机 3~8 分钟再演一次，
   * 直到状态恢复（恢复时清零 —— 下次变坏又是"立刻演"）。
   */
  private offlineNextAt = 0;
  private overheatNextAt = 0;

  /** 最近一次 GPU 温度（摄氏度）；null = 读不到。 */
  private gpuTempC: number | null = null;
  /** 连续多少次读不到 GPU 温度（决定要不要打一条"这个功能不可用"的日志）。 */
  private gpuFailures = 0;
  private gpuProbeWarned = false;

  public constructor(options: TriggerServiceOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  private isPaused(): boolean {
    try {
      return this.options.isPaused?.() === true;
    } catch {
      // 暂停状态读不出来时按"没暂停"处理：宁可多演一次，也不要静默失效
      return false;
    }
  }

  public start(): void {
    if (this.cursorTimer !== null) return;

    this.cursorTimer = setInterval(() => {
      try {
        this.checkApproach();
      } catch (error) {
        this.logger.warn('cursor proximity check failed', { error: describeError(error) });
      }
    }, Math.max(100, this.options.cursorIntervalMs ?? 250));
    this.cursorTimer.unref?.();

    this.stateTimer = setInterval(() => {
      try {
        this.checkMoodAndHunger();
        this.checkOffline();
      } catch (error) {
        this.logger.warn('state trigger check failed', { error: describeError(error) });
      }
    }, Math.max(5000, this.options.stateIntervalMs ?? 30_000));
    this.stateTimer.unref?.();

    this.gpuTimer = setInterval(() => {
      void this.probeGpuTemperature().then(() => this.checkOverheat()).catch(() => undefined);
    }, Math.max(10_000, this.options.gpuIntervalMs ?? 60_000));
    this.gpuTimer.unref?.();

    // 启动时先各查一次，别让"没配密钥"要等 30 秒才演
    this.checkMoodAndHunger();
    this.checkOffline();
    void this.probeGpuTemperature().then(() => this.checkOverheat()).catch(() => undefined);
    this.logger.info('trigger service started', {
      data: {
        cursorMs: this.options.cursorIntervalMs ?? 250,
        approachCooldownMs: this.options.approachCooldownMs ?? APPROACH_COOLDOWN_MS,
        stateMs: this.options.stateIntervalMs ?? 30_000,
        gpuMs: this.options.gpuIntervalMs ?? 60_000,
        // 过热阈值是从感知设置读来的：打在启动日志里，"设置没生效"一眼可查
        overheatThresholdC: this.resolveOverheatThreshold(),
      },
    });
  }

  public stop(): void {
    for (const timer of [this.cursorTimer, this.stateTimer, this.gpuTimer]) {
      if (timer !== null) clearInterval(timer);
    }
    this.cursorTimer = null;
    this.stateTimer = null;
    this.gpuTimer = null;
  }

  /* ------------------------------------------------------------------ */
  /* 1) 鼠标靠近（catch_down / catch_right）                              */
  /* ------------------------------------------------------------------ */

  private checkApproach(): void {
    if (this.isPaused()) return;
    const pet = this.options.getPetRect();
    if (!pet) return;
    let cursor: { x: number; y: number };
    try {
      cursor = screen.getCursorScreenPoint();
    } catch (error) {
      this.logger.debug('cursor point unavailable', { error: describeError(error) });
      return;
    }
    const decision = classifyApproach(
      {
        dx: cursor.x - (pet.x + pet.width / 2),
        dy: cursor.y - (pet.y + pet.height / 2),
      },
      this.approachArmed,
      {
        // 冷却：距上次"接住"不足 APPROACH_COOLDOWN_MS 时不再演（见 shared/pet-triggers）
        cooldownMs: this.options.approachCooldownMs ?? APPROACH_COOLDOWN_MS,
        sinceLastTriggerMs: this.approachLastTriggerAt === 0
          ? Number.POSITIVE_INFINITY
          : Date.now() - this.approachLastTriggerAt,
      },
    );
    this.approachArmed = decision.armed;
    if (decision.animationId) {
      this.approachLastTriggerAt = Date.now();
      this.fire(decision.animationId, 'proximity:cursor');
    }
  }

  /**
   * 真的去触发，并**记一条带原因的日志**。
   *
   * 为什么多这一层：这个类存在的意义就是回答"她为什么突然演这个"，
   * 而原因字符串（`offline:network` / `gpu-hot:52C>=45C`）原来只往 IPC 里塞了一份，
   * 日志里只有一个动画 id —— 掉线到底是"没配密钥"还是"网断了"就分不出来。
   */
  private fire(animationId: TriggerAnimationId, reason: string): void {
    this.logger.info('trigger fired', { data: { animationId, reason } });
    this.options.trigger(animationId, reason);
  }

  /* ------------------------------------------------------------------ */
  /* 2) 心情 / 饿                                                        */
  /* ------------------------------------------------------------------ */

  private checkMoodAndHunger(): void {
    if (this.isPaused()) return;
    const emotion = this.options.getEmotion();
    if (!emotion) return;

    const sad = evaluateSad(emotion.mood, this.sadArmed);
    this.sadArmed = sad.armed;
    if (sad.animationId) this.fire(sad.animationId, `mood-low:${emotion.mood}`);

    const hungry = evaluateHungry(emotion.satiety, this.hungryArmed);
    this.hungryArmed = hungry.armed;
    if (hungry.animationId) this.fire(hungry.animationId, `satiety-low:${emotion.satiety}`);
  }

  /* ------------------------------------------------------------------ */
  /* 3) 掉线（没配密钥 / 密钥无效 / 网络不通 / 余额不足）                    */
  /* ------------------------------------------------------------------ */

  private checkOffline(): void {
    if (this.isPaused()) return;
    const reason = this.options.getOfflineReason();
    const decision = evaluateOffline(reason, this.offlineArmed);
    this.offlineArmed = decision.armed;
    if (decision.animationId) {
      this.fire(decision.animationId, `offline:${reason}`);
      this.offlineNextAt = Date.now() + this.repeatDelay();
      return;
    }
    if (reason === '') {
      // 恢复了：下次一断就立刻演（而不是接着上一轮的计时）
      this.offlineNextAt = 0;
      return;
    }
    // 还在掉线：到点了就再演一次（用户要求"网络不连通时随机触发"）
    if (this.offlineNextAt !== 0 && Date.now() >= this.offlineNextAt) {
      this.fire('offline', `offline:${reason}`);
      this.offlineNextAt = Date.now() + this.repeatDelay();
    }
  }

  /** 持续状态的下一次重复间隔（随机；可注入随机源与区间，便于验收）。 */
  private repeatDelay(): number {
    const random = this.options.random ?? Math.random;
    try {
      return pickRepeatDelayMs(random, this.options.conditionRepeatRangeMs ?? CONDITION_REPEAT_RANGE_MS);
    } catch {
      // 随机源坏了也不能让她再不被提醒：退回区间下限
      return (this.options.conditionRepeatRangeMs ?? CONDITION_REPEAT_RANGE_MS)[0];
    }
  }

  /* ------------------------------------------------------------------ */
  /* 4) GPU 温度（overheat）                                             */
  /* ------------------------------------------------------------------ */

  /**
   * 读 GPU 温度：优先 `nvidia-smi`。
   *
   * 读不到就是 **null**，规则层会当作"不知道"，一律不触发 ——
   * 猜一个温度出来演"过热"只会变成假警报（这也是需求里"不确定就不要做特化"
   * 那条思路在触发动画上的延续）。
   */
  private async probeGpuTemperature(): Promise<void> {
    try {
      const output = await queryNvidiaSmi();
      const value = Number.parseFloat(output);
      if (Number.isFinite(value) && value > 0 && value < 150) {
        this.gpuTempC = value;
        this.gpuFailures = 0;
        return;
      }
      this.gpuTempC = null;
      this.noteGpuUnavailable('nvidia-smi 返回了无法解析的温度');
    } catch (error) {
      this.gpuTempC = null;
      this.noteGpuUnavailable(describeError(error));
    }
  }

  private noteGpuUnavailable(detail: string): void {
    this.gpuFailures += 1;
    // 只提醒一次：持续刷"读不到温度"会把日志淹掉，而它本来就是可选功能
    if (!this.gpuProbeWarned) {
      this.gpuProbeWarned = true;
      this.logger.info('GPU temperature unavailable; overheat animation stays off', {
        data: { detail: detail.slice(0, 120) },
      });
    }
  }

  private checkOverheat(): void {
    if (this.isPaused()) return;
    const threshold = this.resolveOverheatThreshold();
    const decision = evaluateOverheat(this.gpuTempC, this.overheatArmed, { threshold });
    this.overheatArmed = decision.armed;
    const reason = `gpu-hot:${this.gpuTempC ?? '?'}C>=${threshold}C`;
    if (decision.animationId) {
      this.fire(decision.animationId, reason);
      this.overheatNextAt = Date.now() + this.repeatDelay();
      return;
    }
    // 温度降下来了（含读不到温度）：下次一热就立刻演
    if (this.gpuTempC === null || this.gpuTempC < threshold) {
      this.overheatNextAt = 0;
      return;
    }
    // 还热着：到点了就再演一次（用户要求"温度过高时随机触发"）
    if (this.overheatNextAt !== 0 && Date.now() >= this.overheatNextAt) {
      this.fire('overheat', reason);
      this.overheatNextAt = Date.now() + this.repeatDelay();
    }
  }

  /** 读过热阈值（感知设置坏了就退回默认 80 度，绝不因为配置问题不提醒）。 */
  private resolveOverheatThreshold(): number {
    try {
      const value = this.options.getOverheatThresholdC?.();
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 150) return value;
    } catch (error) {
      this.logger.debug('overheat threshold unavailable', { error: describeError(error) });
    }
    return OVERHEAT_TEMP_C;
  }

  /** 供托盘/验收查询：当前读到的 GPU 温度与"这个功能是否可用"。 */
  public describe(): {
    readonly gpuTempC: number | null;
    readonly gpuAvailable: boolean;
    readonly overheatThresholdC: number;
    readonly approachCooldownMs: number;
    readonly armed: {
      readonly approach: boolean;
      readonly sad: boolean;
      readonly hungry: boolean;
      readonly offline: boolean;
      readonly overheat: boolean;
    };
  } {
    return {
      gpuTempC: this.gpuTempC,
      // 连续失败 3 次以上就当作"这台机器没有可读的 GPU 温度"
      gpuAvailable: this.gpuFailures < 3,
      overheatThresholdC: this.resolveOverheatThreshold(),
      approachCooldownMs: this.options.approachCooldownMs ?? APPROACH_COOLDOWN_MS,
      armed: {
        approach: this.approachArmed,
        sad: this.sadArmed,
        hungry: this.hungryArmed,
        offline: this.offlineArmed,
        overheat: this.overheatArmed,
      },
    };
  }
}

/**
 * 调用 `nvidia-smi` 读一次温度。
 *
 * 用 `execFile`（不是 `exec`）：不经过 shell，参数是固定数组，
 * 不存在命令注入面；超时 5 秒，失败就当读不到。
 */
function queryNvidiaSmi(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout).trim().split(/\r?\n/)[0] ?? '');
      },
    );
  });
}
