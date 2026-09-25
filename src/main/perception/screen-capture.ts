/**
 * 屏幕截取（3.1）—— 用 Electron 自带的 `desktopCapturer`，不装任何原生依赖。
 *
 * 三个必须注意的点（都是实测/文档里踩过的）：
 *
 * 1. **`thumbnailSize` 不总是被尊重**：某些环境会返回全分辨率缩略图。
 *    因此这里拿到图之后再**自己 resize 一次**，保证交给视觉模型的图足够小
 *    （默认宽 640，JPEG 质量 72）—— 直接送 2560×1440 会既慢又贵。
 * 2. **优先主显示器**：多屏时 `getSources` 会返回多个 source，
 *    按 `display_id` 匹配主屏，匹配不上才退回第一个。
 * 3. **图像只在内存里存在一次调用**：本函数返回 base64 给视觉客户端，
 *    调用方用完即弃；磁盘上永远没有截图（见 observation-store 的说明）。
 */

import { desktopCapturer, screen } from 'electron';
import type { PerceptionSettings } from '../../shared/perception-types';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export interface CaptureResult {
  readonly dataBase64: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  /** 这次截取的耗时（毫秒）—— 采样间隔的合理性靠它判断。 */
  readonly elapsedMs: number;
}

export interface ScreenCaptureOptions {
  readonly logger: Logger;
  readonly getSettings: () => PerceptionSettings;
}

export class ScreenCapture {
  private readonly options: ScreenCaptureOptions;
  private readonly logger: Logger;

  public constructor(options: ScreenCaptureOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /** 截一帧（失败返回 null，绝不抛给调用方）。 */
  public async grab(): Promise<CaptureResult | null> {
    const startedAt = Date.now();
    const settings = this.options.getSettings();
    try {
      const primary = screen.getPrimaryDisplay();
      const targetWidth = Math.max(160, Math.round(settings.captureWidth));
      const aspect = primary.size.height > 0 ? primary.size.height / Math.max(1, primary.size.width) : 0.5625;
      const targetHeight = Math.max(90, Math.round(targetWidth * aspect));

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: targetWidth, height: targetHeight },
        fetchWindowIcons: false,
      });
      if (sources.length === 0) {
        this.logger.warn('screen capture returned no sources');
        return null;
      }
      const source =
        sources.find((item) => String(item.display_id) === String(primary.id)) ?? sources[0];
      if (!source) return null;

      let image = source.thumbnail;
      if (image.isEmpty()) {
        this.logger.warn('screen capture returned an empty thumbnail');
        return null;
      }
      // 见文件头注释 1：自己再缩一次，别赌 thumbnailSize 生效
      const size = image.getSize();
      if (size.width > targetWidth) {
        image = image.resize({ width: targetWidth, quality: 'good' });
      }
      const jpeg = image.toJPEG(72);
      const finalSize = image.getSize();
      return {
        dataBase64: jpeg.toString('base64'),
        mimeType: 'image/jpeg',
        width: finalSize.width,
        height: finalSize.height,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger.warn('screen capture failed', { error: describeError(error) });
      return null;
    }
  }

  /**
   * 让桌宠自己**不进任何截屏/录屏**（Windows 的 `WDA_EXCLUDEFROMCAPTURE`）。
   *
   * 为什么需要：她是一个常驻置顶的浮层，如果出现在画面里，
   * 既会污染她自己的感知输入（"屏幕上有只鲸鱼"），也会跑进用户的录屏/共享。
   * 这是一项**可关闭**的能力（`hideFromCapture`）：有人就是喜欢截她。
   */
  public applyContentProtection(windows: readonly Electron.BrowserWindow[], enabled: boolean): void {
    for (const window of windows) {
      try {
        if (!window.isDestroyed()) window.setContentProtection(enabled);
      } catch (error) {
        this.logger.debug('setContentProtection failed', { error: describeError(error) });
      }
    }
  }
}
