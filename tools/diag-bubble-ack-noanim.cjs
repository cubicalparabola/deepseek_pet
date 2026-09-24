// @ts-check
/**
 * 诊断：点"知道了"按钮**不应**触发宠物点击动画。
 *
 * 用 `webContents.sendInputEvent` 发**真实指针事件**（mouseDown/mouseUp）到按钮
 * 所在坐标，然后看有没有 `pet:click` / `animation:start`。
 *
 * 为什么必须用真实指针事件：直接调用 `element.click()` 不经过
 * InteractionManager 的 pointerdown/up，测不出"点击冒泡到宠物"这个问题。
 *
 * 用法：npx electron tools/diag-bubble-ack-noanim.cjs
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'bubble-ack-noanim.json');

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

  const report = { steps: [] };
  const collect = async (tag) => {
    const s = await js(`(() => {
      const b = document.getElementById('pet-bubble');
      const a = document.getElementById('pet-bubble-ack');
      const ar = a.getBoundingClientRect();
      return {
        bubbleHidden: b.hidden,
        ackCenter: { x: Math.round(ar.left + ar.width / 2), y: Math.round(ar.top + ar.height / 2) },
        events: window.__events,
      };
    })()`);
    report.steps.push({ tag, ...s });
    return s;
  };

  /* 记录宠物交互与动画事件 */
  await js(`(() => {
    const bus = window.petDebug.bus;
    window.__events = [];
    window.__subs = [
      bus.on('pet:click', (p) => window.__events.push({ t: 'pet:click', region: p.region })),
      bus.on('pet:dblclick', (p) => window.__events.push({ t: 'pet:dblclick', region: p.region })),
      bus.on('animation:start', (p) => window.__events.push({ t: 'anim', id: p.animationId, reason: p.reason })),
      bus.on('pet:drag', (p) => window.__events.push({ t: 'drag', phase: p.phase })),
    ];
    return true;
  })()`);

  /* 显示气泡并等稳定 */
  await js(`window.petAPI.bubble.set({ visible: true, text: '点下面的按钮关闭我' })`);
  let last = -1, stable = 0;
  for (let i = 0; i < 40 && stable < 2; i++) {
    await wait(120);
    const h = await js(`Math.round(document.getElementById('pet-bubble').getBoundingClientRect().height)`);
    if (h === last) stable++; else stable = 0;
    last = h;
  }
  const before = await collect('气泡已显示');
  const point = before.ackCenter;

  /* 清空事件，发**真实指针事件**到按钮中心 */
  await js('window.__events.length = 0; true');
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await wait(60);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await wait(1200);
  const afterClick = await collect('真实点击按钮后');

  /* 对照：点宠物身体（气泡外）应当产生点击动画 */
  await js('window.__events.length = 0; true');
  const bodyPoint = await js(`(() => {
    const p = document.getElementById('pet-pet').getBoundingClientRect();
    return { x: Math.round(p.left + p.width / 2), y: Math.round(p.top + p.height * 0.7) };
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: bodyPoint.x, y: bodyPoint.y, button: 'left', clickCount: 1 });
  await wait(60);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: bodyPoint.x, y: bodyPoint.y, button: 'left', clickCount: 1 });
  await wait(1200);
  const afterBody = await collect('对照：点击宠物身体后');

  await js('window.__subs.forEach((s) => s.unsubscribe()); window.petAPI.bubble.set(null); true');
  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');

  const clickBtnEvents = afterClick.events ?? [];
  const clickBodyEvents = afterBody.events ?? [];
  console.log('=== 点"知道了"不应触发动画 ===');
  console.log(`  按钮坐标: (${point.x},${point.y})`);
  console.log(`  点按钮后的事件: ${JSON.stringify(clickBtnEvents)}`);
  console.log(`  点按钮后气泡是否关闭: ${afterClick.bubbleHidden}`);
  console.log(`  对照 — 点身体后的事件: ${JSON.stringify(clickBodyEvents)}`);
  console.log('  判定:');
  console.log(`    点按钮无宠物交互事件: ${clickBtnEvents.length === 0 ? '✅' : '❌'}`);
  console.log(`    点按钮关闭了气泡:     ${afterClick.bubbleHidden ? '✅' : '❌'}`);
  console.log(`    点身体仍有交互事件:   ${clickBodyEvents.length > 0 ? '✅' : '❌ 对照失效'}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
