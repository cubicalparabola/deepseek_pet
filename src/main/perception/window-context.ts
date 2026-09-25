/**
 * 窗口上下文（"现在开着哪些窗口 / 最上层是哪个"）——3.1/3.2 判断"在用哪个应用"的**关键证据**。
 *
 * 为什么不用 Electron 的 `desktopCapturer.getSources({types:['window']})`：
 * 实测（`tools/probe-foreground-window.cjs`）它在这台机器上**只枚举到 2 个窗口**、
 * 耗时 577ms、而且**不告诉哪个是前台**。而一次 PowerShell `EnumWindows` 就能拿到
 * **29 个可见窗口 + 进程名 + 前台标记**（~500ms），信息量和准确度都高一个量级。
 *
 * 三条设计约束：
 * 1. **一次 spawn 拿全部**：前台与窗口列表来自同一次枚举，避免"两次采样时间不一致"；
 * 2. **编码必须显式设 UTF-8**：否则中文窗口标题会以 GBK 写进 stdout，
 *    Node 按 UTF-8 解码得到一堆 U+FFFD（第一次探针就栽在这里）；
 * 3. **失败要退避**：没有 PowerShell / 被策略拦住时不能每个采样周期都重试，
 *    失败后进入退避窗口（默认 10 分钟），并且**只是少一路证据**，不影响其它感知。
 */

import { execFile } from 'node:child_process';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import { normalizeWindowTitle } from '../../shared/perception';

/** 一次窗口枚举的结果。 */
export interface WindowSnapshot {
  /** 最上层（前台）窗口。 */
  readonly foreground: { readonly title: string; readonly process: string } | null;
  /** 可见的顶层窗口（按 Z 序，前台通常在最前）。 */
  readonly windows: readonly { readonly title: string; readonly process: string; readonly foreground: boolean }[];
  /** 这次枚举的时间（epoch ms）。 */
  readonly at: number;
  /** 这次是真的枚举了（false = 用了缓存/退避）。 */
  readonly fresh: boolean;
}

export interface WindowContextOptions {
  readonly logger: Logger;
  /** 是否允许探测（开关关掉时直接返回空）。 */
  readonly isEnabled: () => boolean;
  /** 结果缓存多久（毫秒）：默认 25s，配合 30s 采样基本一次采样一次探测。 */
  readonly ttlMs?: number;
  /** 枚举超时（毫秒，默认 8000）。 */
  readonly timeoutMs?: number;
  /** 失败退避（毫秒，默认 10 分钟）。 */
  readonly failureBackoffMs?: number;
}

/** PowerShell 脚本（EnumWindows + 进程名 + 前台标记，一次性输出 JSON）。 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# 必须显式设 UTF-8：中文窗口标题否则会以 GBK 写进 stdout（实测踩过）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class PetWinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static List<string> Rows() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0 || len > 512) return true;
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(pid + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static long Foreground() {
    var h = GetForegroundWindow();
    uint pid; GetWindowThreadProcessId(h, out pid);
    return (long)pid;
  }
}
"@
$fg = [PetWinEnum]::Foreground()
$items = @()
foreach ($row in [PetWinEnum]::Rows()) {
  $parts = $row.Split('|', 2)
  $p = Get-Process -Id ([int]$parts[0]) -ErrorAction SilentlyContinue
  $items += [ordered]@{
    title = $parts[1]
    process = if ($p) { $p.ProcessName } else { '' }
    foreground = ([int]$parts[0] -eq $fg)
  }
}
$items | ConvertTo-Json -Compress
`;

export class WindowContextProbe {
  private readonly options: WindowContextOptions;
  private readonly logger: Logger;
  private snapshot: WindowSnapshot | null = null;
  private failedUntil = 0;
  private lastFailure = '';

  public constructor(options: WindowContextOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /** 当前快照（可能是缓存；没探过则为 null）。 */
  public current(): WindowSnapshot | null {
    return this.snapshot;
  }

  /**
   * 取窗口上下文（带 TTL 缓存与失败退避）。
   *
   * @param force true = 忽略 TTL（手动"立刻感知一次"用）
   */
  public async probe(force = false, now: number = Date.now()): Promise<WindowSnapshot | null> {
    if (!this.options.isEnabled()) return null;
    const ttl = Math.max(5000, this.options.ttlMs ?? 25000);
    if (!force && this.snapshot && now - this.snapshot.at < ttl) return this.snapshot;
    if (now < this.failedUntil) return this.snapshot;

    const startedAt = Date.now();
    try {
      const stdout = await runPowerShell(SCRIPT, this.options.timeoutMs ?? 8000);
      const parsed = JSON.parse(stdout.trim() === '' ? '[]' : stdout.trim()) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      const windows = rows
        .map((row) => {
          if (typeof row !== 'object' || row === null) return null;
          const record = row as Record<string, unknown>;
          const title = normalizeWindowTitle(typeof record.title === 'string' ? record.title : '');
          const process = typeof record.process === 'string' ? record.process.toLowerCase().slice(0, 40) : '';
          if (title === '') return null;
          return { title, process, foreground: record.foreground === true };
        })
        .filter((item): item is { title: string; process: string; foreground: boolean } => item !== null);

      const foregroundRow = windows.find((item) => item.foreground) ?? windows[0] ?? null;
      this.snapshot = {
        foreground: foregroundRow ? { title: foregroundRow.title, process: foregroundRow.process } : null,
        windows,
        at: Date.now(),
        fresh: true,
      };
      this.lastFailure = '';
      this.logger.debug('window context probed', {
        data: { windows: windows.length, foreground: foregroundRow?.process ?? '', elapsedMs: Date.now() - startedAt },
      });
      return this.snapshot;
    } catch (error) {
      const message = describeError(error);
      if (message !== this.lastFailure) {
        this.lastFailure = message;
        // 只提示一次（同一种失败不刷日志），并进入退避
        this.logger.warn('window context probe failed; backing off', {
          error: message,
          data: { backoffMs: this.options.failureBackoffMs ?? 600000 },
        });
      }
      this.failedUntil = Date.now() + Math.max(60000, this.options.failureBackoffMs ?? 600000);
      return this.snapshot;
    }
  }

  /** 探测是否处于退避中（状态展示用）。 */
  public get backingOff(): boolean {
    return Date.now() < this.failedUntil;
  }
}

/** 跑一次 PowerShell 并返回 stdout（UTF-8）。 */
function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(typeof stdout === 'string' ? stdout : '');
      },
    );
  });
}
