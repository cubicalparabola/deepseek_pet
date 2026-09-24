// @ts-check
/**
 * 诊断：**点击持续动画 -> 先播收尾段 -> 再播点击反应**（真实点击入口 + 逐帧可见性）。
 *
 * 用户要求：loop 阶段点击人物不能直接回 idle 跳过 end 段，而应该先播 end。
 *
 * 覆盖：
 *   A. loop 阶段点击 -> 观察 phase 是否转 end、end 段素材是否真的出现、
 *      收尾后是否接上点击反应（body -> stroke）；全程逐帧看有没有空帧。
 *   B. 收尾段播到中途再点一次 -> 残局是否收敛（不能卡死在 watch 或空白）。
 *   C. 对照：bomb（priority 100）被点击 -> 立刻让位，不进 end 段。
 *
 * 用法：npx electron tools/diag-click-defer.cjs
 * 输出：build/click-defer.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'click-defer.json');

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
      bus.on('animation:loop-cycle', (p) => window.__ev.push({ ms: Date.now(), t: 'cycle', id: p.animationId, cycle: p.cycle })),
    ];
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
        window.__frames.push({ op: Number(maxOp.toFixed(3)), src, phase: window.petDebug.anim.getPersistentPhase(), anim: window.petDebug.anim.getCurrentAnimation() });
      }
      window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
    window.__click = (region) => window.petApp.handleIntent({
      kind: 'click', region,
      payload: { button: 'left', x: 100, y: 100, nx: 0.5, ny: 0.5, region, detail: 1 },
    });
    return true;
  })()`);

  const snap = () =>
    js(`(() => { const a = window.petDebug.anim; return { animation: a.getCurrentAnimation(), phase: a.getPersistentPhase(), source: a.getActiveSource() }; })()`);

  const scenario = async (name, fn) => {
    await js(`(() => { window.petDebug.anim.resetCooldowns(); window.petDebug.anim.stop('reset'); window.__ev.length = 0; window.__frames.length = 0; window.__rec = true; return true; })()`);
    await wait(400);
    const result = await fn();
    await wait(2000);
    await js('window.__rec = false; true');
    const frames = await js('window.__frames');
    const events = await js('window.__ev');
    const blanks = frames.filter((f) => f.op < 0.02);
    /* wasEnd：逐帧里是否出现过 end 段素材 */
    const sawEndSource = frames.some((f) => String(f.src).includes('-end'));
    const sources = [];
    let prev = '';
    for (const f of frames) {
      if (f.src && f.src !== prev) { sources.push(f.src); prev = f.src; }
    }
    return { name, frames: frames.length, blanks: blanks.length, sawEndSource, sources, result, events };
  };

  const runs = [];

  runs.push(await scenario('A: loop 阶段点击 body', async () => {
    await js(`window.petDebug.anim.play('watch', { interrupt: 'force', reason: 'diag-A' })`);
    for (let i = 0; i < 40; i++) { await wait(100); if ((await snap()).phase === 'loop') break; }
    await wait(600);
    const before = await snap();
    const t0 = Date.now();
    await js(`window.__click('body')`);
    /* 探针：看清楚"延后执行"这一步到底进没进队列、带的是什么仲裁参数 */
    await wait(300);
    const queued = await js(`(() => {
      const q = window.petDebug.anim.queue;
      return q ? { animationId: q.animationId, options: q.options } : null;
    })()`);
    let endAtMs = null;
    for (let i = 0; i < 100 && endAtMs === null; i++) {
      await wait(20);
      if ((await snap()).phase === 'end') endAtMs = Date.now() - t0;
    }
    /* 反应应该在收尾段播完后出现；给足时间（end 段约 4.4s） */
    const reaction = { at: null, ms: null };
    const t1 = Date.now();
    while (Date.now() - t1 < 12000) {
      await wait(100);
      const s = await snap();
      if (s.animation === 'stroke') { reaction.at = s.animation; reaction.ms = Date.now() - t1; break; }
    }
    const afterReaction = await snap();
    const queueLeft = await js(`(() => { const q = window.petDebug.anim.queue; return q ? q.animationId : null; })()`);
    return { before, queued, enterEndMs: endAtMs, reaction, afterReaction, queueLeft };
  }));
  runs.push(await scenario('B: 收尾段中途再点一次', async () => {
    await js(`window.petDebug.anim.play('watch', { interrupt: 'force', reason: 'diag-B' })`);
    for (let i = 0; i < 40; i++) { await wait(100); if ((await snap()).phase === 'loop') break; }
    await js(`window.__click('body')`);
    for (let i = 0; i < 100; i++) { await wait(20); if ((await snap()).phase === 'end') break; }
    await wait(1200);
    const before = await snap();
    await js(`window.__click('body')`);      // 收尾段中途再点
    await wait(300);
    const rightAfter = await snap();
    /* 收敛观察：最终必须回到有画面在播的状态 */
    let settled = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await wait(200);
      const s = await snap();
      if (s.animation !== null && s.animation !== 'watch' && s.phase === null) { settled = { animation: s.animation, ms: Date.now() - t0 }; break; }
    }
    return { before, rightAfter, settled };
  }));

  runs.push(await scenario('C: 对照 bomb(priority 100) 被点击', async () => {
    await js(`window.petDebug.anim.play('bomb', { interrupt: 'force', reason: 'diag-C', bypassCooldown: true })`);
    await wait(500);
    const before = await snap();
    await js(`window.__click('body')`);
    await wait(500);
    return { before, after: await snap() };
  }));

  await js('window.__subs.forEach((s) => s.unsubscribe()); cancelAnimationFrame(window.__raf); true');
  writeFileSync(outFile, JSON.stringify({ runs }, null, 1), 'utf8');

  console.log('=== 点击持续动画：先收尾再反应 ===');
  for (const r of runs) {
    console.log(`\n${r.name}`);
    console.log(`  帧数=${r.frames} 空帧=${r.blanks} 逐帧里出现过 end 段素材=${r.sawEndSource}`);
    console.log(`  素材序列: ${r.sources.join(' -> ')}`);
    console.log(`  结果: ${JSON.stringify(r.result)}`);
    console.log('  事件:');
    for (const e of r.events) console.log(`    ${e.t} ${e.id} reason=${e.reason ?? ''}${e.completed !== undefined ? ` completed=${e.completed}` : ''}${e.rejection ? ` rejection=${e.rejection}` : ''}`);
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 240000);
