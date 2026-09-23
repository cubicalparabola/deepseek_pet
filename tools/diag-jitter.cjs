// @ts-check
/**
 * 定位那 1px 高度抖动：是否与窗口位置的奇偶/DIP 取整有关？
 * 对比不同位置步进下的 resize 次数与尺寸集合。
 * 用法：npx electron tools/diag-jitter.cjs
 */
const { app, BrowserWindow, screen } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'diag-jitter.json');
const results = [];

function flush(extra = {}) {
  try {
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(outFile, JSON.stringify({ results, ...extra }, null, 1), 'utf8');
  } catch (error) { console.error('flush failed', error); }
}
process.on('uncaughtException', (error) => {
  flush({ fatal: String(error && error.stack) });
  app.exit(1);
});

app.disableHardwareAcceleration();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = { width: 360, height: 480 };

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  flush({ display: { workArea: `${d.workArea.width}x${d.workArea.height}`, scaleFactor: d.scaleFactor } });

  const win = new BrowserWindow({
    width: BASE.width, height: BASE.height, show: false, skipTaskbar: true,
    transparent: true, frame: false, resizable: false,
  });
  await wait(700);

  const steps = [
    { name: '步进 9,7（当前）', dx: 9, dy: 7 },
    { name: '步进 10,10（偶数）', dx: 10, dy: 10 },
    { name: '步进 8,8（偶数）', dx: 8, dy: 8 },
    { name: '步进 5,5（奇数）', dx: 5, dy: 5 },
    { name: '步进 1,1', dx: 1, dy: 1 },
    { name: '步进 4,4', dx: 4, dy: 4 },
  ];

  for (const step of steps) {
    win.setMinimumSize(0, 0);
    win.setBounds({ x: 300, y: 200, ...BASE });
    await wait(450);
    let resizes = 0;
    const onResize = () => { resizes += 1; };
    win.on('resize', onResize);
    const sizes = new Set();
    for (let i = 1; i <= 12; i++) {
      const cur = win.getBounds();
      win.setBounds({ x: cur.x + step.dx, y: cur.y + step.dy, width: BASE.width, height: BASE.height });
      await wait(85);
      const b = win.getBounds();
      sizes.add(`${b.width}x${b.height}`);
    }
    win.off('resize', onResize);
    await wait(250);
    results.push({ name: step.name, resizes, sizes: [...sizes] });
    flush({ display: { workArea: `${d.workArea.width}x${d.workArea.height}`, scaleFactor: d.scaleFactor } });
  }

  flush({ done: true, display: { workArea: `${d.workArea.width}x${d.workArea.height}`, scaleFactor: d.scaleFactor } });
  console.log('JITTER_DONE');
  app.exit(0);
}).catch((error) => { flush({ fatal: String(error && error.stack) }); app.exit(1); });
setTimeout(() => { flush({ timeout: true }); app.exit(2); }, 150000);
