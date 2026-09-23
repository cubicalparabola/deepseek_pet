/**
 * 日志系统接口（Main / Preload / Renderer / Plugin 共用）。
 *
 * 日志格式：[HH:mm:ss] [Module] message
 * 日志只通过 Logger 输出，禁止在业务代码里直接 console.log。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 结构化日志字段（可选，用于未来接入文件日志 / 远端诊断）。 */
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

/** 可派生子 logger 的工厂，用于给每个模块创建带模块名的 Logger。 */
export interface LoggerFactory {
  create(module: string): Logger;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
}
