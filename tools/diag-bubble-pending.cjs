// @ts-check
/**
 * 诊断：首次显示气泡时，`pet-bubble-pending`（不画）是否真的挡住了"先撑大再收缩"。
 *
 * 逐帧记录气泡的 visibility / class / 尺寸 / 窗口尺寸，看是否存在
 * "气泡可见且高度是最大高度"的帧。
 *
 * 用法：npx electron tools/diag-bubble-pending.cjs
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'bubble-pending.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`(async () => { await window.petAPI.settings.setScale(0.6); return true; })()`);
  await wait(700);

  await js(`(() => {
    window.__frames = [];
    window.__rec = true;
    const tick = () => {
      const b = document.getElementById('pet-bubble');
      const cs = getComputedStyle(b);
      window.__frames.push({
        t: performance.now(),
        cls: b.className,
        vis: cs.visibility,
        hidden: b.hidden,
        h: Math.round(b.getBoundingClientRect().height),
        winH: window.innerHeight,
      });
      window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
    return true;
  })()`);

  /* 首次显示（贴图未缓存） */
  await js(`window.petAPI.bubble.set({ visible: true, text: '首次显示测试文字' })`);
  await wait(900);
  await js('window.__rec = false; cancelAnimationFrame(window.__raf); true');
  const frames = await js('window.__frames');
  await js('window.petAPI.bubble.set(null)');
  await wait(500);

  /* 找出"可见且高度达到最大值"的帧 —— 那就是会闪的那一帧 */
  const maxH = Math.max(...frames.map((f) => f.h));
  const bad = frames.filter((f) => f.hidden === false && f.vis !== 'hidden' && f.h > f[f.length - 1] && f.h > 300);

  const changes = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a.cls !== b.cls || a.vis !== b.vis || a.h !== b.h || a.winH !== b.winH) {
      changes.push({
        dt: +(b.t - a.t).toFixed(1),
        cls: `${a.cls} -> ${b.cls}`,
        vis: `${a.vis} -> ${b.vis}`,
        h: `${a.h} -> ${b.h}`,
        winH: `${a.winH} -> ${b.winH}`,
      });
    }
  }

  writeFileSync(outFile, JSON.stringify({ frameCount: frames.length, maxH, badFrames: bad.length, changes, frames: frames.slice(0, 40) }, null, 1), 'utf8');
  console.log('=== 首次显示：pending 是否挡住"先撑大" ===');
  console.log(`  帧数=${frames.length} 最大高度=${maxH} "可见且超高"的帧数=${bad.length}`);
  for (const c of changes.slice(0, 10)) {
    console.log(`  +${c.dt}ms  cls=${c.cls}  vis=${c.vis}  h=${c.h}  winH=${c.winH}`);
  }
  console.log(bad.length === 0 ? '  ✅ 不存在"可见且按最大高度渲染"的帧' : `  ❌ 有 ${bad.length} 帧会闪: ${JSON.stringify(bad.slice(0, 3))}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
