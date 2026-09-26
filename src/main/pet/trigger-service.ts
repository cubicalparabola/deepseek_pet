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
  classifyApproach,
  evaluateHungry,
  evaluateOffline,
  evaluateOverheat,
  evaluateSad,
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
  /** 情绪快照（mood / hunger）。 */
  readonly getEmotion: () => { readonly mood: number; readonly hunger: number } | null;
  /** 掉线原因（空串 = 没掉线）。 */
  readonly getOfflineReason: () => string;
  /** 光标轮询间隔（毫秒，默认 250）。 */
  readonly cursorIntervalMs?: number;
  /** 慢速状态轮询间隔（毫秒，默认 30 秒）：情绪 / 掉线。 */
  readonly stateIntervalMs?: number;
  /** GPU 温度轮询间隔（毫秒，默认 60 秒）。 */
  readonly gpuIntervalMs?: number;
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
        stateMs: this.options.stateIntervalMs ?? 30_000,
        gpuMs: this.options.gpuIntervalMs ?? 60_000,
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
    );
    this.approachArmed = decision.armed;
    if (decision.animationId) {
      this.options.trigger(decision.animationId, 'proximity:cursor');
    }
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
    if (sad.animationId) this.options.trigger(sad.animationId, `mood-low:${emotion.mood}`);

    const hungry = evaluateHungry(emotion.hunger, this.hungryArmed);
    this.hungryArmed = hungry.armed;
    if (hungry.animationId) this.options.trigger(hungry.animationId, `hunger-high:${emotion.hunger}`);
  }

  /* ------------------------------------------------------------------ */
  /* 3) 掉线（没配密钥 / 密钥无效 / 余额不足）                              */
  /* ------------------------------------------------------------------ */

  private checkOffline(): void {
    if (this.isPaused()) return;
    const reason = this.options.getOfflineReason();
    const decision = evaluateOffline(reason, this.offlineArmed);
    this.offlineArmed = decision.armed;
    if (decision.animationId) this.options.trigger(decision.animationId, `offline:${reason}`);
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
    const decision = evaluateOverheat(this.gpuTempC, this.overheatArmed);
    this.overheatArmed = decision.armed;
    if (decision.animationId) {
      this.options.trigger(decision.animationId, `gpu-hot:${this.gpuTempC ?? '?'}C`);
    }
  }

  /** 供托盘/验收查询：当前读到的 GPU 温度与"这个功能是否可用"。 */
  public describe(): {
    readonly gpuTempC: number | null;
    readonly gpuAvailable: boolean;
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
