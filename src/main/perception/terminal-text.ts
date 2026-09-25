/**
 * 终端文本（3.1 的"内容证据"之一）—— 用 Windows UI Automation **只读**读终端缓冲区。
 *
 * ## 为什么做（以及为什么值得小心）
 *
 * 用户实测：她对**终端里在干什么**经常瞎说。整屏缩到 640 宽后终端字符只有几像素，
 * 视觉模型读不出来，只能顺着"黑底白字像代码"编。而终端文本其实**拿得到** ——
 * 探针（`tools/probe-terminal-text.ps1`）实测：Windows Terminal 把缓冲区文本暴露在
 * **子元素**上（`ControlType.Text` + `TextPattern`，UIA 树 8 层以内），
 * 一个窗口能取到 46 万字符的完整 scrollback。既然拿得到，就用它当证据（用户的要求）。
 *
 * ## 五条硬约束（每一条都有代码落点，别改回去）
 *
 * 1. **只读**：`AutomationElement.FromHandle` + `TextPattern.DocumentRange.GetText`。
 *    不注入、不改窗口、不发按键、不碰剪贴板、不 attach 别人的控制台。
 * 2. **只读"终端类进程"**（`isTerminalProcess`）：别的窗口一律不碰。
 * 3. **只取尾部**（`tailTerminalText`，默认 30 行 / 1200 字）：缓冲区是整段历史，
 *    既没必要也不安全。
 * 4. **先打码再送出**（`redactTerminalSecrets`）：实测缓冲区里就有
 *    `?token=...` 这种地址 —— 我们只想知道"他在干什么"，不想要他的凭据。
 * 5. **绝不落盘**：文本与截图同一条纪律，只在当次请求的内存里活一次；
 *    命中敏感词时**整段不发给模型**（由调用方判断）。
 *
 * 失败一律安静降级（返回 null）：没有 UIA、窗口不是终端、读不到文本、超时 ——
 * 都只是"少一路证据"，绝不影响其它感知。
 */

import { execFile } from 'node:child_process';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import { isTerminalProcess, redactTerminalSecrets, stripAnsiEscape, tailTerminalText } from '../../shared/perception';

export interface TerminalTextResult {
  /** 清理 + 打码 + 截尾之后的文本（给模型看的那一份）。 */
  readonly text: string;
  /** 原始长度（只用于日志/状态，便于判断"是不是真读到了东西"）。 */
  readonly rawLength: number;
  /** 从哪个 UIA 模式读到的（`TextPattern` / `ValuePattern`）。 */
  readonly mode: string;
  /** 这次读取的耗时（毫秒）。 */
  readonly elapsedMs: number;
}

export interface TerminalTextOptions {
  readonly logger: Logger;
  /** 是否允许读（总开关 + 隐私模式都在这里判断）。 */
  readonly isEnabled: () => boolean;
  /** 当前最上层窗口的进程名（空串 = 不知道）。 */
  readonly getForegroundProcess: () => string;
  /** 缓存多久（毫秒，默认 15000）：手动"看一次"与周期采样可能挨得很近。 */
  readonly ttlMs?: number;
  /** 单次读取超时（毫秒，默认 8000）。 */
  readonly timeoutMs?: number;
  /** 尾部保留行数 / 字符数（默认 **20 行 / 800 字**；见下面 `probe()` 里的说明）。 */
  readonly maxLines?: number;
  readonly maxChars?: number;
  /** 失败退避（毫秒，默认 10 分钟；与窗口探针同样的策略）。 */
  readonly failureBackoffMs?: number;
}

/**
 * 读前台终端窗口文本的 PowerShell 脚本（一次性，只读）。
 *
 * 结构与 `window-context.ts` 同源：显式设 UTF-8（否则中文命令输出会变乱码）、
 * 一次性输出 JSON、异常一律走 stdout 的 `{ok:false}` 而不是抛栈（Node 侧好处理）。
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PetFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$handle = [PetFg]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { '{"ok":false,"reason":"no-foreground"}' ; exit 0 }
$element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($null -eq $element) { '{"ok":false,"reason":"no-element"}' ; exit 0 }
# 广度优先往下找第一个能给出文本的元素（终端把文本放在 TermControl 子元素上）
$queue = New-Object System.Collections.Queue
$queue.Enqueue($element)
$visited = 0
$text = ''
$mode = ''
while ($queue.Count -gt 0 -and $visited -lt 400 -and $text -eq '') {
  $node = $queue.Dequeue()
  $visited++
  try {
    $pattern = $null
    if ($node.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
      $value = $pattern.DocumentRange.GetText(-1)
      if ($value -and $value.Trim().Length -gt 0) { $text = $value; $mode = 'TextPattern' }
    }
    if ($text -eq '') {
      $valuePattern = $null
      if ($node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        $value = $valuePattern.Current.Value
        if ($value -and $value.Trim().Length -gt 0) { $text = $value; $mode = 'ValuePattern' }
      }
    }
  } catch { }
  if ($text -eq '' -and $visited -lt 400) {
    try {
      $kids = $node.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($kid in $kids) { $queue.Enqueue($kid) }
    } catch { }
  }
}
if ($text -eq '') { '{"ok":false,"reason":"no-text"}' ; exit 0 }
[ordered]@{ ok = $true; mode = $mode; text = $text } | ConvertTo-Json -Compress -Depth 4
`;

/** 跑一次 PowerShell 并返回 stdout。 */
function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
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

