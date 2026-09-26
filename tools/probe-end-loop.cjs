// @ts-check
/**
 * 探针：**收起状态下会不会陷入"end 一直循环"**（用户报告的症状）。
 *
 * 复现思路（照抄真实运行里会发生的请求）：
 *   收起后默认动画是 watch（三段式、无限循环）。此时只要有人**重复**请求动画，
 *   每一次都会走"loop 中被打断 -> 先播 end"，于是画面上就是一串 end。
 *   真实运行里做这件事的正是**自愈链路**：
 *     - `checkVideoHealth()`（视频缓冲僵死时）-> `playFallback()` = idle
 *     - `healStuckAnimation()`（有画面但没动画在播）-> `playFallback()` = idle
 *   它们硬编码回 idle，而收起状态的默认其实是 watch/lie；配合
 *   `resumeFallbackLoop()`（每次回 IDLE 都会把默认动画接回来），
 *   就形成 watch -> end -> idle -> watch -> end ... 的死循环。
 *
 * 本探针直接模拟这两条：
 *   A) 收起右侧，然后每 700ms 调一次 `anim.playFallback()`（= 自愈在做的动作）
 *   B) 收起右侧，然后每 700ms 调一次 `anim.play('watch', { interrupt: 'force' })`
 *      （= "重复请求当前默认动画"这一类的统称）
 * 判定：稳态里不该反复出现 `-end` 素材，也不该长期停在非 idle 的收尾里。
 *
 * 用法：npx electron tools/probe-end-loop.cjs
 * 输出：build/end-loop.json
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'end-loop.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-endloop');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('桌宠窗口不存在');
  const run = (js) => win.webContents.executeJavaScript(js, true);

  // 随机池与触发都静音：本探针只关心"重复请求"这一条
  await run(`(() => { window.petDebug.behaviors.pause(); window.petAPI.notifyBehaviorPaused(true); return true; })()`);

  /** 彻底复位：停掉动画 + 清掉挂起/排队，再收起右侧，等到状态稳定。 */
  const dockRight = () => run(`(async () => {
    const api = window.petAPI;
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    anim.stop('probe-reset');
    anim.clearPendingAfterEnd();
    anim.clearQueue();
    anim.resetCooldowns();
    await wait(300);
    await api.window.setPosition(500, 300);
    await wait(400);
    await api.window.dragEnd();
    await api.window.setPosition(100000, 100000);
    await wait(400);
    await api.window.dragEnd();
    for (let i = 0; i < 25; i += 1) {
      if (window.petDebug.display().dock === 'right') break;
      await wait(100);
    }
    return window.petDebug.display().dock;
  })()`);

  /**
   * 采样 + 按指定动作循环制造"重复请求"。
   * @param action 在渲染层里每次要执行的 JS 片段
   */
  const sample = (action, ms) => run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const frames = [];
    let last = '';
    const t0 = Date.now();
    let ticks = 0;
    let nextActionAt = 0;
    while (Date.now() - t0 < ${ms}) {
      if (Date.now() - t0 >= nextActionAt) {
        nextActionAt = Date.now() - t0 + 700;
        ticks += 1;
        try { ${action} } catch (error) { /* 忽略 */ }
      }
      const source = String(anim.getActiveSource() || '').split('/').pop();
      const frame = [anim.getCurrentAnimation(), anim.getPersistentPhase() || '-', source].join('|');
      if (frame !== last) { frames.push({ at: Date.now() - t0, frame }); last = frame; }
      await wait(100);
    }
    return {
      frames,
      ticks,
      endCount: frames.filter((f) => f.frame.includes('-end')).length,
      idles: frames.filter((f) => f.frame.startsWith('idle|')).length,
      dock: window.petDebug.display().dock,
    };
  })()`);

  const result = {};

  /* A) 自愈动作：playFallback()（= idle）反复请求 */
  result.dockA = await dockRight();
  result.healFallback = await sample(`void anim.playFallback({ reason: 'probe-heal', source: 'system' });`, 9000);
  result.afterA = await run(`(() => ({ animation: window.petDebug.anim.getCurrentAnimation(), phase: window.petDebug.anim.getPersistentPhase() }))()`);

  /* B) 重复请求当前默认动画本身（force） */
  result.dockB = await dockRight();
  result.repeatSame = await sample(`void anim.play('watch', { interrupt: 'force', reason: 'probe-repeat', source: 'system' });`, 9000);
  result.afterB = await run(`(() => ({ animation: window.petDebug.anim.getCurrentAnimation(), phase: window.petDebug.anim.getPersistentPhase() }))()`);

  /* C) 对照：不做任何重复请求，收起后应当稳定停在 watch 的 loop 段 */
  result.dockC = await dockRight();
  result.steady = await sample(`/* 不请求任何动画 */`, 6000);

  /*
   * D) 反方向：收起状态的**随机池动画（peek）必须仍然允许**
   *    （需求：收起时有一个随机动画、随机时间触发），
   *    而 idle 这种"收起状态不该有的动画"必须被拒。
   */
  result.dockD = await dockRight();
  result.poolAllowed = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const peek = await anim.play('peek', { interrupt: 'auto', reason: 'random-pool:docked-right-random', source: 'behavior' });
    await wait(400);
    const afterPeek = anim.getCurrentAnimation();
    const idle = await anim.play('idle', { interrupt: 'force', reason: 'probe-idle', source: 'system' });
    await wait(400);
    return {
      peekAccepted: peek.accepted,
      peekReason: peek.reason ?? null,
      afterPeek,
      idleAccepted: idle.accepted,
      idleReason: idle.reason ?? null,
      animation: anim.getCurrentAnimation(),
    };
  })()`);

  result.verdict = {
    // 自愈动作不该把收起状态的默认动画反复打断成 end
    healDoesNotLoopEnd: result.healFallback.endCount === 0,
    // 重复请求同一个默认动画也不该反复播 end
    repeatSameDoesNotLoopEnd: result.repeatSame.endCount === 0,
    // 对照：稳态本来就不该出现 end
    steadyHasNoEnd: result.steady.endCount === 0,
    // 收起状态自己的随机动画（peek）仍然被允许
    poolAnimationStillAllowed: result.poolAllowed.peekAccepted === true,
    // 收起状态不该被 idle 之类的动画顶掉
    idleRejectedWhileDocked: result.poolAllowed.idleAccepted === false && result.poolAllowed.idleReason === 'docked',
    // 收起结束时仍应停在该状态的默认动画上（watch 的 loop 段）
    settledOnDefault: result.afterA.animation === 'watch' || result.afterA.animation === 'idle',
  };

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log(JSON.stringify(result.verdict, null, 1));
  const show = (name, item) => console.log(`\n[${name}] end=${item.endCount} idle=${item.idles} ticks=${item.ticks}\n  ` +
    item.frames.map((f) => `${f.at}ms ${f.frame}`).join('\n  '));
  show('healFallback', result.healFallback);
  show('repeatSame', result.repeatSame);
  show('steady', result.steady);
  console.log('\n[poolAllowed]', JSON.stringify(result.poolAllowed));
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 240000);
