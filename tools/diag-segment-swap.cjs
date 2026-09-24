// @ts-check
/**
 * 诊断：**切段瞬间**（start->loop、loop->end）为什么闪？
 *
 * 与 diag-persistent-flicker 的区别：那个只看"当前可见缓冲"的 alpha；
 * 这里要同时盯**两个缓冲**，并且以 8ms 高频采样，看清交换前后到底发生了什么：
 *   - 哪个缓冲带 .layer-active
 *   - 两个缓冲各自的 readyState / currentTime / 采样 alpha
 *   - 交换瞬间是否出现"两个都不可见"或"可见的那个没内容"
 *
 * 用法：npx electron tools/diag-segment-swap.cjs read
 * 输出：build/segment-swap.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'segment-swap.json');
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
      const bus = window.petDebug.bus;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const videos = () => Array.from(document.querySelectorAll('#pet-stage video'));
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const alphaOf = (v) => {
        if (!v || !v.videoWidth) return null;
        const w = 40, h = 54;
        if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
        ctx.clearRect(0, 0, w, h);
        try { ctx.drawImage(v, 0, 0, w, h); } catch { return null; }
        const d = ctx.getImageData(0, 0, w, h).data;
        let sum = 0, opaque = 0;
        for (let i = 3; i < d.length; i += 4) { sum += d[i]; if (d[i] === 255) opaque++; }
        const total = w * h;
        return { mean: Number((sum / total).toFixed(1)), opaquePct: Number(((opaque / total) * 100).toFixed(1)) };
      };

      const snapshot = (at) => {
        const list = videos().map((v) => ({
          id: v.id,
          active: v.classList.contains('layer-active'),
          rs: v.readyState,
          t: Number(v.currentTime.toFixed(3)),
          paused: v.paused,
          loop: v.loop,
          src: String(v.currentSrc || v.src || '').split('/').pop() || null,
          alpha: alphaOf(v),
        }));
        return { at, videos: list };
      };

      anim.resetCooldowns();
      const samples = [];
      const timer = setInterval(() => samples.push(snapshot(Date.now())), 8);
      const t0 = Date.now();

      // 记录段落切换事件（用 phase 变化做标记）
      const phaseMarks = [];
      let lastPhase = null, lastSrc = null;
      const phaseTimer = setInterval(() => {
        const p = anim.getPersistentPhase();
        const s = anim.getActiveSource();
        if (p !== lastPhase || s !== lastSrc) {
          phaseMarks.push({ at: Date.now() - t0, phase: p, source: s });
          lastPhase = p; lastSrc = s;
        }
      }, 4);

      await anim.play('${animationId}', { interrupt: 'force', reason: 'swap-diag' });
      // 覆盖：开场 -> 循环 -> （至少一轮）-> 收尾 -> 结束
      await wait(14000);

      clearInterval(timer);
      clearInterval(phaseTimer);

      // 找出"两个 buffer 都没有可见内容"的帧（真实闪白/闪透明的特征）
      const badFrames = samples.filter((s) => {
        const active = s.videos.find((v) => v.active);
        if (!active) return true;                                  // 没有可见缓冲
        if (active.rs < 2) return true;                            // 可见缓冲没解码数据
        if (active.alpha && active.alpha.mean < 1) return true;    // 可见缓冲全透明
        return false;
      }).map((s) => ({ at: s.at - t0, videos: s.videos.map((v) => ({ id: v.id, active: v.active, rs: v.rs, t: v.t, src: v.src, mean: v.alpha ? v.alpha.mean : null })) }));

      // 每个 phase 切换点前后各取 200ms 的样本
      const windows = phaseMarks.map((m) => ({
        mark: m,
        frames: samples
          .filter((s) => Math.abs(s.at - t0 - m.at) <= 200)
          .map((s) => ({
            d: s.at - t0 - m.at,
            v: s.videos.map((v) => \`\${v.id}\${v.active ? '*' : ''}:rs\${v.rs},t\${v.t},\${v.alpha ? v.alpha.mean : 'na'}\`).join(' | '),
          })),
      }));

      return {
        animationId: '${animationId}',
        sampleCount: samples.length,
        phaseMarks,
        badFrameCount: badFrames.length,
        badFrames: badFrames.slice(0, 10),
        windows,
      };
    })()`,
    true,
  );

  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');

  console.log('=== 切段闪烁诊断 ===');
  console.log('样本数:', result.sampleCount);
  console.log('阶段变化点:', JSON.stringify(result.phaseMarks));
  console.log('"无可见内容"的帧数:', result.badFrameCount);
  for (const b of result.badFrames.slice(0, 5)) console.log('  bad @', b.at, 'ms', JSON.stringify(b.videos));
  for (const w of result.windows) {
    console.log(`--- 切换 phase=${w.mark.phase} src=${String(w.mark.source).split('/').pop()} @${w.mark.at}ms 前后 200ms ---`);
    for (const f of w.frames.filter((_, i) => i % 3 === 0)) console.log(`  d=${String(f.d).padStart(5)}ms  ${f.v}`);
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
