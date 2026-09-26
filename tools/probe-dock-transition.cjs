// @ts-check
/**
 * 探针：**收起状态的稳态与"离开收起"的过渡**（需求：收起时点击先播 end 再播 idle）。
 *
 * 为什么要单独一个探针：`diag-anim-system` 只在"点一下"这一条路径上取样，
 * 而用户看到的问题是**稳态**（右侧收起时 end 反复播）与**另一条离开路径**
 * （拖动离开边缘）—— 那两条都要把"每一帧在播哪一段"按时间记下来才看得清。
 *
 * 输出：build/dock-transition.json
 *   steadyRight  右侧收起后 8 秒内实际播过的素材序列（end 出现多次 = 反复播收尾）
 *   clickUndock  点击展开后 12 秒内序列
 *   dragUndock   拖离边缘展开后 12 秒内序列
 *   steadyBottom 下方收起后的序列 + 点击展开后的序列
 *
 * 用法：npx electron tools/probe-dock-transition.cjs
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'dock-transition.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-dock');
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

  // 关掉随机池与触发（否则样本里会混进随机动画，看不出稳态）
  await run(`(() => { window.petDebug.behaviors.pause(); window.petAPI.notifyBehaviorPaused(true); return true; })()`);

  /** 采样：每 120ms 记一次"当前动画 + 阶段 + 实际素材"。 */
  const sampler = `(async (ms) => {
    const anim = window.petDebug.anim;
    const samples = [];
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < ms) {
      const source = String(anim.getActiveSource() || '').split('/').pop();
      const frame = [anim.getCurrentAnimation(), anim.getPersistentPhase() || '-', source].join('|');
      if (frame !== last) { samples.push({ at: Date.now() - t0, frame }); last = frame; }
      await new Promise((r) => setTimeout(r, 120));
    }
    return samples;
  })`;

  const result = {};

  /* ---------------- 1) 右侧收起：稳态 -> 点击展开 ---------------- */
  await run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(400, 240);
    await new Promise((r) => setTimeout(r, 300));
    await api.window.dragEnd();
    await api.window.setPosition(100000, 100000);
    await new Promise((r) => setTimeout(r, 400));
    return (await api.window.dragEnd()).dock;
  })()`);
  result.steadyRight = await run(`${sampler}(8000)`);
  await run(`window.petDebug.click('head', 0.5, 0.4)`);
  result.clickUndock = await run(`${sampler}(12000)`);

  /* ---------------- 2) 右侧收起：拖离边缘展开 ---------------- */
  await run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(400, 240);
    await new Promise((r) => setTimeout(r, 300));
    await api.window.dragEnd();
    await api.window.setPosition(100000, 100000);
    await new Promise((r) => setTimeout(r, 400));
    return (await api.window.dragEnd()).dock;
  })()`);
  await wait(2500);
  await run(`(async () => {
    const api = window.petAPI;
    const pos = await api.window.getPosition();
    await api.window.setPosition(pos.x - 300, pos.y - 200);
    await new Promise((r) => setTimeout(r, 600));
    return (await api.window.dragEnd()).dock;
  })()`);
  result.dragUndock = await run(`${sampler}(12000)`);

  /* ---------------- 2b) 右侧收起：**真实拖拽**（合成指针事件）到边缘 ---------------- */
  await run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(400, 240);
    await new Promise((r) => setTimeout(r, 300));
    await api.window.dragEnd();
    return true;
  })()`);
  await wait(800);
  const realDrag = await run(`(async () => {
    const stage = document.getElementById('pet-stage');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const rect = stage.getBoundingClientRect();
    const startX = Math.round(rect.left + rect.width / 2);
    const startY = Math.round(rect.top + rect.height / 2);
    const expect = (type) => (type === 'pointerdown' ? stage : window);
    const fire = (type, sx, sy) => expect(type).dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, button: 0, pointerId: 77, isPrimary: true,
      clientX: sx, clientY: sy, screenX: sx, screenY: sy,
    }));
    fire('pointerdown', startX, startY);
    // 一步步往屏幕右侧推（每次 40px，超过 5px 阈值即判定为拖动）
    for (let step = 1; step <= 30; step += 1) {
      fire('pointermove', startX + step * 40, startY);
      await wait(20);
    }
    fire('pointerup', startX + 30 * 40, startY);
    await wait(400);
    return window.petDebug.display();
  })()`);
  result.realDrag = realDrag;
  result.realDragSteady = await run(`${sampler}(15000)`);
  result.realDragClick = await (async () => {
    await run(`window.petDebug.click('head', 0.5, 0.4)`);
    return run(`${sampler}(12000)`);
  })();

  /* ---------------- 3) 下方收起：稳态 -> 点击展开 ---------------- */  const bottomDock = await run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(400, 240);
    await new Promise((r) => setTimeout(r, 300));
    await api.window.dragEnd();
    await api.window.setPosition(500, 100000);
    await new Promise((r) => setTimeout(r, 400));
    return (await api.window.dragEnd()).dock;
  })()`);
  result.bottomDock = bottomDock;
  result.steadyBottom = await run(`${sampler}(6000)`);
  await run(`window.petDebug.click('head', 0.5, 0.4)`);
  result.clickUndockBottom = await run(`${sampler}(9000)`);

  // 判定：稳态里 end 素材出现几次
  const countEnd = (samples) => samples.filter((s) => s.frame.includes('-end')).length;
  result.verdict = {
    // 右侧稳态**不该**出现 watch-end（那是收尾段，只在离开收起时播一次）
    steadyRightNoEnd: countEnd(result.steadyRight) === 0,
    // 点击展开：先 watch-end 再 idle
    clickPlaysEndBeforeIdle:
      countEnd(result.clickUndock) === 1 &&
      result.clickUndock.some((s) => s.frame.startsWith('idle|')),
    // 拖离展开同样先 end 再 idle
    dragPlaysEndBeforeIdle:
      countEnd(result.dragUndock) === 1 &&
      result.dragUndock.some((s) => s.frame.startsWith('idle|')),
    // 下方收起的默认姿势现在是 **sleep**（躺下睡觉）：稳态应看到 sleep-loop
    bottomSteadyIsSleep: result.steadyBottom.some((s) => s.frame.includes('sleep-loop.webm')),
    bottomPlaysEnd: countEnd(result.clickUndockBottom) > 0,
    // 真实拖拽到右边缘后：稳态不该反复播 end
    realDragSteadyNoEnd: countEnd(result.realDragSteady) === 0,
    realDragClickPlaysEndOnce: countEnd(result.realDragClick) === 1,
  };

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log(JSON.stringify(result.verdict, null, 1));
  const show = (name) => console.log(`\n[${name}]`, result[name].map((s) => `${s.at}ms ${s.frame}`).join('\n  '));
  show('steadyRight');
  show('clickUndock');
  show('dragUndock');
  console.log('\n[realDrag display]', JSON.stringify(result.realDrag));
  show('realDragSteady');
  show('realDragClick');
  show('steadyBottom');
  show('clickUndockBottom');
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
