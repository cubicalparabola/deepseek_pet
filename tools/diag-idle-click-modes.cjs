// @ts-check
/**
 * 诊断：**idle 阶段反复点击** 的几种形态，找"卡住"的复现条件。
 *
 * 单次点击已确认正常（stroke 播满 6.04s -> 回 idle）。
 * 本脚本测：
 *   A. 快速连点 3 次（同一区域，间隔 150ms）—— 冷却期内的点击会怎样
 *   B. 点击不同区域（head -> face -> body -> tail）
 *   C. 慢速连点（每次等 idle 回来再点，间隔 7s）
 *   D. 点击后等冷却转完再点
 *
 * 每个场景都检查：是否出现"没有动画在播 且 可见缓冲不动"。
 *
 * 用法：npx electron tools/diag-idle-click-modes.cjs
 * 输出：build/idle-click-modes.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'idle-click-modes.json');

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
      bus.on('animation:error', (p) => window.__ev.push({ ms: Date.now(), t: 'error', id: p.animationId, message: p.message })),
    ];
    window.__click = (region) => window.petApp.handleIntent({
      kind: 'click', region,
      payload: { button: 'left', x: 100, y: 100, nx: 0.5, ny: 0.5, region, detail: 1 },
    });
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

  /** 判断"卡住"：可见缓冲存在但全 paused，或者根本没有可见缓冲 */
  const isStuck = (s) => {
    const visible = s.vids.filter((v) => v.op > 0.02);
    if (visible.length === 0) return true;
    return visible.every((v) => v.paused);
  };

  const runScenario = async (name, actions) => {
    await js(`window.petDebug.anim.resetCooldowns(); window.petDebug.anim.stop('reset'); window.__ev.length = 0; true`);
    /* 等回到 idle 循环 */
    for (let i = 0; i < 60; i++) { await wait(100); const s = await snap(); if (s.animation === 'idle' && !isStuck(s)) break; }
    const start = await snap();

    const trace = [];
    let stuckSamples = 0;
    const record = async (tag) => {
      const s = await snap();
      const stuck = isStuck(s);
      if (stuck) stuckSamples += 1;
      trace.push({ tag, stuck, ...s });
      return s;
    };
    await record('起点');

    for (const step of actions) {
      if (step.wait) { await wait(step.wait); }
      if (step.region) { await js(`window.__click(${JSON.stringify(step.region)})`); await record(`点击 ${step.region}`); }
      if (step.sample) {
        const t0 = Date.now();
        while (Date.now() - t0 < step.sample) {
          await wait(150);
          const s = await snap();
          if (isStuck(s)) { stuckSamples += 1; trace.push({ tag: `采样 t+${Date.now() - t0}`, stuck: true, ...s }); }
        }
      }
    }
    const end = await snap();
    const events = await js('window.__ev');
    return { name, start, end, stuckSamples, trace, events };
  };

  const results = [];

  results.push(await runScenario('A: 快速连点 body x3（间隔 150ms）', [
    { region: 'body' }, { wait: 150 }, { region: 'body' }, { wait: 150 }, { region: 'body' },
    { sample: 9000 },
  ]));

  results.push(await runScenario('B: 依次点击不同区域 head/face/body/tail', [
    { region: 'head' }, { wait: 600 }, { region: 'face' }, { wait: 600 },
    { region: 'body' }, { wait: 600 }, { region: 'tail' },
    { sample: 9000 },
  ]));

  results.push(await runScenario('C: 慢速连点（等 idle 回来再点）x2', [
    { region: 'body' }, { sample: 8000 }, { region: 'body' }, { sample: 8000 },
  ]));

  results.push(await runScenario('D: 冷却转完再点（间隔 5s）x2', [
    { region: 'body' }, { wait: 5000 }, { region: 'body' }, { sample: 9000 },
  ]));

  await js('window.__subs.forEach((s) => s.unsubscribe()); true');
  writeFileSync(outFile, JSON.stringify({ results }, null, 1), 'utf8');

  console.log('=== idle 阶段反复点击 ===');
  for (const r of results) {
    console.log(`\n${r.name}`);
    console.log(`  起点: anim=${r.start.animation} state=${r.start.state} vids=[${r.start.vids.map((v) => `${v.src}:${v.paused ? 'paused' : 'playing'}:op${v.op}`).join(' ')}]`);
    console.log(`  卡住采样数=${r.stuckSamples}`);
    console.log(`  终点: anim=${r.end.animation} state=${r.end.state} vids=[${r.end.vids.map((v) => `${v.src}:${v.paused ? 'paused' : 'playing'}:op${v.op}`).join(' ')}]`);
    for (const t of r.trace) {
      if (t.stuck) console.log(`    [卡] ${t.tag}: anim=${t.animation} vids=[${t.vids.map((v) => `${v.src}:${v.paused ? 'paused' : 'playing'}:op${v.op}`).join(' ')}]`);
    }
    console.log('  事件:');
    for (const e of r.events) console.log(`    ${e.t} ${e.id} ${e.reason ?? e.rejection ?? e.message ?? ''}${e.completed !== undefined ? ` completed=${e.completed}` : ''}`);
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 240000);
