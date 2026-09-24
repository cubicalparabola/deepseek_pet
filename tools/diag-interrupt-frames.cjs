// @ts-check
/**
 * 诊断：**打断立刻进 end 段 / end 段被打断立刻收干净** 这两条新行为的帧级副作用。
 *
 * 逻辑改对了不代表画面没问题：把收尾段提前到"循环段中途"，以及让收尾段被
 * 硬切断，都可能露出空帧或让剪辑显得突兀。本脚本逐帧记录可见性 + 时间线，
 * 覆盖三条路径：
 *   A. loop 中途 endPersistent  -> 立刻进 end（测量延迟、有无空帧、end 段是否真播）
 *   B. end 段中途 endPersistent -> 立刻收干净回 idle（测量回 idle 延迟、有无空帧）
 *   C. start 段中途 endPersistent -> 立刻进 end（最激进的边界：开场还在加载）
 *
 * 用法：npx electron tools/diag-interrupt-frames.cjs
 * 输出：build/interrupt-frames.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'interrupt-frames.json');

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
      bus.on('animation:loop-cycle', (p) => window.__ev.push({ ms: Date.now(), t: 'cycle', id: p.animationId, cycle: p.cycle })),
    ];
    /* 逐帧记录：可见层不透明度 + 当前段素材 + 相位 */
    window.__frames = [];
    window.__rec = false;
    const tick = () => {
      if (window.__rec) {
        const vids = Array.from(document.querySelectorAll('#pet-stage video'));
        let maxOp = 0; let src = '';
        for (const v of vids) {
          const op = Number(getComputedStyle(v).opacity) || 0;
          if (op > maxOp) { maxOp = op; src = String(v.currentSrc || v.src || '').split('/').pop(); }
        }
        window.__frames.push({
          hw: performance.now(),
          op: Number(maxOp.toFixed(3)),
          src,
          anim: window.petDebug.anim.getCurrentAnimation(),
          phase: window.petDebug.anim.getPersistentPhase(),
        });
      }
      window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
    return true;
  })()`);

  const snap = () =>
    js(`(() => { const a = window.petDebug.anim; return { animation: a.getCurrentAnimation(), phase: a.getPersistentPhase(), source: a.getActiveSource() }; })()`);

  /** 跑一次场景，返回逐帧分析。 */
  const scenario = async (name, setup) => {
    await js(`(() => { window.petDebug.anim.resetCooldowns(); window.petDebug.anim.stop('scenario-reset'); window.__ev.length = 0; window.__frames.length = 0; window.__rec = true; return true; })()`);
    await wait(400);
    const result = await setup();
    await wait(2000);
    await js('window.__rec = false; true');
    const frames = await js('window.__frames');
    const events = await js('window.__ev');

    /* 空帧统计：不透明度 < 0.02 的帧 */
    const blanks = frames.filter((f) => f.op < 0.02);
    /* 每次素材切换的位置，用于看剪辑是否突变 */
    const switches = [];
    let prevSrc = '';
    for (const f of frames) {
      if (f.src && f.src !== prevSrc) {
        switches.push({ hw: Number(f.hw.toFixed(0)), from: prevSrc, to: f.src });
        prevSrc = f.src;
      }
    }
    return { name, frames: frames.length, blankFrames: blanks.length, blankSample: blanks.slice(0, 5), switches, events, result };
  };

  const runs = [];

  /* A. loop 中途打断 -> 立刻进 end */
  runs.push(await scenario('A: loop 中途打断 -> 立刻 end', async () => {
    await js(`window.petDebug.anim.play('watch', { interrupt: 'force', reason: 'diag-A' })`);
    for (let i = 0; i < 40; i++) { await wait(100); if ((await snap()).phase === 'loop') break; }
    await wait(600);                       // 让循环段播一会儿，确保不是刚切进去
    const before = await snap();
    const t0 = Date.now();
    const accepted = await js(`window.petDebug.anim.endPersistent('diag-A-end')`);
    const after = await snap();
    return { before, accepted, enterEndLatencyMs: Date.now() - t0, after };
  }));

  /* B. end 段中途打断 -> 立刻收干净回 idle */
  runs.push(await scenario('B: end 中途打断 -> 立刻回 idle', async () => {
    await js(`window.petDebug.anim.play('watch', { interrupt: 'force', reason: 'diag-B' })`);
    for (let i = 0; i < 40; i++) { await wait(100); if ((await snap()).phase === 'loop') break; }
    await js(`window.petDebug.anim.endPersistent('diag-B-step1')`);
    for (let i = 0; i < 40; i++) { await wait(50); if ((await snap()).phase === 'end') break; }
    await wait(1200);                      // 收尾段播到中途（end 段 4.4s）
    const before = await snap();
    const t0 = Date.now();
    const accepted = await js(`window.petDebug.anim.endPersistent('diag-B-step2')`);
    const after = await snap();
    /* 等回 idle */
    let backToIdleMs = null;
    while (Date.now() - t0 < 8000) {
      await wait(50);
      const s = await snap();
      if (s.animation === 'idle') { backToIdleMs = Date.now() - t0; break; }
    }
    return { before, accepted, immediatePhase: after.phase, immediateAnimation: after.animation, backToIdleMs };
  }));

  /* C. start 段中途打断 -> 立刻进 end（最激进边界） */
  runs.push(await scenario('C: start 中途打断 -> 立刻 end', async () => {
    await js(`window.petDebug.anim.play('watch', { interrupt: 'force', reason: 'diag-C' })`);
    await wait(120);                       // 故意很短：此时还在 start 段
    const before = await snap();
    const t0 = Date.now();
    const accepted = await js(`window.petDebug.anim.endPersistent('diag-C-end')`);
    const after = await snap();
    return { before, accepted, enterEndLatencyMs: Date.now() - t0, after };
  }));

  await js('window.__subs.forEach((s) => s.unsubscribe()); cancelAnimationFrame(window.__raf); true');
  writeFileSync(outFile, JSON.stringify({ runs }, null, 1), 'utf8');

  console.log('=== 打断新行为的帧级验证 ===');
  for (const r of runs) {
    console.log(`\n${r.name}`);
    console.log(`  帧数=${r.frames} 空帧(不透明度<0.02)=${r.blankFrames}`);
    if (r.blankSample.length) console.log(`  空帧样例: ${JSON.stringify(r.blankSample)}`);
    console.log(`  结果: ${JSON.stringify(r.result)}`);
    console.log('  素材切换:');
    for (const s of r.switches) console.log(`    ${s.hw}ms ${s.from || '(none)'} -> ${s.to}`);
    console.log('  事件:');
    for (const e of r.events) console.log(`    ${e.t} ${e.id} reason=${e.reason}${e.completed !== undefined ? ` completed=${e.completed}` : ''}${e.cycle !== undefined ? ` cycle=${e.cycle}` : ''}`);
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 240000);