export class TerminalTextProbe {
  private readonly options: TerminalTextOptions;
  private readonly logger: Logger;
  private cache: (TerminalTextResult & { readonly at: number; readonly process: string }) | null = null;
  private failedUntil = 0;
  private lastFailure = '';

  public constructor(options: TerminalTextOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /** 最近一次读到的结果（状态展示用；没读过就是 null）。 */
  public get last(): TerminalTextResult | null {
    return this.cache;
  }

  /** 是否处于失败退避中。 */
  public get backingOff(): boolean {
    return Date.now() < this.failedUntil;
  }

  /**
   * 取当前前台终端窗口的文本（带 TTL 缓存与失败退避）。
   *
   * @param force true = 忽略 TTL（手动"立刻看一次"用）
   */
  public async probe(force = false, now: number = Date.now()): Promise<TerminalTextResult | null> {
    if (!this.options.isEnabled()) return null;
    const process = this.options.getForegroundProcess();
    /*
     * 只在前台是终端时才读 —— 这一条同时解决了"读谁"和"值不值得读"两个问题：
     * 用户此刻在看哪个终端，就是哪个终端。
     */
    if (!isTerminalProcess(process)) return null;

    const ttl = Math.max(3000, this.options.ttlMs ?? 15000);
    if (!force && this.cache && this.cache.process === process && now - this.cache.at < ttl) return this.cache;
    if (now < this.failedUntil) return this.cache;

    const startedAt = Date.now();
    try {
      const stdout = await runPowerShell(SCRIPT, this.options.timeoutMs ?? 8000);
      const parsed = JSON.parse(stdout.trim() === '' ? '{}' : stdout.trim()) as unknown;
      const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
      if (record.ok !== true || typeof record.text !== 'string') {
        // "读不到文本"是最常见的正常结果（比如前台窗口刚打开、或不是真的终端控件）
        this.logger.debug('terminal text not available', { data: { process, reason: String(record.reason ?? 'unknown') } });
        this.cache = null;
        return null;
      }
      const raw = record.text;
      /*
       * 顺序很重要：先去控制字符 → 再打码 → 最后截尾（截尾之后才不会再漏出长串）。
       *
       * 默认 **20 行 / 800 字**（一开始是 30 行 / 1200 字）：用户日志里出现过
       * `terminal text captured` 紧接着 `模型返回了空内容` —— 终端那段原样文本
       * 把预算吃在了思考过程里。文本短一点，触发这种情况的概率就低一点，
       * 而"最后十几行"对判断"在跑什么"已经够了。视觉分析侧另有兜底重试
       * （`vision.ts` 的 `analyzeScene`：空内容时**不带终端文本**再试一次）。
       */
      const cleaned = tailTerminalText(redactTerminalSecrets(stripAnsiEscape(raw)), {
        maxLines: this.options.maxLines ?? 20,
        maxChars: this.options.maxChars ?? 800,
      });
      const result: TerminalTextResult & { at: number; process: string } = {
        text: cleaned,
        rawLength: raw.length,
        mode: typeof record.mode === 'string' ? record.mode : '',
        elapsedMs: Date.now() - startedAt,
        at: Date.now(),
        process,
      };
      this.cache = result;
      this.lastFailure = '';
      this.logger.debug('terminal text captured', {
        data: { process, rawLength: raw.length, kept: cleaned.length, mode: result.mode, elapsedMs: result.elapsedMs },
      });
      return result;
    } catch (error) {
      const message = describeError(error);
      if (message !== this.lastFailure) {
        this.lastFailure = message;
        this.logger.warn('terminal text probe failed; backing off', {
          error: message,
          data: { backoffMs: this.options.failureBackoffMs ?? 600000, process },
        });
      }
      this.failedUntil = Date.now() + Math.max(60000, this.options.failureBackoffMs ?? 600000);
      return this.cache;
    }
  }
}
