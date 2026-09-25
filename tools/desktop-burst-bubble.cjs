// @ts-check
/**
 * 用 `desktopCapturer` 抓**真实屏幕**（OS 层），同时触发气泡显隐。
 *
 * 为什么必须抓屏幕而不是 `webContents.capturePage()`：
 * 后者抓的是 Chromium 的**页面表面** —— 实测四张过渡帧全部正常
 * （宠物位置、大小都对），说明"闪"发生在 OS/DWM 合成器那一层，
 * 页面表面看不到。
 *
 * 流程：应用启动 -> 先空转抓若干帧（基线）-> 触发显示 -> 再抓若干帧
 * -> 触发隐藏 -> 再抓。每帧都存盘 + 记录时间戳。
 *
 * 用法：npx electron tools/desktop-burst-bubble.cjs
 * 输出：build/desktop-burst/*.png + build/desktop-burst.json
 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'build', 'desktop-burst');
const outFile = join(root, 'build', 'desktop-burst.json');

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

  await js('window.petAPI.bubble.set(null)');
  await wait(800);

  /* 抓屏区域：覆盖"隐藏时的宠物 + 显示时气泡会占的那块" */
  const primary = screen.getPrimaryDisplay();
  const petBounds = win.getBounds();
  const captureX = Math.max(0, petBounds.x - 200);
  const captureY = Math.max(0, petBounds.y - 500);
  const captureW = Math.min(primary.size.width - captureX, petBounds.width + 260);
  const captureH = Math.min(primary.size.height - captureY, petBounds.height + 560);
  console.log(`抓屏区域: ${captureW}x${captureH} @ (${captureX},${captureY})`);

  const source = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: captureW, height: captureH },
  });
  const src = source[0];
  if (!src) { console.error('no screen source'); app.exit(1); return; }

  const frames = [];
  const grab = async (tag) => {
    const t = Date.now();
    const image = await src.thumbnail;
    const file = join(outDir, `${String(frames.length).padStart(3, '0')}-${tag}.png`);
    writeFileSync(file, image.toPNG());
    frames.push({ i: frames.length, tag, t, file, size: image.getSize() });
  };

  /* 空转抓几帧作为基线（确认抓屏本身可用） */
  for (let i = 0; i < 4; i++) await grab('baseline');

  /*
   * 触发显示，然后**连续快速抓帧**。
   *
   * 注意 desktopCapturer 的 thumbnail 是"抓取那一刻"的画面（不会随后更新），
   * 因此这里每次都重新 getSources 才能拿到最新画面。
   */
  const grabFresh = async (tag) => {
    const t = Date.now();
    const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: captureW, height: captureH } });
    const img = list[0]?.thumbnail;
    if (!img) return;
    const file = join(outDir, `${String(frames.length).padStart(3, '0')}-${tag}.png`);
    writeFileSync(file, img.toPNG());
    frames.push({ i: frames.length, tag, t, file, size: img.getSize() });
  };

  console.log('触发显示气泡…');
  void js(`window.petAPI.bubble.set({ visible: true, text: '屏幕抓取' })`);
  for (let i = 0; i < 14; i++) await grabFresh('show');

  await wait(1500);
  for (let i = 0; i < 3; i++) await grabFresh('steady-shown');

  console.log('触发隐藏气泡…');
  void js('window.petAPI.bubble.set(null)');
  for (let i = 0; i < 14; i++) await grabFresh('hide');

  await wait(1200);
  for (let i = 0; i < 3; i++) await grabFresh('steady-hidden');

  writeFileSync(outFile, JSON.stringify({ capture: { x: captureX, y: captureY, w: captureW, h: captureH }, frames }, null, 1), 'utf8');
  console.log(`共 ${frames.length} 帧 -> ${outDir}`);
  const t0 = frames[0]?.t ?? 0;
  for (const f of frames) console.log(`  ${String(f.i).padStart(3)} ${f.tag.padEnd(14)} +${f.t - t0}ms  ${f.size.width}x${f.size.height}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
