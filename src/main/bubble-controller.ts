/**
 * 对话气泡控制器（Main 进程）。
 *
 * 职责只有两件，且必须成对发生：
 *   1. 把"显示/隐藏 + 文本"换算成气泡尺寸与窗口尺寸（`shared/bubble.ts` 的纯函数）；
 *   2. 让窗口按**宠物锚点**扩张/收缩，并把最终布局下发给 Renderer。
 *
 * 为什么不做成"Renderer 自己画一个 div"：桌宠窗口是按宠物裁剪的透明无边框窗口，
 * 气泡在宠物上方，窗口不够大就会被裁掉。窗口尺寸只能由 Main 改，
 * 所以"气泡多大 -> 窗口多大"这件事必须由 Main 决策，否则两边各算一遍必然漂移。
 *
 * 第一版刻意**不做触发机制**（行为/插件/AI 都不会自动说话），
 * 只提供 `show()` / `hide()` 供托盘菜单与验收脚本调用。
 */

import type { Logger } from '../shared/logger';
import {
  resolveBubbleLayout,
  type BubbleLayout,
  type BubblePayload,
  type BubbleState,
} from '../shared/bubble';
import type { WindowSize } from '../shared/ipc';

export interface BubbleControllerDeps {
  readonly logger: Logger;
  /**
   * 当前的**宠物**像素尺寸（未显示气泡时的窗口尺寸）。
   * 每次都要实时取：用户可能刚拖过尺寸滑块。
   */
  getPetSize(): WindowSize;
  /** 窗口是否已创建（未创建时只更新状态，不碰窗口）。 */
  hasWindow(): boolean;
  /**
   * 含气泡的窗口最大高度（通常是显示器工作区高度）。
   *
   * 超过就要等比缩小气泡：否则窗口会被顶到屏幕外、位置被 clamp 拉回，
   * 宠物在屏幕上会一路漂移（实测）。
   */
  getMaxWindowHeight(): number;
  /**
   * 按宠物锚点缩放窗口。
   *
   * @param previousPetBottomOffset 调整前宠物底边到窗口底边的距离
   * @param nextPetBottomOffset     调整后宠物底边到窗口底边的距离
   */
  resizeWindow(
    previousPet: WindowSize,
    nextPet: WindowSize,
    nextWindow: WindowSize,
    previousPetBottomOffset: number,
    nextPetBottomOffset: number,
  ): void;
  /** 把气泡状态 + 布局下发给 Renderer。 */
  notify(payload: BubblePayload): void;
}

export class BubbleController {
  private readonly deps: BubbleControllerDeps;
  private state: BubbleState = { visible: false, text: '' };
  private layout: BubbleLayout;

  public constructor(deps: BubbleControllerDeps) {
    this.deps = deps;
    // 初始布局按当前宠物尺寸算一次，保证 `payload()` 任何时候都可用
    this.layout = resolveBubbleLayout(this.layoutInput(this.deps.getPetSize()));
  }

  /** 组装布局输入（宠物尺寸 + 工作区高度上限）。 */
  private layoutInput(pet: WindowSize): { petWidth: number; petHeight: number; maxWindowHeight: number } {
    return {
      petWidth: pet.width,
      petHeight: pet.height,
      maxWindowHeight: this.deps.getMaxWindowHeight(),
    };
  }

  public isVisible(): boolean {
    return this.state.visible;
  }

  public getText(): string {
    return this.state.text;
  }

  public getLayout(): BubbleLayout {
    return this.layout;
  }

  /** 当前状态 + 布局（bootstrap 与 IPC 下发用同一份）。 */
  public payload(): BubblePayload {
    return { state: { ...this.state }, layout: { ...this.layout } };
  }

  /**
   * 显示气泡（带文本）。重复调用只更新文本，不做多余的窗口调整。
   */
  public show(text: string): BubblePayload {
    const wasVisible = this.state.visible;
    this.state = { visible: true, text };
    this.applyLayout(wasVisible ? null : this.deps.getPetSize());
    return this.payload();
  }

  /** 隐藏气泡（窗口收回宠物尺寸）。 */
  public hide(): BubblePayload {
    const wasVisible = this.state.visible;
    this.state = { visible: false, text: this.state.text };
    this.applyLayout(wasVisible ? this.deps.getPetSize() : null);
    return this.payload();
  }

  /**
   * 宠物尺寸变化后重新计算结果（用户拖了尺寸滑块）。
   *
   * 气泡必须跟着宠物一起缩放，所以尺寸一变就要重算并再次调整窗口。
   * 这里传入旧宠物尺寸用于锚点计算。
   */
  public onPetSizeChanged(previousPet: WindowSize): BubblePayload {
    this.applyLayout(previousPet);
    return this.payload();
  }

  /**
   * 应用布局并按需调整窗口。
   *
   * @param previousPet 需要调整窗口时传入"调整前的宠物尺寸"；null 表示尺寸没变、不必动窗口
   */
  private applyLayout(previousPet: WindowSize | null): void {
    const pet = this.deps.getPetSize();
    const next = resolveBubbleLayout(this.layoutInput(pet));
    const windowSize = windowSizeFor(this.state.visible, next);

    if (previousPet === null) {
      this.layout = next;
      this.notifyOnly();
      return;
    }

    /*
     * 锚点用"宠物底边"：有气泡时宠物下面还有 gap + padding，
     * 它并不贴窗口底边 —— 用窗口底边做锚会导致隐藏时宠物跳位置（实测）。
     * 旧状态的偏移由上一版布局给出，新状态用刚算出来的。
     */
    const previousOffset = this.layout.petBottomOffset;
    const previousWindowSize: WindowSize = { width: previousPet.width, height: previousPet.height };
    this.layout = next;

    if (this.deps.hasWindow()) {
      this.deps.resizeWindow(
        previousWindowSize,
        pet,
        windowSize,
        previousOffset,
        next.petBottomOffset,
      );
    }
    this.deps.logger.info('bubble layout applied', {
      data: {
        visible: this.state.visible,
        textLength: this.state.text.length,
        pet: `${pet.width}x${pet.height}`,
        bubble: `${next.bubbleWidth}x${next.bubbleHeight}`,
        window: `${windowSize.width}x${windowSize.height}`,
      },
    });
    this.notifyOnly();
  }

  /** 只下发状态（窗口已经由调用方或本类调好）。 */
  private notifyOnly(): void {
    try {
      this.deps.notify(this.payload());
    } catch (error) {
      this.deps.logger.warn('bubble notify failed', { error });
    }
  }
}

/**
 * 由气泡布局推出**窗口**尺寸（气泡可见时含气泡，隐藏时收回纯宠物尺寸）。
 *
 * 提成纯函数便于直接断言"气泡越大窗口越高"，不必真的开窗口。
 */
export function windowSizeFor(visible: boolean, layout: BubbleLayout): WindowSize {
  return visible
    ? { width: layout.windowWidth, height: layout.windowHeight }
    : { width: layout.petWidth, height: layout.petHeight };
}

