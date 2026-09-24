// @ts-check
/**
 * 诊断：**在收尾段（end）中途再次点同一个动画** + 全流程可见性连续性。
 *
 * 用户报"右键再点 watch 没有正确结束"。已排除：
 *  - 收尾段播不完（diag-watch-endphase.cjs 证明 end 段能播完并回 idle）；
 *  - 命令路径分叉（托盘与右键在 Main 侧调用同一条 IPC）。
 *
 * 本脚本专门压这条边界：watch 在 end 段播到一半时再点一次同一项 ——
 * 此时 `endPersistent()` 的 `endingRequested` 早退分支会被命中。
 * 同时逐帧记录可见层不透明度，任何"没有可见层"的帧都会被记为空帧。
 *
 * 用法：npx electron tools/diag-watch-endclick.cjs
 * 输出：build/watch-endclick.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'watch-endclick.json');

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

  await win.webContents.executeJavaScript(
    `(() => {
      const bus = window.petDebug.bus;
      window.__ev = [];
      window.__subs = [
        bus.on('animation:start', (p) => window.__ev.push({ t: 'start', id: p.animationId, reason: p.reason })),
        bus.on('animation:end', (p) => window.__ev.push({ t: 'end', id: p.animationId, reason: p.reason, completed: p.completed })),
        bus.on('animation:rejected', (p) => window.__ev.push({ t: 'rejected', id: p.animationId, rejection: p.rejection })),
        bus.on('animation:loop-cycle', (p) => window.__ev.push({ t: 'cycle', id: p.animationId, cycle: p.cycle })),
      ];

      /* 逐帧记录"画面是否可见"：所有 video 的 opacity 最大值 + 各层状态 */
      window.__frames = [];
      window.__noVisible = 0;
      const tickFrame = () => {
        const vids = Array.from(document.querySelectorAll('#pet-stage video'));
        let maxOp = 0;
        let detail = [];
        for (const v of vids) {
          const op = Number(getComputedStyle(v).opacity) || 0;
          if (op > maxOp) maxOp = op;
          detail.push(op.toFixed(2));
        }
        const rec = { op: Number(maxOp.toFixed(2)), detail: detail.join('/'), anim: window.petDebug.anim.getCurrentAnimation(), phase: window.petDebug.anim.getPersistentPhase() };
        window.__frames.push(rec);
        if (maxOp < 0.02) window.__noVisible += 1;
        window.__raf = requestAnimationFrame(tickFrame);
      };
      window.__raf = requestAnimationFrame(tickFrame);
      return true;
    })()`,
    true,
  );

  const snap = () =>
    win.webContents.executeJavaScript(
      `(() => { const a = window.petDebug.anim; return { animation: a.getCurrentAnimation(), phase: a.getPersistentPhase(), cycles: a.getLoopCycles(), source: a.getActiveSource(), state: window.petDebug.state.get() }; })()`,
      true,
    );
  const send = (id) => win.webContents.send('pet:command-set-animation', id);

  const log = [];
  const mark = async (tag) => log.push({ tag, ...(await snap()) });

  /* 1) 播 watch，进入 loop */
  await win.webContents.executeJavaScript('window.petDebug.anim.resetCooldowns(); window.petDebug.anim.stop("diag-reset"); true', true);
  await wait(300);
  send('watch');
  await wait(2500);
  await mark('1) watch 在 loop');

  /* 2) 点一次 -> 应进入 end 段 */
  send('watch');
  let enteredEnd = false;
  for (let i = 0; i < 100 && !enteredEnd; i++) {
    await wait(60);
    const s = await snap();
    if (s.phase === 'end') enteredEnd = true;
  }
  await mark('2) 已进入 end 段');

  /* 3) 关键边界：**end 段播到一半再点同一项** */
  await wait(1500);
  const beforeThird = await snap();
  send('watch');
  await wait(300);
  await mark('3) end 段中途再点一次');
  const afterThird = await snap();

  /* 4) 观察 8s，看最终是否回到 idle */
  let leftWatch = false;
  for (let i = 0; i < 120 && !leftWatch; i++) {
    await wait(100);
    const s = await snap();
    if (s.animation !== 'watch') leftWatch = true;
  }
  await wait(1200);
  await mark('4) 最终');

  /* 5) 收数据 */
  const frameStats = await win.webContents.executeJavaScript(
    `(() => {
      cancelAnimationFrame(window.__raf);
      const f = window.__frames;
      const gaps = [];
      let inEnd = false;
      for (const r of f) {
        if (r.phase === 'end') inEnd = true;
        if (inEnd && r.op < 0.02) gaps.push(r);
      }
      return { total: f.length, noVisible: window.__noVisible, endPhaseNoVisible: gaps.length, sampleGaps: gaps.slice(0, 10) };
    })()`,
    true,
  );
  const events = await win.webContents.executeJavaScript('window.__ev', true);
  await win.webContents.executeJavaScript('window.__subs.forEach((s) => s.unsubscribe()); true', true);

  writeFileSync(
    outFile,
    JSON.stringify({ ended: { enteredEnd, leftWatch, beforeThird, afterThird }, log, frameStats, events }, null, 1),
    'utf8',
  );

  console.log('=== end 段中途再点同一项 ===');
  console.log(`进入过 end 段: ${enteredEnd}`);
  console.log(`第三次点击前: ${JSON.stringify(beforeThird)}`);
  console.log(`第三次点击后: ${JSON.stringify(afterThird)}`);
  console.log(`最终离开 watch: ${leftWatch}`);
  for (const l of log) console.log(`  ${l.tag}: ${JSON.stringify(l)}`);
  console.log(`--- 逐帧可见性 --- noVisible=${frameStats.noVisible}/${frameStats.total} end段内无可见层帧=${frameStats.endPhaseNoVisible}`);
  console.log('--- 事件 ---');
  for (const e of events) console.log(' ', JSON.stringify(e));
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
