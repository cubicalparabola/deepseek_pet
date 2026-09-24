// @ts-check
/**
 * 决定性实验：正文区**实际能显示几行** vs **理论值**（文字区高 / 行高）。
 *
 * 若两者一致 -> 没有"被裁"这回事，之前看到的都是坐标错配；
 * 若实际明显更少 -> 确实是容器把内容截断了，需要改布局。
 *
 * 做法：逐步加长的文本，读回"文字区 clientHeight / 行高"与
 * "滚动到底时可见的整行数"（用 scrollHeight/行高 反推总行数）。
 *
 * 用法：npx electron tools/diag-bubble-lines.cjs
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'bubble-lines.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const read = () =>
    js(`(() => {
      const t = document.getElementById('pet-bubble-text');
      const body = document.getElementById('pet-bubble-body');
      const cs = getComputedStyle(t);
      const lineHeight = parseFloat(cs.lineHeight);
      const clientH = t.clientHeight;
      const scrollH = t.scrollHeight;
      /* 逐行测量：正文里每个字符的 rect 按 top 分组 -> 实际渲染了多少行 */
      const range = document.createRange();
      const textNode = body.firstChild;
      const tops = new Map();
      if (textNode) {
        for (let i = 0; i < textNode.length; i++) {
          range.setStart(textNode, i);
          range.setEnd(textNode, i + 1);
          const r = range.getBoundingClientRect();
          const key = Math.round(r.top);
          tops.set(key, (tops.get(key) ?? 0) + 1);
        }
      }
      return {
        lineHeight,
        clientH,
        scrollH,
        /** 理论可显示行数 */
        theoreticalRows: +(clientH / lineHeight).toFixed(2),
        /** 实际渲染的行数（全部，含被滚出视口的） */
        renderedRows: tops.size,
        /** 可见范围内的行数（top 落在容器内的） */
        containerTop: t.getBoundingClientRect().top,
        containerBottom: t.getBoundingClientRect().bottom,
        visibleRows: [...tops.keys()].filter((top) => top >= t.getBoundingClientRect().top - 1 && top + lineHeight <= t.getBoundingClientRect().bottom + 1).length,
        textLength: (body.textContent || '').length,
        bubbleH: Math.round(document.getElementById('pet-bubble').getBoundingClientRect().height),
      };
    })()`);

  const rows = [];
  for (let n = 1; n <= 14; n++) {
    const text = '行文本内容测试'.repeat(n);
    await js(`window.petAPI.bubble.set({ visible: true, text: ${JSON.stringify(text)} })`);
    /* 等收敛 */
    let lastH = -1, stable = 0;
    for (let i = 0; i < 40 && stable < 2; i++) {
      await wait(120);
      const h = await js(`Math.round(document.getElementById('pet-bubble').getBoundingClientRect().height)`);
      if (h === lastH) stable++; else stable = 0;
      lastH = h;
    }
    rows.push({ n, ...(await read()) });
  }
  await js('window.petAPI.bubble.set(null)');

  writeFileSync(outFile, JSON.stringify({ rows }, null, 1), 'utf8');
  console.log('=== 正文区能显示几行（理论 vs 实际） ===');
  for (const r of rows) {
    const ok = r.visibleRows === Math.floor(r.theoreticalRows) ? '✅' : '⚠️';
    console.log(
      `  文本x${String(r.n).padStart(2)}  气泡高=${String(r.bubbleH).padStart(4)}  文字区高=${String(r.clientH).padStart(4)}  行高=${r.lineHeight}  理论行数=${r.theoreticalRows}  实际可见行数=${r.visibleRows}  总渲染行数=${r.renderedRows}  ${ok}`,
    );
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
