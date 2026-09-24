// @ts-check
/**
 * 诊断：`watch` 为什么"无法打断"？
 *
 * 采集完整证据链：
 *   1. 播放 watch，等到循环阶段；
 *   2. 依次尝试三种"打断"方式并记录结果：
 *      a. `anim.endPersistent()`（显式结束请求）
 *      b. 播放另一个动画（优先级抢占）
 *      c. `anim.stop()`（硬停）
 *   3. 每一步打印 phase / cycle / 当前素材 / 当前动画，看清楚卡在哪。
 *
 * 用法：npx electron tools/diag-watch-interrupt.cjs
 * 输出：build/watch-interrupt.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'watch-interrupt.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 6000));
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    writeFileSync(outFile, JSON.stringify({ fatal: 'no window' }), 'utf8');
    app.exit(1);
    return;
  }

  const result = await win.webContents.executeJavaScript(
    `(async () => {
      const anim = window.petDebug.anim;
      const bus = window.petDebug.bus;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const snap = (tag) => ({
        tag,
        animation: anim.getCurrentAnimation(),
        phase: anim.getPersistentPhase(),
        cycles: anim.getLoopCycles(),
        source: anim.getActiveSource(),
        persistentPlaying: anim.isPersistentPlaying(),
      });

      const log = [];
      const events = [];
      const subs = [
        bus.on('animation:loop-cycle', (p) => events.push({ t: 'loop-cycle', id: p.animationId, cycle: p.cycle, target: p.target ?? null })),
        bus.on('animation:end', (p) => events.push({ t: 'end', id: p.animationId, reason: p.reason, completed: p.completed })),
        bus.on('animation:start', (p) => events.push({ t: 'start', id: p.animationId })),
      ];

      anim.resetCooldowns();
      await anim.play('watch', { interrupt: 'force', reason: 'watch-diag' });
      log.push(snap('played watch'));
      log.push({ tag: 'watch segments', segments: anim.getDefinition('watch').segments });

      // 等进入循环阶段
      for (let i = 0; i < 60 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
      log.push(snap('reached loop'));

      // 观察 4 秒：循环是否真的在推进
      const cyclesSeen = [];
      const sub = bus.on('animation:loop-cycle', (p) => { if (p.animationId === 'watch') cyclesSeen.push(p.cycle); });
      await wait(4000);
      log.push({ tag: 'after 4s watching', cyclesSeen });
      log.push(snap('after 4s'));
      sub.unsubscribe();

      // a) 显式结束请求
      const acceptedA = anim.endPersistent('diag-explicit-end');
      log.push({ tag: 'endPersistent() returned', acceptedA });
      log.push(snap('right after endPersistent'));
      await wait(1500);
      log.push(snap('1.5s after endPersistent'));
      await wait(4000);
      log.push(snap('5.5s after endPersistent'));

      // b) 若还活着，用优先级抢占
      const stillAlive = anim.getCurrentAnimation();
      let steal = null;
      if (stillAlive === 'watch') {
        anim.resetCooldowns();
        steal = await anim.play('bomb', { priority: 100, interrupt: 'force', reason: 'diag-steal' });
        log.push({ tag: 'steal with bomb', steal });
        await wait(800);
        log.push(snap('after steal attempt'));
      }

      // c) 兜底：硬停
      const beforeStop = anim.getCurrentAnimation();
      anim.stop('diag-hard-stop');
      await wait(400);
      log.push({ tag: 'after stop()', beforeStop, ...snap('after stop') });

      for (const s of subs) s.unsubscribe();
      return { log, events: events.slice(0, 40) };
    })()`,
    true,
  );

  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');

  console.log('=== watch 打断诊断 ===');
  for (const entry of result.log) {
    if (entry.tag) {
      console.log(
        `${entry.tag.padEnd(26)} animation=${entry.animation ?? '-'} phase=${entry.phase ?? '-'} ` +
          `cycles=${entry.cycles ?? '-'} source=${entry.source ?? '-'}` +
          (entry.acceptedA !== undefined ? ` accepted=${entry.acceptedA}` : '') +
          (entry.segments ? ` segments=${JSON.stringify(entry.segments)}` : '') +
          (entry.cyclesSeen ? ` cyclesSeen=${JSON.stringify(entry.cyclesSeen)}` : '') +
          (entry.steal ? ` steal=${JSON.stringify(entry.steal)}` : '') +
          (entry.beforeStop !== undefined ? ` beforeStop=${entry.beforeStop}` : ''),
      );
    }
  }
  console.log('--- 事件序列 ---');
  for (const e of result.events) console.log(' ', JSON.stringify(e));
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
