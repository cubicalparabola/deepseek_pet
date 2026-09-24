// @ts-check
/**
 * 量气泡内部三行（正文区 / 正文 / 按钮）的实际像素位置，定位"上方空白 / 按钮被挤"。
 *
 * 用法：npx electron tools/diag-bubble-inner.cjs
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'bubble-inner.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const snap = () =>
    js(`(() => {
      const b = document.getElementById('pet-bubble');
      const t = document.getElementById('pet-bubble-text');
      const body = document.getElementById('pet-bubble-body');
      const ack = document.getElementById('pet-bubble-ack');
      const band = document.getElementById('pet-bubble-ack-band');
      const r = (el) => { const x = el.getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), h: Math.round(x.height), w: Math.round(x.width) }; };
      const cs = getComputedStyle(t);
      return {
        bubble: r(b),
        text: { ...r(t), clientH: t.clientHeight, scrollH: t.scrollHeight, padTop: cs.paddingTop, padBottom: cs.paddingBottom, flex: cs.flex, minHeight: cs.minHeight, justifyContent: cs.justifyContent },
        body: r(body),
        band: r(band),
        ack: { ...r(ack), styleH: ack.style.height, hidden: ack.hidden },
        bubbleDisplay: getComputedStyle(b).display,
        bubbleFlexDir: getComputedStyle(b).flexDirection,
      };
    })()`);

  const rows = [];
  for (const [name, text] of [['极短', '早'], ['中', '这是一段中等长度的文本，用来观察气泡高度会不会跟着变高。大概两到三行。'], ['极长', '这一段刻意写得非常长，用来把气泡撑到高度上限。'.repeat(10)]]) {
    /* 固定 scale，避免被上一个诊断脚本留下的值影响；用 async IIFE 包住 await */
    await js(`(async () => {
      await window.petAPI.settings.setScale(0.6);
      await window.petAPI.bubble.set({ visible: true, text: ${JSON.stringify(text)} });
      return true;
    })()`);
    let last = -1, stable = 0;
    for (let i = 0; i < 40 && stable < 2; i++) {
      await wait(120);
      const h = await js(`Math.round(document.getElementById('pet-bubble').getBoundingClientRect().height)`);
      if (h === last) stable++; else stable = 0;
      last = h;
    }
    rows.push({ name, ...(await snap()) });
  }
  await js('window.petAPI.bubble.set(null)');

  writeFileSync(outFile, JSON.stringify({ rows }, null, 1), 'utf8');
  console.log('=== 气泡内部布局 ===');
  for (const r of rows) {
    console.log(`\n[${r.name}] 气泡 display=${r.bubbleDisplay} flexDirection=${r.bubbleFlexDir} 高=${r.bubble.h}`);
    console.log(`  正文区: top=${r.text.top} bottom=${r.text.bottom} h=${r.text.h} clientH=${r.text.clientH} flex=${r.text.flex} justify=${r.text.justifyContent}`);
    console.log(`  正文  : top=${r.body.top} bottom=${r.body.bottom} h=${r.body.h}`);
    console.log(`  按钮带: top=${r.band.top} bottom=${r.band.bottom} h=${r.band.h}`);
    console.log(`  按钮  : top=${r.ack.top} bottom=${r.ack.bottom} h=${r.ack.h} styleH=${r.ack.styleH} 隐藏=${r.ack.hidden}`);
    console.log(`  关系  : 正文区顶到气泡顶=${r.text.top - r.bubble.top}px, 按钮底到气泡底=${r.bubble.bottom - r.ack.bottom}px, 按钮带底到气泡底=${r.bubble.bottom - r.band.bottom}px`);
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
