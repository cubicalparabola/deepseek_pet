// @ts-check
/**
 * 量清楚气泡布局的真实输入/输出，用来定位"为什么被缩得这么小 + 宠物为何漂移"。
 *
 * 打印：
 *   - 显示器工作区（workArea）与 scaleFactor；
 *   - 宠物尺寸（主进程 resolvePetSize 的结果）；
 *   - resolveBubbleLayout 的输入与输出（ideal vs actual、shrink）；
 *   - 窗口前后的 bounds 与宠物在屏幕上的矩形。
 *
 * 用法：npx electron tools/diag-bubble-geometry.cjs
 */
const { app, BrowserWindow, screen } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'bubble-geometry.json');

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

  const displays = screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
  }));
  const primary = screen.getPrimaryDisplay();

  const petRect = async () => {
    const b = win.getBounds();
    const r = await js(`(() => { const e = document.getElementById('pet-pet'); const x = e.getBoundingClientRect(); return { x: x.x, y: x.y, w: x.width, h: x.height }; })()`);
    return { screenX: b.x + r.x, screenY: b.y + r.y, w: r.w, h: r.h, window: b };
  };

  const report = { displays, primaryWorkAreaHeight: primary.workArea.height };

  /* 基线（无气泡） */
  await js('window.petAPI.bubble.set(null)');
  await wait(800);
  report.before = { pet: await petRect(), layout: (await js('window.petApp.describeBubble()')) };

  /* 显示气泡，记录主进程下发的布局 */
  const payload = await js(`window.petAPI.bubble.set({ visible: true, text: '测试' })`);
  await wait(1000);
  report.payload = payload;
  report.after = { pet: await petRect(), layout: (await js('window.petApp.describeBubble()')) };

  /* 隐藏，看是否回到原位 */
  await js('window.petAPI.bubble.set(null)');
  await wait(1000);
  report.afterHide = { pet: await petRect() };

  report.analysis = {
    workAreaH: primary.workArea.height,
    layoutWindowH: payload?.layout?.windowHeight,
    layoutBubbleH: payload?.layout?.bubbleHeight,
    layoutPadding: payload?.layout?.padding,
    layoutGap: payload?.layout?.gap,
    petHeight: payload?.layout?.petHeight,
    /** 按公式复算"气泡能用的高度" */
    availableForBubble: primary.workArea.height - (payload?.layout?.petHeight ?? 0) - (payload?.layout?.gap ?? 0) - (payload?.layout?.padding ?? 0) * 2,
    idealBubbleHeightIfRatio15: ((payload?.layout?.petWidth ?? 0) * 1.5) / (1434 / 1426),
    petScreenBefore: `${report.before.pet.screenX},${report.before.pet.screenY}`,
    petScreenAfterShow: `${report.after.pet.screenX},${report.after.pet.screenY}`,
    petScreenAfterHide: `${report.afterHide.pet.screenX},${report.afterHide.pet.screenY}`,
  };

  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');
  console.log(JSON.stringify(report.analysis, null, 1));
  console.log('窗口: before=' + JSON.stringify(report.before.pet.window)
    + ' show=' + JSON.stringify(report.after.pet.window)
    + ' hide=' + JSON.stringify(report.afterHide.pet.window));
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
