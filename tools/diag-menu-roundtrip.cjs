// @ts-check
/**
 * 诊断（**真实右键菜单、两个完整来回**）：右键点 watch -> 等它自己播完回到 idle
 * -> 再右键点 watch，两轮都必须生效。
 *
 * 与 diag-menu-click.cjs 的区别：那个只做了一次"点了就判定离开 watch"；
 * 这里每次都**等它彻底回到 idle**，再做下一轮，并且全程记录：
 *   - 菜单项 type / checked（判断右键菜单是否把 watch 标成当前项）
 *   - 每次点击后的 animation / phase / cycles
 *   - 事件序列
 * 用户报的"右键再点 watch 没有正确结束"若真实存在，这一轮必然复现。
 *
 * 用法：npx electron tools/diag-menu-roundtrip.cjs
 * 输出：build/menu-roundtrip.json
 */
const { app, BrowserWindow, Menu } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'menu-roundtrip.json');

const built = [];
const originalBuild = Menu.buildFromTemplate;
Menu.buildFromTemplate = function patched(template) {
  const menu = originalBuild.call(this, template);
  built.push({ template, menu, at: Date.now() });
  return menu;
};

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
  const snap = () =>
    js(`(() => { const a = window.petDebug.anim; return { animation: a.getCurrentAnimation(), phase: a.getPersistentPhase(), cycles: a.getLoopCycles(), state: window.petDebug.state.get() }; })()`);

  await js(`(() => {
    const bus = window.petDebug.bus;
    window.__ev = [];
    window.__subs = [
      bus.on('animation:start', (p) => window.__ev.push({ t: 'start', id: p.animationId, reason: p.reason })),
      bus.on('animation:end', (p) => window.__ev.push({ t: 'end', id: p.animationId, reason: p.reason, completed: p.completed })),
      bus.on('animation:rejected', (p) => window.__ev.push({ t: 'rejected', id: p.animationId, rejection: p.rejection })),
      bus.on('animation:loop-cycle', (p) => window.__ev.push({ t: 'cycle', id: p.animationId, cycle: p.cycle })),
    ];
    window.petDebug.anim.resetCooldowns();
    window.petDebug.anim.stop('diag-reset');
    return true;
  })()`);
  await wait(500);

  /** 打开真实右键菜单（走 renderer 的真实入口），返回其中 watch 菜单项。 */
  const openContextMenuAndFindWatch = async () => {
    const before = built.length;
    await js(`(() => { window.petAPI.menu.showContextMenu({ region: 'body', animationId: window.petDebug.anim.getCurrentAnimation() }); return true; })()`);
    await wait(1200);
    const entry = built.slice(before).find((e) => e.template?.some((x) => x?.label === '播放动画（测试）')) ?? built[built.length - 1];
    const top = entry?.template?.find((x) => x?.label === '播放动画（测试）');
    const item = Array.isArray(top?.submenu) ? top.submenu.find((s) => typeof s?.label === 'string' && s.label.includes('(watch)')) : null;
    return { item, label: item?.label ?? null, type: item?.type ?? null, checked: item?.type === 'radio' ? item.checked : null, enabled: item?.enabled ?? null };
  };

  /** 等到 renderer 离开 watch（回到 idle）。 */
  const waitUntilLeftWatch = async (timeoutMs = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await wait(150);
      const s = await snap();
      if (s.animation !== 'watch') return { left: true, ms: Date.now() - t0, final: s };
    }
    return { left: false, ms: Date.now() - t0, final: await snap() };
  };

  const rounds = [];
  for (let round = 1; round <= 2; round++) {
    const found = await openContextMenuAndFindWatch();
    if (!found.item?.click) {
      rounds.push({ round, error: 'menu item not found', found });
      break;
    }
    found.item.click();
    await wait(2500);
    const afterPlay = await snap();

    const found2 = await openContextMenuAndFindWatch();
    if (!found2.item?.click) {
      rounds.push({ round, error: 'second menu item not found', found2 });
      break;
    }
    found2.item.click();
    const leftResult = await waitUntilLeftWatch();
    rounds.push({
      round,
      firstItem: found,
      afterPlay,
      secondItem: found2,
      leftWatch: leftResult.left,
      leftMs: leftResult.ms,
      afterEnd: leftResult.final,
    });
    await wait(800);
  }

  const events = await js('window.__ev');
  await js('window.__subs.forEach((s) => s.unsubscribe()); true');
  Menu.buildFromTemplate = originalBuild;

  const ok = rounds.length === 2 && rounds.every((r) => !r.error && r.afterPlay.animation === 'watch' && r.leftWatch === true);

  writeFileSync(outFile, JSON.stringify({ ok, rounds, events }, null, 1), 'utf8');

  console.log('=== 真实右键菜单：两个完整来回 ===');
  for (const r of rounds) {
    console.log(`第 ${r.round} 轮：`);
    console.log(`  第一次点前菜单项: ${JSON.stringify(r.firstItem)}`);
    console.log(`  点后状态: ${JSON.stringify(r.afterPlay)}`);
    console.log(`  第二次菜单项: ${JSON.stringify(r.secondItem)}`);
    console.log(`  再点后离开 watch: ${r.leftWatch} (${r.leftMs}ms) -> ${JSON.stringify(r.afterEnd)}`);
  }
  console.log(`结论: ${ok ? '两轮都正常' : '存在复现！'}`);
  console.log('--- 事件 ---');
  for (const e of events) console.log(' ', JSON.stringify(e));
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
