// @ts-check
/**
 * 抓住**窗口尺寸变化那一瞬间**的画面。
 *
 * 之前用"等 900ms 再截图"的做法只能看到稳态（一切正常），
 * 看不到那 1~2 帧的过渡。这里在 BrowserWindow 的 `resize` 事件里**立刻**
 * capturePage（此时原生窗口已改尺寸、渲染层通常还没重绘），
 * 把过渡帧抓下来存盘。
 *
 * 用法：npx electron tools/probe-resize-instant.cjs
 * 输出：build/resize-instant/*.png
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'build', 'resize-instant');

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

  /** resize 事件里抓的过渡帧 */
  const instant = [];
  win.on('resize', () => {
    const bounds = win.getBounds();
    const seq = instant.length;
    void win.webContents
      .capturePage()
      .then((image) => {
        const file = join(outDir, `resize-${String(seq).padStart(2, '0')}-${bounds.width}x${bounds.height}.png`);
        writeFileSync(file, image.toPNG());
        instant.push({ seq, bounds: { w: bounds.width, h: bounds.height }, capture: image.getSize(), file });
        console.log(`  [resize#${seq}] 窗口 ${bounds.width}x${bounds.height} -> 截图 ${image.getSize().width}x${image.getSize().height}`);
      })
      .catch((error) => console.log(`  [resize#${seq}] capturePage 失败: ${String(error)}`));
  });

  await js(`(async () => { await window.petAPI.settings.setScale(0.6); return true; })()`);
  await wait(800);

  console.log('=== 抓住窗口尺寸变化瞬间 ===');
  console.log('— 显示气泡 —');
  await js(`window.petAPI.bubble.set({ visible: true, text: '过渡帧检查' })`);
  await wait(1500);

  console.log('— 隐藏气泡 —');
  await js('window.petAPI.bubble.set(null)');
  await wait(1500);

  console.log(`\n共抓到 ${instant.length} 个 resize 瞬间`);
  console.log(`图片: ${outDir}`);
  app.exit(0);
}).catch((error) => {
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
