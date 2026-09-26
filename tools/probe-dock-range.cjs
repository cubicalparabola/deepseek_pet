// @ts-check
/**
 * 探针：**收起的触发范围**——是不是"必须推到最边上才收"（真机）。
 *
 * 用户反馈："调整把触发收起的范围再调一下，需要鼠标向右移到最右侧和最下方时才能触发"。
 * 原来阈值 24px：离屏幕边还有一段距离就先收起了，感觉像"我没拖到边上她自己贴上来了"。
 * 现在阈值 8px，这个探针用**真实的拖动结算路径**（`window.setPosition` + `dragEnd`
 * 就是主进程 `handleDragEnd()` 那条判定，拖动只是喂给它一个位置）量出结论：
 *
 *   1. 推到最边上（工作区外都行）-> 收起；
 *   2. 从贴边位置**往回挪 20px** 再松手 -> **不收起**（这就是用户抱怨的那一段）；
 *   3. 从贴边位置往回挪 4px 再松手 -> 仍然收起（阈值内还是算贴边）；
 *   4. 上/下边缘同理。
 *
 * 为什么用"挪动量"而不是直接算像素距离：窗口里宠物是水平居中的，
 * 但宠物宽度未必等于窗口宽度 —— 用"从贴边位置往回挪了多少"就不用去猜这层换算，
 * 而主进程判定用的就是挪完之后的位置。
 *
 * 用法：npx electron tools/probe-dock-range.cjs
 * 输出：build/dock-range.json
 */
const { app, BrowserWindow, screen } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'dock-range.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-dock-range');
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

/* 隔离落盘位置（绝不动用户真实的 %APPDATA%\DesktopPet） */
app.setPath('userData', dataDir);
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ai-settings.json'), JSON.stringify({ enabled: false }, null, 2), 'utf8');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  await wait(8000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('桌宠窗口不存在');
  const run = (js) => win.webContents.executeJavaScript(js, true);

  /* 关掉随机池与触发：位置判定不该被随机动画打扰 */
  await run(`(() => { window.petDebug.behaviors.pause(); window.petAPI.notifyBehaviorPaused(true); return true; })()`);

  const area = screen.getPrimaryDisplay().workArea;
  const result = { workArea: area };

  /** 把宠物摆到自由位置（避免上一次的状态影响这一次）。 */
  const resetFree = () => run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(${area.x + 400}, ${area.y + 240});
    await new Promise((r) => setTimeout(r, 400));
    await api.window.dragEnd();
    await new Promise((r) => setTimeout(r, 600));
    return window.petDebug.display().dock;
  })()`);

  /** 推到"最右侧/最下方"（给一个远超屏幕的坐标，主进程会夹到允许的极限）后松手。 */
  const pushToEdge = (x, y) => run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(${x}, ${y});
    await new Promise((r) => setTimeout(r, 500));
    await api.window.dragEnd();
    await new Promise((r) => setTimeout(r, 900));
    return { dock: window.petDebug.display().dock, pos: await api.window.getPosition() };
  })()`);

  /** 从当前位置往回挪 (dx, dy) 像素（负数 = 往左/往上 = 离开边缘）再松手。 */
  const releaseAfterNudge = (dx, dy) => run(`(async () => {
    const api = window.petAPI;
    const pos = await api.window.getPosition();
    await api.window.setPosition(pos.x + ${dx}, pos.y + ${dy});
    await new Promise((r) => setTimeout(r, 500));
    const before = window.petDebug.display().dock;
    const after = await api.window.dragEnd();
    await new Promise((r) => setTimeout(r, 700));
    return { dockBeforeRelease: before, dockAfterRelease: after.dock, pos: await api.window.getPosition() };
  })()`);

  /* ---------------- 右边缘 ---------------- */
  await resetFree();
  const rightDocked = await pushToEdge(999999, area.y + 240);
  result.rightDocked = rightDocked;
  result.rightNudge20 = await releaseAfterNudge(-20, 0);
  // 重新贴回去，再试"只往回挪 4px"
  result.rightRedocked = await pushToEdge(999999, area.y + 240);
  result.rightNudge4 = await releaseAfterNudge(-4, 0);

  /* ---------------- 下边缘 ---------------- */
  await resetFree();
  const bottomDocked = await pushToEdge(area.x + 500, 999999);
  result.bottomDocked = bottomDocked;
  result.bottomNudge20 = await releaseAfterNudge(0, -20);
  result.bottomRedocked = await pushToEdge(area.x + 500, 999999);
  result.bottomNudge4 = await releaseAfterNudge(0, -4);

  /* 回到自由位置，别把宠物留在边上 */
  await resetFree();

  result.verdict = {
    // 推到最边上 -> 收起
    pushRightDocks: result.rightDocked.dock === 'right',
    pushBottomDocks: result.bottomDocked.dock === 'bottom',
    // 离边 20px 松手 -> 不收起（用户反馈的那一段）
    twentyPxDoesNotDock:
      result.rightNudge20.dockAfterRelease === 'free' &&
      result.bottomNudge20.dockAfterRelease === 'free',
    // 离边 4px 松手 -> 仍然算贴边（阈值是 8px）
    fourPxStillDocks:
      result.rightNudge4.dockAfterRelease === 'right' &&
      result.bottomNudge4.dockAfterRelease === 'bottom',
    // 20px 那次在松手前仍然处于收起状态（说明确实只差"松手时的位置"这一条判定）
    nudgedWhileDocked: result.rightNudge20.dockBeforeRelease === 'right' &&
      result.bottomNudge20.dockBeforeRelease === 'bottom',
  };

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log(`\n[verdict] ${JSON.stringify(result.verdict, null, 1)}`);
  console.log(`[right] docked=${JSON.stringify(result.rightDocked)} nudge20=${JSON.stringify(result.rightNudge20)} nudge4=${JSON.stringify(result.rightNudge4)}`);
  console.log(`[bottom] docked=${JSON.stringify(result.bottomDocked)} nudge20=${JSON.stringify(result.bottomNudge20)} nudge4=${JSON.stringify(result.bottomNudge4)}`);
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
