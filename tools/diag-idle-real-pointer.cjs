// @ts-check
/**
 * 诊断：**真实指针事件**下 idle 阶段点击会不会卡住。
 *
 * 前面的诊断直接调 `handleIntent`，绕过了 `InteractionManager` 的
 * 指针判定（拖拽阈值、单击/双击区分、区域解析）。用户描述的是手感问题，
 * 必须走真实指针管线：用 `webContents.sendInputEvent` 注入
 * mouseDown/mouseUp（`InteractionManager` 明确支持合成事件）。
 *
 * 场景：
 *   A. idle 中单击一次（真实指针）
 *   B. idle 中快速连点 3 次（真实指针，间隔 120ms）—— 可能被判成双击
 *   C. idle 中连点 2 次（间隔 400ms，不构成双击）
 *
 * 用法：npx electron tools/diag-idle-real-pointer.cjs
 * 输出：build/idle-real-pointer.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'idle-real-pointer.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    writeFileSync(outFile, JSON.stringify({ fatal: 'no window' }), 'utf8');
    app.exit(1);
    return;
  }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`(() => {
    const bus = window.petDebug.bus;
    window.__ev = [];
    window.__subs = [
      bus.on('animation:start', (p) => window.__ev.push({ ms: Date.now(), t: 'start', id: p.animationId, reason: p.reason })),
      bus.on('animation:end', (p) => window.__ev.push({ ms: Date.now(), t: 'end', id: p.animationId, reason: p.reason, completed: p.completed })),
      bus.on('animation:rejected', (p) => window.__ev.push({ ms: Date.now(), t: 'rejected', id: p.animationId, rejection: p.rejection })),
      bus.on('pet:click', (p) => window.__ev.push({ ms: Date.now(), t: 'pet:click', region: p.region })),
      bus.on('pet:dblclick', (p) => window.__ev.push({ ms: Date.now(), t: 'pet:dblclick', region: p.region })),
      bus.on('pet:drag', () => window.__ev.push({ ms: Date.now(), t: 'pet:drag' })),
    ];
    window.__snap = () => {
      const a = window.petDebug.anim;
      const vids = Array.from(document.querySelectorAll('#pet-stage video'));
      return {
        animation: a.getCurrentAnimation(),
        state: window.petDebug.state.get(),
        vids: vids.map((v) => ({
          src: String(v.currentSrc || v.src || '').split('/').pop(),
          paused: v.paused,
          t: Number(v.currentTime.toFixed(2)),
          op: Number((Number(getComputedStyle(v).opacity) || 0).toFixed(2)),
        })),
      };
    };
    return true;
  })()`);

  const snap = () => js('window.__snap()');
  const isStuck = (s) => {
    const visible = s.vids.filter((v) => v.op > 0.02);
    if (visible.length === 0) return true;
    return visible.every((v) => v.paused);
  };

  /* 真实指针事件：命中舞台中心 */
  const rect = win.getContentBounds();
  const point = { x: Math.floor(rect.width / 2), y: Math.floor(rect.height / 2) };
  const realClick = async () => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await wait(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };

  const runScenario = async (name, steps) => {
    await js(`window.petDebug.anim.resetCooldowns(); window.petDebug.anim.stop('reset'); window.__ev.length = 0; true`);
    for (let i = 0; i < 60; i++) { await wait(100); const s = await snap(); if (s.animation === 'idle' && !isStuck(s)) break; }
    const start = await snap();
    const trace = [];
    let stuckSamples = 0;
    const record = async (tag) => {
      const s = await snap();
      const stuck = isStuck(s);
      if (stuck) stuckSamples += 1;
      trace.push({ tag, stuck, ...s });
    };

    for (const step of steps) {
      if (step.wait) await wait(step.wait);
      if (step.click) { await realClick(); await record(`真实点击 @${step.click}`); }
      if (step.sample) {
        const t0 = Date.now();
        while (Date.now() - t0 < step.sample) {
          await wait(120);
          const s = await snap();
          if (isStuck(s)) { stuckSamples += 1; trace.push({ tag: `采样 t+${Date.now() - t0}`, stuck: true, ...s }); }
        }
      }
    }
    const end = await snap();
    const events = await js('window.__ev');
    return { name, point, start, end, stuckSamples, trace, events };
  };

  const results = [];
  results.push(await runScenario('A: idle 中真实单击一次', [{ click: 1 }, { sample: 9000 }]));
  results.push(await runScenario('B: idle 中真实连点 x3（间隔 120ms）', [
    { click: 1 }, { wait: 120 }, { click: 2 }, { wait: 120 }, { click: 3 }, { sample: 9000 },
  ]));
  results.push(await runScenario('C: idle 中真实连点 x2（间隔 400ms）', [
    { click: 1 }, { wait: 400 }, { click: 2 }, { sample: 9000 },
  ]));

  await js('window.__subs.forEach((s) => s.unsubscribe()); true');
  writeFileSync(outFile, JSON.stringify({ results }, null, 1), 'utf8');

  console.log('=== 真实指针：idle 阶段点击 ===');
  for (const r of results) {
    console.log(`\n${r.name}  (点击点 ${r.point.x},${r.point.y})`);
    console.log(`  起点: anim=${r.start.animation} vids=[${r.start.vids.map((v) => `${v.src}:${v.paused ? 'paused' : 'playing'}:op${v.op}`).join(' ')}]`);
    console.log(`  卡住采样数=${r.stuckSamples}`);
    console.log(`  终点: anim=${r.end.animation} state=${r.end.state} vids=[${r.end.vids.map((v) => `${v.src}:${v.paused ? 'paused' : 'playing'}:op${v.op}`).join(' ')}]`);
    for (const t of r.trace) {
      console.log(`    ${t.stuck ? '[卡]' : '    '} ${t.tag}: anim=${t.animation} stage=${t.vids.map((v) => `${v.src}:${v.paused ? 'paused' : 'playing'}:op${v.op}`).join(' ')}`);
    }
    console.log('  事件:');
    for (const e of r.events) console.log(`    ${e.t} ${e.id ?? e.region ?? ''} ${e.reason ?? e.rejection ?? ''}${e.completed !== undefined ? ` completed=${e.completed}` : ''}`);
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 240000);
