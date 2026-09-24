// @ts-check
/**
 * 诊断：**启动阶段**兜底 idle 是否真的在循环。
 *
 * 前面几个诊断的"起点"采样都出现 `anim=null` + `idle.webm` 处于 paused
 * （且已经显示在画面上）—— 说明启动后兜底循环可能并没有跑起来，
 * 桌宠停在 idle 的第一帧。这是独立于点击的问题，单独测。
 *
 * 从 renderer 就绪那一刻起，每 100ms 记录一次 animation/state/视频状态，
 * 持续 12s，把每一次变化都打出来。
 *
 * 用法：npx electron tools/diag-startup-idle.cjs
 * 输出：build/startup-idle.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'startup-idle.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  /* 尽早挂上：只要 webContents 可执行脚本就开始采样 */
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    writeFileSync(outFile, JSON.stringify({ fatal: 'no window' }), 'utf8');
    app.exit(1);
    return;
  }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  /* 等 renderer 里 petDebug 出现 */
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {
    await wait(50);
    ready = await js('Boolean(window.petDebug && window.petDebug.anim)').catch(() => false);
  }

  await js(`(() => {
    const bus = window.petDebug.bus;
    window.__ev = [];
    window.__subs = [
      bus.on('animation:start', (p) => window.__ev.push({ ms: Date.now(), t: 'start', id: p.animationId, reason: p.reason })),
      bus.on('animation:end', (p) => window.__ev.push({ ms: Date.now(), t: 'end', id: p.animationId, reason: p.reason, completed: p.completed })),
      bus.on('animation:rejected', (p) => window.__ev.push({ ms: Date.now(), t: 'rejected', id: p.animationId, rejection: p.rejection })),
      bus.on('animation:error', (p) => window.__ev.push({ ms: Date.now(), t: 'error', id: p.animationId, message: p.message })),
      bus.on('state:change', (p) => window.__ev.push({ ms: Date.now(), t: 'state', from: p.from, to: p.to, reason: p.reason })),
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

  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    await wait(100);
    samples.push({ ms: Date.now() - t0, ...(await js('window.__snap()')) });
  }
  const events = await js('window.__ev');
  await js('window.__subs.forEach((s) => s.unsubscribe()); true');

  /* idle 是否真的在推进：看可见 idle 缓冲的 currentTime 有没有增长 */
  const idleTimes = samples
    .filter((s) => s.vids.some((v) => v.src === 'idle.webm' && v.op > 0.02))
    .map((s) => s.vids.find((v) => v.src === 'idle.webm' && v.op > 0.02).t);
  const advanced = idleTimes.length > 1 && Math.max(...idleTimes) - Math.min(...idleTimes) > 0.5;
  const frozen = samples.filter((s) => {
    if (s.animation !== null) return false;
    const visible = s.vids.filter((v) => v.op > 0.02);
    return visible.length > 0 && visible.every((v) => v.paused);
  }).length;

  writeFileSync(outFile, JSON.stringify({ samples, events, advanced, idleTimeMin: Math.min(...idleTimes), idleTimeMax: Math.max(...idleTimes), noAnimationButVisiblePaused: frozen }, null, 1), 'utf8');

  console.log('=== 启动阶段兜底 idle ===');
  console.log(`idle 时间轴是否推进: ${advanced}  (${Math.min(...idleTimes)} -> ${Math.max(...idleTimes)})`);
  console.log(`"没有动画在播但画面 paused"的采样数: ${frozen} / ${samples.length}`);
  console.log('--- 变化点 ---');
  let prev = '';
  for (const s of samples) {
    const key = `${s.animation}|${s.state}|${s.vids.map((v) => `${v.src}:${v.paused}:${v.op}`).join(',')}`;
    if (key !== prev) {
      prev = key;
      console.log(`  ${String(s.ms).padStart(6)}ms anim=${String(s.animation)} state=${s.state} vids=[${s.vids.map((v) => `${v.src}@${v.t}${v.paused ? '(paused)' : '(playing)'}op${v.op}`).join(' ')}]`);
    }
  }
  console.log('--- 事件 ---');
  for (const e of events) console.log(`  ${e.t} ${e.id ?? ''} ${e.from ? e.from + '->' + e.to : ''} ${e.reason ?? e.rejection ?? e.message ?? ''}${e.completed !== undefined ? ` completed=${e.completed}` : ''}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
