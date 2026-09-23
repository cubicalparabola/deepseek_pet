/**
 * 插件系统契约。
 *
 * 安全边界（第一版即必须成立）：
 * 插件运行在 Renderer 的独立宿主（PluginHost）中，只能看到一个受控的
 * `PluginContext`，**不能**访问：
 *   BrowserWindow / ipcMain / Electron internals / Node.js fs / process / require
 * 任何系统能力都必须经由 Plugin API -> Action Pipeline / IPC 白名单完成。
 *
 * 插件异常由 PluginHost 逐插件隔离：单个插件抛错只记录日志并禁用该插件，
 * 绝不允许影响桌宠核心或其他插件。
 */

import type { Logger } from './logger';
import type { PetEventName, PetEventPayload, Subscription } from './events';
import type { PetState } from './state-types';
import type { PetAction, ActionResult } from './action-types';
import type {
  AnimationDefinition,
  InterruptPolicy,
  PlayResult,
} from './animation-types';

/* -------------------------------------------------------------------------- */
/* Plugin API 子接口                                                           */
/* -------------------------------------------------------------------------- */

/** 事件 API：插件与桌宠通信的唯一事件通道。 */
export interface PluginEventAPI {
  on<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): Subscription;
  once<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): Subscription;
  off<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): void;
  emit<K extends PetEventName>(event: K, payload?: PetEventPayload<K>): void;
}

/** 动画 API：插件唯一被允许的“播放手段”，内部走 Action Pipeline。 */
export interface PluginAnimationAPI {
  play(animationId: string, options?: PluginAnimationOptions): Promise<PlayResult>;
  stop(): void;
  isPlaying(): boolean;
  getCurrent(): string | null;
  /** 读取动画定义（含未注册的 Manifest 条目），用于插件做条件判断。 */
  getDefinition(animationId: string): AnimationDefinition | null;
  list(): readonly string[];
  /** 高级：注册临时动画（例如插件自带的 WebM）。 */
  register(definition: AnimationDefinition): void;
}

export interface PluginAnimationOptions {
  readonly priority?: number;
  readonly interrupt?: InterruptPolicy;
  readonly reason?: string;
}

/** 状态 API（只读）。插件不允许直接改状态，改状态必须走 Action。 */
export interface PluginStateAPI {
  get(): PetState;
  is(state: PetState): boolean;
  /** 订阅状态变化，返回取消订阅句柄。 */
  onChange(handler: (change: { from: PetState; to: PetState; reason: string }) => void): Subscription;
  /** 允许的状态名列表（便于 AI/插件生成合法取值）。 */
  list(): readonly PetState[];
}

/** 存储 API（Renderer 侧持久化，第一版用 localStorage，不引入数据库）。 */
export interface PluginStorageAPI {
  get<T>(key: string, fallback?: T): T | undefined;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
  keys(): readonly string[];
}

/** 行为 API：暂停/恢复自动行为，供插件与托盘菜单使用。 */
export interface PluginBehaviorAPI {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}

/** 系统能力 API（白名单，全部通过 preload -> IPC）。 */
export interface PluginSystemAPI {
  getVersion(): Promise<string>;
  getPlatform(): string;
  showNotification(title: string, body: string): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

/** Action API：与 AI Agent 共用同一条 Pipeline。 */
export interface PluginActionAPI {
  execute(action: PetAction): Promise<ActionResult>;
}

/** 插件上下文。 */
export interface PluginContext {
  readonly events: PluginEventAPI;
  readonly animations: PluginAnimationAPI;
  readonly state: PluginStateAPI;
  readonly logger: Logger;
  readonly storage: PluginStorageAPI;
  readonly behavior: PluginBehaviorAPI;
  readonly system: PluginSystemAPI;
  readonly actions: PluginActionAPI;
  /** 插件自身 id / name / version，便于日志与存储 key 前缀。 */
  readonly plugin: PluginIdentity;
  /** 插件目录标识（相对 plugins/ 的路径），只读字符串，不是文件系统句柄。 */
  readonly pluginDir: string;
}

/* -------------------------------------------------------------------------- */
/* 插件定义                                                                    */
/* -------------------------------------------------------------------------- */

export interface PluginIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
}

export interface PetPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  /** 兼容 loader 的静态元数据（未提供时使用 PetPlugin 的字段）。 */
  readonly manifest?: PluginIdentity;
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** 插件生命周期状态。 */
export type PluginStatus =
  | 'discovered'
  | 'loading'
  | 'loaded'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'inactive'
  | 'failed';

export interface PluginRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly enabled: boolean;
  readonly status: PluginStatus;
  readonly error?: string;
  readonly activatedAt?: number;
}

/* -------------------------------------------------------------------------- */
/* 插件 Manifest                                                               */
/* -------------------------------------------------------------------------- */

/** `assets/config/plugins.json` 的单条记录。 */
export interface PluginManifestEntry {
  readonly id: string;
  readonly enabled?: boolean;
  /** 可选：覆盖插件目录（默认 plugins/<id>）。 */
  readonly path?: string;
}

export interface PluginManifest {
  readonly plugins: readonly PluginManifestEntry[];
}

/* -------------------------------------------------------------------------- */
/* 静态分析结果（Main 进程只做发现与读取，不执行插件逻辑）                        */
/* -------------------------------------------------------------------------- */

export interface DiscoveredPlugin {
  readonly id: string;
  readonly dir: string;
  /** 主进程解析 package.json 得到的元数据（不含任何可执行代码）。 */
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly enabled: boolean;
  /** 插件入口的源文件绝对路径（可能是 index.js 或 index.ts）。 */
  readonly entryPath: string;
  /** 入口是否需要先编译（.ts -> .js）。 */
  readonly needsCompile: boolean;
}
