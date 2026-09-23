// @ts-check
/**
 * 诊断脚本（非产品代码）：验证「bomb 播完一次后还能再播」。
 *
 * 复现背景：bomb 的 cooldown 是 300000ms（5 分钟），而冷却对
 * `interrupt: 'force'` 也生效，于是托盘/右键菜单里点第二次毫无反应，
 * 看起来就是"这个动画只能播一次"。
 *
 * 修复后：用户手动挑动画（托盘 / 右键菜单）走 `bypassCooldown: true`，
 * 冷却只对自动化来源（行为 / 插件 / AI）继续生效。
 *
 * 用法：npx electron tools/diag-bomb-replay.cjs
 * 退出码：0 = 全部通过，1 = 有失败项。
 */
const { app, BrowserWindow } = require('electron');
const { join } = require('node:path');

const root = join(__dirname, '..');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.log('DIAG_RESULT', JSON.stringify({ fatal: 'no window' }));
    return app.exit(1);
  }
  const run = (script) => win.webContents.executeJavaScript(script, true);

  const result = await run(`(async () => {
    const anim = window.petDebug.anim;
    const actions = window.petDebug.actions;
    const sm = window.petDebug.state;
    const bus = window.petDebug.bus;
    const events = [];
    const rejected = [];
    bus.on('animation:end', (p) => events.push(['end', p.animationId, p.completed, p.reason]));
    bus.on('animation:rejected', (p) => rejected.push([p.animationId, p.rejection]));

    const def = anim.getDefinition('bomb');
    // 与托盘/右键菜单「播放动画（测试）」完全同一条路径（priority 60 + bypassCooldown）
    const manual = (extra) => actions.execute({
      type: 'animation',
      animationId: 'bomb',
      priority: 60,
      source: 'system',
      reason: 'tray-menu',
      bypassCooldown: true,
      ...extra,
    });

    if (sm.get() !== 'IDLE') sm.request('IDLE', 'diag-reset');
    anim.stop('diag-cleanup');
    await new Promise((r) => setTimeout(r, 300));

    // ---- 第一次手动播放 ----
    const first = await manual();
    let waited = 0;
    while (waited < 15000 && anim.getCurrentAnimation() === 'bomb') {
      await new Promise((r) => setTimeout(r, 200));
      waited += 200;
    }
    const afterFirst = { animation: anim.getCurrentAnimation(), state: sm.get(), waited };
    await new Promise((r) => setTimeout(r, 1500));

    // ---- 紧接着第二次手动播放（关键回归点）----
    const second = await manual();
    const secondVideo = document.querySelector('video.layer-active') || document.querySelector('video');
    const seen = {
      animation: anim.getCurrentAnimation(),
      src: String(secondVideo?.currentSrc || '').split('/').pop(),
      paused: secondVideo?.paused,
      readyState: secondVideo?.readyState,
      t0: Number(secondVideo?.currentTime ?? 0),
    };
    await new Promise((r) => setTimeout(r, 800));
    const seenLater = {
      t: Number((document.querySelector('video.layer-active') || document.querySelector('video'))?.currentTime ?? 0),
    };
    anim.stop('diag-cleanup');

    // ---- 自动化来源必须继续受冷却保护 ----
    await new Promise((r) => setTimeout(r, 200));
    const automated = await actions.execute({
      type: 'animation', animationId: 'bomb', priority: 100, source: 'behavior', reason: 'diag-auto',
    });
    anim.stop('diag-cleanup');

    return {
      definition: { cooldown: def.cooldown, priority: def.priority, interruptible: def.interruptible },
      first: { accepted: first.accepted, rejection: first.rejection ?? null },
      afterFirst,
      second: { accepted: second.accepted, rejection: second.rejection ?? null, ...seen, ...seenLater },
      // ActionManager 会把动画被拒统一说成 animation-not-found，
      // 所以这里看 AnimationManager 发出的权威事件 animation:rejected
      automated: { accepted: automated.accepted, rejection: automated.rejection ?? null },
      automatedRejection: rejected[rejected.length - 1] ?? null,
      events,
    };
  })()`);

  const checks = [
    ['第一次手动播放 bomb 成功', result.first.accepted === true, JSON.stringify(result.first)],
    ['bomb 播完后自动回到 idle', result.afterFirst.animation === 'idle', JSON.stringify(result.afterFirst)],
    [
      '第二次手动播放 bomb 被接受（回归：不再被冷却吞掉）',
      result.second.accepted === true && result.second.animation === 'bomb',
      JSON.stringify({ accepted: result.second.accepted, rejection: result.second.rejection, animation: result.second.animation }),
    ],
    [
      '第二次确实在播 bomb 且时间轴前进',
      result.second.src === 'bomb.webm' && result.second.paused === false && result.second.t > result.second.t0,
      JSON.stringify({ src: result.second.src, paused: result.second.paused, t0: result.second.t0, t: result.second.t }),
    ],
    [
      '自动化来源仍被冷却拦住（防刷屏未被削弱）',
      result.automated.accepted === false
        && Array.isArray(result.automatedRejection)
        && result.automatedRejection[1] === 'cooldown',
      JSON.stringify({ action: result.automated, event: result.automatedRejection }),
    ],
  ];

  const failed = checks.filter(([, ok]) => !ok);
  console.log('DIAG_RESULT', JSON.stringify({ checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })), result }, null, 1));
  console.log(failed.length === 0 ? 'DIAG_PASS' : 'DIAG_FAIL');
  app.exit(failed.length === 0 ? 0 : 1);
});
