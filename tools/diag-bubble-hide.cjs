// @ts-check
/**
 * 验证**关闭气泡**的两拍顺序：气泡先不可见 -> 宠物重排/窗口收缩。
 *
 * 逐帧记录「气泡可见性 / 气泡高度 / 窗口高度 / 宠物在窗内的纵向位置」，
 * 检查是否存在"气泡可见 + 宠物尚未重排"的那一帧
 * （那正是关闭时"闪一下"的成因）。
 *
 * 用法：npx electron tools/diag-bubble-hide.cjs
 * 输出：build/bubble-hide.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'bubble-hide.json');

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

  /* 先显示气泡并等稳定 */
  await js(`window.petAPI.bubble.set({ visible: true, text: '关闭顺序检查' })`);
  await wait(1500);

  /* 逐帧记录 */
  await js(`(() => {
    window.__frames = [];
    window.__rec = true;
    const tick = () => {
      const b = document.getElementById('pet-bubble');
      const pet = document.getElementById('pet-pet');
      const cs = getComputedStyle(b);
      window.__frames.push({
        t: performance.now(),
        vis: cs.visibility,
        hidden: b.hidden,
        bubbleH: Math.round(b.getBoundingClientRect().height),
        petTop: Math.round(pet.getBoundingClientRect().top),
        petH: pet.clientHeight,
        winH: window.innerHeight,
        winW: window.innerWidth,
      });
      window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
    return true;
  })()`);

  await js('window.petAPI.bubble.set(null)');
  await wait(1200);
  await js('window.__rec = false; cancelAnimationFrame(window.__raf); true');
  const frames = await js('window.__frames');

  const changes = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const diff = {};
    for (const k of ['vis', 'hidden', 'bubbleH', 'petTop', 'winH', 'winW']) {
      if (a[k] !== b[k]) diff[k] = `${a[k]} -> ${b[k]}`;
    }
    if (Object.keys(diff).length) changes.push({ dt: +(b.t - a.t).toFixed(1), diff });
  }

  /* 违规帧：气泡仍可见（vis 非 hidden、未 hidden）却还没重排（窗口仍是含气泡尺寸） */
  const bad = frames.filter((f) => f.hidden === false && f.vis !== 'hidden' && f.winH > f.petH + 40);

  writeFileSync(outFile, JSON.stringify({ frameCount: frames.length, changes, badFrames: bad.length, first: frames[0], last: frames[frames.length - 1] }, null, 1), 'utf8');
  console.log('=== 关闭气泡的逐帧顺序 ===');
  console.log(`  帧数=${frames.length}`);
  console.log(`  首帧: vis=${frames[0]?.vis} bubbleH=${frames[0]?.bubbleH} petTop=${frames[0]?.petTop} winH=${frames[0]?.winH}`);
  console.log(`  末帧: vis=${frames[frames.length - 1]?.vis} bubbleH=${frames[frames.length - 1]?.bubbleH} petTop=${frames[frames.length - 1]?.petTop} winH=${frames[frames.length - 1]?.winH}`);
  for (const c of changes.slice(0, 8)) console.log(`  +${c.dt}ms  ${JSON.stringify(c.diff)}`);
  console.log(`  "气泡可见但窗口未收缩"的帧数 = ${bad.length} ${bad.length === 0 ? '✅' : '❌'}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
