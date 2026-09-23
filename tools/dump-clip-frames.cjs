// @ts-check
/**
 * 把若干素材的关键帧合成网格图，便于人工确认动作内容。
 * 用法：npx electron tools/dump-clip-frames.cjs talk stroke peek
 * 输出：build/frames/<name>.png
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const clips = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const assetsDir = join(root, 'assets', 'animations');
const outDir = join(root, 'build', 'frames');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const pageFile = join(outDir, 'dump.html');
const html = `<!doctype html><html><body><canvas id="c"></canvas><script>
window.__RUN__ = async function (base, clips) {
  const out = {};
  const canvas = document.getElementById('c');
  for (const clip of clips) {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.src = base + '/' + clip + '.webm';
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout ' + clip)), 20000);
      video.onloadeddata = () => { clearTimeout(t); res(); };
      video.onerror = () => { clearTimeout(t); rej(new Error('media error ' + clip)); };
    });
    const w = video.videoWidth, h = video.videoHeight;
    const cols = 4, rows = 2;
    const scale = 300 / h;
    const cw = Math.round(w * scale), ch = 300;
    const sheet = document.createElement('canvas');
    sheet.width = cw * cols; sheet.height = ch * rows;
    const sx = sheet.getContext('2d');
    // 中灰底：透明处露灰，便于判断抠图
    sx.fillStyle = '#7a7a7a'; sx.fillRect(0, 0, sheet.width, sheet.height);
    const duration = video.duration || 6;
    for (let i = 0; i < cols * rows; i++) {
      video.currentTime = Math.min(duration * 0.98, (duration * (i + 1)) / (cols * rows + 1));
      await new Promise((res) => { const t = setTimeout(res, 2000); video.onseeked = () => { clearTimeout(t); res(); }; });
      await new Promise((r) => setTimeout(r, 60));
      sx.drawImage(video, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch);
    }
    out[clip] = await new Promise((res) => sheet.toBlob(async (b) => res(await b.arrayBuffer()), 'image/png'));
  }
  return out;
};
</script></body></html>`;

mkdirSync(outDir, { recursive: true });
writeFileSync(pageFile, html, 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 800, show: false });
  await win.loadFile(pageFile);
  const base = 'file:///' + assetsDir.replace(/\\/g, '/');
  const result = await win.webContents.executeJavaScript(
    `window.__RUN__(${JSON.stringify(base)}, ${JSON.stringify(clips)})`,
    true,
  );
  for (const [clip, data] of Object.entries(result)) {
    const target = join(outDir, `${clip}.png`);
    writeFileSync(target, Buffer.from(data));
    console.log('wrote ' + target);
  }
  app.exit(0);
}).catch((error) => {
  console.error('FAILED', error);
  app.exit(1);
});
setTimeout(() => app.exit(2), 180000);
