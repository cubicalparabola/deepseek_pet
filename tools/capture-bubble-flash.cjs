// @ts-check
/**
 * 用**密集截图**抓气泡显隐的瞬间，看闪的那一帧长什么样。
 *
 * 逐帧 DOM 诊断只能说明"属性何时变"，看不出"画面上闪的是什么"。
 * 这里在显隐前后约 600ms 内不停 capturePage，把每张图存盘并给出
 * "宠物区域的平均亮度 / 不透明像素数"，用来判断那一帧是不是：
 *   - 宠物被拉伸（像素数变多/变形）
 *   - 整窗变暗或变空
 *   - 气泡出现在错误位置
 *
 * 用法：npx electron tools/capture-bubble-flash.cjs
 * 输出：build/bubble-flash/<tag>-<i>.png + build/bubble-flash.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { decodePng, pixelAt } = require('./lib/png.mjs');

const root = join(__dirname, '..');
const outDir = join(root, 'build', 'bubble-flash');
const outFile = join(root, 'build', 'bubble-flash.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  mkdirSync(outDir, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`(async () => { await window.petAPI.settings.setScale(0.6); return true; })()`);
  await wait(700);

  /** 连续截图一段时间，返回每张的统计。 */
  const burst = async (tag, action, durationMs = 700) => {
    const shots = [];
    const t0 = Date.now();
    const promise = (async () => {
      action();
      while (Date.now() - t0 < durationMs) {
        const image = await win.webContents.capturePage();
        const file = join(outDir, `${tag}-${String(shots.length).padStart(2, '0')}.png`);
        writeFileSync(file, image.toPNG());
        shots.push({ i: shots.length, dt: Date.now() - t0, w: image.getSize().width, h: image.getSize().height, file });
      }
    })();
    await promise;
    return { tag, shots };
  };

  const runs = [];
  /* 首次显示（贴图可能未缓存） */
  runs.push(await burst('show1', () => { void js(`window.petAPI.bubble.set({ visible: true, text: '闪烁检查' })`); }));
  await wait(1200);
  runs.push(await burst('hide1', () => { void js(`window.petAPI.bubble.set(null)`); }));
  await wait(1200);
  /* 第二次显示（贴图已缓存） */
  runs.push(await burst('show2', () => { void js(`window.petAPI.bubble.set({ visible: true, text: '闪烁检查' })`); }));
  await wait(1200);
  runs.push(await burst('hide2', () => { void js(`window.petAPI.bubble.set(null)`); }));
  await wait(600);

  /* 统计：每张图的尺寸 + 不透明像素数（用 alpha 判断） */
  const analysis = runs.map((run) => {
    const frames = run.shots.map((s) => {
      const img = decodePng(s.file);
      let opaque = 0;
      /* 抽样：每 4 像素取一个，够判断"画面有没有内容" */
      for (let y = 0; y < img.height; y += 4) {
        for (let x = 0; x < img.width; x += 4) {
          if (pixelAt(img, x, y).a > 32) opaque += 1;
        }
      }
      return { i: s.i, dt: s.dt, w: s.w, h: s.h, opaque, file: s.file };
    });
    /* 找尺寸变化的那一帧 */
    const changes = [];
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].w !== frames[i - 1].w || frames[i].h !== frames[i - 1].h) {
        changes.push({ at: i, dt: frames[i].dt, size: `${frames[i - 1].w}x${frames[i - 1].h} -> ${frames[i].w}x${frames[i].h}`, opaque: `${frames[i - 1].opaque} -> ${frames[i].opaque}` });
      }
    }
    return { tag: run.tag, frameCount: frames.length, changes, frames };
  });

  writeFileSync(outFile, JSON.stringify({ analysis }, null, 1), 'utf8');
  console.log('=== 气泡显隐瞬间（密集截图） ===');
  for (const a of analysis) {
    console.log(`\n[${a.tag}] 抓到 ${a.frameCount} 帧`);
    for (const c of a.changes) console.log(`  第 ${c.at} 帧 @${c.dt}ms  尺寸 ${c.size}  不透明采样 ${c.opaque}`);
    const ops = a.frames.map((f) => f.opaque);
    console.log(`  不透明采样序列: ${ops.slice(0, 14).join(', ')}${ops.length > 14 ? ' ...' : ''}`);
  }
  console.log(`\n图片: ${outDir}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 240000);
