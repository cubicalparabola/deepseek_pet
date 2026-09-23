/**
 * 文件日志 sink（仅 Main 进程使用）。
 *
 * 为什么需要它：
 * Electron 在 Windows 上是 GUI 子系统程序，直接 `electron .` 或后台启动时
 * stdout 不可靠（重定向经常拿不到任何内容）。有了文件日志，
 * 无论是开发调试还是打包后给用户排查，都有稳定的诊断入口：
 *   %APPDATA%/<appName>/logs/desktop-pet.log
 *
 * 安全性/健壮性：
 * - 目录不存在会自动创建；
 * - 单文件超过上限后轮转（.1 / .2），不会无限增长；
 * - 任何写入失败都静默 —— 日志系统绝不能反过来拖垮桌宠。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LoggerSink } from '../shared/logging';

/** 单文件上限（1MB）。 */
export const LOG_FILE_MAX_BYTES = 1024 * 1024;
/** 保留的历史文件份数。 */
export const LOG_FILE_KEEP = 2;

export interface FileSinkOptions {
  readonly maxBytes?: number;
  readonly keep?: number;
  /** 每次启动是否清空旧日志（默认 true，便于定位“本次运行”）。 */
  readonly truncateOnStart?: boolean;
}

export function createFileSink(filePath: string, options: FileSinkOptions = {}): LoggerSink {
  const maxBytes = options.maxBytes ?? LOG_FILE_MAX_BYTES;
  const keep = options.keep ?? LOG_FILE_KEEP;
  const truncateOnStart = options.truncateOnStart ?? true;
  let bytesWritten = 0;
  let initialized = false;

  const rotate = (): void => {
    try {
      for (let index = keep - 1; index >= 1; index -= 1) {
        const from = index === 1 ? filePath : `${filePath}.${index - 1}`;
        const to = `${filePath}.${index}`;
        if (existsSync(from)) renameSync(from, to);
      }
    } catch {
      /* 轮转失败忽略 */
    }
  };

  return (entry) => {
    try {
      if (!initialized) {
        mkdirSync(dirname(filePath), { recursive: true });
        if (truncateOnStart) writeFileSync(filePath, '', 'utf8');
        initialized = true;
      }
      if (bytesWritten > maxBytes) {
        rotate();
        writeFileSync(filePath, '', 'utf8');
        bytesWritten = 0;
      }
      const line = `${entry.line}\n`;
      appendFileSync(filePath, line, 'utf8');
      bytesWritten += Buffer.byteLength(line, 'utf8');
    } catch {
      /* 日志写入失败必须静默 */
    }
  };
}
