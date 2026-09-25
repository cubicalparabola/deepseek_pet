/**
 * 屏幕截取（3.1）—— 用 Electron 自带的 `desktopCapturer`，不装任何原生依赖。
 *
 * 四个必须注意的点（都是实测/文档里踩过的）：
 *
 * 1. **`thumbnailSize` 不总是被尊重**：某些环境会返回全分辨率缩略图。
 *    因此这里拿到图之后再**自己 resize 一次**，保证交给视觉模型的图足够小
 *    （默认宽 640，JPEG 质量 72）—— 直接送 2560×1440 会既慢又贵。
 * 2. **优先主显示器**：多屏时 `getSources` 会返回多个 source，
 *    按 `display_id` 匹配主屏，匹配不上才退回第一个。
 * 3. **图像只在内存里存在一次调用**：本函数返回 base64 给视觉客户端，
 *    调用方用完即弃；磁盘上永远没有截图（见 observation-store 的说明）。
 *    **整屏、地址栏横条、窗口特写三类图都遵守这一条**。
 * 4. **桌宠自己要从画面里涂掉**：`setContentProtection` 只挡别的进程，
 *    自家 `desktopCapturer` 照样截得到她（`maskSelf`）。
 */

import { desktopCapturer, nativeImage, screen } from 'electron';
import type { PerceptionSettings } from '../../shared/perception-types';
import { computeCloseUpCrop, computeSelfMaskRect, fillBitmapRect } from '../../shared/perception';
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

/** 一个屏幕矩形（Electron 的 `getBounds()` 口径：DIP）。 */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenCaptureOptions {
  readonly logger: Logger;
  readonly getSettings: () => PerceptionSettings;
  /**
   * 桌宠自己那些窗口的当前位置（DIP）——用来把她的像素从画面里**涂掉**。
   *
   * 为什么需要（实测见 `tools/probe-self-capture.cjs`）：`setContentProtection(true)`
   * 只挡得住**别的进程**的截屏，我们自己 `desktopCapturer` 截出来的帧里她照样在。
   */
  readonly getSelfRects?: () => readonly ScreenRect[];
}

export class ScreenCapture {
  private readonly options: ScreenCaptureOptions;
  private readonly logger: Logger;

