// @ts-check
/**
 * 诊断：**右键菜单**「播放动画」子菜单里那一项的 click 回调，实际执行时会发生什么？
 *
 * 为什么这样测：Electron 的原生菜单项无法被程序化点击，但我们可以拦截
 * `Menu.buildFromTemplate`，把 **ContextMenu** 构建出来的模板留一份，
 * 然后**直接调用**该菜单项的 `click()` —— 这正是用户点它的等价操作。
 *
 * 对比两条路径：
 *   A. 托盘菜单项的 click（同样拦截拿到）
 *   B. 右键菜单项的 click
 * 如果 A 能结束 watch 而 B 不能，差异就锁死在菜单这一层。
 *
 * 用法：npx electron tools/diag-menu-click.cjs
 * 输出：build/menu-click.json
 */
const electron = require('electron');
const { app, BrowserWindow, Menu } = electron;
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'menu-click.json');

/** 每次 buildFromTemplate 都留一份模板引用，便于之后调用其中的 click。 */
const built = [];
const originalBuild = Menu.buildFromTemplate;
Menu.buildFromTemplate = function patched(template) {
  const menu = originalBuild.call(this, template);
  built.push({ template, menu });
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

  const snap = async () =>
    win.webContents.executeJavaScript(
      `(() => ({ animation: window.petDebug.anim.getCurrentAnimation(), phase: window.petDebug.anim.getPersistentPhase(), cycles: window.petDebug.anim.getLoopCycles() }))()`,
      true,
    );

  const findAnimItem = (entry, id) => {
    const top = entry.template.find((x) => x?.label === '播放动画（测试）');
    if (!top || !Array.isArray(top.submenu)) return null;
    return top.submenu.find((s) => typeof s?.label === 'string' && s.label.includes(`(${id})`)) ?? null;
  };

  const result = { steps: [] };
  const push = (tag, extra = {}) => result.steps.push({ tag, ...extra });

  // ---------- 准备：用右键菜单项启动 watch（等价于用户右键 -> 播放动画 -> watch）----------
  await win.webContents.executeJavaScript(
    `(() => { window.petAPI.menu.showContextMenu({ region: 'body', animationId: window.petDebug.anim.getCurrentAnimation() }); return true; })()`,
    true,
  );
  await wait(1500);
  const ctxEntry = built[built.length - 1];
  const ctxWatch = findAnimItem(ctxEntry, 'watch');
  push('找到右键菜单里的 watch 项', { found: Boolean(ctxWatch), label: ctxWatch?.label ?? null });

  if (ctxWatch?.click) {
    ctxWatch.click();
    await wait(2500);
    push('右键点 watch 后', await snap());
  }

  // ---------- 关键：再次调用右键菜单里 watch 的 click ----------
  await win.webContents.executeJavaScript(
    `(() => { window.petAPI.menu.showContextMenu({ region: 'body', animationId: window.petDebug.anim.getCurrentAnimation() }); return true; })()`,
    true,
  );
  await wait(1500);
  const ctxEntry2 = built[built.length - 1];
  const ctxWatch2 = findAnimItem(ctxEntry2, 'watch');
  push('第二次右键菜单里 watch 项', { found: Boolean(ctxWatch2), checked: ctxWatch2?.type === 'radio' ? ctxWatch2?.checked : null });

  if (ctxWatch2?.click) {
    ctxWatch2.click();
  }
  let gone = false;
  for (let i = 0; i < 80 && !gone; i++) {
    await wait(150);
    const s = await snap();
    if (s.animation !== 'watch') gone = true;
  }
  push('右键再点 watch 后', { ...(await snap()), gone });

  // ---------- 对照：托盘菜单项 ----------
  await win.webContents.executeJavaScript(
    `(() => { window.petDebug.anim.stop('ctx-reset'); window.petDebug.anim.resetCooldowns(); return true; })()`,
    true,
  );
  await wait(400);
  // 触发一次托盘菜单重建
  await win.webContents.executeJavaScript(`(() => { window.petAPI.animations; return true; })()`, true);
  await wait(800);
  // 找最近的托盘模板（21 项、首项鲸鱼娘）
  const trayEntry = [...built].reverse().find((e) => e.template?.[0]?.label === '鲸鱼娘' && e.template.length === 21);
  const trayWatch = trayEntry ? findAnimItem(trayEntry, 'watch') : null;
  push('托盘菜单里的 watch 项', { found: Boolean(trayWatch), label: trayWatch?.label ?? null });

  if (trayWatch?.click) {
    trayWatch.click();
    await wait(2500);
    push('托盘点 watch 后', await snap());
    // 再点一次
    const trayEntry2 = [...built].reverse().find((e) => e.template?.[0]?.label === '鲸鱼娘' && e.template.length === 21);
    const trayWatch2 = trayEntry2 ? findAnimItem(trayEntry2, 'watch') : null;
    if (trayWatch2?.click) trayWatch2.click();
    let goneTray = false;
    for (let i = 0; i < 80 && !goneTray; i++) {
      await wait(150);
      const s = await snap();
      if (s.animation !== 'watch') goneTray = true;
    }
    push('托盘再点 watch 后', { ...(await snap()), gone: goneTray });
  }

  Menu.buildFromTemplate = originalBuild;
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('=== 菜单项 click 回调对比 ===');
  for (const s of result.steps) console.log(' ', JSON.stringify(s));
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
