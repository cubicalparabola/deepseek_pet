// @ts-check
/**
 * 用抓屏连拍验证：隐藏气泡时"气泡先消失、再收缩窗口"两拍是否都真的画出去了。
 *
 * 为了绕开 `desktopCapturer` ~800ms/帧 的限制，这里把**收缩延迟临时拉长**
 * （通过环境变量 `DESKTOP_PET_SHRINK_MS`），让两拍之间有足够时间各抓几帧。
 *
 * 分析：统计每帧上方区域（气泡所在带）的"非透明像素数"。
 *   - 第一拍后：上方区域应**基本为空**（气泡已消失）
 *   - 第二拍后：窗口变小，上方区域仍为空，且宠物区域位置正确
 *
 * 用法：npx electron tools/diag-hide-two-beat.cjs
 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { decodePng, pixelAt } = require('./lib/png.mjs');

const root = join(__dirname, '..');
const outDir = join(root, 'build', 'hide-two-beat');
const outFile = join(root, 'build', 'hide-two-beat.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 收缩延迟（毫秒）——由 BubbleController 读取，缺省 60。 */
const SHRINK_MS = Number(process.env.DESKTOP_PET_SHRINK_MS ?? 0);

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  mkdirSync(outDir, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`(async () => { await window.petAPI.settings.setScale(0.6); return true; })()`);
  await wait(700);
  await js(`window.petAPI.bubble.set({ visible: true, text: '两拍验证' })`);
  await wait(1500);

  const bounds = win.getBounds();
  const primary = screen.getPrimaryDisplay();
  const cx = Math.max(0, bounds.x - 60);
  const cy = Math.max(0, bounds.y - 40);
  const cw = Math.min(primary.size.width - cx, bounds.width + 120);
  const ch = Math.min(primary.size.height - cy, bounds.height + 80);
  console.log(`抓屏区域 ${cw}x${ch} @ (${cx},${cy})  收缩延迟=${SHRINK_MS}ms`);

  const grab = async (tag) => {
    const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: cw, height: ch } });
    const img = list[0]?.thumbnail;
    if (!img) return null;
    const file = join(outDir, `${tag}-${Date.now()}.png`);
    const buf = img.toPNG();
    writeFileSync(file, buf);
    const size = img.getSize();
    const decoded = decodePng(file);
    /* 上半部分（气泡带）的非透明像素数，以及整图非透明像素数 */
    const half = Math.floor(decoded.height / 2);
    let top = 0;
    let all = 0;
    for (let y = 0; y < decoded.height; y += 2) {
      for (let x = 0; x < decoded.width; x += 2) {
        if (pixelAt(decoded, x, y).a > 32) {
          all += 1;
          if (y < half) top += 1;
        }
      }
    }
    console.log(`  [${tag}] 截图 ${size.width}x${size.height}  上半非透明=${top}  全图非透明=${all}`);
    return { tag, at: Date.now(), top, all, file, size };
  };

  const frames = [];
  frames.push(await grab('before-hide'));
  console.log('触发隐藏…');
  void js('window.petAPI.bubble.set(null)');
  /* 连抓若干帧：覆盖"第一拍 -> 第二拍"整个过程 */
  for (let i = 0; i < 8; i++) frames.push(await grab(`after-hide-${i}`));

  writeFileSync(outFile, JSON.stringify({ shrinkMs: SHRINK_MS, region: { cx, cy, cw, ch }, frames }, null, 1), 'utf8');
  console.log(`\n图片: ${outDir}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
