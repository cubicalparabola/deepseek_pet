// @ts-check
/**
 * 诊断：**右键/托盘再次点 watch 之后，收尾段到底有没有播完**。
 *
 * 背景：用户报"右键再点 watch 没有正确结束"。
 * 之前 diag-ipc-toggle.cjs 只验证了"点了以后会离开 watch"（150ms 轮询看到
 * getCurrentAnimation() 变了），但**没有跟踪收尾段（end）能否真正播完**。
 * watch 有 start/loop/end 三段，end 段是 loop=false，需要靠 ended 事件收尾 ——
 * 如果这里断了，症状正是"没正确结束"。
 *
 * 本脚本：
 *   1. 走真实 IPC 命令播 watch；
 *   2. 再发一次同一条命令（= 右键再点 watch）；
 *   3. 以 **100ms** 粒度连续采样 12s，记录 animation / phase / cycles /
 *      状态机状态 / 可见层 / 视频播放状态；
 *   4. 收集 animation:* 事件序列。
 *
 * 用法：npx electron tools/diag-watch-endphase.cjs
 * 输出：build/watch-endphase.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'watch-endphase.json');

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
        bus.on('animation:start', (p) => window.__ev.push({ ms: Date.now(), t: 'start', id: p.animationId, reason: p.reason })),
        bus.on('animation:end', (p) => window.__ev.push({ ms: Date.now(), t: 'end', id: p.animationId, reason: p.reason, completed: p.completed })),
        bus.on('animation:rejected', (p) => window.__ev.push({ ms: Date.now(), t: 'rejected', id: p.animationId, rejection: p.rejection })),
        bus.on('animation:loop-cycle', (p) => window.__ev.push({ ms: Date.now(), t: 'cycle', id: p.animationId, cycle: p.cycle, target: p.target ?? null })),
      ];
      window.__t0 = Date.now();

      /* 每次采样都返回一份完整快照 */
      window.__snap = () => {
        const anim = window.petDebug.anim;
        const layers = window.petDebug.anim; // 占位，真正的层信息从 DOM 读
        const vids = Array.from(document.querySelectorAll('video'));
        return {
          ms: Date.now() - window.__t0,
          animation: anim.getCurrentAnimation(),
          phase: anim.getPersistentPhase(),
          cycles: anim.getLoopCycles(),
          source: anim.getActiveSource(),
          state: window.petDebug.state.get(),
          stageClass: document.getElementById('pet-stage')?.className ?? null,
          videos: vids.map((v) => ({
            id: v.id,
            src: (v.currentSrc || v.src || '').split('/').pop(),
            paused: v.paused,
            loop: v.loop,
            t: Number(v.currentTime.toFixed(2)),
            dur: Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
            readyState: v.readyState,
            visible: getComputedStyle(v).opacity,
          })),
        };
      };
      return true;
    })()`,
    true,
  );

  const snap = () => win.webContents.executeJavaScript('window.__snap()', true);
  const send = (id) => win.webContents.send('pet:command-set-animation', id);

  const samples = [];
  const push = async (tag) => samples.push({ tag, ...(await snap()) });

  /* 阶段 1：播 watch */
  await win.webContents.executeJavaScript('window.petDebug.anim.resetCooldowns(); window.petDebug.anim.stop("diag-reset"); true', true);
  await wait(300);
  send('watch');
  await wait(2500);
  await push('播放 watch 2.5s 后');

  /* 阶段 2：右键再点 watch（真实命令） */
  send('watch');

  /* 阶段 3：100ms 粒度连续采样 12s，完整覆盖 end 段 */
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    await wait(100);
    const s = await snap();
    samples.push({ tag: 'trace', ...s });
  }
  await push('收尾后 12s');

  /* 判定：收尾段有没有被播到并播完 */
  const phases = samples.filter((s) => s.tag === 'trace').map((s) => s.phase);
  const sawEnd = phases.includes('end');
  const finalState = samples[samples.length - 1];

  const events = await win.webContents.executeJavaScript('window.__ev', true);
  await win.webContents.executeJavaScript('window.__subs.forEach((s) => s.unsubscribe()); true', true);

  const report = {
    summary: {
      sawEndPhase: sawEnd,
      finalAnimation: finalState.animation,
      finalPhase: finalState.phase,
      finalState: finalState.state,
      finalStageClass: finalState.stageClass,
      finalVideos: finalState.videos,
      events,
    },
    samples,
  };
  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');

  console.log('=== 右键再点 watch：收尾段跟踪 ===');
  console.log(`是否进入 end 段: ${sawEnd}`);
  console.log(`最终 animation=${finalState.animation} phase=${finalState.phase} state=${finalState.state} stage=${finalState.stageClass}`);
  console.log('--- 阶段变化（仅打印变化点）---');
  let prev = '';
  for (const s of samples) {
    const key = `${s.animation}|${s.phase}|${s.state}|${s.stageClass}|${(s.videos || []).map((v) => `${v.src}:${v.paused}:${v.visible}`).join(',')}`;
    if (key !== prev) {
      prev = key;
      console.log(
        `  ${String(s.ms).padStart(6)}ms ${String(s.tag).padEnd(18)} anim=${s.animation ?? '-'} phase=${s.phase ?? '-'} cyc=${s.cycles ?? '-'} state=${s.state} stage=${s.stageClass}` +
          ` vids=[${(s.videos || []).map((v) => `${v.src}@${v.t}/${v.dur}${v.paused ? '(paused)' : ''}op${v.visible}`).join(' ')}]`,
      );
    }
  }
  console.log('--- 事件序列 ---');
  for (const e of events) console.log(`  ${e.ms - (events[0]?.ms ?? 0)}ms ${e.t} ${JSON.stringify(e)}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
