// @ts-check
/**
 * 定位「动画播放前后各闪一下」。
 *
 * 思路：在真实桌宠里切换动画，逐帧把 <video> 画到离屏 canvas 上并统计
 *   - 不透明像素数（画面内容是否变空）
 *   - 元素的可见性 / currentSrc / readyState
 * 从而判断"闪"是出现在
 *   (a) 换源后视频纹理为空的期间，还是
 *   (b) 播放结束后的收尾。
 *
 * 用法：npx electron tools/diag-switch-flicker.cjs
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'diag-switch.json');
app.disableHardwareAcceleration();
require(join(root, 'dist', 'main', 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function flush(payload) {
  try {
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(outFile, JSON.stringify(payload, null, 1), 'utf8');
  } catch (error) { console.error('flush failed', error); }
}
process.on('uncaughtException', (error) => { flush({ fatal: String(error && error.stack) }); app.exit(1); });

app.whenReady().then(async () => {
  await wait(8000);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const result = await js(`(async () => {
    const anim = window.petDebug.anim;

    /*
     * 双缓冲后，"当前可见"的 <video> 可能在 A/B 之间切换，
     * 因此每次采样都要重新取 .layer-active 的那个。
     */
    const activeVideo = () => document.querySelector('video.layer-active') || document.getElementById('pet-video');

    const probe = document.createElement('canvas');
    const pctx = probe.getContext('2d', { willReadFrequently: true });

    const sample = (label) => {
      const video = activeVideo();
      const cs = getComputedStyle(video);
      let nonZeroAlpha = null;
      let maxAlpha = null;
      if (video.videoWidth > 0 && video.readyState >= 2) {
        probe.width = video.videoWidth;
        probe.height = video.videoHeight;
        pctx.clearRect(0, 0, probe.width, probe.height);
        pctx.drawImage(video, 0, 0);
        const d = pctx.getImageData(0, 0, probe.width, probe.height).data;
        nonZeroAlpha = 0;
        maxAlpha = 0;
        for (let i = 3; i < d.length; i += 4) {
          const a = d[i];
          if (a > 0) nonZeroAlpha += 1;
          if (a > maxAlpha) maxAlpha = a;
        }
      }
      return {
        label,
        id: video.id,
        src: (video.currentSrc || '').split('/').pop(),
        readyState: video.readyState,
        opacity: cs.opacity,
        videoActive: video.classList.contains('layer-active'),
        nonZeroAlpha,
        maxAlpha,
      };
    };

    const frames = [];
    let sampling = false;
    const loop = () => {
      if (!sampling) return;
      frames.push(sample('t+' + frames.length));
      requestAnimationFrame(loop);
    };

    const out = { before: sample('idle-before') };

    // 切换动画：idle -> cute（触发换源），再切回 idle（复用同素材路径）
    sampling = true;
    requestAnimationFrame(loop);
    await anim.play('cute', { priority: 50, interrupt: 'force', reason: 'diag' });
    await new Promise((r) => setTimeout(r, 1200));
    await anim.play('idle', { priority: 0, interrupt: 'force', reason: 'diag' });
    await new Promise((r) => setTimeout(r, 1200));
    sampling = false;

    // "空画面"帧：元素可见但没有任何不透明像素（就是肉眼看到的闪）
    const visibleBlank = frames.filter((f) => f.videoActive && f.opacity !== '0' && f.nonZeroAlpha === 0);
    // 没有可用纹理但可见（readyState < 2）
    const noTextureVisible = frames.filter((f) => f.videoActive && f.readyState < 2 && f.opacity !== '0');
    // 两个缓冲都不可见 = 整个视频层消失
    const noneActive = frames.filter((f) => !f.videoActive);
    return {
      before: out.before,
      frameCount: frames.length,
      visibleBlankFrames: visibleBlank.length,
      noTextureVisibleFrames: noTextureVisible.length,
      noneActiveFrames: noneActive.length,
      firstFrames: frames.slice(0, 20).map((f) => \`\${f.label} id=\${f.id} src=\${f.src} rs=\${f.readyState} op=\${f.opacity} act=\${f.videoActive} nz=\${f.nonZeroAlpha}\`),
    };
  })()`, true);

  flush(result);
  console.log(JSON.stringify({
    before: result.before,
    frameCount: result.frameCount,
    visibleBlankFrames: result.visibleBlankFrames,
    noTextureVisibleFrames: result.noTextureVisibleFrames,
    noneActiveFrames: result.noneActiveFrames,
    firstFrames: result.firstFrames,
  }, null, 1));
  app.exit(0);
}).catch((error) => { flush({ fatal: String(error && error.stack) }); app.exit(1); });
setTimeout(() => { flush({ timeout: true }); app.exit(2); }, 150000);
