/**
 * Renderer 侧的类型补充声明。
 *
 * `window.petAPI` / `window.petBootstrap` 由 preload 通过 contextBridge 注入，
 * 这里只做类型声明，不产生运行时代码。
 */

import type { PetBridge } from '../../shared/ipc';
import type { DiscoveredPlugin } from '../../shared/plugin-types';
import type { AnimationManager } from '../core/animation-manager';
import type { ActionManager } from '../core/action-manager';
import type { BehaviorManager } from '../core/behavior-manager';
import type { EventBus } from '../core/event-bus';
import type { InteractionManager } from '../core/interaction-manager';
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
      shutdown(): void;
    };
    /** 管理器只读引用（调试用）。 */
    petDebug?: PetDebugHandles;
  }
}

export {};
