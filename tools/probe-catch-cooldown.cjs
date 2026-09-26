// @ts-check
/**
 * 探针：**鼠标靠近的"接住"动画真的有冷却吗**（真机、真光标）。
 *
 * 用户反馈："鼠标靠近的动画需要有一段时间的冷却，不能连续触发"。
 * 为什么会连续触发：`classifyApproach` 原来只要求"离开 210px 再回来"就重新武装，
 * 而手在桌面上划来划去一秒钟能进出好几个来回 —— 于是她一路 catch_down 停不下来。
 *
 * 这个探针用**真光标**（`SetCursorPos`，只移动不点击）做几轮
 * "走开 -> 靠近 -> 走开 -> 再靠近"，然后数日志里"真的触发了几次"：
 *   1. 第一次靠近：接住一次（t1）；
 *   2. 冷却窗口内再靠近两次：**一次都不该再接住**（这就是用户说的"不能连续触发"）；
 *   3. 冷却（60 秒）过去后再靠近：能接住第二次（冷却不是"永远不再演"），
 *      并且 t2 - t1 >= 60 秒。
 *
 * 为什么要真光标：`TriggerService` 读的是 `screen.getCursorScreenPoint()`，
 * 合成指针事件（renderer 里 dispatch 的那种）根本到不了这条路径 ——
 * 这条动画是"她感知到你靠近"，只有真鼠标能证明。探针结束会把光标放回原处。
 *
 * 为了让"数触发次数"这件事干净，本轮 AI 与感知开关全关（见下面两个设置文件）：
 * 日志里就只会有鼠标靠近这一条触发源。
 *
 * 用法：npx electron tools/probe-catch-cooldown.cjs
 * 输出：build/catch-cooldown.json
 */
const { app, screen, BrowserWindow } = require('electron');
const { execFile } = require('node:child_process');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'catch-cooldown.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-catch');
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

/* 隔离落盘位置（绝不动用户真实的 %APPDATA%\DesktopPet） */
app.setPath('userData', dataDir);
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;

/* 关掉其它触发源，只留鼠标靠近：AI 关（不会 offline/sad/hungry）、感知关（不会 work/read/remind） */
writeFileSync(join(dataDir, 'ai-settings.json'), JSON.stringify({
  enabled: false, chat: false, memory: false, emotion: false, diary: false,
}, null, 2), 'utf8');
writeFileSync(join(dataDir, 'perception-settings.json'), JSON.stringify({
  screen: false, behavior: false, camera: false, habits: false,
}, null, 2), 'utf8');

/* 收集日志：必须在 require main 之前劫持 */
const captured = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  try { captured.push(String(chunk)); } catch (error) { /* 忽略 */ }
  return originalWrite(chunk, ...rest);
};

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logText = () => captured.join('');

/** 已经"接住"了几次（TriggerService.fire 打的日志行）。 */
function catchCount(text = logText()) {
  return (text.match(/"animationId":"catch_(down|right)"/g) ?? []).length;
}

/**
 * 把真光标按一串 DIP 坐标挪动（每步之间等一会儿）。
 *
 * 坐标按 `scaleX/scaleY` 换算成 PowerShell 那边的坐标 —— 这两个系数由调用方
 * **实测标定**（见下面：挪到两个已知点、读回 Electron 的 `getCursorScreenPoint()`）。
 * 为什么要标定：PowerShell 5.1 是 DPI-unaware 进程，`Cursor.Position` 走的是
 * Windows 的虚拟化坐标；这台机器上实测它与 Electron 的 DIP 是 1:1
 * （要求 (1770,952) -> 实际夹到 (1535,863)，Electron 读回来也是 (1535,863)），
 * 但别的机器/DPI 设置未必一样 —— 标定一次比假设可靠。
 */
function moveCursor(steps, scaleX, scaleY) {
  /*
   * ⚠️ 函数名不能叫 `Move`：PowerShell 里 `Move` 是 `Move-Item` 的别名，
   * 而别名优先于函数 —— 实测那样写会变成"移动文件"，光标一动不动
   * （报错 `Cannot find path 'E:\ds_pet\300'`，而 exit code 还是 0）。
   */
  const body = steps
    .map(([x, y, ms]) => `SetCursorTo ${Math.round(x * scaleX)} ${Math.round(y * scaleY)}; Start-Sleep -Milliseconds ${ms}`)
    .join('; ');
  const script = "$ErrorActionPreference = 'Stop'; "
    + 'Add-Type -AssemblyName System.Windows.Forms; '
    + 'function SetCursorTo($x,$y){ [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point -ArgumentList $x,$y }; '
    + body;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: 90000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) { reject(new Error(`${error.message} ${String(stderr).slice(0, 200)}`)); return; }
        resolve(String(stdout));
      });
  });
}

