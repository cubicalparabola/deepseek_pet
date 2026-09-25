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
 *    **整屏、地址栏横条、窗口特写三类图都遵守这一条**。
 */

import { desktopCapturer, screen } from 'electron';
import type { PerceptionSettings } from '../../shared/perception-types';
import { computeCloseUpCrop } from '../../shared/perception';
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
   * 截一条**地址栏横条**（屏幕顶部），用于让模型读出网址。
   *
   * 为什么单独截这一条：整屏缩到 640 宽时地址栏文字只有几像素，读不出来；
   * 按 `urlCaptureWidth`（默认 1280）截下顶部约 7%，文字就清楚了。
   * 这张图**只在本次请求里活一次**，不落盘（与整屏截图同一条隐私纪律）。
   *
   * @returns 与 {@link grab} 同构的结果；不需要/失败时返回 null（调用方直接不带这条）
   */
  public async grabAddressBar(): Promise<CaptureResult | null> {
    const settings = this.options.getSettings();
    if (!settings.captureUrl) return null;
    const startedAt = Date.now();
    try {
      const primary = screen.getPrimaryDisplay();
      const targetWidth = Math.max(640, Math.round(settings.urlCaptureWidth));
      const aspect = primary.size.height > 0 ? primary.size.height / Math.max(1, primary.size.width) : 0.5625;
      const targetHeight = Math.max(160, Math.round(targetWidth * aspect));

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: targetWidth, height: targetHeight },
        fetchWindowIcons: false,
      });
      const source = sources.find((item) => String(item.display_id) === String(primary.id)) ?? sources[0];
      if (!source) return null;

      let image = source.thumbnail;
      if (image.isEmpty()) return null;
      const size = image.getSize();
      if (size.width > targetWidth) image = image.resize({ width: targetWidth, quality: 'good' });

      const full = image.getSize();
      // 顶部 7%（至少 24px）：最大化浏览器下正好覆盖标签页 + 地址栏
      const stripHeight = Math.max(24, Math.round(full.height * 0.07));
      const strip = image.crop({ x: 0, y: 0, width: full.width, height: Math.min(stripHeight, full.height) });
      if (strip.isEmpty()) return null;
      const jpeg = strip.toJPEG(80);
      const stripSize = strip.getSize();
      return {
        dataBase64: jpeg.toString('base64'),
        mimeType: 'image/jpeg',
        width: stripSize.width,
        height: stripSize.height,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger.debug('address bar capture failed', { error: describeError(error) });
      return null;
    }
  }

  /**
   * 截一张**最上层窗口的特写**（按原分辨率截，再裁到窗口区域）。
   *
   * 为什么需要：终端、编辑器这类窗口**整屏都是文字**，缩到 640 宽之后字符只有几像素，
   * 视觉模型读不出来就只能"看着像代码"来猜 —— 用户实测到的误判（她瞎说终端里在干什么）
   * 就是这么来的。把窗口那一块**按原分辨率**截下来单独给模型，文字才真的可读；
   * 拿不准的内容就不许她回答（见 `gateUnreadableContent` 与提示词里的 `contentReadable`）。
   *
   * 坐标容错：`GetWindowRect` 来自 DPI 不感知的 PowerShell，多数情况下是**逻辑坐标**
   * （与 Electron 的 DIP 同一套），但有的环境会给物理像素。这里按"哪套能落在屏幕内"
   * 判断，两套都不像就直接放弃这一路（宁可没有特写，也不要裁错地方）。
   *
   * 这张图与整屏、地址栏横条一样：**只在本次请求的内存里活一次，永不落盘**。
   *
   * @param rect 最上层窗口矩形（来自 `WindowContextProbe`）；为空则返回 null
   */
  public async grabWindowCloseUp(
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null,
  ): Promise<CaptureResult | null> {
    const settings = this.options.getSettings();
    if (!settings.windowCloseUp || !rect) return null;
    const startedAt = Date.now();
    try {
      const primary = screen.getPrimaryDisplay();
      const displayWidth = primary.size.width;
      const displayHeight = primary.size.height;
      if (displayWidth <= 0 || displayHeight <= 0) return null;

      /*
       * 按**原分辨率**请求缩略图：这是"看得清文字"的前提。
       * 上限用物理分辨率——再大也不会多出信息，只是白花时间和内存。
       */
      const scaleFactor = primary.scaleFactor > 0 ? primary.scaleFactor : 1;
      const physicalWidth = Math.max(640, Math.round(displayWidth * scaleFactor));
      const physicalHeight = Math.max(360, Math.round(displayHeight * scaleFactor));
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: physicalWidth, height: physicalHeight },
        fetchWindowIcons: false,
      });
      const source = sources.find((item) => String(item.display_id) === String(primary.id)) ?? sources[0];
      if (!source) return null;
      let image = source.thumbnail;
      if (image.isEmpty()) return null;

      /*
       * 裁剪矩形交给纯函数算（坐标系判断 + 夹取 + 太小就放弃），
       * 它的三种情形都被验收逐条断言过（见 computeCloseUpCrop）。
       */
      const full = image.getSize();
      const crop = computeCloseUpCrop({
        rect,
        display: { width: displayWidth, height: displayHeight },
        scaleFactor,
        image: { width: full.width, height: full.height },
      });
      if (!crop) {
        this.logger.debug('window close-up skipped (rect unusable for this screen space)', { data: { rect } });
        return null;
      }

      image = image.crop(crop);
      if (image.isEmpty()) return null;

      const targetWidth = Math.max(480, Math.min(2560, Math.round(settings.windowCloseUpWidth)));
      if (image.getSize().width > targetWidth) {
        image = image.resize({ width: targetWidth, quality: 'good' });
      }
      const jpeg = image.toJPEG(78);
      const finalSize = image.getSize();
      return {
        dataBase64: jpeg.toString('base64'),
        mimeType: 'image/jpeg',
        width: finalSize.width,
        height: finalSize.height,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger.debug('window close-up capture failed', { error: describeError(error) });
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
