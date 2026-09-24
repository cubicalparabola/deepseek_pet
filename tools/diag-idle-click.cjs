// @ts-check
/**
 * 诊断：**idle 阶段点击人物** 会不会卡住。
 *
 * 用户报告："idle 时再点击 idle 会卡住"。
 *
 * idle 是 loop=true 的兜底循环，点击反应（body -> stroke）走的是
 * `startVideo` 的**复用分支**：同一个素材就复用当前缓冲、把 currentTime 拨回 0、
 * 并把 `loop` 改成 false。这条路径与持续动画无关，需要单独验证。
 *
 * 记录：点击后每 50ms 的 animation/phase/state + 两个 video 的
 * paused / loop / currentTime / duration / readyState / opacity，
 * 以及事件序列。任何"paused 且没有动画在播"的采样都算卡住。
 *
 * 用法：npx electron tools/diag-idle-click.cjs
 * 输出：build/idle-click.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'idle-click.json');

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
    window.__snap = () => {
      const a = window.petDebug.anim;
      const vids = Array.from(document.querySelectorAll('#pet-stage video'));
      return {
        animation: a.getCurrentAnimation(),
        phase: a.getPersistentPhase(),
        state: window.petDebug.state.get(),
        videos: vids.map((v) => ({
          id: v.id,
          src: String(v.currentSrc || v.src || '').split('/').pop(),
          paused: v.paused,
          loop: v.loop,
          t: Number(v.currentTime.toFixed(2)),
          dur: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
          rs: v.readyState,
          op: Number((Number(getComputedStyle(v).opacity) || 0).toFixed(2)),
        })),
      };
    };
    return true;
  })()`);

  const snap = () => js('window.__snap()');

  /* 1) 确认已经回到 idle 兜底循环 */
  await js(`window.petDebug.anim.resetCooldowns(); window.petDebug.anim.stop('setup'); true`);
  await wait(1200);
  for (let i = 0; i < 40; i++) { await wait(100); if ((await snap()).animation === 'idle') break; }
  const before = await snap();

  /* 2) 点击（body -> stroke） */
  await js(`window.__ev.length = 0; window.__click('body')`);

  /* 3) 50ms 粒度采样 8s，找"卡住"的采样 */
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await wait(50);
    samples.push({ ms: Date.now() - t0, ...(await snap()) });
  }

  const events = await js('window.__ev');
  await js('window.__subs.forEach((s) => s.unsubscribe()); true');

  /* 卡住判定：没有任何可见缓冲在播（或所有可见缓冲都 paused 且没动画在播） */
  const stuck = samples.filter((s) => {
    const active = s.videos.filter((v) => v.op > 0.02);
    const anyPlaying = active.some((v) => !v.paused);
    return s.animation === null && !anyPlaying;
  });
  /* 另一种卡：动画在播但视频 paused */
  const pausedWhilePlaying = samples.filter((s) => {
    const active = s.videos.filter((v) => v.op > 0.02);
    return s.animation !== null && active.length > 0 && active.every((v) => v.paused);
  });

  const final = samples[samples.length - 1];
  writeFileSync(outFile, JSON.stringify({ before, stuck: stuck.length, stuckSample: stuck.slice(0, 5), pausedWhilePlaying: pausedWhilePlaying.length, pausedSample: pausedWhilePlaying.slice(0, 5), final, events }, null, 1), 'utf8');

  console.log('=== idle 阶段点击 ===');
  console.log(`点击前: ${JSON.stringify(before)}`);
  console.log(`"没动画在播且没画面在动"的采样数: ${stuck.length} / ${samples.length}`);
  if (stuck.length) console.log(`  首次: ${JSON.stringify(stuck[0])}`);
  console.log(`"动画在播但可见视频全 paused"的采样数: ${pausedWhilePlaying.length}`);
  if (pausedWhilePlaying.length) console.log(`  首次: ${JSON.stringify(pausedWhilePlaying[0])}`);
  console.log(`最终: ${JSON.stringify(final)}`);
  console.log('--- 事件 ---');
  for (const e of events) console.log(`  ${e.t} ${e.id} ${e.reason ?? e.rejection ?? ''}${e.completed !== undefined ? ` completed=${e.completed}` : ''}`);
  console.log('--- 阶段变化点 ---');
  let prev = '';
  for (const s of samples) {
    const key = `${s.animation}|${s.state}|${s.videos.map((v) => `${v.src}:${v.paused}:${v.op}`).join(',')}`;
    if (key !== prev) {
      prev = key;
      console.log(`  ${String(s.ms).padStart(5)}ms anim=${s.animation} state=${s.state} vids=[${s.videos.map((v) => `${v.src}@${v.t}/${v.dur}${v.paused ? '(paused)' : ''}loop=${v.loop}rs=${v.rs}op${v.op}`).join(' ')}]`);
    }
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
