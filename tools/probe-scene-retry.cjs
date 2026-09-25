// @ts-check
/**
 * 探针：**"模型返回了空内容"时，这一轮观察不能丢**（带终端文本那条路的回归测试）。
 *
 * 背景（用户真机日志）：
 *   `terminal text captured | {rawLength:494095, kept:1200}` 紧接着
 *   `scene analysis failed | 模型返回了空内容`，而同一时刻前台是浏览器时一切正常 ——
 *   说明是**终端那段原样文本**把 `maxTokens: 360` 的预算吃在了思考过程里，
 *   最后 `content` 是空的，于是这一轮没有观察、她什么都看不见。
 *
 * 修法（`vision.ts` 的 `analyzeScene`）：空内容且这次带了终端文本时**退一步重试一次** ——
 * 不带终端文本、放宽到 700 token、并要求"只输出 JSON、不要思考过程"。
 *
 * 这个探针用**本地假模型**把这条路径钉死（不需要真的密钥）：
 *   第 1 次请求 → 故意回空内容（`choices[0].message.content = ""`）
 *   第 2 次请求 → 回合法 JSON
 * 断言：① 真的发生了 2 次请求；② 第 1 次请求体里**有**终端文本；③ 第 2 次请求体里**没有**
 * 终端文本且 `max_tokens` 变大了；④ 这一轮最终**产出了观察**（`lastObservation !== null`）。
 *
 * ⚠️ 前置条件：前台必须是终端（否则根本不会有终端文本，这条路径不触发）。
 * 探针会先把 Windows Terminal 置为前台 —— `SetForegroundWindow` 会被 Windows 的前台锁
 * 拒掉，所以补了"先模拟一次 ALT 按键"的经典绕法（不注入、不改窗口内容）。
 *
 * 用法：npx electron tools/probe-scene-retry.cjs
 * 输出：build/scene-retry.json
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'scene-retry.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-scene-retry');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VALID_ANSWER = JSON.stringify({
  scene: 'terminal',
  app: 'Windows Terminal',
  activity: '在跑一个探针脚本',
  url: '',
  browserChrome: false,
  editorChrome: false,
  sensitive: false,
  focus: 'deep',
  suggestion: '',
});

const requests = [];

function startFakeModel() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (error) { parsed = { raw: body.slice(0, 500) }; }
        const index = requests.length;
        requests.push(parsed);
        const isEmpty = index === 0;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          // 第 1 次故意回空内容（就是真机上那次的形状），第 2 次才给合法 JSON
          choices: [{ message: { role: 'assistant', content: isEmpty ? '' : VALID_ANSWER } }],
          usage: { prompt_tokens: 1200, completion_tokens: isEmpty ? 360 : 40, total_tokens: isEmpty ? 1560 : 1240 },
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
public class PetFg3 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
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
[void][PetFg3]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 250
if ([PetFg3]::GetForegroundWindow() -ne $handle) {
  [PetFg3]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [void][PetFg3]::SetForegroundWindow($handle)
  [PetFg3]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 400
}
'{"ok":true}'
`;

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolve({ error: error ? String(error.message) : '', stdout: typeof stdout === 'string' ? stdout.trim() : '' }));
  });
}

/** 第 N 次请求里有没有"终端输出开始"那段、以及 max_tokens 是多少。 */
function describeRequest(request) {
  let text = '';
  for (const message of request.messages || []) {
    if (typeof message.content === 'string') { text += message.content; continue; }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'text' && typeof part.text === 'string') text += part.text + '\n';
    }
  }
  return {
    hasTerminalText: text.includes('=== 终端输出开始'),
    hasNoThinkingInstruction: text.includes('不要思考过程'),
    maxTokens: request.max_tokens,
    promptChars: text.length,
  };
}

app.whenReady().then(async () => {
  const { server, port } = await startFakeModel();
  await wait(6000);
  const petWin = BrowserWindow.getAllWindows()[0];
  if (!petWin) throw new Error('桌宠窗口不存在');
  const run = (js) => petWin.webContents.executeJavaScript(js, true);

  const activation = await runPowerShell(ACTIVATE_SCRIPT);
  await wait(600);

  const status = await run(`(async () => {
    await window.petAPI.ai.setSettings({
      enabled: true, chat: true,
      provider: { baseUrl: 'http://127.0.0.1:${port}/v1', model: 'probe-retry', apiKey: 'sk-probe-retry-0001', timeoutMs: 5000 },
    });
    // 窗口快照 TTL 调短，好让 sampleNow 立刻做一次**新鲜的**窗口枚举
    // （默认 25s 会复用"刚才那个前台窗口"，实测踩到过）
    await window.petAPI.perception.setSettings({
      screen: true, windowContext: true, terminalText: true, privacyMode: false, windowProbeTtlMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 6000));
    // 走**周期采样**那条路（analyzeScene），它才是用户日志里失败的那条
    await window.petAPI.perception.sampleNow();
    const after = await window.petAPI.perception.status();
    await window.petAPI.ai.setSettings({ clearApiKey: true });
    await window.petAPI.perception.setSettings({ windowProbeTtlMs: 25000 });
    return {
      foreground: after.windowContext.foregroundProcess,
      terminalState: after.terminalText,
      lastObservation: after.lastObservation,
      lastError: after.lastError,
    };
  })()`);

  const described = requests.map(describeRequest);
  const result = {
    activation,
    foregroundProcess: status.foreground,
    terminalState: status.terminalState,
    requestCount: requests.length,
    requests: described,
    observationProduced: status.lastObservation !== null,
    observationScene: status.lastObservation ? status.lastObservation.scene : null,
    lastError: status.lastError,
    verdict: {
      twoRequests: requests.length === 2,
      firstHadTerminalText: Boolean(described[0] && described[0].hasTerminalText),
      secondWithoutTerminalText: Boolean(described[1] && !described[1].hasTerminalText && described[1].hasNoThinkingInstruction),
      budgetRaised: Boolean(described[1] && described[1].maxTokens === 700),
      observationProduced: status.lastObservation !== null,
    },
  };
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('[result]', JSON.stringify(result, null, 1));
  server.close();
  const ok = Object.values(result.verdict).every(Boolean);
  app.exit(ok ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
