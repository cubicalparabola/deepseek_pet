// @ts-check
/**
 * 一次性探针：把"窗口屏幕位置"和"宠物视口/屏幕位置"一起打出来，
 * 用来解释验收里宠物 offsetTop 为负（-9）的现象。
 *
 * 用法：npx electron tools/diag-bubble-anchor-probe.cjs
 */
const { app, BrowserWindow, screen } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'bubble-anchor-probe.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const probe = async (tag) => {
    const b = win.getBounds();
    const dom = await js(`(() => {
      const el = document.getElementById('pet-pet');
      const r = el.getBoundingClientRect();
      const stage = document.getElementById('pet-stage');
      return {
        petViewportTop: r.top, petViewportLeft: r.left,
        petSize: { w: r.width, h: r.height },
        stagePad: getComputedStyle(stage).paddingTop,
        windowScreenX: window.screenX, windowScreenY: window.screenY,
        inner: { w: window.innerWidth, h: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio,
      };
    })()`);
    return {
      tag,
      mainWindowBounds: b,
      dom,
      petScreenTop: b.y + dom.petViewportTop,
      petScreenLeft: b.x + dom.petViewportLeft,
      /** 宠物在**窗口内**的偏移（按主进程 bounds 与 DOM 视口推算） */
      petOffsetInWindowTop: dom.petViewportTop - (dom.windowScreenY - b.y),
    };
  };

  const report = { workArea: screen.getPrimaryDisplay().workArea, scaleFactor: screen.getPrimaryDisplay().scaleFactor, steps: [] };
  report.steps.push(await probe('启动后'));

  await js('window.petAPI.bubble.set(null)');
  await wait(800);
  report.steps.push(await probe('隐藏气泡'));

  await js(`window.petAPI.bubble.set({ visible: true, text: '探针' })`);
  await wait(1000);
  report.steps.push(await probe('显示气泡'));

  await js('window.petAPI.bubble.set(null)');
  await wait(900);
  report.steps.push(await probe('再次隐藏'));

  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');
  for (const s of report.steps) {
    console.log(`\n[${s.tag}]`);
    console.log(`  主进程窗口 bounds: ${JSON.stringify(s.mainWindowBounds)}`);
    console.log(`  DOM: 宠物视口 top=${s.dom.petViewportTop} left=${s.dom.petViewportLeft} size=${s.dom.petSize.w}x${s.dom.petSize.h} stagePad=${s.dom.stagePad}`);
    console.log(`  DOM: window.screenX/Y=${s.dom.windowScreenX}/${s.dom.windowScreenY} inner=${s.dom.inner.w}x${s.dom.inner.h} dpr=${s.dom.devicePixelRatio}`);
    console.log(`  推算: 宠物屏幕位置=(${s.petScreenLeft},${s.petScreenTop})  宠物在窗口内 top=${s.petOffsetInWindowTop}`);
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
