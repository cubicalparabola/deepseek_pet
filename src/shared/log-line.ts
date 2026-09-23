/**
 * 日志格式化（Main / Renderer 共用），保证两端输出格式完全一致：
 *   [12:31:20] [AnimationManager] play coffee
 */

import type { LogFields, LogLevel } from './logger';
import { describeError } from './errors';

export function formatTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * 拼装一行日志。
 * 注意：级别不进入文本（终端本身已有颜色语义），但保留在结构化字段中，
 * 便于未来接入文件日志时按级别过滤。
 */
export function formatLogLine(
  _level: LogLevel,
  moduleName: string,
  message: string,
  fields?: LogFields,
): string {
  const suffix = fields?.event ? ` [${fields.event}]` : '';
  const errorPart = fields?.error !== undefined ? ` | ${describeError(fields.error)}` : '';
  const dataPart = fields?.data && Object.keys(fields.data).length > 0 ? ` | ${safeStringify(fields.data)}` : '';
  return `[${formatTimestamp()}] [${moduleName}]${suffix} ${message}${errorPart}${dataPart}`;
}
