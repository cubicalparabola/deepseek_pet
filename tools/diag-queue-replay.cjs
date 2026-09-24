// @ts-check
/**
 * 诊断（聚焦）：排队项在 `finishActive` 里回放时到底发生了什么？
 *
 * 已确认队列内容正确：{priority:50, interrupt:'queue', bypassCooldown:true}。
 * 但 watch 收尾段结束后只有 idle 被接回，排队项没播。
 *
 * 本脚本把 `finishActive` 之后的每一步都记下来：
 *   - 订阅 animation:start / end / rejected / queue 相关日志；
 *   - 在 end 事件后立刻快照 animation / phase / queue；
 *   - 逐 50ms 观察 1.5s，看排队项是否有出现的机会。
 *
 * 用法：npx electron tools/diag-queue-replay.cjs
 * 输出：build/queue-replay.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'queue-replay.json');

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
    ];
    window.__click = (region) => window.petApp.handleIntent({
      kind: 'click', region,
      payload: { button: 'left', x: 100, y: 100, nx: 0.5, ny: 0.5, region, detail: 1 },
    });
    /* 包一层 requestAnimation，记录每一次调用与结果 */
    const anim = window.petDebug.anim;
    window.__calls = [];
    const original = anim.requestAnimation.bind(anim);
    anim.requestAnimation = async (id, options) => {
      const q = anim.queue;
      const before = { id, options, active: anim.getCurrentAnimation(), queued: q ? q.animationId : null };
      const result = await original(id, options);
      window.__calls.push({ ...before, result });
      return result;
    };
    return true;
  })()`);

  const snap = () => js(`(() => { const a = window.petDebug.anim; const q = a.queue; return { animation: a.getCurrentAnimation(), phase: a.getPersistentPhase(), queue: q ? { id: q.animationId, options: q.options } : null }; })()`);

  const trace = [];
  await js(`window.petDebug.anim.resetCooldowns(); window.petDebug.anim.stop('setup'); true`);
  await wait(300);
  await js(`window.petDebug.anim.play('watch', { interrupt: 'force', reason: 'queue-replay-diag' })`);
  for (let i = 0; i < 40; i++) { await wait(100); if ((await snap()).phase === 'loop') break; }
  trace.push({ tag: 'loop 阶段', ...(await snap()) });

  await js(`window.__click('body')`);
  await wait(200);
  trace.push({ tag: '点击后 200ms', ...(await snap()) });

  /* 等收尾段结束（最多 8s），每 150ms 记一次 */
  const t0 = Date.now();
  let lastKey = '';
  while (Date.now() - t0 < 9000) {
    await wait(150);
    const s = await snap();
    const key = `${s.animation}|${s.phase}|${s.queue ? s.queue.id : '-'}`;
    if (key !== lastKey) {
      lastKey = key;
      trace.push({ tag: `t+${Date.now() - t0}ms`, ...s });
    }
  }
  trace.push({ tag: '最终', ...(await snap()) });

  const calls = await js('window.__calls');
  const events = await js('window.__ev');
  await js('window.__subs.forEach((s) => s.unsubscribe()); true');

  writeFileSync(outFile, JSON.stringify({ trace, calls, events }, null, 1), 'utf8');
  console.log('=== 排队项回放追踪 ===');
  for (const t of trace) console.log(`  ${t.tag}: anim=${t.animation} phase=${t.phase} queue=${t.queue ? JSON.stringify(t.queue) : '-'}`);
  console.log('--- requestAnimation 调用 ---');
  for (const c of calls) console.log(`  request ${c.id} active=${c.active} queued=${c.queued} options=${JSON.stringify(c.options)} -> ${JSON.stringify(c.result)}`);
  console.log('--- 事件 ---');
  for (const e of events) console.log(`  ${e.t} ${e.id} ${e.reason ?? e.rejection ?? ''}${e.completed !== undefined ? ` completed=${e.completed}` : ''}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
