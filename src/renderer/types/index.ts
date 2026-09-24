/**
 * Renderer 侧的类型补充声明。
 *
 * `window.petAPI` / `window.petBootstrap` 由 preload 通过 contextBridge 注入，
 * 这里只做类型声明，不产生运行时代码。
 */

import type { PetBridge } from '../../shared/ipc';
import type { DiscoveredPlugin } from '../../shared/plugin-types';
import type { PetSizeInfo } from '../../shared/pet-size';
import type { BubblePayload } from '../../shared/bubble';
import type { AnimationManager } from '../core/animation-manager';
import type { ActionManager } from '../core/action-manager';
import type { BehaviorManager } from '../core/behavior-manager';
import type { EventBus } from '../core/event-bus';
import type { InteractionIntent, InteractionManager } from '../core/interaction-manager';
import type { PluginHost } from '../core/plugin-host';
import type { StateMachine } from '../core/state-machine';

export interface BootstrapPayload {
  readonly runtime: PetBridge['runtime'];
  readonly plugins: readonly DiscoveredPlugin[];
  readonly window: {
    readonly width: number;
    readonly height: number;
    readonly x: number;
    readonly y: number;
  };
  /** 主进程解析出的尺寸信息（宠物像素尺寸是气泡布局的输入）。 */
  readonly size?: PetSizeInfo;
  /** 当前对话气泡状态与布局（可能在 Renderer 就绪前就已打开）。 */
  readonly bubble?: BubblePayload;
}

/** 调试句柄（仅开发期使用，见 renderer.ts 的 debugHandles()）。 */
export interface PetDebugHandles {
  readonly bus: EventBus;
  readonly events: EventBus;
  readonly anim: AnimationManager;
  readonly state: StateMachine;
  readonly actions: ActionManager;
  readonly behaviors: BehaviorManager;
  readonly interactions: InteractionManager;
  readonly plugins: PluginHost;
}

declare global {
  interface Window {
    /** preload 暴露的系统能力（唯一入口）。 */
    readonly petAPI?: PetBridge;
    /** preload 注入的启动数据。 */
    readonly petBootstrap?: BootstrapPayload;
    /** 桌宠应用实例（调试用）。 */
    petApp?: {
      describe(): Record<string, unknown>;
      debugHandles(): PetDebugHandles;
      /** 托盘 / 右键菜单选择动画的真实入口（验收脚本直接调用它，避免复刻逻辑）。 */
      handleMenuAnimation(animationId: string): void;
      /** 点击/双击/悬停进入区域的真实入口（验收脚本直接调用它，避免复刻逻辑）。 */
      handleIntent(intent: InteractionIntent): void;
      /** 手动跑一次兜底健康检查（与看门狗同一逻辑，验收用）。 */
      runHealthCheck(reason?: string): void;
      /** 自愈链路状态（只读，验收定位用）。 */
      describeRecovery(): Record<string, unknown>;
      /** 对话气泡的只读快照（验收断言用）。 */
      describeBubble(): Record<string, unknown>;
      shutdown(): void;
    };
    /** 管理器只读引用（调试用）。 */
    petDebug?: PetDebugHandles;
  }
}

export {};
