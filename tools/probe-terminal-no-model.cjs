// @ts-check
/**
 * 探针：**终端在前台时，到底有没有调模型**（用户报"仍然会调用模型"，这里给出可复现的判据）。
 *
 * 做法：起一个本地假模型服务（记录每一次请求），把 Windows Terminal 置为前台，
 * 然后走**周期采样**那条路（`sampleNow()`）。期望：
 *   - `scene === 'terminal'`、`activity === '正在使用控制台'`、`mode === 'local'`、`tokens === 0`；
 *   - **假模型一次请求都没收到**（`requestCount === 0`）。
 *
 * 为什么必须用假模型而不是只看日志：日志里 `llm completion ok` 只有在真配了密钥时才会出现，
 * 而"有没有请求出去"最硬的证据是服务端收到了几次。
 *
 * ⚠️ 两个真机细节（踩过）：
 *   1. `SetForegroundWindow` 会被 Windows 的前台锁拒掉 —— 补一次"模拟 ALT 按键"的经典绕法；
 *   2. 窗口快照有 25s TTL，`sampleNow()` 会复用旧快照（前台还是上一次那个窗口）——
 *      探针先把 `windowProbeTtlMs` 调成 5000 并等 6 秒，确保这次采样做的是新鲜枚举。
 *
 * 用法：npx electron tools/probe-terminal-no-model.cjs
 * 输出：build/terminal-no-model.json
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'terminal-no-model.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-terminal-no-model');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ANSWER = JSON.stringify({
  scene: 'coding', app: 'VS Code', activity: '在写代码', url: '', browserChrome: false,
  editorChrome: true, sensitive: false, focus: 'deep', suggestion: '',
});

const requests = [];

function startFakeModel() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ at: new Date().toISOString(), path: req.url, bytes: body.length });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: ANSWER } }],
          usage: { prompt_tokens: 1000, completion_tokens: 30, total_tokens: 1030 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const ACTIVATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PetFg4 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$target = $null
foreach ($element in $children) {
  try {
    $proc = Get-Process -Id $element.Current.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'WindowsTerminal') { $target = $element; break }
  } catch { }
}
if ($null -eq $target) { '{"ok":false,"reason":"no-terminal-window"}' ; exit 0 }
$handle = [IntPtr]$target.Current.NativeWindowHandle

# 前台锁的规范绕法：把**当前前台线程**与自己的线程短暂 attach 起来，再 SetForegroundWindow。
# 比"模拟一次 ALT 按键"稳得多（ALT 那招实测会被别的应用抢回焦点，前台甚至跑到微信上）。
function Force-Foreground([IntPtr]$h) {
  $fg = [PetFg4]::GetForegroundWindow()
  $pid2 = 0
  $fgThread = [PetFg4]::GetWindowThreadProcessId($fg, [ref]$pid2)
  $me = [PetFg4]::GetCurrentThreadId()
  [void][PetFg4]::AttachThreadInput($me, $fgThread, $true)
  try {
    [void][PetFg4]::ShowWindow($h, 9)   # SW_RESTORE
    [void][PetFg4]::BringWindowToTop($h)
    [void][PetFg4]::SetForegroundWindow($h)
  } finally {
    [void][PetFg4]::AttachThreadInput($me, $fgThread, $false)
  }
}

$held = $false
for ($i = 0; $i -lt 6 -and -not $held; $i++) {
  Force-Foreground $handle
  Start-Sleep -Milliseconds 400
  $held = ([PetFg4]::GetForegroundWindow() -eq $handle)
}
if (-not $held) { '{"ok":true,"heldForeground":false}' ; exit 0 }
# 保持前台若干秒（Node 侧在这段时间里跑两条代码路径）
Start-Sleep -Seconds '@@HOLD_SECONDS@@'
'{"ok":true,"heldForeground":true}'
`;

/** 把 @@HOLD_SECONDS@@ 换成实际秒数（脚本里用字符串替换，避免 PowerShell 侧再算时间）。 */
function activateAndHold(seconds) {
  return runPowerShell(ACTIVATE_SCRIPT.replace('@@HOLD_SECONDS@@', String(seconds)));
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 40000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolve({ error: error ? String(error.message) : '', stdout: typeof stdout === 'string' ? stdout.trim() : '' }));
  });
}

app.whenReady().then(async () => {
  const { server, port } = await startFakeModel();
  await wait(6000);
  const petWin = BrowserWindow.getAllWindows()[0];
  if (!petWin) throw new Error('桌宠窗口不存在');
  const run = (js) => petWin.webContents.executeJavaScript(js, true);

  // 先配好假模型（这一步必须在"按住 ALT"之前，免得抢走焦点）
  await run(`(async () => {
    await window.petAPI.ai.setSettings({
      enabled: true, chat: true,
      provider: { baseUrl: 'http://127.0.0.1:${port}/v1', model: 'probe-no-model', apiKey: 'sk-probe-nomodel-0001', timeoutMs: 4000 },
    });
    await window.petAPI.perception.setSettings({ screen: true, windowContext: true, privacyMode: false });
    return true;
  })()`);

  /*
   * 按住 ALT 让终端稳定留在前台 12 秒，在这段时间里跑两条路：
   *   1. 按需「看我在做什么」`viewNow('scene')`（它会强制刷新窗口枚举）；
   *   2. 紧接着 `sampleNow()` 走周期那条路（此时快照已是最新的 windowsterminal）。
   * 两条都必须**不调模型**。
   */
  const holdPromise = activateAndHold(12);
  await wait(1500);
  const status = await run(`(async () => {
    const view = await window.petAPI.perception.viewNow('scene');
    const sampled = await window.petAPI.perception.sampleNow();
    const after = await window.petAPI.perception.status();
    await window.petAPI.ai.setSettings({ clearApiKey: true });
    return {
      foreground: after.windowContext.foregroundProcess,
      view: { ok: view.ok, text: view.text, scene: view.scene, tokens: view.tokens },
      observation: sampled.lastObservation
        ? { scene: sampled.lastObservation.scene, activity: sampled.lastObservation.activity, mode: sampled.lastObservation.mode, tokens: sampled.lastObservation.tokens }
        : null,
      lastError: sampled.lastError,
    };
  })()`);
  const activation = await holdPromise;

  const result = {
    activation,
    foregroundProcess: status.foreground,
    viewPath: status.view,
    periodicPath: status.observation,
    lastError: status.lastError,
    fakeModelRequestCount: requests.length,
    fakeModelRequests: requests,
    verdict: {
      foregroundWasTerminal: status.foreground === 'windowsterminal',
      viewFixedText: status.view.text === '正在使用控制台' && status.view.tokens === 0,
      periodicFixedConclusion: Boolean(status.observation) &&
        status.observation.scene === 'terminal' &&
        status.observation.activity === '正在使用控制台' &&
        status.observation.mode === 'local' &&
        status.observation.tokens === 0,
      noModelCall: requests.length === 0,
    },
  };
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('[result]', JSON.stringify(result, null, 1));
  server.close();
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
