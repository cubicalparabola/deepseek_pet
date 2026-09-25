/**
 * 摄像头采集（3.5）—— 渲染层负责的那一半。
 *
 * 为什么摄像头必须在渲染层：`getUserMedia` 是 Web API，主进程没有。
 * 因此分工是：
 *
 *   主进程（PerceptionService）  决定"该不该采"、"采到的帧意味着什么"
 *        ↓ CommandPerceptionCameraRequest
 *   渲染层（本文件）             getUserMedia -> <video> -> canvas -> JPEG
 *        ↓ petAPI.perception.cameraFrame(dataUrl)
 *   主进程                        视觉模型分析 -> 在场/表情/陌生人 -> 决策
 *
 * 四条隐私纪律（本文件是它们的技术保证）：
 * 1. **未授权绝不打开摄像头**：只有主进程下发的采样请求才会走到 `getUserMedia`，
 *    而主进程只在 `cameraAuthorized === true` 时才下发请求；
 * 2. **帧不落盘**：只在内存里画到 canvas、立刻编码回传，不写文件、不进 DOM；
 * 3. **用完就关**：每次请求只开一小会儿（拿到一帧就把 track 停掉），
 *    不做常驻视频流 —— 摄像头指示灯不会一直亮着；
 * 4. **失败要说话**：设备被占用/没有权限时上报给主进程，让它提示用户，
 *    绝不静默重试（重试会反复触发权限提示）。
 */

import type { PerceptionAPI } from '../../shared/ipc';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export interface CameraSensorOptions {
  readonly logger: Logger;
  /** 取感知桥（preload 未注入时返回 undefined）。 */
  readonly getApi: () => PerceptionAPI | undefined;
  /** 一帧的最大宽度（越小越省 token）。 */
  readonly maxWidth?: number;
}

export class CameraSensor {
  private readonly options: CameraSensorOptions;
  private readonly logger: Logger;
  private busy = false;
  private ready = false;
  private reportedError = '';
  private disposers: (() => void)[] = [];

  public constructor(options: CameraSensorOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /** 订阅主进程的"请采一帧"请求。 */
  public attach(): void {
    const api = this.options.getApi();
    if (!api) {
      this.logger.warn('perception bridge missing; camera sensor disabled');
      return;
    }
    this.disposers.push(
      api.onCameraRequest(() => {
        void this.captureOnce();
      }),
    );
    this.logger.info('camera sensor attached');
  }

  public detach(): void {
    for (const dispose of this.disposers) {
      try {
        dispose();
      } catch (error) {
        this.logger.debug('camera sensor dispose failed', { error: describeError(error) });
      }
    }
    this.disposers = [];
  }

  /**
   * 采一帧并回传。
   *
   * 关键实现细节：**每次都新建 stream 并立刻停掉**。
   * 常驻 stream 会让摄像头指示灯一直亮着（用户会紧张），
   * 而且设备可能被别人占用 —— 单次开关的失败面更小。
   */
  public async captureOnce(): Promise<boolean> {
    const api = this.options.getApi();
    if (!api || this.busy) return false;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.reportFailure('这个环境不支持摄像头（mediaDevices 缺失）');
      return false;
    }
    this.busy = true;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      const frame = await grabFrame(stream, this.options.maxWidth ?? 480);
      if (!frame) {
        this.reportFailure('摄像头没有返回画面');
        return false;
      }
      api.cameraFrame(frame);
      if (!this.ready) {
        this.ready = true;
        this.reportedError = '';
        api.setCameraReady(true);
        this.logger.info('camera stream opened for a single frame');
      }
      return true;
    } catch (error) {
      this.reportFailure(describeError(error));
      return false;
    } finally {
      // 无论成功失败都立刻关掉：指示灯不留着亮
      for (const track of stream?.getTracks() ?? []) {
        try {
          track.stop();
        } catch {
          /* 忽略 */
        }
      }
      this.busy = false;
    }
  }

  /** 上报失败（同一错误只报一次，避免刷屏）。 */
  private reportFailure(message: string): void {
    if (this.reportedError === message) return;
    this.reportedError = message;
    this.ready = false;
    this.logger.warn('camera capture failed', { error: message });
    try {
      this.options.getApi()?.setCameraReady(false, message);
    } catch (error) {
      this.logger.debug('reporting camera failure failed', { error: describeError(error) });
    }
  }
}

/**
 * 从 stream 里抓一帧并编码成 JPEG data URL。
 *
 * 用 `video.requestVideoFrameCallback`（若可用）等"真的有一帧了"再画，
 * 否则退化为等 300ms —— 直接 `play()` 之后立刻 `drawImage` 会画出黑屏，
 * 那种帧送进视觉模型只会让它胡猜。
 */
async function grabFrame(stream: MediaStream, maxWidth: number): Promise<string | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    /* 某些环境 autoplay 需要用户手势；下面仍然尝试等一帧 */
  }

  await new Promise<void>((resolve) => {
    const withCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (typeof withCallback.requestVideoFrameCallback === 'function') {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      withCallback.requestVideoFrameCallback(() => finish());
      window.setTimeout(finish, 1500);
      return;
    }
    window.setTimeout(resolve, 300);
  });

  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;

  const scale = Math.min(1, maxWidth / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  video.srcObject = null;
  return canvas.toDataURL('image/jpeg', 0.6);
}
