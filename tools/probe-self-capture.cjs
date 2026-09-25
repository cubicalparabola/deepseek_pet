// @ts-check
/**
 * 探针：**桌宠自己会不会出现在她自己的感知画面里**？——以及"把她涂掉"到底有没有用。
 *
 * ## 为什么需要这个探针
 *
 * 面板上写着"让桌宠不出现在截屏/录屏里（她不会出现在自己的感知画面里）"，
 * 实现是 `setContentProtection(true)`（Windows `WDA_EXCLUDEFROMCAPTURE`）。
 * 但这个 API 挡的是**别的进程**的截屏/录屏 —— 我们自己 `desktopCapturer` 截出来的帧里
 * 她**照样在**（本探针就是这条结论的证据）。于是模型每帧都能在画面角落看到一只鲸鱼娘。
 * 线上因此在把图交给模型之前**把她的矩形涂掉**（`ScreenCapture.maskSelf`）。
 *
 * ## 怎么量（这里踩过两次坑，别再改回去）
 *
 * 1. **不能只看"可见 vs 隐藏"的差异**：页面自己会动，第一次就是被动画噪声骗了。
 *    必须量两条：同样的画面隔 1.5s 的**噪声**（页面动画），与"可见 vs 隐藏"的**信号**；
 *    信号要明显大于噪声（这里用 `signal > max(4, noise * 2)`）。
 * 2. **必须确认她真的渲染了**：`win.capturePage()` 的不透明像素比例。
 *    漏掉 autoplay 开关时（前面的探针就漏了）她根本没画出来，探针会得出反向结论。
 *
 * 用法：npx electron tools/probe-self-capture.cjs
 * 输出：build/self-capture.json + build/self-capture-*.png（桌宠那块"她的样子"与"屏幕里的样子"）
 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'self-capture.json');
const { guardSingleInstance } = require('./lib/instance-guard.cjs');
const dataDir = join(tmpdir(), 'desktop-pet-probe-self-capture');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
// ⚠️ 少了这一条，桌宠的 idle 视频不会自动播放 → 窗口全透明 → 探针结论完全反过来
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
guardSingleInstance(app, {
  onBlocked: (message) => {
    try { writeFileSync(outFile, JSON.stringify({ fatal: message }, null, 1), 'utf8'); } catch (error) { /* 忽略 */ }
  },
});
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function grabScreen() {
  const primary = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(primary.size.width * primary.scaleFactor),
      height: Math.round(primary.size.height * primary.scaleFactor),
    },
    fetchWindowIcons: false,
  });
  const source = sources.find((item) => String(item.display_id) === String(primary.id)) ?? sources[0];
  return { image: source.thumbnail, primary };
}

/** 一块区域的平均绝对差（三通道平均）。 */
function regionDiff(a, b, size, rect) {
  let sum = 0;
  let count = 0;
  for (let y = rect.y; y < Math.min(size.height, rect.y + rect.height); y++) {
    for (let x = rect.x; x < Math.min(size.width, rect.x + rect.width); x++) {
      const i = (y * size.width + x) * 4;
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      count += 3;
    }
  }
  return count > 0 ? sum / count : 0;
}

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('桌宠窗口不存在');
  const run = (js) => win.webContents.executeJavaScript(js, true);

  await run(`(() => { window.petAPI.window.show(); return true; })()`);
  await wait(2000);

  // A) 她自己渲染出东西了吗（不透明像素比例）
  const own = await win.capturePage();
  const ownBitmap = own.toBitmap();
  let opaque = 0;
  for (let i = 3; i < ownBitmap.length; i += 4) if ((ownBitmap[i] ?? 0) > 16) opaque += 1;
  const ownWindowOpaqueRatio = ownBitmap.length > 0 ? opaque / (ownBitmap.length / 4) : 0;
  writeFileSync(join(root, 'build', 'self-capture-own-window.png'), own.toPNG());

  const bounds = win.getBounds();
  const first = await grabScreen();
  const size = first.image.getSize();
  const scale = size.width / first.primary.size.width;
  const region = {
    x: Math.max(0, Math.round(bounds.x * scale)),
    y: Math.max(0, Math.round(bounds.y * scale)),
    width: Math.min(size.width, Math.round(bounds.width * scale)),
    height: Math.min(size.height, Math.round(bounds.height * scale)),
  };
  writeFileSync(join(root, 'build', 'self-capture-in-screen.png'), first.image.crop(region).toPNG());

  // B) 噪声（页面自身动画）vs 信号（她）
  await wait(1500);
  const second = await grabScreen();
  win.hide();
  await wait(1500);
  const hiddenShot = await grabScreen();
  win.show();

  const noise = regionDiff(first.image.toBitmap(), second.image.toBitmap(), size, region);
  const signal = regionDiff(first.image.toBitmap(), hiddenShot.image.toBitmap(), size, region);
  const captured = signal > Math.max(4, noise * 2);
  const result = {
    petBoundsDip: bounds,
    imageSize: size,
    pixelsPerDip: Number(scale.toFixed(3)),
    petRegionPx: region,
    ownWindowOpaqueRatio: Number(ownWindowOpaqueRatio.toFixed(4)),
    pageNoiseMeanAbsDiff: Number(noise.toFixed(2)),
    visibleVsHiddenMeanAbsDiff: Number(signal.toFixed(2)),
    verdict: captured ? 'pet-is-captured' : 'pet-not-captured',
    note: captured
      ? '自家 desktopCapturer 会截到桌宠：线上靠 ScreenCapture.maskSelf 把她的矩形涂掉'
      : '这次没截到她（请先确认 ownWindowOpaqueRatio 足够大，否则可能是她根本没渲染）',
  };
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('[result]', JSON.stringify(result, null, 1));
  app.exit(captured && ownWindowOpaqueRatio > 0.05 ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 90000);
