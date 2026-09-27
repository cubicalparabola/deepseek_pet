// @ts-check
/**
 * 探针：**心情真的低于阈值时，随机池是不是整体变成了 sad**（端到端）。
 *
 * 为什么必须单独跑一次真机：验收里只能断言纯函数（`sadPoolAnimation`）与
 * "心情正常时池子还是原来那 8 条"。而这条需求真正的风险在**接线**上：
 *   1. 主进程的心情有没有真的推给桌宠窗口？（这是这一轮新加的推送）
 *   2. 渲染层的镜像有没有落进 BehaviorManager？
 *   3. 跨过阈值之后，池子里到底是不是只剩 sad？
 *   4. **收起状态**（`sleep` / `watch` 与 `lie` / `peek`）有没有被误伤？
 *
 * 做法：先把 `emotion.json` 写成 `mood = 18`（低于阈值 25）再启动桌宠 ——
 * 与 tools/probe-sad-hungry.cjs 同一套办法（真实情绪状态，不是 mock）；
 * 然后读 `petDebug.behaviors.describeSadPool()` / `describePools()`；
 * 最后真的把她拖到屏幕下边缘收起，确认池空了、而 fidget 还是 `sleep -> lie`。
 *
 * 用法：npx electron tools/probe-sad-pool.cjs
 * 输出：build/sad-pool.json
 *
 * ⚠️ 用独立的 userData / 数据目录，不会和正在运行的桌宠抢单实例锁。
 */
const { app, BrowserWindow, screen } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'sad-pool.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-sadpool');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(join(dataDir, 'mood'), { recursive: true });

/** 低于阈值 25 的心情（与 probe-sad-hungry 用同一个数，便于对照）。 */
const LOW_MOOD = 18;

writeFileSync(
  join(dataDir, 'ai-settings.json'),
  JSON.stringify({
    version: 1,
    enabled: true,
    chat: false,
    memory: false,
    emotion: true,
    diary: false,
  }, null, 2),
  'utf8',
);

const now = Date.now();
writeFileSync(
  join(dataDir, 'emotion.json'),
  JSON.stringify({
    mood: LOW_MOOD,
    satiety: 100,
    lastInteractionAt: now - 10 * 60000,
    lastUpdateAt: now - 10 * 60000,
    updatedAt: new Date(now).toISOString(),
  }, null, 2),
  'utf8',
);

const profileDir = join(tmpdir(), 'desktop-pet-probe-sadpool-profile');
try { rmSync(profileDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
app.setPath('userData', profileDir);

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
  app.exit(payload.ok === true ? 0 : 1);
}

app.whenReady().then(async () => {
  try {
    await wait(7000);
    const petWin = BrowserWindow.getAllWindows()[0];
    if (!petWin) throw new Error('桌宠窗口不存在');
    const pet = (js) => petWin.webContents.executeJavaScript(js, true);

    // 1. 心情镜像 + 池子内容（此刻是"正常"显示状态）
    const inNormal = await pet(`(() => {
      const behaviors = window.petDebug.behaviors;
      return {
        display: window.petDebug.display(),
        sad: behaviors.describeSadPool(),
        pools: behaviors.describePools().map((p) => ({
          poolId: p.poolId,
          state: p.state,
          animations: p.animations,
          intervalMs: p.intervalMs,
        })),
        mainStatusMood: null,
      };
    })()`);
    const status = await pet(`window.petAPI.ai.status().then((s) => s.emotion.mood)`);

    // 2. 真的拖到屏幕下边缘收起（走真实贴边判定）
    const work = screen.getPrimaryDisplay().workArea;
    const size = petWin.getBounds();
    const targetX = Math.round(work.x + (work.width - size.width) / 2);
    const targetY = Math.round(work.y + work.height - size.height);
    petWin.setPosition(targetX, targetY);
    await wait(600);
    const docked = await pet(`(async () => {
      const state = await window.petAPI.window.dragEnd(${targetX}, ${targetY});
      return state;
    })()`);
    await wait(2500);

    // 3. 收起状态：池子应为空，fidget 仍是 sleep -> lie
    /*
     * 收起时可能还挂着一条正在收尾的动画（心情低会先触发一次 `sad`，三段式要先把 end 播完），
     * 所以这里**等到默认姿势真的接上**再看 —— 需求要的是"收起状态的动画不受影响"，
     * 也就是最终稳定在 `sleep`，而不是被 sad 池顶掉。
     */
    const waitForSleep = await pet(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 60; i += 1) {
        if (window.petDebug.anim.getCurrentAnimation() === 'sleep') return { at: i * 250 };
        await wait(250);
      }
      return { at: -1, stuck: window.petDebug.anim.getCurrentAnimation() };
    })()`);
    const inDocked = await pet(`(() => {
      const behaviors = window.petDebug.behaviors;
      return {
        display: window.petDebug.display(),
        sad: behaviors.describeSadPool(),
        pools: behaviors.describePools().map((p) => p.animations),
        fidget: behaviors.describeFidget(),
        animation: window.petDebug.anim.getCurrentAnimation(),
        bottomDefault: window.petDebug.animationModel.defaultAnimationFor(
          window.petDebug.animationModel.DEFAULT_BEHAVIOR_CONFIG, 'docked-bottom'),
      };
    })()`);

    const normalPool = inNormal.pools[0] ?? null;
    const ok =
      // 心情真的低（数据源可信）
      inNormal.sad.mood <= inNormal.sad.moodBelow &&
      status <= inNormal.sad.moodBelow &&
      // 镜像与规则一致
      inNormal.sad.active === true &&
      // 正常状态只有一个池，而它的内容被整体换成了 sad
      inNormal.pools.length === 1 &&
      normalPool !== null &&
      normalPool.animations.length === 1 &&
      normalPool.animations[0] === 'sad' &&
      normalPool.state === 'normal' &&
      // 间隔照旧（换的只是"演什么"）
      JSON.stringify(normalPool.intervalMs) === JSON.stringify([25000, 60000]) &&
      // 收起状态：没有池（不受影响），fidget 还是 lie，默认姿势真的回到 sleep
      inDocked.display.dock === 'bottom' &&
      inDocked.pools.length === 0 &&
      inDocked.fidget !== null &&
      inDocked.fidget.animations.join() === 'lie' &&
      inDocked.fidget.defaultAnimation === 'sleep' &&
      inDocked.bottomDefault === 'sleep' &&
      inDocked.animation === 'sleep';

    finish({
      ok,
      lowMood: LOW_MOOD,
      mainStatusMood: status,
      inNormal,
      docked,
      waitForSleep,
      inDocked,
    });
  } catch (error) {
    finish({ ok: false, error: String((error && error.stack) || error) });
  }
});

setTimeout(() => {
  finish({ ok: false, error: 'PROBE_TIMEOUT' });
}, 90000);
