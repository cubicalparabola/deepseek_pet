// @ts-check
/**
 * 探针：验证"窗口列表 + 最上层窗口"这两件事在 Windows 上到底能拿到什么。
 *
 * 需要回答三个问题（不测量就写代码等于赌）：
 *   A. `desktopCapturer.getSources({types:['window']})` 能否枚举出窗口标题？
 *   B. 它的**顺序**是不是 Z 序（第一个就是前台窗口）？——Chromium 用 EnumWindows，
 *      理论上是从上到下，但必须实测。
 *   C. 用 PowerShell 读 `GetForegroundWindow` 的标题/进程名是否可行、耗时多少？
 *
 * 用法：npx electron tools/probe-foreground-window.cjs
 * 输出：build/window-probe.json + 控制台摘要
 */
const { app, BrowserWindow, desktopCapturer } = require('electron');
const { execFile } = require('node:child_process');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'window-probe.json');
const { guardSingleInstance } = require('./lib/instance-guard.cjs');
const dataDir = join(tmpdir(), 'desktop-pet-probe-window');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
// 没有这一步：已有实例时 require(main.js) 会静默 app.quit()，探针"跑过了"是假象
guardSingleInstance(app, {
  onBlocked: (message) => {
    try { writeFileSync(outFile, JSON.stringify({ fatal: message }, null, 1), 'utf8'); } catch (error) { /* 忽略 */ }
  },
});
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用 PowerShell 读前台窗口（不需要原生模块，代价是一次进程启动 + Add-Type 编译）。 */
function readForeground() {
  const script = `
$ErrorActionPreference = 'Stop'
# 必须显式把输出编码设成 UTF-8：否则中文窗口标题会以 GBK 写进 stdout，
# Node 按 UTF-8 解码就得到一堆 U+FFFD（第一次探针就栽在这里）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [FgWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 1024
[void][FgWin]::GetWindowText($h, $sb, 1024)
$procId = [uint32]0
[void][FgWin]::GetWindowThreadProcessId($h, [ref]$procId)
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
$out = [ordered]@{ title = $sb.ToString(); process = if ($p) { $p.ProcessName } else { '' } }
$out | ConvertTo-Json -Compress
`;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 256 },
      (error, stdout, stderr) => {
        const elapsedMs = Date.now() - startedAt;
        if (error) {
          resolve({ ok: false, elapsedMs, error: String(error.message || error), stderr: String(stderr).slice(0, 200) });
          return;
        }
        try {
          resolve({ ok: true, elapsedMs, ...JSON.parse(String(stdout).trim()) });
        } catch (parseError) {
          resolve({ ok: false, elapsedMs, error: `parse: ${String(parseError)}`, stdout: String(stdout).slice(0, 200) });
        }
      },
    );
  });
}

app.whenReady().then(async () => {
  await wait(6000);

  /* A/B：窗口列表与顺序 */
  const listStarted = Date.now();
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
  const listElapsed = Date.now() - listStarted;
  const windows = sources.slice(0, 15).map((source, index) => ({
    index,
    id: source.id,
    name: source.name,
    emptyThumb: source.thumbnail.isEmpty(),
  }));

  /* C：PowerShell 前台窗口（跑两次看耗时是否稳定） */
  const fg1 = await readForeground();
  await wait(400);
  const fg2 = await readForeground();

  /* 判定：前台标题在列表里的位置 */
  const norm = (value) => String(value ?? '').trim().toLowerCase();
  const fgTitle = norm(fg2.ok ? fg2.title : '');
  const matchIndex = fgTitle === '' ? -1 : windows.findIndex((item) => norm(item.name) === fgTitle);
  const fuzzyIndex = fgTitle === '' ? -1 : windows.findIndex((item) => norm(item.name).includes(fgTitle) || fgTitle.includes(norm(item.name)));

  const report = {
    windowCount: sources.length,
    listElapsedMs: listElapsed,
    windows,
    foreground: { first: fg1, second: fg2 },
    verdict: {
      /** 前台标题与列表第一项完全相同？ */
      foregroundIsFirst: matchIndex === 0,
      exactIndex: matchIndex,
      fuzzyIndex,
      listOrderLooksZOrder: matchIndex === 0 || fuzzyIndex === 0,
    },
  };

  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');
  console.log(`窗口数=${sources.length}（枚举耗时 ${listElapsed}ms）`);
  console.log(`PowerShell 前台读取：第一次 ${fg1.elapsedMs}ms（ok=${fg1.ok}） 第二次 ${fg2.elapsedMs}ms（ok=${fg2.ok}）`);
  console.log(`PowerShell 读到：title="${fg2.title ?? ''}" process="${fg2.process ?? ''}"`);
  console.log('前 8 个窗口（按 desktopCapturer 返回顺序）：');
  for (const item of windows.slice(0, 8)) console.log(`  [${item.index}] ${item.name}`);
  console.log(`判定：前台 == 列表第一项？ ${report.verdict.foregroundIsFirst}（exact=${matchIndex} fuzzy=${fuzzyIndex}）`);
  console.log(`输出：${outFile}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
