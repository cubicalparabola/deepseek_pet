// @ts-check
/**
 * 探针：**展开时"播 end 不动位置"** + **watch 的渲染向右偏移**。
 *
 * 两件事都是用户看着画面提的，所以这里既查数值、也**存图**给人眼确认：
 *
 *   1. 播 end 时窗口不许动：收起 -> 点击展开 -> 记录 end 段期间与之后的窗口位置，
 *      要求 "end 期间位置 == 收起时的位置"，且之后才挪回收起前的位置。
 *   2. watch 的渲染偏移：收起右侧后截图（`build/watch-offset.png`），
 *      并把 `render.offsetXPercent` 读出来一起写进结果。
 *
 * 用法：npx electron tools/probe-end-and-offset.cjs
 * 输出：build/end-offset.json + build/watch-offset.png
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'end-offset.json');
const shotFile = join(root, 'build', 'watch-offset.png');
const dataDir = join(tmpdir(), 'desktop-pet-probe-end-offset');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('桌宠窗口不存在');
  const run = (js) => win.webContents.executeJavaScript(js, true);

  await run(`(() => { window.petDebug.behaviors.pause(); window.petAPI.notifyBehaviorPaused(true); return true; })()`);

  /* ---------- 1) 收起 -> 点击展开：end 段期间窗口不许动 ---------- */
  const undock = await run(`(async () => {
    const api = window.petAPI;
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const pos = () => api.window.getPosition();
    const settle = async (expected) => {
      for (let i = 0; i < 25; i += 1) {
        if (window.petDebug.display().dock === expected) break;
        await wait(100);
      }
      return window.petDebug.display().dock;
    };

    // 先从"自由位置"出发，再贴到右边缘
    await api.window.setPosition(500, 300);
    await wait(400);
    await api.window.dragEnd();
    await settle('free');
    await api.window.setPosition(100000, 100000);
    await wait(400);
    await api.window.dragEnd();
    await settle('right');
    await wait(1500);
    const posDocked = await pos();

    // 点一下（真实点击路径）-> 会先播 end，再回 idle
    window.petDebug.click('head', 0.5, 0.4);
    const samples = [];
    const t0 = Date.now();
    let idleAt = null;
    while (Date.now() - t0 < 20000) {
      await wait(100);
      const current = anim.getCurrentAnimation();
      const phase = anim.getPersistentPhase() || '-';
      const at = await pos();
      samples.push({ ms: Date.now() - t0, animation: current, phase, x: at.x, y: at.y });
      if (current === 'idle' && idleAt === null) idleAt = Date.now() - t0;
      if (idleAt !== null && Date.now() - t0 > idleAt + 1200) break;
    }
    const movingSamples = samples.filter((s) => s.phase === 'end' && (s.x !== posDocked.x || s.y !== posDocked.y));
    return {
      posDocked,
      endSamples: samples.filter((s) => s.phase === 'end').length,
      movedDuringEnd: movingSamples.length,
      firstMovedAt: movingSamples[0] ?? null,
      finalPosition: await pos(),
      idleAt,
      dock: window.petDebug.display().dock,
      sequence: samples.filter((s, i) => i === 0 || s.animation !== samples[i - 1].animation || s.phase !== samples[i - 1].phase)
        .map((s) => s.ms + 'ms ' + s.animation + '|' + s.phase + ' @' + s.x + ',' + s.y),
    };
  })()`);

  /* ---------- 2) watch 的渲染偏移：截图 + 读清单 ---------- */
  const offset = await run(`(async () => {
    const api = window.petAPI;
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await api.window.setPosition(100000, 100000);
    await wait(400);
    await api.window.dragEnd();
    for (let i = 0; i < 25 && window.petDebug.display().dock !== 'right'; i += 1) await wait(100);
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i += 1) await wait(100);
    const video = document.querySelector('video.layer-active') || document.getElementById('pet-video');
    return {
      animation: anim.getCurrentAnimation(),
      phase: anim.getPersistentPhase(),
      offsetXPercent: anim.getDefinition('watch').render?.offsetXPercent ?? null,
      inlineTransform: video ? video.style.transform : null,
      dock: window.petDebug.display().dock,
    };
  })()`);
  const image = await win.capturePage();
  writeFileSync(shotFile, image.toPNG());

  /*
   * 再抓几张不同偏移的图（只覆盖行内 transform，**不改配置**），
   * 方便人眼挑"再向右一点"到底要多少：build/watch-offset-<n>.png
   * （配置现在用的是 12%；18% 一起出一张，用户想再往右就有直接的对照图）
   */
  const shots = {};
  for (const percent of [0, 6, 12, 18]) {
    await run(`(() => {
      for (const v of document.querySelectorAll('video')) v.style.transform = 'translate(${percent}%, 0%)';
      return true;
    })()`);
    await wait(400);
    const shot = await win.capturePage();
    const file = join(root, 'build', `watch-offset-${percent}.png`);
    writeFileSync(file, shot.toPNG());
    shots[percent] = file;
  }

  const result = {
    undock,
    offset,
    verdict: {
      // end 段里窗口一次都不能动
      noMoveDuringEnd: undock.movedDuringEnd === 0 && undock.endSamples > 0,
      // 展开后确实回到了收起前的位置（500,300 附近）
      movedAfterEnd: Math.abs(undock.finalPosition.x - 500) < 40 && Math.abs(undock.finalPosition.y - 300) < 40,
      // watch 的渲染偏移生效（清单 + 行内 transform 两处都要有）
      watchOffsetApplied:
        typeof offset.offsetXPercent === 'number' &&
        offset.offsetXPercent > 0 &&
        typeof offset.inlineTransform === 'string' &&
        offset.inlineTransform.includes('translate'),
    },
  };

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log(JSON.stringify(result.verdict, null, 1));
  console.log('\n[undock]', JSON.stringify({ posDocked: undock.posDocked, endSamples: undock.endSamples, movedDuringEnd: undock.movedDuringEnd, finalPosition: undock.finalPosition, idleAt: undock.idleAt }, null, 1));
  console.log(undock.sequence.join('\n'));
  console.log('\n[offset]', JSON.stringify(offset));
  console.log('[shot]', shotFile);
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
