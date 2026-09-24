// @ts-check
/**
 * 诊断：气泡**出现/消失**时的闪烁，逐帧看是什么在变。
 *
 * 逐帧（rAF）记录：
 *   - 宠物容器的像素尺寸（气泡显隐若影响它，就是"被拉伸一下"）
 *   - 宠物/气泡的可见性、气泡容器尺寸
 *   - 是否有"气泡可见但贴图还没加载"的帧（背景图 complete 状态）
 *   - 窗口尺寸（主进程侧）
 *
 * 用法：npx electron tools/diag-bubble-flicker.cjs
 * 输出：build/bubble-flicker.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'bubble-flicker.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`(async () => { await window.petAPI.settings.setScale(0.6); return true; })()`);
  await wait(600);

  /* 逐帧记录器 */
  await js(`(() => {
    window.__frames = [];
    window.__rec = false;
    window.__bgReady = null;
    /* 提前探一下气泡贴图能否 decode（用于判断"贴图未就绪"） */
    window.__bgState = () => {
      const b = document.getElementById('pet-bubble');
      return { hidden: b.hidden, w: b.clientWidth, h: b.clientHeight };
    };
    const tick = () => {
      if (window.__rec) {
        const pet = document.getElementById('pet-pet');
        const bubble = document.getElementById('pet-bubble');
        const stage = document.getElementById('pet-stage');
        const vids = Array.from(document.querySelectorAll('#pet-stage video'));
        let maxOp = 0;
        for (const v of vids) maxOp = Math.max(maxOp, Number(getComputedStyle(v).opacity) || 0);
        window.__frames.push({
          t: performance.now(),
          petW: pet.clientWidth, petH: pet.clientHeight,
          petTop: Math.round(pet.getBoundingClientRect().top),
          stageW: stage.clientWidth, stageH: stage.clientHeight,
          bubbleHidden: bubble.hidden,
          bubbleW: bubble.clientWidth, bubbleH: bubble.clientHeight,
          videoOpacity: Number(maxOp.toFixed(2)),
          winW: window.innerWidth, winH: window.innerHeight,
        });
      }
      window.__raf = requestAnimationFrame(tick);
    };
    window.__raf = requestAnimationFrame(tick);
    return true;
  })()`);

  const record = async (tag, action) => {
    await js(`window.__frames = []; window.__rec = true;`);
    await action();
    await wait(700);
    await js('window.__rec = false;');
    const frames = await js('window.__frames');
    return { tag, frames };
  };

  const runs = [];
  runs.push(await record('显示气泡', async () => {
    await js(`window.petAPI.bubble.set({ visible: true, text: '测试闪烁' })`);
  }));
  runs.push(await record('隐藏气泡', async () => {
    await js(`window.petAPI.bubble.set(null)`);
  }));
  /* 第二次显示：贴图已在缓存里，用来看"首次 vs 再次"的差异 */
  runs.push(await record('再次显示气泡', async () => {
    await js(`window.petAPI.bubble.set({ visible: true, text: '测试闪烁' })`);
  }));
  await js('window.petAPI.bubble.set(null)');

  /* 分析：找出每一帧里"发生变化"的字段 */
  const analysis = runs.map((run) => {
    const frames = run.frames ?? [];
    const changes = [];
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      const diff = {};
      for (const k of ['petW', 'petH', 'petTop', 'stageW', 'stageH', 'bubbleHidden', 'bubbleW', 'bubbleH', 'videoOpacity', 'winW', 'winH']) {
        if (a[k] !== b[k]) diff[k] = `${a[k]} -> ${b[k]}`;
      }
      if (Object.keys(diff).length > 0) changes.push({ dt: +(b.t - a.t).toFixed(1), diff });
    }
    return { tag: run.tag, frameCount: frames.length, changes, first: frames[0], last: frames[frames.length - 1] };
  });

  writeFileSync(outFile, JSON.stringify({ analysis, runs }, null, 1), 'utf8');
  console.log('=== 气泡显隐逐帧变化 ===');
  for (const a of analysis) {
    console.log(`\n[${a.tag}] 帧数 ${a.frameCount}`);
    console.log(`  首帧: pet=${a.first?.petW}x${a.first?.petH} win=${a.first?.winW}x${a.first?.winH} bubbleHidden=${a.first?.bubbleHidden} bubble=${a.first?.bubbleW}x${a.first?.bubbleH} videoOp=${a.first?.videoOpacity}`);
    console.log(`  末帧: pet=${a.last?.petW}x${a.last?.petH} win=${a.last?.winW}x${a.last?.winH} bubbleHidden=${a.last?.bubbleHidden} bubble=${a.last?.bubbleW}x${a.last?.bubbleH} videoOp=${a.last?.videoOpacity}`);
    for (const c of a.changes.slice(0, 12)) console.log(`  +${c.dt}ms  ${JSON.stringify(c.diff)}`);
    if (a.changes.length > 12) console.log(`  ...共 ${a.changes.length} 处变化`);
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