app.whenReady().then(async () => {
  const result = { placements: [] };

  /* 0) 记住光标原位置（结束前放回去，别把用户的鼠标扔在角落） */
  const cursorHome = screen.getCursorScreenPoint();

  /* 1) 等宠物与触发服务就绪 */
  await wait(12000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('桌宠窗口不存在');

  const bounds = win.getBounds();
  // 宠物在窗口里水平居中：正常状态下窗口宽度≈宠物宽度，窗口中心就是宠物中心
  const petCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };

  /* 1b) 标定光标坐标系：挪到两个已知点，读回 Electron 看到的坐标 -> 得到换算系数 */
  await moveCursor([[200, 200, 250]], 1, 1);
  const calA = screen.getCursorScreenPoint();
  await moveCursor([[800, 600, 250]], 1, 1);
  const calB = screen.getCursorScreenPoint();
  const scaleX = calB.x === calA.x ? 1 : 600 / (calB.x - calA.x);
  const scaleY = calB.y === calA.y ? 1 : 400 / (calB.y - calA.y);
  result.calibration = { calA, calB, scaleX, scaleY };

  const inside = [petCenter.x, petCenter.y + 90, 900];        // 下方 90px（<150 半径、垂直占主导）
  const outside = [petCenter.x - 600, petCenter.y + 90, 600]; // 左边 600px（>210，重新武装）
  result.petCenter = petCenter;
  result.workArea = screen.getPrimaryDisplay().workArea;

  /**
   * 靠近一次：先走开（重新武装）再进入触发区，并**读回真实光标位置**核对几何
   * （不靠缩放换算猜：读回来是什么就是什么）。
   */
  async function approachOnce() {
    await moveCursor([outside, inside], scaleX, scaleY);
    const point = screen.getCursorScreenPoint();
    const dx = point.x - petCenter.x;
    const dy = point.y - petCenter.y;
    const placement = { at: Date.now(), dx: Math.round(dx), dy: Math.round(dy), distance: Math.round(Math.hypot(dx, dy)) };
    result.placements.push(placement);
    return placement;
  }

  /** 轮询等"接住次数"变化，返回变化发生的时刻（毫秒）与当时的次数。 */
  async function waitForCatch(baseline, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = catchCount();
      if (count > baseline) return { at: Date.now(), count };
      await wait(150);
    }
    return { at: null, count: catchCount() };
  }

  /* 2) 先把光标赶到远处：她启动时可能已经被"接住"过一次（用户鼠标本来就停在附近） */
  await moveCursor([[outside[0], outside[1], 1500]], scaleX, scaleY);
  const baseline = catchCount();
  result.baselineAtStartup = baseline;

  /* 3) 第一次靠近 -> 应当接住一次（并记下这次的时间 t1） */
  await approachOnce();
  const first = await waitForCatch(baseline, 6000);
  const t1 = first.at;
  result.first = { at: t1, count: first.count, caught: first.count === baseline + 1 };

  /* 4) 冷却窗口内再靠近两次 -> 一次都不该再接住（用户："不能连续触发"） */
  const cooldownAttemptsStart = Date.now();
  await approachOnce();
  await approachOnce();
  // 停在触发区里等一会儿：冷却中"站着不动"也不该补演
  await wait(3000);
  const afterCooldownAttempts = catchCount();
  result.duringCooldown = {
    attempts: 2,
    countBefore: first.count,
    countAfter: afterCooldownAttempts,
    elapsedMs: Date.now() - cooldownAttemptsStart,
    nextApproachOutsideRadius: (() => {
      const point = screen.getCursorScreenPoint();
      return Math.round(Math.hypot(point.x - petCenter.x, point.y - petCenter.y));
    })(),
  };

  /* 5) 把光标挪开，等冷却过去，再靠近一次 -> 应当接住第二次（t2 - t1 >= 60 秒） */
  await moveCursor([[outside[0], outside[1], 400]], scaleX, scaleY);
  const remaining = t1 === null ? 62000 : Math.max(0, t1 + 61500 - Date.now());
  await wait(remaining);
  const beforeSecond = catchCount();
  await approachOnce();
  const second = await waitForCatch(beforeSecond, 6000);
  const t2 = second.at;
  result.second = {
    at: t2,
    caught: second.count === beforeSecond + 1,
    gapMs: t1 !== null && t2 !== null ? t2 - t1 : null,
  };

  /* 6) 托盘日志里"画面上真演了"的序列（次要证据：不只触发了，还真演出来了） */
  const played = [];
  for (const match of logText().matchAll(/"current":"([^"]+)"/g)) {
    const id = match[1];
    if (id !== '(none)' && played[played.length - 1] !== id) played.push(id);
  }
  result.played = played;

  result.verdict = {
    // 真光标确实落在"下方 150px 内"（用读回来的坐标核对）
    cursorPlaced: result.placements.length >= 4 &&
      result.placements.every((item) => item.dy > 0 && item.distance < 150),
    // 第一次靠近：接住一次
    firstCatch: result.first.caught === true,
    // 冷却窗口内（约 10 秒）再靠近两次 + 站在附近 3 秒：次数一点不涨
    noCatchDuringCooldown: afterCooldownAttempts === first.count,
    // 冷却过去后再靠近：能接住第二次，且间隔 >= 60 秒
    catchAgainAfterCooldown:
      result.second.caught === true && typeof result.second.gapMs === 'number' && result.second.gapMs >= 60000,
    // 真的演出来了
    catchPlayed: played.includes('catch_down') || played.includes('catch_right'),
  };

  /* 光标放回原处 */
  await moveCursor([[cursorHome.x, cursorHome.y, 100]], scaleX, scaleY).catch(() => undefined);

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log(`\n[verdict] ${JSON.stringify(result.verdict, null, 1)}`);
  console.log(`[petCenter] ${JSON.stringify(petCenter)} calibration=${JSON.stringify(result.calibration)}`);
  console.log(`[placements] ${JSON.stringify(result.placements)}`);
  console.log(`[first] ${JSON.stringify(result.first)} duringCooldown=${JSON.stringify(result.duringCooldown)}`);
  console.log(`[second] ${JSON.stringify(result.second)}`);
  console.log(`[played] ${played.join(' -> ')}`);
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 240000);
