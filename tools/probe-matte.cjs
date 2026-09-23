// @ts-check
/**
 * 对比「alpha 蒙版」的不同做法，输出并排对比图供人工判断。
 *
 * 背景：
 * 素材是 premultiplied alpha 渲染到纯黑底。之前用 `alpha = luma`，
 * 结果角色本身的深色部分（头发/描边，luma 很低）也被判成半透明，
 * 整个角色看起来发虚（半透明）。
 *
 * 但角色内部本来就应该是**不透明**的。所以应该用「分段蒙版」：
 *   luma > threshold        -> alpha 255（角色实体，完全不透明）
 *   nearBlack < luma <= t   -> 保留 luma（阴影/软边，真实半透明）
 *   luma <= nearBlack       -> alpha 0（纯黑背景，全透明）
 *
 * 跑法：npx electron tools/probe-matte.cjs [clip]
 * 输出：build/matte/<clip>-variants.png（并排对比）
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const root = join(__dirname, '..');
const clip = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'idle';
const srcDir = join(root, 'assets', 'animations', 'source-premultiplied');
const outDir = join(root, 'build', 'matte');
const tmpDir = join(outDir, 'tmp');

app.disableHardwareAcceleration();

/** 生成一张 RGBA PNG：反预乘颜色 + 分段蒙版 alpha。 */
function makeVariant(name, filter) {
  const output = join(tmpDir, `${name}.png`);
  execFileSync('ffmpeg', [
    '-hide_banner', '-v', 'error', '-y',
    '-ss', '2.0', '-i', join(srcDir, `${clip}.webm`),
    '-frames:v', '1',
    '-filter_complex', filter,
    '-map', '[out]', '-pix_fmt', 'rgba', output,
  ]);
  return output;
}

const k = 'max(1,max(max(r(X,Y),g(X,Y)),b(X,Y)))';
const unpremul = `format=gbrp,geq=r='r(X,Y)*255/${k}':g='g(X,Y)*255/${k}':b='b(X,Y)*255/${k}',format=rgb24[rgb]`;
const luma = 'format=gray';

/** 分段蒙版：luma 低于 lo 全透明，高于 hi 全不透明，中间线性过渡。 */
function steppy(lo, hi) {
  return `format=gray,lut=y='if(lt(val,${lo}),0,if(gt(val,${hi}),255,255*(val-${lo})/(${hi}-${lo})))'`;
}

const variants = [
  {
    label: 'A luma=alpha (当前, 发虚)',
    filter: `[0:v]${luma}[matte];[0:v]${unpremul};[rgb][matte]alphamerge,format=rgba[out]`,
  },
  {
    label: `B 分段 lo=8 hi=48`,
    filter: `[0:v]${steppy(8, 48)}[matte];[0:v]${unpremul};[rgb][matte]alphamerge,format=rgba[out]`,
  },
  {
    label: `C 分段 lo=8 hi=96`,
    filter: `[0:v]${steppy(8, 96)}[matte];[0:v]${unpremul};[rgb][matte]alphamerge,format=rgba[out]`,
  },
  {
    label: `D 分段 lo=16 hi=64`,
    filter: `[0:v]${steppy(16, 64)}[matte];[0:v]${unpremul};[rgb][matte]alphamerge,format=rgba[out]`,
  },
];

mkdirSync(tmpDir, { recursive: true });

const files = [];
for (const variant of variants) {
  try {
    files.push({ label: variant.label, file: makeVariant(variant.label.split(' ')[0], variant.filter) });
  } catch (error) {
    console.error('variant failed', variant.label, error.message);
  }
}

const items = files.map((f) => ({ label: f.label, file: 'file:///' + f.file.replace(/\\/g, '/') }));

const pageFile = join(outDir, 'sheet.html');
const html = `<!doctype html><html><body><canvas id="c"></canvas><script>
window.__RUN__ = async function (items) {
  const out = [];
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const loaded = [];
  for (const item of items) {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = item.file; });
    // 关键：alpha 必须在**独立**的透明画布上读取。
    // 直接读合成用的棋盘画布永远得到 255（棋子是不透明的）。
    const probe = document.createElement('canvas');
    probe.width = img.naturalWidth; probe.height = img.naturalHeight;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.clearRect(0, 0, probe.width, probe.height);
    pctx.drawImage(img, 0, 0);
    const data = pctx.getImageData(0, 0, probe.width, probe.height).data;
    const alphaAt = (x, y) => data[((y * probe.width + x) * 4) + 3];
    let zero = 0, semi = 0, opaque = 0;
    for (let p = 3; p < data.length; p += 4) {
      const a = data[p];
      if (a === 0) zero++; else if (a === 255) opaque++; else semi++;
    }
    const total = probe.width * probe.height;
    loaded.push({
      label: item.label,
      img,
      stats: {
        transparentPct: +(zero / total * 100).toFixed(1),
        semiPct: +(semi / total * 100).toFixed(1),
        opaquePct: +(opaque / total * 100).toFixed(1),
        cornerAlpha: alphaAt(2, 2),
        centerAlpha: alphaAt(probe.width >> 1, Math.round(probe.height * 0.45)),
      },
    });
  }
  const first = loaded[0].img;
  const scale = 420 / first.naturalWidth;
  const w = Math.round(first.naturalWidth * scale), h = Math.round(first.naturalHeight * scale);
  const pad = 6;
  canvas.width = w * loaded.length + pad * (loaded.length + 1);
  canvas.height = h + pad * 2 + 24;
  // 棋盘底：既能看到透明，也能看出半透明
  const cell = 16;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x += 1) {
      // 用 fillRect 批量画太慢，这里用两色交替的小块
    }
  }
  ctx.fillStyle = '#8a8a8a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#6e6e6e';
  for (let y = 0; y < canvas.height; y += cell) {
    for (let x = 0; x < canvas.width; x += cell) {
      if (((x / cell) + (y / cell)) % 2 === 0) ctx.fillRect(x, y, cell, cell);
    }
  }
  loaded.forEach((entry, i) => {
    const x = pad + i * (w + pad);
    ctx.drawImage(entry.img, x, pad, w, h);
    out.push({ label: entry.label, ...entry.stats });
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px sans-serif';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
    ctx.strokeText(entry.label, x + 4, pad + h + 20);
    ctx.fillText(entry.label, x + 4, pad + h + 20);
  });
  return { stats: out, sheet: canvas.toDataURL('image/png') };
};
</script></body></html>`;
writeFileSync(pageFile, html, 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1600, height: 1200, show: false });
  await win.loadFile(pageFile);
  const result = await win.webContents.executeJavaScript(`window.__RUN__(${JSON.stringify(items)})`, true);
  const base64 = String(result.sheet).replace(/^data:image\/png;base64,/, '');
  const target = join(outDir, `${clip}-variants.png`);
  writeFileSync(target, Buffer.from(base64, 'base64'));
  console.log('wrote ' + target);
  console.log(JSON.stringify(result.stats, null, 1));
  app.exit(0);
}).catch((error) => {
  console.error('FAILED', error);
  app.exit(1);
});
setTimeout(() => app.exit(2), 120000);
