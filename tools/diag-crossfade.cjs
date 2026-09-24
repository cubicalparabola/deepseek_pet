// @ts-check
/**
 * 确认交叉淡化真的在跑：采样切段瞬间两个缓冲的 computed opacity 与混合模式。
 * 用法：npx electron tools/diag-crossfade.cjs read
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join: pjoin } = require('node:path');

const root = pjoin(__dirname, '..');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(pjoin(root, 'dist', 'main', 'main.js'));

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 6000));
  const win = BrowserWindow.getAllWindows()[0];
  const result = await win.webContents.executeJavaScript(
    `(async () => {
      const anim = window.petDebug.anim;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const vids = () => Array.from(document.querySelectorAll('#pet-stage video'));
      const read = (tag) => ({
        tag,
        phase: anim.getPersistentPhase(),
        v: vids().map((v) => ({
          id: v.id,
          active: v.classList.contains('layer-active'),
          opacity: Number(getComputedStyle(v).opacity),
          blend: getComputedStyle(v).mixBlendMode,
          held: v.dataset.hold === '1',
        })),
      });
      anim.resetCooldowns();
      const out = [];
      await anim.play('read', { interrupt: 'force', reason: 'cf' });
      out.push(read('t=0'));
      // 覆盖 start->loop 与 loop->end 两个切换点
      for (let i = 0; i < 120; i++) {
        await wait(80);
        const r = read('t=' + (i * 80));
        // 只在"两个缓冲同时可见"或"有 hold"时记录，聚焦过渡窗口
        const twoVisible = r.v.filter((x) => x.opacity > 0.01).length >= 2;
        const hasHold = r.v.some((x) => x.held);
        if (twoVisible || hasHold) out.push(r);
        if (i > 20 && anim.getCurrentAnimation() === 'idle') break;
      }
      out.push(read('final'));
      return out;
    })()`,
    true,
  );
  writeFileSync(pjoin(root, 'build', 'crossfade.json'), JSON.stringify(result, null, 1), 'utf8');
  console.log('=== 交叉淡化采样（仅列过渡窗口）===');
  for (const r of result) {
    console.log(
      `${String(r.tag).padEnd(9)} phase=${String(r.phase).padEnd(7)} ` +
        r.v.map((v) => `${v.id}${v.active ? '*' : ' '} op=${v.opacity.toFixed(2)} blend=${v.blend}${v.held ? ' HOLD' : ''}`).join('  |  '),
    );
  }
  app.exit(0);
}).catch((e) => {
  console.error('FAILED', e);
  app.exit(1);
});
setTimeout(() => app.exit(2), 120000);
