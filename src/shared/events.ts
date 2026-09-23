/**
 * 全局 EventBus 的事件契约。
 *
 * 命名规范：`domain:action`，例如 `pet:click` / `animation:end`。
 * 所有模块之间（包括插件、未来的 AI Agent）只通过事件通信，
 * 不允许直接互相 import 后调用内部方法。
 *
 * 兼容性说明：
 * - 已知事件走 `PetEventMap` 强类型（推荐）；
 * - 同时允许自定义事件名（插件自定义事件、未来 AI 事件），
 *   见 `PetEventName = KnownEventName | (string & {})`。
 */

import type { PetState } from './state-types';
import type { InterruptPolicy, PlayRejectionReason } from './animation-types';

/* -------------------------------------------------------------------------- */
/* 事件负载                                                                    */
/* -------------------------------------------------------------------------- */

export interface PetClickPayload {
  readonly button: 'left' | 'middle' | 'right';
  readonly x: number;
  readonly y: number;
  /** 归一化坐标（0-1），便于判断“点击了头部/肚子/尾巴”这类分区互动。 */
  readonly nx: number;
  readonly ny: number;
  /** 命中的分区标签（由 InteractionManager 计算，例如 "head" / "belly" / "tail" / "body"）。 */
  readonly region: string;
  readonly detail: number;
}

export interface PetPointerPayload {
  readonly x: number;
  readonly y: number;
  readonly nx: number;
  readonly ny: number;
  readonly region: string;
}

export interface PetDragPayload {
  readonly phase: 'start' | 'move' | 'end';
  readonly screenX: number;
  readonly screenY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface PetRegionPayload {
  readonly region: string;
  readonly x: number;
  readonly y: number;
  readonly nx: number;
  readonly ny: number;
}

export interface AnimationStartPayload {
  readonly animationId: string;
  readonly priority: number;
  readonly loop: boolean;
  readonly reason?: string;
  readonly source?: string;
  /** 被本次播放抢占掉的动画（如果有）。 */
  readonly interrupted?: string;
}

export interface AnimationEndPayload {
  readonly animationId: string;
  readonly reason?: string;
  readonly source?: string;
  /** 是否自然播放结束（false 表示被打断或手动 stop）。 */
  readonly completed: boolean;
}

export interface AnimationRequestPayload {
  readonly animationId: string;
  readonly priority?: number;
  readonly interrupt?: InterruptPolicy;
  readonly reason?: string;
  readonly source?: string;
}

export interface AnimationRejectedPayload extends AnimationRequestPayload {
  readonly rejection: PlayRejectionReason;
}

export interface StateChangePayload {
  readonly from: PetState;
  readonly to: PetState;
  readonly reason: string;
  readonly source?: string;
  readonly at: number;
}

export interface ActionReceivedPayload {
  readonly type: string;
  readonly target?: string;
  readonly priority?: number;
  readonly source: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ActionRejectedPayload extends ActionReceivedPayload {
  readonly rejection: string;
}

export interface PluginLifecyclePayload {
  readonly pluginId: string;
  readonly name?: string;
  readonly version?: string;
  /** 失败时的错误信息。 */
  readonly error?: string;
}

export interface PluginErrorPayload {
  readonly pluginId: string;
  /** 插件内部哪个钩子/事件处理抛的错。 */
  readonly hook: string;
  readonly message: string;
}

export interface SystemReadyPayload {
  readonly version: string;
  readonly platform: string;
  readonly animations: number;
  readonly plugins: number;
  /** "dev" | "packaged" 等运行模式信息。 */
  readonly mode: string;
}

export interface BehaviorPayload {
  readonly animationId: string;
  readonly reason: string;
}

/* -------------------------------------------------------------------------- */
/* 事件表                                                                      */
/* -------------------------------------------------------------------------- */

export interface PetEventMap {
  'app:ready': SystemReadyPayload;
  'app:error': { readonly module: string; readonly message: string };

  'pet:click': PetClickPayload;
  'pet:dblclick': PetClickPayload;
  'pet:pointer-enter': PetPointerPayload;
  'pet:pointer-move': PetPointerPayload;
  'pet:pointer-leave': PetPointerPayload;
  'pet:drag': PetDragPayload;
  'pet:region': PetRegionPayload;

  'animation:request': AnimationRequestPayload;
  'animation:start': AnimationStartPayload;
  'animation:end': AnimationEndPayload;
  'animation:rejected': AnimationRejectedPayload;

  'state:change': StateChangePayload;

  'action:received': ActionReceivedPayload;
  'action:rejected': ActionRejectedPayload;

  'plugin:discovered': PluginLifecyclePayload;
  'plugin:loaded': PluginLifecyclePayload;
  'plugin:activated': PluginLifecyclePayload;
  'plugin:deactivated': PluginLifecyclePayload;
  'plugin:unloaded': PluginLifecyclePayload;
  'plugin:error': PluginErrorPayload;

  'behavior:triggered': BehaviorPayload;
  'behavior:paused': { readonly paused: boolean };
}

export type KnownEventName = keyof PetEventMap;

/**
 * 允许自定义事件名：`(string & {})` 保证自动补全已知事件的同时不封闭类型。
 */
export type PetEventName = KnownEventName | (string & {});

/** 取某个事件名的负载类型；自定义事件回退到 Record<string, unknown>。 */
export type PetEventPayload<K extends PetEventName> = K extends KnownEventName
  ? PetEventMap[K]
  : Record<string, unknown>;

export type EventHandler<K extends PetEventName = PetEventName> = (
  payload: PetEventPayload<K>,
) => void;

export interface Subscription {
  unsubscribe(): void;
}

/** 事件拦截器：可以修改负载或阻止事件继续派发。 */
export type EventInterceptor = (
  event: PetEventName,
  payload: unknown,
) => { readonly payload?: unknown; readonly cancel?: boolean } | void;

/* -------------------------------------------------------------------------- */
/* 事件名常量（避免各模块手写字符串出错）                                        */
/* -------------------------------------------------------------------------- */

export const PetEvents = {
  AppReady: 'app:ready',
  AppError: 'app:error',
  PetClick: 'pet:click',
  PetDoubleClick: 'pet:dblclick',
  PetPointerEnter: 'pet:pointer-enter',
  PetPointerMove: 'pet:pointer-move',
  PetPointerLeave: 'pet:pointer-leave',
  PetDrag: 'pet:drag',
  PetRegion: 'pet:region',
  AnimationRequest: 'animation:request',
  AnimationStart: 'animation:start',
  AnimationEnd: 'animation:end',
  AnimationRejected: 'animation:rejected',
  StateChange: 'state:change',
  ActionReceived: 'action:received',
  ActionRejected: 'action:rejected',
  PluginDiscovered: 'plugin:discovered',
  PluginLoaded: 'plugin:loaded',
  PluginActivated: 'plugin:activated',
  PluginDeactivated: 'plugin:deactivated',
  PluginUnloaded: 'plugin:unloaded',
  PluginError: 'plugin:error',
  BehaviorTriggered: 'behavior:triggered',
  BehaviorPaused: 'behavior:paused',
} as const satisfies Record<string, KnownEventName>;
