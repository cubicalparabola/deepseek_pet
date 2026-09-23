/**
 * Logger 实现（Main / Renderer 共用，**零 Node 依赖**）。
 *
 * - 输出格式由 shared/log-line 统一保证；
 * - 支持最低级别过滤（开发环境 debug，生产 info）；
 * - 支持 sink：Main 用它把日志同时写入文件（见 main/log-file-sink.ts）；
 * - **日志本身绝不抛异常**。
 *
 * 注意：本文件会被打包进 renderer，因此绝不能 import node:* 模块。
 */

import { LOG_LEVEL_WEIGHT, type LogFields, type LogLevel, type Logger, type LoggerFactory } from './logger';
import { formatLogLine } from './log-line';

export interface LogEntry {
  readonly level: LogLevel;
  readonly module: string;
  readonly message: string;
  readonly fields?: LogFields;
  readonly line: string;
}

export type LoggerSink = (entry: LogEntry) => void;

/**
 * 自定义终端输出。
 *
 * 主进程传入一个把日志写成 UTF-8 字节的实现（见 main/console-encoding.ts）；
 * renderer 不传，走浏览器 console。
 *
 * 注意：**日志消息一律用英文**。原因是 Electron 主进程在 Windows + npm 链路上
 * 往终端写中文无法保证正确显示（详见 README §17），而英文不依赖终端编码。
 * 界面上给用户看的文本（托盘菜单、设置窗口等）仍是中文 —— 那是 HTML 渲染，不受影响。
 */
export type LogLineWriter = (level: LogLevel, line: string) => void;

export interface CreateLoggerOptions {
  readonly level?: LogLevel;
  readonly sinks?: readonly LoggerSink[];
  readonly toConsole?: boolean;
  /** 覆盖终端输出实现；缺省用 console.log/warn/error。 */
  readonly writeLine?: LogLineWriter;
}


class ModuleLogger implements Logger {
  public constructor(
    private readonly moduleName: string,
    private readonly owner: LoggerFactoryImpl,
  ) {}

  public debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  public info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  public warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  public error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    try {
      const owner = this.owner;
      if (LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[owner.level]) return;
      const moduleName = fields?.module ?? this.moduleName;
      const line = formatLogLine(level, moduleName, message, fields);
      owner.dispatch({ level, module: moduleName, message, fields, line });
    } catch {
      /* 日志失败必须静默 */
    }
  }
}

class LoggerFactoryImpl implements LoggerFactory {
  public level: LogLevel;
  private readonly sinks: readonly LoggerSink[];
  private readonly toConsole: boolean;
  private readonly writeLine: LogLineWriter;
  private readonly cache = new Map<string, Logger>();

  public constructor(options: CreateLoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.sinks = options.sinks ?? [];
    this.toConsole = options.toConsole ?? true;
    this.writeLine =
      options.writeLine ??
      ((level, line) => {
        const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        target(line);
      });
  }

  public create(moduleName: string): Logger {
    const cached = this.cache.get(moduleName);
    if (cached) return cached;
    const logger = new ModuleLogger(moduleName, this);
    this.cache.set(moduleName, logger);
    return logger;
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public getLevel(): LogLevel {
    return this.level;
  }

  public dispatch(entry: LogEntry): void {
    if (this.toConsole) {
      try {
        this.writeLine(entry.level, entry.line);
      } catch {
        /* 终端不可用时静默：日志不能反过来影响业务 */
      }
    }
    for (const sink of this.sinks) {
      try {
        sink(entry);
      } catch {
        /* 单个 sink 失败不影响其它 sink */
      }
    }
  }
}

export function createLoggerFactory(options: CreateLoggerOptions = {}): LoggerFactory {
  return new LoggerFactoryImpl(options);
}
