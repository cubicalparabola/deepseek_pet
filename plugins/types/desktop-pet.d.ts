/**
 * 插件类型垫片：让示例插件在 IDE 中获得完整类型提示。
 *
 * 运行时这个模块**不存在**：主进程用 esbuild 打包插件时把 `desktop-pet` 标记为 external，
 * 编译产物里的 `require('desktop-pet', ...)` 由 PluginHost 的 require shim 提供
 * （只返回 `definePlugin`，不暴露任何系统能力）。
 *
 * 因此插件作者只需要这一个 d.ts，不需要把主工程作为依赖安装。
 */

declare module 'desktop-pet' {
  /** 事件订阅句柄。 */
  export interface Subscription {
    unsubscribe(): void;
  }

  export interface LogFields {
    readonly module?: string;
    readonly event?: string;
    readonly error?: unknown;
    readonly data?: Record<string, unknown>;
  }

  export interface Logger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
  }

  /** 与主工程 src/shared 中的同名类型保持一致（结构兼容即可）。 */
  export interface AnimationDefinition {
    readonly id: string;
    readonly type: 'video' | 'image';
    readonly source: string;
    readonly loop?: boolean;
    readonly priority?: number;
    readonly interruptible?: boolean;
    readonly cooldown?: number;
    readonly tags?: readonly string[];
    readonly label?: string;
    readonly fallback?: boolean;
    readonly render?: {
      readonly className?: string;
      readonly scale?: number;
      readonly offsetX?: number;
      readonly offsetY?: number;
      readonly keying?: 'auto' | 'none' | 'luma' | 'screen';
    };
  }

  export type PetState = 'IDLE' | 'PLAYING' | 'SLEEPING' | 'BUSY';
  export type ActionSource = 'user' | 'behavior' | 'system' | 'ai-agent' | 'plugin' | (string & {});

  export interface PetAction {
    readonly type: 'animation' | 'state' | 'event';
    readonly target?: string;
    readonly animationId?: string;
    readonly priority?: number;
    readonly source?: ActionSource;
    readonly reason?: string;
    readonly interrupt?: 'auto' | 'force' | 'queue';
    readonly payload?: unknown;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }

  export interface ActionResult {
    readonly accepted: boolean;
    readonly type: 'animation' | 'state' | 'event';
    readonly rejection?: string;
    readonly animationId?: string;
    readonly state?: PetState;
    readonly detail?: string;
  }

  export interface PlayResult {
    readonly accepted: boolean;
    readonly animationId: string;
    readonly reason?: string;
    readonly queued?: boolean;
  }

  export interface PetClickPayload {
    readonly button: 'left' | 'middle' | 'right';
    readonly x: number;
    readonly y: number;
    readonly nx: number;
    readonly ny: number;
    readonly region: string;
    readonly detail: number;
  }

  export interface AnimationEndPayload {
    readonly animationId: string;
    readonly reason?: string;
    readonly source?: string;
    readonly completed: boolean;
  }

  export interface StateChangePayload {
    readonly from: PetState;
    readonly to: PetState;
    readonly reason: string;
    readonly source?: string;
    readonly at: number;
  }

  /** 事件名 -> 负载（允许自定义事件名）。 */
  export interface PetEventMap {
    'pet:click': PetClickPayload;
    'pet:dblclick': PetClickPayload;
    'pet:pointer-enter': { readonly region: string; readonly nx: number; readonly ny: number };
    'pet:pointer-move': { readonly region: string; readonly nx: number; readonly ny: number };
    'pet:pointer-leave': { readonly region: string; readonly nx: number; readonly ny: number };
    'pet:region': { readonly region: string; readonly nx: number; readonly ny: number };
    'pet:drag': { readonly phase: 'start' | 'move' | 'end'; readonly screenX: number; readonly screenY: number };
    'animation:request': { readonly animationId: string; readonly priority?: number };
    'animation:start': { readonly animationId: string; readonly priority: number; readonly loop: boolean };
    'animation:end': AnimationEndPayload;
    'animation:rejected': { readonly animationId: string; readonly rejection: string };
    'state:change': StateChangePayload;
    'action:received': { readonly type: string; readonly source: string };
    'action:rejected': { readonly type: string; readonly rejection: string };
    'plugin:loaded': { readonly pluginId: string };
    'plugin:activated': { readonly pluginId: string; readonly name?: string; readonly version?: string };
    'plugin:deactivated': { readonly pluginId: string };
    'behavior:triggered': { readonly animationId: string; readonly reason: string };
    'behavior:paused': { readonly paused: boolean };
    'app:ready': { readonly version: string; readonly animations: number; readonly plugins: number };
  }

  export type PetEventName = keyof PetEventMap | (string & {});
  export type PetEventPayload<K extends PetEventName> = K extends keyof PetEventMap
    ? PetEventMap[K]
    : Record<string, unknown>;

  export interface PluginEventAPI {
    on<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): Subscription;
    once<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): Subscription;
    off<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): void;
    emit<K extends PetEventName>(event: K, payload?: PetEventPayload<K>): void;
  }

  export interface PluginAnimationOptions {
    readonly priority?: number;
    readonly interrupt?: 'auto' | 'force' | 'queue';
    readonly reason?: string;
  }

  export interface PluginAnimationAPI {
    play(animationId: string, options?: PluginAnimationOptions): Promise<PlayResult>;
    stop(): void;
    isPlaying(): boolean;
    getCurrent(): string | null;
    getDefinition(animationId: string): AnimationDefinition | null;
    list(): readonly string[];
    register(definition: AnimationDefinition): void;
  }

  export interface PluginStateAPI {
    get(): PetState;
    is(state: PetState): boolean;
    onChange(handler: (change: { from: PetState; to: PetState; reason: string }) => void): Subscription;
    list(): readonly PetState[];
  }

  export interface PluginStorageAPI {
    get<T>(key: string, fallback?: T): T | undefined;
    set<T>(key: string, value: T): void;
    remove(key: string): void;
    keys(): readonly string[];
  }

  export interface PluginBehaviorAPI {
    pause(): void;
    resume(): void;
    isPaused(): boolean;
  }

  export interface PluginSystemAPI {
    getVersion(): Promise<string>;
    getPlatform(): string;
    showNotification(title: string, body: string): void;
    log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  }

  export interface PluginActionAPI {
    execute(action: PetAction): Promise<ActionResult>;
  }

  export interface PluginIdentity {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly description?: string;
    readonly author?: string;
  }

  export interface PluginContext {
    readonly events: PluginEventAPI;
    readonly animations: PluginAnimationAPI;
    readonly state: PluginStateAPI;
    readonly logger: Logger;
    readonly storage: PluginStorageAPI;
    readonly behavior: PluginBehaviorAPI;
    readonly system: PluginSystemAPI;
    readonly actions: PluginActionAPI;
    readonly plugin: PluginIdentity;
    readonly pluginDir: string;
  }

  export interface PetPlugin {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly description?: string;
    readonly author?: string;
    activate(context: PluginContext): void | Promise<void>;
    deactivate?(): void | Promise<void>;
  }

  /** 定义插件（恒等函数，仅用于类型收窄与稳定导出）。 */
  export function definePlugin(plugin: PetPlugin): PetPlugin;

  const _default: { definePlugin: typeof definePlugin };
  export default _default;
}
