// @ts-check
/**
 * 诊断：托盘菜单与右键菜单的**构造结果**是否一致？
 *
 * 用 module 拦截 electron 的 Menu.buildFromTemplate，把两个菜单真正构建出来的
 * 模板抓下来对比（尤其是「播放动画（测试）」子菜单里每项的 click 回调）。
 *
 * 用法：npx electron tools/diag-menu-build.cjs
 * 输出：build/menu-build.json
 */
const Module = require('node:module');
const { app } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'menu-build.json');

const captured = [];
const originalBuild = require('electron').Menu.buildFromTemplate;
require('electron').Menu.buildFromTemplate = function patchedBuild(template) {
  try {
    captured.push(
      template.map((item) => ({
        label: item?.label,
        type: item?.type,
        enabled: item?.enabled,
        hasClick: typeof item?.click === 'function',
        submenu: Array.isArray(item?.submenu)
          ? item.submenu.map((s) => ({ label: s?.label, type: s?.type, checked: s?.checked, hasClick: typeof s?.click === 'function' }))
          : null,
      })),
    );
  } catch (error) {
    captured.push({ error: String(error) });
  }
  return originalBuild.call(this, template);
};

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 6000));

  const win = require('electron').BrowserWindow.getAllWindows()[0];
  const result = { menus: [] };

  // 让托盘菜单刷新一次（会构建菜单）
  const before = captured.length;
  await win.webContents.executeJavaScript(`(() => { window.petDebug.anim.play('watch', { interrupt: 'force', reason: 'menu-build-diag' }); return true; })()`, true);
  await new Promise((r) => setTimeout(r, 2500));

  // 触发右键菜单（会构建 context menu）
  const beforeCtx = captured.length;
  await win.webContents.executeJavaScript(
    `(() => { window.petAPI.menu.showContextMenu({ region: 'body', animationId: window.petDebug.anim.getCurrentAnimation() }); return true; })()`,
    true,
  );
  await new Promise((r) => setTimeout(r, 1200));

  // 找所有含「播放动画（测试）」的模板，对比它们的子菜单
  for (let i = 0; i < captured.length; i++) {
    const tpl = captured[i];
    if (!Array.isArray(tpl)) continue;
    const anim = tpl.find((x) => x?.label === '播放动画（测试）');
    if (!anim || !anim.submenu) continue;
    result.menus.push({
      index: i,
      totalItems: tpl.length,
      firstItem: tpl[0]?.label,
      animItemCount: anim.submenu.length,
      // 子菜单里 watch 那一项的检查状态
      watchItem: anim.submenu.find((x) => String(x?.label).includes('(watch)')) ?? null,
      readItem: anim.submenu.find((x) => String(x?.label).includes('(read)')) ?? null,
      allHaveClick: anim.submenu.every((x) => x?.hasClick || x?.enabled === false),
      topLevelLabels: tpl.map((x) => x?.label).filter(Boolean).slice(0, 12),
    });
  }

  result.capturedTemplateCount = captured.length;
  result.beforeTray = before;
  result.beforeCtx = beforeCtx;
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');

  console.log('=== 菜单构建对比 ===');
  console.log('捕获模板数:', result.capturedTemplateCount);
  for (const m of result.menus) {
    console.log(`--- 模板 #${m.index}（共 ${m.totalItems} 项，首项="${m.firstItem}"）---`);
    console.log('  顶层项:', JSON.stringify(m.topLevelLabels));
    console.log('  动画子菜单项数:', m.animItemCount, '| 全部可点击:', m.allHaveClick);
    console.log('  watch 项:', JSON.stringify(m.watchItem));
    console.log('  read  项:', JSON.stringify(m.readItem));
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
