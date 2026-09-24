// @ts-check
/**
 * 诊断：从托盘菜单切换到**其它动画**时，watch 为什么没被打断？
 *
 * 复刻菜单真实路径：priority 60 + bypassCooldown + reason 'tray-menu'
 * （与 renderer.onSetAnimation 完全一致），然后逐个试其它动画，
 * 记录每次的 accepted / rejection / 当前动画。
 *
 * 关键怀疑：托盘播放时 priority=60，如果 watch 以 60 在播，
 * 再选 priority 50 的动画会命中 "priority < current.priority" -> lower-priority 被拒。
 *
 * 用法：npx electron tools/diag-menu-switch.cjs
 * 输出：build/menu-switch.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'menu-switch.json');

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
      const actions = window.petDebug.actions;
      const bus = window.petDebug.bus;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));

      // 复刻 renderer.onSetAnimation 的**真实**参数（改 renderer 时这里要同步）
      const menuPlay = (id) => actions.execute({
        type: 'animation', animationId: id, priority: 70, interrupt: 'force',
        source: 'user', reason: 'tray-menu', bypassCooldown: true,
      });

      const events = [];
      const subs = [
        bus.on('animation:start', (p) => events.push({ t: 'start', id: p.animationId, reason: p.reason })),
        bus.on('animation:end', (p) => events.push({ t: 'end', id: p.animationId, reason: p.reason, completed: p.completed })),
        bus.on('animation:rejected', (p) => events.push({ t: 'rejected', id: p.animationId, rejection: p.rejection })),
      ];

      anim.resetCooldowns();
      // 用菜单路径播放 watch（priority 60）
      await menuPlay('watch');
      for (let i = 0; i < 60 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
      const base = { animation: anim.getCurrentAnimation(), phase: anim.getPersistentPhase(), priority: anim.getCurrentPriority() };

      // 逐个尝试切换到其它动画（都用菜单路径）
      const targets = ['talk', 'cute', 'sing', 'read', 'idle'];
      const results = [];
      for (const id of targets) {
        anim.resetCooldowns();
        // 每次都先回到 watch（保证起点一致）
        const before = anim.getCurrentAnimation();
        const r = await menuPlay(id);
        await wait(600);
        results.push({
          target: id,
          before,
          accepted: r.accepted,
          rejection: r.rejection ?? null,
          after: anim.getCurrentAnimation(),
          phase: anim.getPersistentPhase(),
          currentPriority: anim.getCurrentPriority(),
        });
        // 如果没切走，停掉再继续，避免影响下一轮
        if (anim.getCurrentAnimation() === 'watch') {
          anim.stop('diag-reset');
          await wait(300);
        }
        // 重新起 watch 作为下一轮起点
        anim.resetCooldowns();
        await menuPlay('watch');
        for (let i = 0; i < 60 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
      }

      // 对照：直接从菜单点 idle（不是同一动画）能不能抢占
      const idleResult = await menuPlay('idle');
      await wait(500);

      for (const s of subs) s.unsubscribe();
      return { base, results, events: events.slice(0, 40), idleAfter: anim.getCurrentAnimation(), idleAccepted: idleResult.accepted, idleRejection: idleResult.rejection ?? null };
    })()`,
    true,
  );

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('=== 菜单切换诊断 ===');
  console.log('watch 起点:', JSON.stringify(result.base));
  console.log('（priority = 菜单播放时给的 60）');
  for (const r of result.results) {
    console.log(
      `  切到 ${r.target.padEnd(6)} accepted=${String(r.accepted).padEnd(5)} rejection=${String(r.rejection).padEnd(16)} after=${String(r.after).padEnd(6)} priority=${r.currentPriority}`,
    );
  }
  console.log('--- 事件（前 20）---');
  for (const e of result.events.slice(0, 20)) console.log(' ', JSON.stringify(e));
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
