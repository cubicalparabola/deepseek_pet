// @ts-check
/**
 * 逐帧录制：把切段过程录成"每帧一个哈希 + 若干统计量"，用来精确定位闪烁帧。
 *
 * 为什么需要它：采样 alpha 只能说明"整体透明了多少"，
 * 无法判断"某一帧画面与前后帧是否突兀"。这里改成：
 *   1. 用 requestAnimationFrame **每帧**抓一次可见缓冲；
 *   2. 每帧算一个退化哈希（缩小到 8x8 灰度后取整数），用于比较帧间差异；
 *   3. 同时记录该帧的 alpha 均值/不透明占比/时间轴；
 *   4. 标注"与前后帧都明显不同"的帧 —— 那就是可见的闪烁帧。
 *
 * 用法：npx electron tools/capture-frames.cjs read
 * 输出：build/frame-capture.json，并把异常帧导出为 build/frames-capture/*.png
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'frame-capture.json');
const pngDir = join(root, 'build', 'frames-capture');
const animationId = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'read';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 6000));
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    writeFileSync(outFile, JSON.stringify({ fatal: 'no window' }), 'utf8');
    app.exit(1);
    return;
  }

  const result = await win.webContents.executeJavaScript(
    `(async () => {
      const anim = window.petDebug.anim;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const visible = () => document.querySelector('#pet-stage video.layer-active');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const W = 96, H = 128;
      canvas.width = W; canvas.height = H;

      // 8x8 灰度指纹
      const hashOf = (data) => {
        const cells = [];
        const cw = W / 8, ch = H / 8;
        for (let cy = 0; cy < 8; cy++) {
          for (let cx = 0; cx < 8; cx++) {
            let sum = 0, n = 0;
            for (let y = Math.floor(cy * ch); y < Math.floor((cy + 1) * ch); y++) {
              for (let x = Math.floor(cx * cw); x < Math.floor((cx + 1) * cw); x++) {
                const i = (y * W + x) * 4;
                sum += (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) * (data[i + 3] / 255);
                n++;
              }
            }
            cells.push(Math.round(sum / Math.max(1, n) / 4) * 4);
          }
        }
        return cells;
      };
      const hashDiff = (a, b) => {
        let sum = 0;
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
        return sum / a.length;
      };

      const frames = [];
      anim.resetCooldowns();
      await anim.play('${animationId}', { interrupt: 'force', reason: 'capture' });

      const t0 = performance.now();
      let running = true;
      const tick = () => {
        if (!running) return;
        const v = visible();
        if (v && v.videoWidth) {
          ctx.clearRect(0, 0, W, H);
          ctx.drawImage(v, 0, 0, W, H);
          const img = ctx.getImageData(0, 0, W, H);
          const d = img.data;
          let aSum = 0, opaque = 0, nonZero = 0;
          for (let i = 3; i < d.length; i += 4) {
            aSum += d[i];
            if (d[i] === 255) opaque++;
            if (d[i] > 0) nonZero++;
          }
          const total = W * H;
          frames.push({
            t: Number((performance.now() - t0).toFixed(1)),
            id: v.id,
            rs: v.readyState,
            ct: Number(v.currentTime.toFixed(3)),
            meanAlpha: Number((aSum / total).toFixed(1)),
            opaquePct: Number(((opaque / total) * 100).toFixed(1)),
            coverPct: Number(((nonZero / total) * 100).toFixed(1)),
            phase: anim.getPersistentPhase(),
            hash: hashOf(d),
            png: img.width && frames.length < 0 ? null : null,
          });
        } else {
          frames.push({ t: Number((performance.now() - t0).toFixed(1)), id: null, rs: 0, ct: 0, meanAlpha: 0, opaquePct: 0, coverPct: 0, phase: anim.getPersistentPhase(), hash: null });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await wait(13000);
      running = false;

      // 找异常帧：与前后各 2 帧的平均差异明显偏大（局部突变）
      const anomalies = [];
      for (let i = 2; i < frames.length - 2; i++) {
        const f = frames[i];
        if (!f.hash) { anomalies.push({ i, t: f.t, reason: 'no-frame', id: f.id, rs: f.rs }); continue; }
        const prev2 = frames[i - 2].hash, prev1 = frames[i - 1].hash, next1 = frames[i + 1].hash, next2 = frames[i + 2].hash;
        if (!prev1 || !next1) continue;
        const dPrev = hashDiff(f.hash, prev1);
        const dNext = hashDiff(f.hash, next1);
        const dNeighbors = prev2 && next2 ? hashDiff(prev1, next1) : 0;
        // 与两侧都差、且比"邻居之间的差异"大很多 -> 局部突变
        if (dPrev > 3 && dNext > 3 && dPrev > dNeighbors * 3 + 2) {
          anomalies.push({ i, t: f.t, reason: 'spike', dPrev: Number(dPrev.toFixed(2)), dNext: Number(dNext.toFixed(2)), dNeighbors: Number(dNeighbors.toFixed(2)), meanAlpha: f.meanAlpha, coverPct: f.coverPct, id: f.id, rs: f.rs, ct: f.ct, phase: f.phase });
        }
      }

      // 阶段切换点前后的逐帧明细
      const marks = [];
      let lastPhase = null;
      for (const f of frames) {
        if (f.phase !== lastPhase) { marks.push({ phase: f.phase, t: f.t, index: frames.indexOf(f) }); lastPhase = f.phase; }
      }
      const windows = marks.map((m) => ({
        mark: m,
        frames: frames.slice(Math.max(0, m.index - 6), m.index + 12).map((f) => ({ t: f.t, id: f.id, rs: f.rs, ct: f.ct, ma: f.meanAlpha, cover: f.coverPct, phase: f.phase })),
      }));

      return {
        animationId: '${animationId}',
        frameCount: frames.length,
        marks,
        anomalyCount: anomalies.length,
        anomalies: anomalies.slice(0, 20),
        windows,
      };
    })()`,
    true,
  );

  mkdirSync(join(root, 'build'), { recursive: true });
  mkdirSync(pngDir, { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');

  console.log('=== 逐帧录制诊断 ===');
  console.log('帧数:', result.frameCount);
  console.log('阶段切换:', JSON.stringify(result.marks));
  console.log('异常帧数:', result.anomalyCount);
  for (const a of result.anomalies) console.log('  anomaly:', JSON.stringify(a));
  for (const w of result.windows) {
    console.log(`--- ${w.mark.phase} @${w.mark.t}ms 前后逐帧 ---`);
    for (const f of w.frames) {
      console.log(`  t=${String(f.t).padStart(8)} id=${f.id} rs=${f.rs} ct=${String(f.ct).padStart(6)} 均alpha=${String(f.ma).padStart(6)} 覆盖=${String(f.cover).padStart(5)}%`);
    }
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
