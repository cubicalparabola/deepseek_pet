// @ts-check
/**
 * 视觉验证：确认背景扣除后，画面四角与边缘是**真正透明**的，
 * 而角色区域不透明 —— 这是"桌宠不再有黑方块"的硬证据。
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'visual.json');
const { guardSingleInstance } = require('./lib/instance-guard.cjs');

app.disableHardwareAcceleration();
// 没有这一步：已有实例时 require(main.js) 会静默 app.quit()，结果文件保持上一次内容
guardSingleInstance(app, {
  onBlocked: (message) => {
    try { writeFileSync(outFile, JSON.stringify({ fatal: message }, null, 1), 'utf8'); } catch (error) { /* 忽略 */ }
  },
});
require(join(root, 'dist', 'main', 'main.js'));

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 8000));
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    writeFileSync(outFile, JSON.stringify({ fatal: 'no window' }), 'utf8');
    return app.exit(1);
  }

  const result = await win.webContents.executeJavaScript(`(() => {
    const video = document.getElementById('pet-video');
    const w = video.videoWidth, h = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(video, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const alphaAt = (x, y) => data[(y * w + x) * 4 + 3];

    let opaque = 0, semi = 0, transparent = 0;
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      if (a === 0) transparent++;
      else if (a === 255) opaque++;
      else semi++;
    }
    const total = w * h;

    // 角色包围盒（alpha > 16）
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alphaAt(x, y) > 16) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    // 边缘 alpha（四角 + 四条边中点）
    const edges = {
      topLeft: alphaAt(0, 0),
      topRight: alphaAt(w - 1, 0),
      bottomLeft: alphaAt(0, h - 1),
      bottomRight: alphaAt(w - 1, h - 1),
      topMid: alphaAt(w >> 1, 0),
      leftMid: alphaAt(0, h >> 1),
      rightMid: alphaAt(w - 1, h >> 1),
      bottomMid: alphaAt(w >> 1, h - 1),
    };

    // 角色中心区域 alpha（应当不透明）
    const centerAlpha = alphaAt(w >> 1, Math.round(h * 0.45));

    return {
      source: { w, h },
      windowSize: { w: window.innerWidth, h: window.innerHeight },
      videoMixBlendMode: getComputedStyle(video).mixBlendMode,
      pctOpaque: +(opaque / total * 100).toFixed(1),
      pctSemi: +(semi / total * 100).toFixed(1),
      pctTransparent: +(transparent / total * 100).toFixed(1),
      bbox: { minX, minY, maxX, maxY, widthPct: +(((maxX - minX) / w) * 100).toFixed(1), heightPct: +(((maxY - minY) / h) * 100).toFixed(1) },
      edges,
      maxEdgeAlpha: Math.max(...Object.values(edges)),
      centerAlpha,
      animation: window.petApp ? window.petApp.describe() : null,
    };
  })()`, true);

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log(JSON.stringify(result, null, 1));
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error && error.stack) }), 'utf8');
  app.exit(1);
});

setTimeout(() => app.exit(2), 60000);
