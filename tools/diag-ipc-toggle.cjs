// @ts-check
/**
 * 诊断：走**真实的 IPC 命令路径**（`pet:command-set-animation`）验证
 * "再次点击同一动画 -> 结束它"。
 *
 * 为什么必须这样测：托盘菜单与右键菜单在 Main 侧都会调用
 *   IpcManager.setAnimation(id) -> broadcast(CommandSetAnimation, id)
 * 也就是说 renderer 收到的是**同一条命令**。
 * 之前验收里是"复刻"renderer 的判断逻辑，不是走真实路径，可能漏掉差异。
 *
 * 测试内容：
 *   1. 用 IPC 命令播放 watch；
 *   2. 再次用 IPC 命令发同一个 watch -> 应结束它（播收尾 -> 回 idle）；
 *   3. 对照：发**不同**动画 -> 应立刻切换。
 *
 * 用法：npx electron tools/diag-ipc-toggle.cjs
 * 输出：build/ipc-toggle.json
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'ipc-toggle.json');

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

  /* 先让 renderer 记录事件，再驱动命令 */
  await win.webContents.executeJavaScript(
    `(() => {
      const bus = window.petDebug.bus;
      window.__diagEvents = [];
      window.__diagSubs = [
        bus.on('animation:start', (p) => window.__diagEvents.push({ t: 'start', id: p.animationId, reason: p.reason })),
        bus.on('animation:end', (p) => window.__diagEvents.push({ t: 'end', id: p.animationId, reason: p.reason, completed: p.completed })),
        bus.on('animation:rejected', (p) => window.__diagEvents.push({ t: 'rejected', id: p.animationId, rejection: p.rejection })),
      ];
      window.petDebug.anim.resetCooldowns();
      return true;
    })()`,
    true,
  );

  /** 发送与两条菜单完全相同的命令。 */
  const sendMenuCommand = (animationId) => {
    return win.webContents.executeJavaScript(
      `window.petAPI.commands && true`,
      true,
    ).then(() => {
      // 直接从 main 侧广播（这就是 IpcManager.setAnimation 做的事）
      win.webContents.send('pet:command-set-animation', animationId);
    });
  };

  const snap = async (tag) => {
    const s = await win.webContents.executeJavaScript(
      `(() => ({
        animation: window.petDebug.anim.getCurrentAnimation(),
        phase: window.petDebug.anim.getPersistentPhase(),
        cycles: window.petDebug.anim.getLoopCycles(),
      }))()`,
      true,
    );
    return { tag, ...s };
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];

  // 1) 通过 IPC 播放 watch
  await sendMenuCommand('watch');
  await wait(2500);
  log.push(await snap('IPC 播放 watch 后'));

  // 2) 再发一次同样的 watch -> 应结束它
  await sendMenuCommand('watch');
  let gone = false;
  for (let i = 0; i < 80 && !gone; i++) {
    await wait(150);
    const s = await snap('poll');
    if (s.animation !== 'watch') gone = true;
  }
  log.push(await snap('再次 IPC 发 watch 后'));
  log.push({ tag: '是否已离开 watch', gone });

  // 3) 对照：发不同动画
  await sendMenuCommand('watch');
  await wait(2500);
  await sendMenuCommand('talk');
  await wait(600);
  log.push(await snap('从 watch 切到 talk 后'));

  const events = await win.webContents.executeJavaScript('window.__diagEvents', true);

  /*
   * 场景 2：**快速连续两次**同一个动画（用户"点一下没反应就又点一下"的典型操作）。
   * 第一次可能还在 start 段（仍在加载/开场），看守卫是否仍然生效。
   */
  await win.webContents.executeJavaScript('window.petDebug.anim.stop("rapid-reset"); window.petDebug.anim.resetCooldowns(); true', true);
  await wait(400);
  await sendMenuCommand('watch');
  await wait(120);                 // 故意很短：此时还在 start 段
  const midPhase = await snap('第二次点击前（120ms）');
  await sendMenuCommand('watch');  // 再点一次
  let rapidGone = false;
  for (let i = 0; i < 80 && !rapidGone; i++) {
    await wait(150);
    const s = await snap('poll');
    if (s.animation !== 'watch') rapidGone = true;
  }
  const rapidAfter = await snap('快速再点后');
  log.push(midPhase, rapidAfter, { tag: '快速两次：是否已离开 watch', gone: rapidGone });

  const events2 = await win.webContents.executeJavaScript('window.__diagEvents', true);
  await win.webContents.executeJavaScript('window.__diagSubs.forEach((s) => s.unsubscribe()); true', true);

  writeFileSync(outFile, JSON.stringify({ log, events: events2 }, null, 1), 'utf8');
  console.log('=== IPC 命令路径：再点同一动画 ===');
  for (const e of log) {
    console.log(
      `${String(e.tag).padEnd(24)} animation=${e.animation ?? '-'} phase=${e.phase ?? '-'} cycles=${e.cycles ?? '-'}` +
        (e.gone !== undefined ? ` gone=${e.gone}` : ''),
    );
  }
  console.log('--- 事件序列 ---');
  for (const e of events2) console.log(' ', JSON.stringify(e));
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
