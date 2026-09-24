/**
 * WindowManager —— 负责透明桌宠窗口的一切（创建 / 显示 / 隐藏 / 移动 / 层级 / 鼠标穿透）。
 *
 * 安全设计：
 * - Renderer 永远拿不到 BrowserWindow，只能通过 IPC 白名单调用本类暴露的方法；
 * - 本类不处理任何业务逻辑（不播放动画、不决定状态），只做窗口能力。
 */

import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from 'electron';
import type { PetConfig } from '../shared/config';
import type { WindowPosition, WindowSize } from '../shared/ipc';
import type { Logger } from '../shared/logger';
import { describeError } from '../shared/errors';

export interface WindowManagerOptions {
  readonly config: PetConfig;
  readonly logger: Logger;
  readonly preloadPath: string;
  readonly rendererHtmlPath: string;
  readonly size: WindowSize;
  readonly position?: WindowPosition;
  /**
   * 任务栏 / Alt+Tab 用的窗口图标（.ico 或 .png 绝对路径）。
   * 打包后必须指向 asar 之外的 `resources/build/icon.*`（见 main.ts 的图标解析）。
   */
  readonly iconPath?: string;
  /**
   * 追加到渲染进程命令行参数。
   * 用于把 bootstrap 数据（runtime + 插件清单 + 窗口尺寸）零成本注入 preload，
   * 避免 preload 阶段使用 sendSync 阻塞启动。
   */
  readonly additionalArguments?: readonly string[];
  /** 调试句柄：把 bootstrap 挂到 window 上（仅开发模式用）。 */
  readonly debug?: boolean;
}

/**
 * 默认桌宠尺寸（与素材 834x1112 同比例、对应默认 scale 0.6，见 pet-size.ts）。
 * 注意：真实尺寸由 main.ts 的 resolvePetSize 计算，这里只是"窗口尚未创建"时
 * 的一个自洽兜底值，必须与默认 scale 保持一致，否则自检输出会自相矛盾。
 */
export const DEFAULT_PET_SIZE: WindowSize = { width: 288, height: 384 };

export class WindowManager {
  private readonly options: WindowManagerOptions;
  private readonly logger: Logger;
  private window: BrowserWindow | null = null;
  private quitting = false;
  /**
   * 窗口的逻辑尺寸（单一事实来源）。
   * 移动窗口时显式带上它，避免 Windows 的 DIP 取整误差被累积成"拖动过程中越来越大"。
   */
  private logicalSize: WindowSize | null = null;

