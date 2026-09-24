// @ts-check
/**
 * 诊断：点"知道了"按钮能否真正关闭气泡。
 *
 * 用**真实点击**（`element.click()`，与用户点它等价）验证整条链路：
 * 按钮 -> BubbleView 回调 -> IPC `pet:bubble-acknowledge` -> Main `setBubble(null)`
 * -> 收起窗口 -> 广播新布局 -> 渲染层隐藏。
 *
 * 用法：npx electron tools/diag-bubble-ack.cjs
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'bubble-ack.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const snap = () =>
    js(`(() => {
      const b = document.getElementById('pet-bubble');
      const ack = document.getElementById('pet-bubble-ack');
      const ar = ack.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return {
        bubbleHidden: b.hidden,
        ackHidden: ack.hidden,
        ackRect: { x: Math.round(ar.x), y: Math.round(ar.y), w: Math.round(ar.width), h: Math.round(ar.height) },
        ackInsideBubble: ar.top >= br.top - 1 && ar.bottom <= br.bottom + 1 && ar.left >= br.left - 1 && ar.right <= br.right + 1,
        ackText: (ack.textContent || '').trim(),
        windowInner: { w: window.innerWidth, h: window.innerHeight },
      };
    })()`);

  const steps = [];

  /* 1) 显示气泡 -> 按钮应可见且在气泡内 */
  await js(`window.petAPI.bubble.set({ visible: true, text: '点下面的按钮关闭我说' })`);
  let lastH = -1, stable = 0;
  for (let i = 0; i < 40 && stable < 2; i++) {
    await wait(120);
    const h = await js(`Math.round(document.getElementById('pet-bubble').getBoundingClientRect().height)`);
    if (h === lastH) stable++; else stable = 0;
    lastH = h;
  }
  steps.push({ tag: '显示后', ...(await snap()) });

  /* 2) 真实点击按钮 */
  await js(`document.getElementById('pet-bubble-ack').click()`);
  await wait(1200);
  const after = await snap();
  steps.push({ tag: '点击"知道了"后', ...after });

  /* 3) 再点一次（已隐藏时不应报错） */
  await js(`document.getElementById('pet-bubble-ack').click()`);
  await wait(600);
  steps.push({ tag: '隐藏后再点一次', ...(await snap()) });

  const report = {
    steps,
    verdict: {
      buttonVisibleWhenShown: steps[0].ackHidden === false && steps[0].ackText === '知道了',
      buttonInsideBubble: steps[0].ackInsideBubble === true,
      closedByClick: steps[1].bubbleHidden === true,
      windowShrank: steps[1].windowInner.h < steps[0].windowInner.h,
      stillClosedAfterSecondClick: steps[2].bubbleHidden === true,
    },
  };
  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');

  console.log('=== "知道了"按钮 ===');
  for (const s of steps) {
    console.log(
      `  ${s.tag}: 气泡隐藏=${s.bubbleHidden} 按钮隐藏=${s.ackHidden} 按钮=${s.ackRect.w}x${s.ackRect.h}@(${s.ackRect.x},${s.ackRect.y}) 在气泡内=${s.ackInsideBubble} 窗口=${s.windowInner.w}x${s.windowInner.h}`,
    );
  }
  console.log('  判定:', JSON.stringify(report.verdict, null, 1));
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
