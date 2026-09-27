// @ts-check
/**
 * 探针：**收起时的"随机小动作"到底有没有按需求走**。
 *
 * 需求：`sleep` 循环中随机时刻 -> 先播完 `sleep` 的 end -> `lie` ×N -> 回到 `sleep`；
 *       `peek` 同理但只在 `watch` 阶段触发。
 *
 * 做法：真的收起到下方（默认动画 = sleep，无限循环），只把 fidget 间隔临时改成
 * 1 秒（真实配置是 3–8 分钟，等不起），然后录一段 `animation:start/end/rejected`
 * 事件流 —— 被拒的那条会带上 rejection 原因，这正是"没有接上 lie"时要看的东西。
 *
 * 用法：npx electron tools/probe-fidget.cjs
 * 输出：build/fidget-probe.json
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'fidget-probe.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-fidget');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish(payload) {
  try {
    writeFileSync(outFile, JSON.stringify(payload, null, 1), 'utf8');
  } catch (error) {
    console.error('写入探针结果失败', error);
  }
  console.log(JSON.stringify(payload, null, 1));
  app.exit(0);
}

app.whenReady().then(async () => {
  try {
    await wait(6000);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('桌宠窗口不存在');
    const run = (js) => win.webContents.executeJavaScript(js, true);

    /* 收起前先回到桌面中央，避免上一个状态残留；并确保"拖到边缘自动收起"是开着的 */
    await run(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.petAPI.settings.setDockOnEdge(true);
      await window.petAPI.window.setPosition(500, 300);
      await wait(300);
      await window.petAPI.window.undock();
      await wait(400);
      return window.petDebug.display();
    })()`);

    const result = await run(`(async () => {
      const anim = window.petDebug.anim;
      const behaviors = window.petDebug.behaviors;
      const bus = window.petDebug.bus;
      const model = window.petDebug.animationModel;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const events = [];
      const subs = [
        bus.on('animation:start', (p) => events.push({ t: 'start', id: p.animationId, reason: p.reason ?? '' })),
        bus.on('animation:end', (p) => events.push({ t: 'end', id: p.animationId, completed: p.completed })),
        bus.on('animation:rejected', (p) => events.push({ t: 'rejected', id: p.animationId, rejection: p.rejection, reason: p.reason ?? '' })),
      ];
      const samples = [];
      const sample = (note) => samples.push({
        note,
        display: window.petDebug.display(),
        current: anim.getCurrentAnimation(),
        phase: anim.getPersistentPhase(),
        fidget: behaviors.describeFidget(),
      });
      const base = model.DEFAULT_BEHAVIOR_CONFIG;

      try {
        /* 只把 fidget 间隔改成 1 秒：状态机与默认姿势都走真实配置 */
        behaviors.setConfig({
          version: base.version,
          states: Object.assign({}, base.states, {
            'docked-bottom': Object.assign({}, base.states['docked-bottom'], {
              fidget: { animations: ['lie'], intervalMs: [1000, 1000], loopCountRange: [1, 1] },
            }),
          }),
          pools: base.pools,
        });

        /* 真的收起到**下方**（默认动画 sleep） */
        await window.petAPI.window.setPosition(500, 300);
        await wait(300);
        await window.petAPI.window.dragEnd();
        await window.petAPI.window.setPosition(500, 100000);
        await wait(500);
        await window.petAPI.window.dragEnd();
        for (let i = 0; i < 30; i += 1) {
          if (window.petDebug.display().dock === 'bottom') break;
          await wait(100);
        }
        sample('docked');

        /* 等默认姿势进入循环段 */
        for (let i = 0; i < 60 && anim.getPersistentPhase() !== 'loop'; i += 1) await wait(100);
        sample('sleep-loop');

        /* 采集 12 秒 */
        for (let i = 0; i < 24; i += 1) {
          await wait(500);
          sample('t+' + ((i + 1) * 0.5).toFixed(1) + 's');
        }
        return { events, samples, current: anim.getCurrentAnimation(), phase: anim.getPersistentPhase() };
      } finally {
        behaviors.setConfig(base);
        for (const sub of subs) sub.unsubscribe();
        try {
          await window.petAPI.window.setPosition(500, 300);
          await wait(200);
          await window.petAPI.window.undock();
        } catch (error) { /* 忽略 */ }
      }
    })()`);

    finish(result);
  } catch (error) {
    finish({ error: String((error && error.stack) || error) });
  }
});

setTimeout(() => {
  finish({ error: 'PROBE_TIMEOUT' });
}, 90000);
