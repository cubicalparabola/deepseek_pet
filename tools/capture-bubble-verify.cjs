// @ts-check
/**
 * 第一步（Electron）：只负责**截图**，不做像素分析。
 *
 * 分成两步是因为"渲染 + 截图 + 像素分析"挤在一个脚本里时，一旦某处卡住
 * 就没有任何中间产物可查。这里把图存下来，分析交给
 * `tools/analyze-bubble-visual.mjs`（纯 Node，秒级）。
 *
 * 会给正文区/按钮画上内描边（品红/青色）便于在像素里反查它们的精确位置。
 *
 * 用法：npx electron tools/capture-bubble-verify.cjs
 * 输出：build/bubble-visual/<name>.png + build/bubble-visual-index.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'build', 'bubble-visual');
const indexFile = join(root, 'build', 'bubble-visual-index.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLES = [
  { name: 'short', text: '早' },
  { name: 'medium', text: '这是一段中等长度的文本，用来观察气泡高度会不会跟着变高。大概两到三行。' },
  { name: 'long', text: '当文字超过一屏时，气泡内部会出现滚动条，可以用鼠标滚轮拖动滚动条查看后面的内容。'.repeat(4) },
];

app.whenReady().then(async () => {
  console.log('STEP: ready');
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.error('no window'); app.exit(1); return; }
  mkdirSync(outDir, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  console.log('STEP: set scale 0.6');
  await js('window.petAPI ? window.petAPI.settings.setScale(0.6) : null');
  await wait(900);

  const index = [];
  for (const sample of SAMPLES) {
    console.log('STEP: sample', sample.name);
    await js(`window.petAPI.bubble.set({ visible: true, text: ${JSON.stringify(sample.text)} })`);
    /* 等气泡高度稳定 */
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 30 && stable < 2; i++) {
      await wait(150);
      const h = await js(`Math.round(document.getElementById('pet-bubble').getBoundingClientRect().height)`);
      if (h === last) stable += 1;
      else stable = 0;
      last = h;
    }

    const dom = await js(`(() => {
      const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };
      return {
        bubble: r('pet-bubble'), text: r('pet-bubble-text'), ack: r('pet-bubble-ack'),
        inner: { w: window.innerWidth, h: window.innerHeight }, dpr: window.devicePixelRatio,
      };
    })()`);

    /* 画内描边（outline 不参与布局，不影响被测几何） */
    await js(`(() => {
      const t = document.getElementById('pet-bubble-text');
      const a = document.getElementById('pet-bubble-ack');
      t.style.outline = '2px solid rgb(255,0,255)';
      t.style.outlineOffset = '-2px';
      a.style.outline = '2px solid rgb(0,255,255)';
      a.style.outlineOffset = '-2px';
      return true;
    })()`);
    await wait(250);

    const image = await win.webContents.capturePage();
    const size = image.getSize();
    writeFileSync(join(outDir, `${sample.name}.png`), image.toPNG());
    console.log('STEP: captured', sample.name, `${size.width}x${size.height}`);

    await js(`(() => {
      document.getElementById('pet-bubble-text').style.outline = '';
      document.getElementById('pet-bubble-ack').style.outline = '';
      return true;
    })()`);

    index.push({ name: sample.name, captureSize: size, dom });
  }

  await js('window.petAPI.bubble.set(null)');
  writeFileSync(indexFile, JSON.stringify({ index }, null, 1), 'utf8');
  console.log('DONE');
  app.exit(0);
}).catch((error) => {
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => { console.error('TIMEOUT'); app.exit(2); }, 120000);
