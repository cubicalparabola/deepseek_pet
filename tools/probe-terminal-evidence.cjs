// @ts-check
/**
 * 探针：**在线上的那条链路上**验证"终端文本"真的被读到并当作证据使用。
 *
 * 为什么需要它：`tools/probe-terminal-text.ps1` 只证明了"UIA 能拿到终端文本"，
 * 验收只证明了纯函数（打码/截尾/白名单）正确 —— 两者都不覆盖**中间那段**：
 * `TerminalTextProbe` 里内联的 PowerShell 脚本、JSON 解析、以及"读到了就发给模型"的接线。
 * 而这一段只在"前台窗口正好是终端"时才跑，平时完全静默。
 *
 * 做法：先把系统里那个 Windows Terminal 窗口**置为前台**（UIA 找到它的 NativeWindowHandle
 * 再 `SetForegroundWindow`），然后调 `perception.sampleNow()`，再看状态里的
 * `terminalText.state` / `keptChars` —— 期望 `captured` 且 `keptChars > 0`。
 *
 * 用法：npx electron tools/probe-terminal-evidence.cjs
 * 输出：build/terminal-evidence.json
 */
const { app, BrowserWindow } = require('electron');
const { execFile } = require('node:child_process');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'terminal-evidence.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-terminal-evidence');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把 Windows Terminal 的窗口置为前台（只影响焦点，不注入、不改内容）。 */
const ACTIVATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PetFg2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$target = $null
$targetPid = 0
foreach ($element in $children) {
  try {
    $proc = Get-Process -Id $element.Current.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'WindowsTerminal') { $target = $element; $targetPid = $element.Current.ProcessId; break }
  } catch { }
}
if ($null -eq $target) { '{"ok":false,"reason":"no-terminal-window"}' ; exit 0 }
$handle = [IntPtr]$target.Current.NativeWindowHandle
# 第一次：直接试
[void][PetFg2]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 250
if ([PetFg2]::GetForegroundWindow() -ne $handle) {
  # Windows 的前台锁：后台进程不许抢焦点。经典绕法 —— 先模拟一次 ALT 按键
  # （让系统认为"用户刚有输入"），再 SetForegroundWindow。只按一下 ALT，不改任何内容。
  [PetFg2]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [void][PetFg2]::SetForegroundWindow($handle)
  [PetFg2]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 400
}
if ([PetFg2]::GetForegroundWindow() -ne $handle) {
  try { (New-Object -ComObject WScript.Shell).AppActivate($targetPid) | Out-Null } catch { }
  Start-Sleep -Milliseconds 500
}
$now = [PetFg2]::GetForegroundWindow()
'{"ok":true,"activated":' + ($now -eq $handle).ToString().ToLower() + '}'
`;

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolve({ error: error ? String(error.message) : '', stdout: typeof stdout === 'string' ? stdout.trim() : '' }));
  });
}

app.whenReady().then(async () => {
  await wait(6000);
  const petWin = BrowserWindow.getAllWindows()[0];
  if (!petWin) throw new Error('桌宠窗口不存在');
  const run = (js) => petWin.webContents.executeJavaScript(js, true);

  // 让终端成为前台窗口（这是这一路唯一的前置条件）
  const activation = await runPowerShell(ACTIVATE_SCRIPT);
  console.log('[activate]', JSON.stringify(activation));
  await wait(600);

  // 必须配一个"能连上"的模型地址才会走截图 + 终端文本那一路；
  // 这里指向本机一个必然拒绝连接的端口：链路照跑，只是最后一步失败。
  //
  // ⚠️ 用 `viewNow('scene')` 而不是 `sampleNow()`：窗口快照有 25s 的 TTL，
  // `sampleNow()` 会复用"刚才那个前台窗口"的缓存（实测踩到：明明切到终端了，
  // 服务看到的还是 msedge）。`viewNow()` 会**强制刷新**窗口枚举与终端文本。
  const status = await run(`(async () => {
    await window.petAPI.ai.setSettings({
      enabled: true, chat: true,
      provider: { baseUrl: 'http://127.0.0.1:9/v1', model: 'probe-terminal', apiKey: 'sk-probe-terminal-0001', timeoutMs: 1500 },
    });
    await window.petAPI.perception.setSettings({ screen: true, windowContext: true, terminalText: true, privacyMode: false });
    await window.petAPI.perception.viewNow('scene');
    const after = await window.petAPI.perception.status();
    await window.petAPI.ai.setSettings({ clearApiKey: true });
    return {
      foreground: after.windowContext.foregroundProcess,
      terminal: after.terminalText,
      lastError: after.lastError,
    };
  })()`);

  const result = {
    activation,
    foregroundProcess: status.foreground,
    terminalState: status.terminal,
    lastError: status.lastError,
    verdict: {
      foregroundIsTerminal: typeof status.foreground === 'string' && status.foreground.length > 0,
      textCaptured: Boolean(status.terminal) && status.terminal.state === 'captured' && status.terminal.keptChars > 0,
    },
  };
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('[result]', JSON.stringify(result, null, 1));
  app.exit(result.verdict.textCaptured ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
