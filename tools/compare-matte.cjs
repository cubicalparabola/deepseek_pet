// @ts-check
/**
 * 旧蒙版(luma=alpha) vs 新蒙版(分段 lo=8 hi=48) 的并排对比图，棋盘底。
 * 用法：npx electron tools/compare-matte.cjs idle
 * 输出：build/matte/<clip>-compare.png
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const clip = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'idle';
const backup = join(root, 'build', 'matte', 'alpha-v1-backup', `${clip}.webm`);
const current = join(root, 'assets', 'animations', `${clip}.webm`);
const outDir = join(root, 'build', 'matte');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const items = [
  { label: '旧: alpha = 亮度 (整体发虚)', file: existsSync(backup) ? backup : null },
  { label: '新: 分段蒙版 8..48 (实体不透明)', file: current },
].filter((i) => i.file);

const pageFile = join(outDir, 'compare.html');
const html = `<!doctype html><html><body><canvas id="c"></canvas><script>
window.__RUN__ = async function (items) {
  const out = { stats: [] };
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const loaded = [];
  for (const item of items) {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.src = 'file:///' + item.file.replace(/\\\\/g, '/');
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 15000);
      video.onloadeddata = () => { clearTimeout(t); res(); };
      video.onerror = () => { clearTimeout(t); rej(new Error('media error')); };
    });
    video.currentTime = Math.min(1.5, (video.duration || 3) * 0.3);
    await new Promise((res) => { const t = setTimeout(res, 2000); video.onseeked = () => { clearTimeout(t); res(); }; });
    await new Promise((r) => setTimeout(r, 120));
    loaded.push({ label: item.label, video });
  }
  const v0 = loaded[0].video;
  const scale = 470 / v0.videoWidth;
  const w = Math.round(v0.videoWidth * scale), h = Math.round(v0.videoHeight * scale);
  const pad = 8;
  canvas.width = w * loaded.length + pad * (loaded.length + 1);
  canvas.height = h + pad * 2 + 26;
  // 棋盘底
  const cell = 18;
  ctx.fillStyle = '#9a9a9a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#6f6f6f';
  for (let y = 0; y < canvas.height; y += cell) {
    for (let x = 0; x < canvas.width; x += cell) {
      if (((x / cell | 0) + (y / cell | 0)) % 2 === 0) ctx.fillRect(x, y, cell, cell);
    }
  }
  loaded.forEach((entry, i) => {
    const x = pad + i * (w + pad);
    ctx.drawImage(entry.video, x, pad, w, h);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 19px sans-serif';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
    ctx.strokeText(entry.label, x + 4, pad + h + 21);
    ctx.fillText(entry.label, x + 4, pad + h + 21);
  });
  // alpha 统计要在独立透明画布上做（棋盘底会让 alpha 恒为 255）
  for (const entry of loaded) {
    const probe = document.createElement('canvas');
    probe.width = entry.video.videoWidth; probe.height = entry.video.videoHeight;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.clearRect(0, 0, probe.width, probe.height);
    pctx.drawImage(entry.video, 0, 0);
    const d = pctx.getImageData(0, 0, probe.width, probe.height).data;
    let zero = 0, semi = 0, opaque = 0;
    for (let p = 3; p < d.length; p += 4) {
      const a = d[p];
      if (a === 0) zero++; else if (a === 255) opaque++; else semi++;
    }
    const total = probe.width * probe.height;
    out.stats.push({
      label: entry.label,
      transparentPct: +(zero / total * 100).toFixed(1),
      semiPct: +(semi / total * 100).toFixed(1),
      opaquePct: +(opaque / total * 100).toFixed(1),
    });
  }
  out.sheet = canvas.toDataURL('image/png');
  return out;
};
</script></body></html>`;
mkdirSync(outDir, { recursive: true });
writeFileSync(pageFile, html, 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false });
  await win.loadFile(pageFile);
  const result = await win.webContents.executeJavaScript(`window.__RUN__(${JSON.stringify(items)})`, true);
  const base64 = String(result.sheet).replace(/^data:image\/png;base64,/, '');
  const target = join(outDir, `${clip}-compare.png`);
  writeFileSync(target, Buffer.from(base64, 'base64'));
  console.log('wrote ' + target);
  console.log(JSON.stringify(result.stats, null, 1));
  app.exit(0);
}).catch((error) => { console.error('FAILED', error); app.exit(1); });
setTimeout(() => app.exit(2), 120000);
