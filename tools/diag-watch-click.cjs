// @ts-check
/**
 * 诊断：用**真实指针事件**点击桌宠，看 watch 能否被打断。
 *
 * 与 diag-watch-interrupt 的区别：那个直接调 anim.play()，
 * 这里走完整链路：pointerdown/pointerup -> InteractionManager 判定点击
 * -> handleIntent -> Action Pipeline -> AnimationManager。
 * 如果"直接调 play 能断、真实点击不能断"，问题就在交互链路而不是动画机制。
 *
 * 用法：npx electron tools/diag-watch-click.cjs
 * 输出：build/watch-click.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'watch-click.json');

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
      });

      const log = [];
      const events = [];
      const subs = [
        bus.on('animation:start', (p) => events.push({ t: 'start', id: p.animationId, reason: p.reason, source: p.source })),
        bus.on('animation:end', (p) => events.push({ t: 'end', id: p.animationId, reason: p.reason, completed: p.completed })),
        bus.on('animation:rejected', (p) => events.push({ t: 'rejected', id: p.animationId, rejection: p.rejection })),
        bus.on('action:received', (p) => events.push({ t: 'action', type: p.type, target: p.target, source: p.source, reason: p.reason })),
        bus.on('action:rejected', (p) => events.push({ t: 'action-rejected', type: p.type, rejection: p.rejection })),
        bus.on('pet:click', (p) => events.push({ t: 'pet:click', region: p.region })),
        bus.on('pet:region', (p) => events.push({ t: 'pet:region', region: p.region })),
        bus.on('pet:dblclick', () => events.push({ t: 'pet:dblclick' })),
      ];

      anim.resetCooldowns();
      await anim.play('watch', { interrupt: 'force', reason: 'click-diag-setup' });
      for (let i = 0; i < 60 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
      log.push(snap('watch 进入循环'));
      const eventsBeforeClick = events.length;

      // 真实指针事件：模拟用户在角色区域点一下
      const stage = document.getElementById('pet-stage');
      const sr = stage.getBoundingClientRect();
      const cx = sr.left + sr.width / 2;
      const cy = sr.top + sr.height * 0.45;
      const opts = {
        bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1, isPrimary: true,
        pointerType: 'mouse', clientX: sr.width / 2, clientY: sr.height * 0.45,
        screenX: cx, screenY: cy,
      };
      stage.dispatchEvent(new PointerEvent('pointerdown', opts));
      await wait(60);
      window.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      await wait(700);

      log.push(snap('点击后 0.7s'));
      const clickEvents = events.slice(eventsBeforeClick);
      await wait(2500);
      log.push(snap('点击后 3.2s'));

      // 对照：直接调 play()（绕过交互链路）
      anim.resetCooldowns();
      await anim.play('watch', { interrupt: 'force', reason: 'click-diag-direct' });
      for (let i = 0; i < 60 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
      const directAccepted = await anim.play('stroke', { priority: 50, interrupt: 'auto', reason: 'user-click:body', source: 'user' });
      await wait(400);
      log.push({ tag: '直接 play 抢占（对照）', accepted: directAccepted.accepted, animation: anim.getCurrentAnimation() });

      for (const s of subs) s.unsubscribe();
      return { log, eventsBeforeClick, clickEvents, allEvents: events.slice(-25) };
    })()`,
    true,
  );

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('=== 真实点击打断 watch 诊断 ===');
  for (const entry of result.log) {
    console.log(
      `${String(entry.tag).padEnd(22)} animation=${entry.animation ?? '-'} phase=${entry.phase ?? '-'} cycles=${entry.cycles ?? '-'}` +
        (entry.accepted !== undefined ? ` accepted=${entry.accepted}` : ''),
    );
  }
  console.log('--- 点击触发的事件 ---');
  if (result.clickEvents.length === 0) console.log('  （无：点击没有产生任何事件！）');
  for (const e of result.clickEvents) console.log(' ', JSON.stringify(e));
  console.log('--- 末尾事件序列 ---');
  for (const e of result.allEvents) console.log(' ', JSON.stringify(e));
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