  public constructor(options: WindowManagerOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /** 窗口尺寸是否与请求一致（自检用）。 */
  public describe(): { readonly size: WindowSize; readonly position: WindowPosition; readonly visible: boolean } {
    if (!this.exists()) {
      return { size: this.options.size, position: this.options.position ?? { x: 0, y: 0 }, visible: false };
    }
    const window = this.window as BrowserWindow;
    const [width, height] = window.getSize();
    const [x, y] = window.getPosition();
    return {
      size: { width: width ?? 0, height: height ?? 0 },
      position: { x: x ?? 0, y: y ?? 0 },
      visible: window.isVisible(),
    };
  }

  public getWindow(): BrowserWindow | null {
    return this.window;
  }

  public exists(): boolean {
    return this.window !== null && !this.window.isDestroyed();
  }

  /** 标记“正在退出”，此时关闭窗口 = 真的退出，而不是最小化到托盘。 */
  public markQuitting(): void {
    this.quitting = true;
  }

  public isQuitting(): boolean {
    return this.quitting;
  }

  public create(): BrowserWindow {
    if (this.exists()) return this.window as BrowserWindow;

    const { size, position } = this.options;
    const initial = position ?? this.resolveDefaultPosition(size);

    const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
      // 安全基线：三项都必须保持
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Electron 官方推荐：preload 使用绝对路径
      preload: this.options.preloadPath,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // 透明窗口 + 前台节流会导致动画卡顿
      backgroundThrottling: false,
      spellcheck: false,
      devTools: this.options.config.mode === 'development',
      ...(this.options.additionalArguments
        ? { additionalArguments: [...this.options.additionalArguments] }
        : {}),
    };

    const window = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: initial.x,
      y: initial.y,
      // 透明桌宠窗口基线配置
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      roundedCorners: false,
      // 避免出现白色/黑色闪烁
      backgroundColor: '#00000000',
      show: false,
      title: '鲸鱼娘桌宠',
      ...(this.options.iconPath ? { icon: this.options.iconPath } : {}),
      webPreferences,
    });

    // 置顶层级：'screen-saver' 保证在全屏应用之上也能看到桌宠
    window.setAlwaysOnTop(true, 'screen-saver');
    // 关闭窗口 = 隐藏到托盘，不退出程序
    window.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.hide();
    });
    window.on('closed', () => {
      this.window = null;
    });
    window.on('unresponsive', () => {
      this.logger.warn('window unresponsive');
    });

    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      this.logger.error('preload error', { error, data: { preloadPath } });
    });
    window.webContents.on('did-fail-load', (_event, code, description, url) => {
      this.logger.error('did-fail-load', { data: { code, description, url } });
    });
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      // 只把 warn/error 汇总到主进程日志，避免 debug 噪音淹没终端
      if (level >= 2) {
        this.logger.warn('renderer console', { data: { message, line, sourceId } });
      }
    });
    // 渲染进程崩溃：只记录，不退出主进程（用户仍可通过托盘重开）
    window.webContents.on('render-process-gone', (_event, details) => {
      this.logger.error('renderer process gone', {
        error: details.reason,
        data: { exitCode: details.exitCode },
      });
    });

    this.window = window;
    /*
     * 记录逻辑尺寸作为单一事实来源。
     * Windows + 非整数显示缩放（本机 1.25）下，实际窗口的物理像素会被取整，
     * getBounds() 可能返回 217x289 这类"多 1px"的值；
     * 如果让它回流进后续的移动，就会表现为「拖动时桌宠慢慢变大」。
     * 因此这里直接锁定请求值，之后所有移动/缩放都只认它。
     */
    this.logicalSize = { width: size.width, height: size.height };
    this.logger.info('window created', { data: { width: size.width, height: size.height, x: initial.x, y: initial.y } });
    return window;
  }

  /** 加载 renderer 页面；失败时记录但不抛出（避免主进程崩溃）。 */
  public async load(): Promise<void> {
    const window = this.window;
    if (!window) return;
    try {
      await window.loadFile(this.options.rendererHtmlPath);
      this.logger.info('renderer loaded', { data: { file: this.options.rendererHtmlPath } });
    } catch (error) {
      this.logger.error('failed to load renderer', { error: describeError(error) });
    }
  }

  /**
   * 显示窗口。
   * 使用 showInactive() 避免抢走用户当前窗口的焦点（桌宠不应打断工作）。
   */
  public show(inactive = true): void {
    if (!this.exists()) return;
    const window = this.window as BrowserWindow;
    if (inactive) window.showInactive();
    else window.show();
  }

  public hide(): void {
    if (!this.exists()) return;
    (this.window as BrowserWindow).hide();
    this.logger.info('window hidden');
  }

  public isVisible(): boolean {
    return this.exists() && (this.window as BrowserWindow).isVisible();
  }

  public toggle(): boolean {
    if (this.isVisible()) {
      this.hide();
      return false;
    }
    this.show();
    return true;
  }

  public getPosition(): WindowPosition {
    if (!this.exists()) return this.options.position ?? { x: 0, y: 0 };
    const [x, y] = (this.window as BrowserWindow).getPosition();
    return { x: x ?? 0, y: y ?? 0 };
  }

  /**
   * 把屏幕坐标对齐到显示器的物理像素网格。
   *
   * 为什么必须这样做（实测，见 tools/diag-jitter.cjs）：
   * 在 125% 缩放的显示器上（devicePixelRatio = 1.25），若窗口位置不落在物理像素网格上，
   * Windows 每次移动都会重新对齐窗口矩形，导致窗口高度在 480 / 481 之间抖动 ——
   * 表现就是**拖动时闪一下**。
   *
   * 实测（连续移动 12 次，目标尺寸 360x480，scaleFactor=1.25）：
   *   步进 9,7   -> 1 次 resize，尺寸 361x481
   *   步进 10,10 -> 8 次 resize，在 361x481 / 360x480 之间抖动  ← 闪烁
   *   步进 8,8   -> **0 次 resize**，尺寸恒定 360x480            ✅
   *   步进 4,4   -> **0 次 resize**                              ✅
   *
   * 对齐步长 = 1 / scale 的小数部分（1.25 -> 4）。缩放为整数时步长为 1（等价于不对齐）。
   */
  private quantizeToPixelGrid(value: number): number {
    const step = this.pixelGridStep();
    return Math.round(value / step) * step;
  }

  /** 当前显示器的物理像素对齐步长（DIP）。 */
  private pixelGridStep(): number {
    try {
      const scale = screen.getPrimaryDisplay().scaleFactor;
      if (!Number.isFinite(scale) || scale <= 1) return 1;
      const fraction = scale - Math.floor(scale);
      if (fraction < 0.01) return 1;
      // 1.25 -> 4（0.25 = 1/4）；1.5 -> 2；1.75 -> 4
      return Math.max(1, Math.round(1 / fraction));
    } catch {
      return 1;
    }
  }

  /**
   * 设置窗口位置（屏幕边界收敛 + 像素网格对齐）。
   *
   * ⚠️ 关于移动 API 的坑（逐项实测，见 tools/diag-move-calm.cjs）：
   * `setPosition()` 或 `setBounds(用当前尺寸)` 每次移动都会让窗口尺寸 +1 并累积；
   * 只有 **`setBounds` + 显式尺寸** 才能做到尺寸不漂移（见 moveWindow 注释）。
   */
  public setPosition(x: number, y: number): WindowPosition {
    if (!this.exists()) return { x, y };
    const window = this.window as BrowserWindow;
    const size = this.canonicalSize();
    const clamped = this.clampToDisplays({ x: Math.round(x), y: Math.round(y) }, size);
    // 对齐到物理像素网格：避免 Windows 反复重对齐窗口导致的高度抖动（闪烁）
    const aligned = {
      x: this.quantizeToPixelGrid(clamped.x),
      y: this.quantizeToPixelGrid(clamped.y),
    };
    this.moveWindow(window, aligned.x, aligned.y, size.width, size.height);
    return aligned;
  }

  /** 当前窗口的逻辑尺寸（优先用记录值，避免 DIP 取整误差被累积）。 */
  private canonicalSize(): WindowSize {
    if (this.logicalSize) return this.logicalSize;
    if (!this.exists()) return this.options.size;
    const [width, height] = (this.window as BrowserWindow).getSize();
    this.logicalSize = {
      width: width ?? this.options.size.width,
      height: height ?? this.options.size.height,
    };
    return this.logicalSize;
  }

  /**
   * 真正执行移动：`setBounds` + **显式尺寸**。
   *
   * 实测对比（同一窗口连续移动 12 次，目标 360x480，见 tools/diag-move-calm.cjs）：
   *   setBounds(显式 w/h)      ->  1 次 resize，尺寸恒为 361x481      ✅ 采用
   *   setBounds(用当前尺寸)     -> 12 次 resize，一路涨到 376x496       ❌
   *   setPosition()            -> 12 次 resize，一路涨到 376x496       ❌
   *   setPosition()+setSize()  -> 18 次 resize，一路涨到 384x504       ❌
   */
  private moveWindow(window: BrowserWindow, x: number, y: number, width: number, height: number): void {
    try {
      window.setMinimumSize(0, 0);
      window.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(64, Math.round(width)),
        height: Math.max(64, Math.round(height)),
      });
    } catch (error) {
      this.logger.warn('window move failed', { error: describeError(error), data: { x, y, width, height } });
    }
  }

  /**
   * 拖拽辅助：把窗口移动到指定的屏幕坐标。
   * 真正跟随鼠标的减法在 renderer 侧完成，这里只负责落地与边界收敛。
   */
  public moveToScreen(x: number, y: number): WindowPosition {
    return this.setPosition(x, y);
  }

  /**
   * 设置窗口尺寸。
   *
   * 同样用 `setBounds`（而不是 `setSize`）：见 setPosition 的说明，
   * `setSize` 在透明无边框窗口上会顶大最小尺寸，导致只能变大不能变小。
   */
  public setSize(width: number, height: number, petBottomOffset = 0): void {
    if (!this.exists()) return;
    const window = this.window as BrowserWindow;
    const targetWidth = Math.max(64, Math.round(width));
    const targetHeight = Math.max(64, Math.round(height));
    try {
      const [rawX, rawY] = window.getPosition();
      /*
       * 按参数补齐宠物信息后再收敛，保证**整只宠物**仍在工作区内。
       * 不这样做的话，缩小窗口时宠物会被留在屏幕上方（实测 y=-105），
       * 用户看到的是"桌宠不见了"。
       */
      const petHeight = Math.max(1, targetHeight - petBottomOffset);
      const safe = this.clampToDisplays(
        { x: rawX ?? 0, y: rawY ?? 0 },
        { width: targetWidth, height: targetHeight },
        targetHeight - petBottomOffset - petHeight,
        petHeight,
      );
      window.setMinimumSize(0, 0);
      window.setBounds({
        x: safe.x,
        y: safe.y,
        width: targetWidth,
        height: targetHeight,
      });
      // 记录新的逻辑尺寸：后续移动都以它为准，不再读 getBounds()
      this.logicalSize = { width: targetWidth, height: targetHeight };
    } catch (error) {
      this.logger.error('setSize failed', {
        error: describeError(error),
        data: { targetWidth, targetHeight },
      });
    }
  }

  /**
   * 扩大/缩小窗口，同时**保持宠物在屏幕上的位置不变**。
   *
   * 用途：显示对话气泡时窗口必须变大（气泡在宠物上方）。若直接沿用
   * `setSize()`（左上角固定），窗口会向右下扩张 —— 宠物的脚会跟着往上跳一大截。
   * 这里反过来做：以**宠物底边**为锚，让窗口水平居中、向**上**扩张。
   *
   * ⚠️ 锚点必须用"宠物底边"而不是"窗口底边"。
   * 宠物在窗口里是**垂直居中偏下**的（上面是气泡、下面还有 padding），
   * 有气泡时它并不贴着窗口底边。实测踩过的坑：用窗口底边做锚，
   * 显示气泡时宠物没动，但**隐藏时宠物跳了 700 多像素**。
   *
   * 因此调用方要传"宠物底边距离窗口底边多少像素"（两个状态各一个值）。
   *
   * @param previousPetSize   调整前的宠物尺寸
   * @param nextPetSize       调整后的宠物尺寸
   * @param nextWindowSize    新的窗口尺寸
   * @param previousPetBottomOffset 调整前：宠物底边到窗口底边的距离
   * @param nextPetBottomOffset     调整后：宠物底边到窗口底边的距离
   */
  public setSizeAnchoredToPet(
    previousPetSize: WindowSize,
    nextPetSize: WindowSize,
    nextWindowSize: WindowSize,
    previousPetBottomOffset: number,
    nextPetBottomOffset: number,
  ): void {
    if (!this.exists()) return;
    const window = this.window as BrowserWindow;
    const [currentX, currentY] = window.getPosition();
    const current = this.canonicalSize();

    // 宠物在窗口内水平居中 -> 新位置按"宠物中心不变"重算
    const anchorCenterX = (currentX ?? 0) + current.width / 2;
    const nextWidth = Math.max(64, Math.round(nextWindowSize.width));
    const nextHeight = Math.max(64, Math.round(nextWindowSize.height));

    /*
     * 垂直：让宠物底边在屏幕上原地不动。
     *   旧：宠物底边 = winY + winH - previousPetBottomOffset
     *   新：宠物底边 = newY + nextH - nextPetBottomOffset
     * 两者相等即可解出 newY。
     */
    const petBottomOnScreen = (currentY ?? 0) + current.height - previousPetBottomOffset;
    const nextY = petBottomOnScreen - (nextHeight - nextPetBottomOffset);

    const target = this.clampToDisplays(
      {
        x: this.quantizeToPixelGrid(Math.round(anchorCenterX - nextWidth / 2)),
        y: this.quantizeToPixelGrid(Math.round(nextY)),
      },
      { width: nextWidth, height: nextHeight },
      nextHeight - nextPetBottomOffset - nextPetSize.height,
      nextPetSize.height,
    );

    this.logger.info('resizing window around pet anchor', {
      data: {
        previousPetSize: `${previousPetSize.width}x${previousPetSize.height}`,
        nextPetSize: `${nextPetSize.width}x${nextPetSize.height}`,
        nextWindowSize: `${nextWidth}x${nextHeight}`,
        petBottomOffset: `${previousPetBottomOffset} -> ${nextPetBottomOffset}`,
        from: `${currentX},${currentY}`,
        to: `${target.x},${target.y}`,
      },
    });
    this.moveWindow(window, target.x, target.y, nextWidth, nextHeight);
    this.logicalSize = { width: nextWidth, height: nextHeight };
  }

  /** 当前记录的逻辑窗口尺寸（优先用记录值，避免 DIP 取整误差累积）。 */
  public getSize(): WindowSize {
    return this.canonicalSize();
  }

  public setAlwaysOnTop(value: boolean): void {
    if (!this.exists()) return;
    (this.window as BrowserWindow).setAlwaysOnTop(value, 'screen-saver');
  }

  /** 鼠标穿透：桌宠不遮挡下方窗口的点击。 */
  public setIgnoreMouseEvents(ignore: boolean, forward = true): void {
    if (!this.exists()) return;
    (this.window as BrowserWindow).setIgnoreMouseEvents(ignore, { forward });
  }

  /** 默认出现位置：主屏工作区右下角（留出任务栏）。 */
  private resolveDefaultPosition(size: WindowSize): WindowPosition {
    try {
      const display = screen.getPrimaryDisplay();
      const area = display.workArea;
      return {
        x: Math.round(area.x + area.width - size.width - 24),
        y: Math.round(area.y + area.height - size.height - 24),
      };
    } catch (error) {
      this.logger.warn('failed to resolve default position', { error: describeError(error) });
      return { x: 100, y: 100 };
    }
  }

  /**
   * 保证窗口内的**宠物**仍然可见（气泡允许露在屏幕外）。
   *
   * 优先级（实测教训）：
   *   1. 宠物整只都在工作区内 -> 不动；
   *   2. 宠物比工作区还高（scale 拉满时）-> 只能保证底部在工作区内；
   *   3. 否则把宠物推回工作区。
   *
   * ⚠️ 不能只保证"宠物底边在工作区内"：显示气泡时窗口向上长高，
   * 宠物会被推到屏幕上方（实测跑到了 y=-165），看起来就是"桌宠不见了"。
   *
   * @param petTopOffset 宠物顶边到窗口顶边的距离
   * @param petHeight    宠物高度
   */
  private clampToDisplays(
    position: WindowPosition,
    size: WindowSize,
    petTopOffset = 0,
    petHeight = size.height,
  ): WindowPosition {
    const margin = 60;
    try {
      const displays = screen.getAllDisplays();
      const petTop = position.y + petTopOffset;
      const petBottom = petTop + petHeight;
      const inside = displays.some((display) => {
        const area = display.workArea;
        return (
          position.x + size.width > area.x + margin &&
          position.x < area.x + area.width - margin &&
          petBottom > area.y + margin &&
          petTop < area.y + area.height - margin
        );
      });
      if (inside) return position;

      const primary = screen.getPrimaryDisplay().workArea;
      const x = Math.min(
        Math.max(position.x, primary.x - size.width + margin),
        primary.x + primary.width - margin,
      );

      let y = position.y;
      if (petHeight <= primary.height) {
        /*
         * 宠物能整只放下：把宠物完整推回工作区。
         * 注意这里改的是"宠物"的位置，窗口（气泡）允许露到屏幕外。
         */
        if (petTop < primary.y) {
          y = position.y + (primary.y - petTop);
        } else if (petBottom > primary.y + primary.height) {
          y = position.y + (primary.y + primary.height - petBottom);
        }
      } else {
        // 宠物本身就比工作区高：只能保证底边可见（顶部必然溢出）
        const maxY = primary.y + primary.height - petHeight - petTopOffset;
        y = Math.min(position.y, maxY);
      }
      return { x, y };
    } catch {
      return position;
    }
  }

  public destroy(): void {
    this.quitting = true;
    if (!this.exists()) return;
    (this.window as BrowserWindow).destroy();
    this.window = null;
  }
}
