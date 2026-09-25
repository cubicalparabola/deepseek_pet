// @ts-check
/**
 * 探针：**肉眼看"窗口特写"到底能不能读清文字**，并留下两张同尺寸对照图。
 *
 * 为什么要单独看一眼：这条链路的成败在像素上，不在断言里 ——
 * "整屏缩到 640 宽"与"按原分辨率截窗口那块"给到视觉模型的文字清晰度差一个量级，
 * 只有把两张图都存下来对比，才能确认终端/编辑器里的字真的到了可读的程度
 * （用户实测的误判正是"看不清还硬猜"）。
 *
 * 它用的是**线上同一套代码**：矩形来自 `perception.status().windowContext.foregroundRect`，
 * 裁剪矩形由 `petDebug.perception.computeCloseUpCrop()`（线上纯函数）算出来，
 * 这里只负责调 desktopCapturer 把图存下来并打印尺寸。
 *
 * 用法：npx electron tools/probe-window-closeup.cjs
 * 输出：build/shot-closeup.jpg（窗口特写）、build/shot-baseline.jpg（同尺寸的整屏缩放对照）
 *      + build/window-closeup-probe.json
 */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'window-closeup-probe.json');
const { guardSingleInstance } = require('./lib/instance-guard.cjs');
const dataDir = join(tmpdir(), 'desktop-pet-probe-closeup');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
// 没有这一步：已有实例时 require(main.js) 会静默 app.quit()，探针"跑过了"是假象
guardSingleInstance(app, {
  onBlocked: (message) => {
    try { writeFileSync(outFile, JSON.stringify({ fatal: message }, null, 1), 'utf8'); } catch (error) { /* 忽略 */ }
  },
});
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const petWin = BrowserWindow.getAllWindows()[0];
  if (!petWin) throw new Error('桌宠窗口不存在');
  const run = (js) => petWin.webContents.executeJavaScript(js, true);

  // 1) 真机拿一次前台窗口矩形（走线上同一条 status 链路）
  const probe = await run(`(async () => {
    const status = await window.petAPI.perception.sampleNow();
    return {
      rect: status.windowContext.foregroundRect,
      title: status.windowContext.foregroundTitle,
      process: status.windowContext.foregroundProcess,
      logical: { width: window.screen.width, height: window.screen.height },
      ratio: window.devicePixelRatio,
    };
  })()`);
  console.log('[probe]', JSON.stringify(probe));

  // 2) 按"原分辨率"截一次（与 grabWindowCloseUp 同一条思路）
  const primary = screen.getPrimaryDisplay();
  const physical = {
    width: Math.max(640, Math.round(primary.size.width * primary.scaleFactor)),
    height: Math.max(360, Math.round(primary.size.height * primary.scaleFactor)),
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: physical,
    fetchWindowIcons: false,
  });
  const source = sources.find((item) => String(item.display_id) === String(primary.id)) ?? sources[0];
  const full = source.thumbnail;
  const fullSize = full.getSize();
  console.log('[capture]', JSON.stringify({ requested: physical, actual: fullSize, displayScaleFactor: primary.scaleFactor }));

  // 3) 裁剪矩形交给**线上纯函数**算（避免这里另写一套而掩盖真问题）
  const crop = await run(`window.petDebug.perception.computeCloseUpCrop(${JSON.stringify({
    rect: probe.rect,
    display: probe.logical,
    scaleFactor: probe.ratio,
    image: fullSize,
  })})`);
  console.log('[crop]', JSON.stringify(crop));
  const summary = { probe, capture: { requested: physical, actual: fullSize }, crop };
  writeFileSync(outFile, JSON.stringify(summary, null, 1), 'utf8');
  if (!crop) {
    console.log('!! 纯函数判定这块矩形没法裁（线上会安静降级：这一路不传图）');
    app.exit(3);
    return;
  }

  const closeUp = full.crop(crop);
  const resized = closeUp.getSize().width > 1280 ? closeUp.resize({ width: 1280, quality: 'good' }) : closeUp;
  writeFileSync(join(root, 'build', 'shot-closeup.jpg'), resized.toJPEG(78));
  console.log(`[shot] closeup ${resized.getSize().width}x${resized.getSize().height} -> build/shot-closeup.jpg`);

  /*
   * 4) 对照组：**同样大小**的一块，但从"缩到 640 宽的整屏"上裁（线上整屏图的实际清晰度）。
   *    两张图内容一样、尺寸一样，唯一差别是采样分辨率 —— 肉眼一比就知道特写有没有意义。
   */
  const small = full.resize({ width: 640, quality: 'good' });
  const smallSize = small.getSize();
  const k = smallSize.width / fullSize.width;
  const smallCrop = small.crop({
    x: Math.max(0, Math.round(crop.x * k)),
    y: Math.max(0, Math.round(crop.y * k)),
    width: Math.max(16, Math.round(crop.width * k)),
    height: Math.max(16, Math.round(crop.height * k)),
  });
  const baseline = smallCrop.resize({ width: resized.getSize().width, quality: 'good' });
  writeFileSync(join(root, 'build', 'shot-baseline.jpg'), baseline.toJPEG(78));
  console.log(`[shot] baseline ${baseline.getSize().width}x${baseline.getSize().height} -> build/shot-baseline.jpg`);
  console.log(`[info] 特写/整屏 采样倍率=${(fullSize.width / smallSize.width).toFixed(1)}x`);

  app.exit(0);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
