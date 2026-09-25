// @ts-check
/**
 * 实验：窗口扩展这一动作**本身**会不会让画面变形？
 *
 * 分三步各截一张图（截图之间留足时间，避免 capturePage 的同步开销干扰）：
 *   1. 基线：只有宠物（窗口 = 宠物尺寸）
 *   2. 扩窗口但气泡**完全不画**（pending / visibility hidden）
 *   3. 再显示气泡
 *
 * 若第 2 张就已经变形/变空，说明问题在"窗口 resize 本身"，
 * "先扩窗口再显示气泡"救不了；若第 2 张正常，才是显示时机的问题。
 *
 * 用法：npx electron tools/probe-window-resize-artifact.cjs
 * 输出：build/resize-artifact/*.png
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'build', 'resize-artifact');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  mkdirSync(outDir, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const shoot = async (name) => {
    const image = await win.webContents.capturePage();
    writeFileSync(join(outDir, `${name}.png`), image.toPNG());
    const size = image.getSize();
    const bounds = win.getBounds();
    console.log(`  [${name}] 截图 ${size.width}x${size.height}  窗口 ${bounds.width}x${bounds.height}`);
    return { name, capture: size, bounds };
  };

  await js(`(async () => { await window.petAPI.settings.setScale(0.6); return true; })()`);
  await wait(800);

  console.log('=== 窗口扩展本身是否变形 ===');

  /* 1) 基线：只有宠物 */
  await js('window.petAPI.bubble.set(null)');
  await wait(800);
  await shoot('1-baseline-pet-only');

  /*
   * 2) 扩窗口但**气泡完全不画**：
   *    直接把气泡设为 visibility:hidden 常驻（不是 pending，而是彻底不显示），
   *    然后请求显示 —— 主进程会调整窗口。等 600ms 让 resize 彻底结束再截图。
   */
  await js(`(() => {
    const b = document.getElementById('pet-bubble');
    b.style.setProperty('visibility', 'hidden', 'important');
    return true;
  })()`);
  await js(`window.petAPI.bubble.set({ visible: true, text: '只扩窗口不画气泡' })`);
  await wait(900);
  await shoot('2-window-expanded-bubble-hidden');

  /* 3) 放开隐藏，让气泡真正显示出来 */
  await js(`(() => {
    document.getElementById('pet-bubble').style.removeProperty('visibility');
    return true;
  })()`);
  await wait(500);
  await shoot('3-bubble-visible');

  /* 4) 反向：窗口收缩过程（气泡先隐藏，再看收缩后的帧） */
  await js(`(() => {
    const b = document.getElementById('pet-bubble');
    b.style.setProperty('visibility', 'hidden', 'important');
    return true;
  })()`);
  await js('window.petAPI.bubble.set(null)');
  await wait(900);
  await shoot('4-window-shrunk-bubble-hidden');
  await js(`(() => { document.getElementById('pet-bubble').style.removeProperty('visibility'); return true; })()`);

  console.log(`\n图片: ${outDir}`);
  console.log('判读：把 2 与 1 对比 —— 若 2 里宠物被拉伸/错位/变空，则问题在 resize 本身。');
  app.exit(0);
}).catch((error) => {
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
