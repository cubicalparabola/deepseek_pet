/**
 * 统一错误类型。
 *
 * 设计原则：
 * - 任何模块抛出的错误都应该是 PetError 的子类，便于统一捕获与结构化日志；
 * - 错误绝不冒泡到 Electron 主进程导致崩溃，必须在模块边界被捕获并降级处理。
 */

export type PetErrorCode =
  // 配置 / Manifest
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'DUPLICATE_ID'
  // 动画
  | 'ANIMATION_NOT_FOUND'
  | 'ANIMATION_UNSUPPORTED_TYPE'
  | 'ANIMATION_LOAD_FAILED'
  | 'ANIMATION_PLAY_FAILED'
  | 'ANIMATION_BLOCKED'
  | 'ANIMATION_COOLDOWN'
  // 状态机
  | 'STATE_TRANSITION_REJECTED'
  // 插件
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_INVALID'
  | 'PLUGIN_LOAD_FAILED'
  | 'PLUGIN_ACTIVATE_FAILED'
  | 'PLUGIN_RUNTIME_ERROR'
  // Action Pipeline
  | 'ACTION_INVALID'
  | 'ACTION_REJECTED'
  // IPC
  | 'IPC_UNAVAILABLE'
  | 'IPC_HANDLER_FAILED'
  // 兜底
  | 'UNKNOWN';

export interface PetErrorOptions {
  readonly code: PetErrorCode;
  readonly module: string;
  readonly cause?: unknown;
  readonly details?: Record<string, unknown>;
  /** 该错误是否属于可以忽略的“正常降级”场景（例如冷却期内重复请求）。 */
  readonly benign?: boolean;
}

export class PetError extends Error {
  public readonly code: PetErrorCode;
  public readonly module: string;
  public readonly details: Record<string, unknown>;
  public readonly benign: boolean;

  public constructor(message: string, options: PetErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    this.module = options.module;
    this.details = options.details ?? {};
    this.benign = options.benign ?? false;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      module: this.module,
      message: this.message,
      details: this.details,
    };
  }
}

export class ConfigError extends PetError {}
export class AnimationError extends PetError {}
export class StateError extends PetError {}
export class PluginError extends PetError {}
export class ActionError extends PetError {}
export class IpcError extends PetError {}

/** 把任意 unknown 错误转成可读字符串（用于日志，不做类型断言）。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** 把任意 unknown 错误转成结构化对象（用于 IPC 传输）。 */
export function serializeError(error: unknown): { message: string; code?: string; module?: string } {
  if (error instanceof PetError) {
    return { message: error.message, code: error.code, module: error.module };
  }
  if (error instanceof Error) {
    return { message: error.message };
  }
  return { message: describeError(error) };
}
