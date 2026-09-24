// @ts-check
/**
 * 诊断：**气泡大小随文本长短变化**。
 *
 * 依次显示"极短 -> 中 -> 长 -> 很长"四段文本，记录每次的气泡高度、
 * 文本行数、是否需要滚动，并截图存盘（人眼可直接核对）。
 *
 * 期望：
 *   - 短文本 -> 气泡矮、不滚动；
 *   - 文本越长 -> 气泡越高（到上限为止）；
 *   - 超过上限 -> 气泡不再变高，改为文字区出现滚动条。
 *
 * 用法：npx electron tools/diag-bubble-adaptive.cjs
 * 输出：build/bubble-adaptive/*.png + build/bubble-adaptive.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'build', 'bubble-adaptive');
const outFile = join(root, 'build', 'bubble-adaptive.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLES = [
  { name: '01-极短', text: '早' },
  { name: '02-短', text: '今天也一起加油吧！' },
  { name: '03-中', text: '这是一段中等长度的文本，用来观察气泡高度会不会跟着变高。大概两到三行。' },
  { name: '04-长', text: '当文字超过一屏时，气泡内部会出现滚动条，可以用鼠标滚轮或拖动滚动条查看后面的内容，文字不会溢出气泡的描边。下面还有一些内容用来继续把文本撑长：一、气泡的尾巴指向桌宠的头顶；二、气泡在桌宠上方，窗口会向上扩展。' },
  /* 刻意远超气泡上限：用来验证"到上限后不再变高、转为文字区滚动" */
  { name: '05-超长', text: '这一段刻意写得非常长，用来把气泡撑到高度上限。'.repeat(6) + '如果你能看到最后这一句，说明滚动条工作正常。' },
  { name: '06-极长', text: '这一段刻意写得非常长，用来把气泡撑到高度上限。'.repeat(16) + '结尾。' },
];

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    writeFileSync(outFile, JSON.stringify({ fatal: 'no window' }), 'utf8');
    app.exit(1);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const snap = () =>
    js(`(() => {
      const b = document.getElementById('pet-bubble');
      const t = document.getElementById('pet-bubble-text');
      const body = document.getElementById('pet-bubble-body');
      const pet = document.getElementById('pet-pet');
      const br = b.getBoundingClientRect();
      const pr = pet.getBoundingClientRect();
      const tr = t.getBoundingClientRect();
      const wr = body.getBoundingClientRect();
      return {
        bubble: { w: Math.round(br.width), h: Math.round(br.height) },
        pet: { w: Math.round(pr.width), h: Math.round(pr.height) },
        text: {
          length: (body.textContent || '').length,
          clientH: t.clientHeight,
          scrollH: t.scrollHeight,
          scrollable: t.scrollHeight > t.clientHeight + 1,
          fontSize: getComputedStyle(t).fontSize,
          lineHeight: getComputedStyle(t).lineHeight,
        },
        /* 正文相对文字区的上下留白：判断是否真的垂直居中 */
        centering: {
          paddingTop: Math.round(wr.top - tr.top),
          paddingBottom: Math.round(tr.bottom - wr.bottom),
        },
        /* 文字区与气泡容器的像素范围（相对窗口），核对"是否被气泡底边裁掉" */
        geometry: {
          bubbleTop: Math.round(br.top),
          bubbleBottom: Math.round(br.bottom),
          textTop: Math.round(tr.top),
          textBottom: Math.round(tr.bottom),
          /** 文字区底边到气泡底边的距离（应 > 0，否则文字会被气泡裁掉） */
          textBottomToBubbleBottom: Math.round(br.bottom - tr.bottom),
          /** 正文元素的底边（应与 textBottom 齐平或在其上方） */
          bodyTop: Math.round(wr.top),
          bodyBottom: Math.round(wr.bottom),
          /** 正文底边越过文字区底边多少 px（>0 表示溢出容器，会被裁） */
          bodyOverflowBelowText: Math.round(wr.bottom - tr.bottom),
          overflowY: getComputedStyle(t).overflowY,
        },
        windowInner: { w: window.innerWidth, h: window.innerHeight },
      };
    })()`);

  const rows = [];
  for (const sample of SAMPLES) {
    await js(`window.petAPI.bubble.set({ visible: true, text: ${JSON.stringify(sample.text)} })`);
    /*
     * 等布局**收敛**再量/再截图。
     *
     * 气泡高度是两轮达成的：第一轮按最大高度渲染并回报行数，主进程重算并
     * 调整窗口，第二轮才落地最终尺寸。固定等 1000ms 不够稳（实测截图与 DOM
     * 量测对不上，就是因为截到了中间状态）。这里改成轮询"两次高度一致"。
     */
    let lastH = -1;
    let stable = 0;
    for (let i = 0; i < 40 && stable < 2; i++) {
      await wait(120);
      const h = await js(`Math.round(document.getElementById('pet-bubble').getBoundingClientRect().height)`);
      if (h === lastH) stable += 1;
      else stable = 0;
      lastH = h;
    }
    const state = await snap();
    const image = await win.webContents.capturePage();
    writeFileSync(join(outDir, `${sample.name}.png`), image.toPNG());
    rows.push({ name: sample.name, ...state });
  }

  /* 恢复隐藏 */
  await js('window.petAPI.bubble.set(null)');
  await wait(700);

  const heights = rows.map((r) => r.bubble.h);
  const monotonic = heights.every((h, i) => i === 0 || h >= heights[i - 1] - 2);
  const report = {
    rows,
    analysis: {
      heights,
      monotonicNonDecreasing: monotonic,
      shortest: rows[0]?.bubble.h,
      longest: rows[rows.length - 1]?.bubble.h,
      grew: (rows[rows.length - 1]?.bubble.h ?? 0) > (rows[0]?.bubble.h ?? 0),
      cappedRows: rows.filter((r) => r.bubble.h === Math.max(...heights)).length,
    },
  };
  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');

  console.log('=== 气泡随文本长短变化 ===');
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(8)} 字数=${String(r.text.length).padStart(3)}  气泡=${r.bubble.w}x${r.bubble.h}  文字区高=${r.text.clientH} 内容高=${r.text.scrollH}  滚动=${r.text.scrollable}  文字区底到气泡底=${r.geometry.textBottomToBubbleBottom}px  正文越界=${r.geometry.bodyOverflowBelowText}px overflowY=${r.geometry.overflowY}`,
    );
  }
  console.log(`  高度序列: ${heights.join(' -> ')}`);
  console.log(`  单调不减: ${monotonic}   最短->最长增长: ${report.analysis.grew}   达到上限的行数: ${report.analysis.cappedRows}`);
  console.log(`  截图: ${outDir}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);