  public constructor(options: ScreenCaptureOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /**
   * 截主屏一张图（**已经把自己涂掉**），三个入口共用。
   *
   * 为什么要有这个私有入口：遮罩必须发生在**任何裁剪之前**。
   * 曾经在 `grabWindowCloseUp` 里"先裁窗口、再涂自己"——遮罩按整屏坐标算，
   * 一旦前景窗口不在 (0,0)（比如终端只占屏幕右下角），涂的位置就整体偏掉，
   * 她反而留在画面里。现在只有这一处会截屏，顺序不可能再写反。
   *
   * @param targetWidth 目标宽度（像素）；实际更大时会自己缩一次（见文件头注释 1）
   */
  private async capturePrimaryScreen(
    targetWidth: number,
    targetHeight: number,
  ): Promise<{ readonly image: Electron.NativeImage; readonly primary: Electron.Display } | null> {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.max(160, Math.round(targetWidth)), height: Math.max(90, Math.round(targetHeight)) },
      fetchWindowIcons: false,
    });
    if (sources.length === 0) {
      this.logger.warn('screen capture returned no sources');
      return null;
    }
    const primary = screen.getPrimaryDisplay();
    const source = sources.find((item) => String(item.display_id) === String(primary.id)) ?? sources[0];
    if (!source) return null;
    let image = source.thumbnail;
    if (image.isEmpty()) {
      this.logger.warn('screen capture returned an empty thumbnail');
      return null;
    }
    // 见文件头注释 1：自己再缩一次，别赌 thumbnailSize 生效
    const size = image.getSize();
    if (size.width > targetWidth) {
      image = image.resize({ width: Math.max(160, Math.round(targetWidth)), quality: 'good' });
    }
    // 把自己涂掉（必须在缩放之后、任何裁剪之前：遮罩按"整屏像素"算）
    image = this.maskSelf(image, primary.size);
    return { image, primary };
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

      const captured = await this.capturePrimaryScreen(targetWidth, targetHeight);
      if (!captured) return null;
      const jpeg = captured.image.toJPEG(72);
      const finalSize = captured.image.getSize();
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

      const captured = await this.capturePrimaryScreen(targetWidth, targetHeight);
      if (!captured) return null;

      const full = captured.image.getSize();
      // 顶部 7%（至少 24px）：最大化浏览器下正好覆盖标签页 + 地址栏
      const stripHeight = Math.max(24, Math.round(full.height * 0.07));
      const strip = captured.image.crop({ x: 0, y: 0, width: full.width, height: Math.min(stripHeight, full.height) });
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
       * 注意 `capturePrimaryScreen` 已经把桌宠自己涂掉了，且**发生在裁剪之前**
       * （曾经写成"先裁窗口再涂"，前景窗口不在 (0,0) 时遮罩会整体偏掉）。
       */
      const scaleFactor = primary.scaleFactor > 0 ? primary.scaleFactor : 1;
      const physicalWidth = Math.max(640, Math.round(displayWidth * scaleFactor));
      const physicalHeight = Math.max(360, Math.round(displayHeight * scaleFactor));
      const captured = await this.capturePrimaryScreen(physicalWidth, physicalHeight);
      if (!captured) return null;
      let image = captured.image;

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
   * 把**桌宠自己**的那几块像素涂掉（`hideFromCapture` 打开时）。
   *
   * 为什么不能只靠 `setContentProtection`：那个 API 挡的是**别的进程**的截屏/录屏，
   * 我们自己的 `desktopCapturer` 截出来照样有她（实测见 `tools/probe-self-capture.cjs`：
   * 她那块"可见 vs 隐藏"的平均像素差 **46.89**，而同区域页面自身动画的噪声只有 **9.48**
   * —— 信噪比 4.9 倍，不是巧合）。于是模型每帧都能在角落看到一只鲸鱼娘。
   *
   * 做法：按窗口矩形把像素涂成**旁边一个像素的颜色**（不是纯黑）——
   * 一块与背景同色的补丁，比一个突兀的黑方块更不容易干扰模型。
   * 图像依然只在内存里活一次，涂改也只发生在这份内存副本上。
   *
   * @param displaySize 主屏尺寸（DIP），用于把窗口矩形换算成图上像素
   */
  private maskSelf(image: Electron.NativeImage, displaySize: { readonly width: number; readonly height: number }): Electron.NativeImage {
    const settings = this.options.getSettings();
    if (!settings.hideFromCapture) return image;
    const rects = this.options.getSelfRects?.() ?? [];
    if (rects.length === 0) return image;
    try {
      const size = image.getSize();
      if (size.width <= 0 || size.height <= 0) return image;
      const targets = rects
        .map((rect) => computeSelfMaskRect({ rect, display: displaySize, image: size }))
        .filter((rect): rect is { x: number; y: number; width: number; height: number } => rect !== null);
      if (targets.length === 0) return image;

      const bitmap = image.toBitmap();
      let painted = 0;
      for (const rect of targets) {
        const color = this.sampleEdgeColor(bitmap, size, rect);
        if (fillBitmapRect(bitmap, size, rect, color)) painted += 1;
      }
      if (painted === 0) return image;
      return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height });
    } catch (error) {
      // 遮罩失败绝不能影响采集本身：顶多是"她出现在自己的画面里"（老行为）
      this.logger.debug('self mask failed', { error: describeError(error) });
      return image;
    }
  }

  /** 取遮罩矩形右侧（越界则上方、再不行右下角）一个像素的颜色，作为填充色。 */
  private sampleEdgeColor(
    bitmap: Buffer,
    size: { readonly width: number; readonly height: number },
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  ): { b: number; g: number; r: number; a: number } {
    const fallback = { b: 32, g: 32, r: 32, a: 255 };
    const candidates: readonly (readonly [number, number])[] = [
      [rect.x + rect.width + 2, rect.y + Math.floor(rect.height / 2)],
      [rect.x + Math.floor(rect.width / 2), rect.y - 2],
      [rect.x - 2, rect.y + Math.floor(rect.height / 2)],
    ];
    for (const [x, y] of candidates) {
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) continue;
      const index = (y * size.width + x) * 4;
      if (index + 3 >= bitmap.length) continue;
      return { b: bitmap[index] ?? 32, g: bitmap[index + 1] ?? 32, r: bitmap[index + 2] ?? 32, a: bitmap[index + 3] ?? 255 };
    }
    return fallback;
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
