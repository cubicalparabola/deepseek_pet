// @ts-check
/**
 * 端到端检查**动画系统这一次的大改**（需求 6.2）：
 *
 *   1. 新动画是否都在（27 条：状态 3 / 随机 10 / 触发 11 / 点击 3）；
 *   2. 三段式"loop 随机次数"是否真的随机（2~5）；
 *   3. loop 阶段被打断 -> **先播 end 再播新动画**；end 阶段被打断 -> 立刻让位；
 *   4. 点击动画**不可打断**（连 force 也不行）；
 *   5. 拖到右/下边缘 -> 收起（watch / lie 成为默认动画），拖动离开 / 点击 -> 展开；
 *   6. 隐藏 = 窗口不可见，显示 = 回来；
 *   7. 随机池按显示状态切换（正常 9 个候选、收起只有 1 个）。
 *
 * 用法：npx electron tools/diag-anim-system.cjs
 * 输出：build/anim-system.json + 控制台摘要
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'anim-system.json');

const dataDir = join(tmpdir(), 'desktop-pet-diag-anim');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { ok: false, steps: [] };
function step(name, detail, ok = true) {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? '[OK]' : '[NG]'} ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

app.whenReady().then(async () => {
  await wait(6000);
  const petWin = BrowserWindow.getAllWindows()[0];
  if (!petWin) throw new Error('桌宠窗口不存在');
  const run = (js) => petWin.webContents.executeJavaScript(js, true);
  const settings = () => petWin.webContents.executeJavaScript('window.petAPI.window.showSettingsWindow()', true);

  /* 1) 清单与分类 */
  const catalog = await run(`(() => {
    const anim = window.petDebug.anim;
    const ids = anim.list();
    const byCategory = {};
    for (const id of ids) {
      const definition = anim.getDefinition(id);
      const category = definition.category ?? '?';
      (byCategory[category] ??= []).push(id);
    }
    return {
      total: ids.length,
      byCategory,
      counts: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
    };
  })()`);
  step(
    '动画清单：27 条，四类（状态 3 / 随机 10 / 触发 11 / 点击 3）',
    catalog,
    catalog.total === 27 &&
      catalog.counts.state === 3 &&
      catalog.counts.random === 10 &&
      catalog.counts.trigger === 11 &&
      catalog.counts.click === 3,
  );

  /* 2) 三段式：loop 随机次数落在配置的 2~5 里，且多次播放不是同一个数 */
  const loopCounts = await run(`(async () => {
    const anim = window.petDebug.anim;
    const seen = [];
    for (let i = 0; i < 8; i += 1) {
      anim.stop('probe');
      anim.resetCooldowns();
      await anim.play('sad', { reason: 'diag-loop-count', source: 'system', interrupt: 'force' });
      // 次数是在**进入 loop 段**时定下的：要等 start 段播完（sad-start 约 1.3s）
      for (let k = 0; k < 40 && anim.getPersistentPhase() !== 'loop'; k += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      seen.push(anim.getLoopTarget());
    }
    anim.stop('probe');
    return { seen, min: Math.min(...seen), max: Math.max(...seen), distinct: [...new Set(seen)].length };
  })()`);
  step(
    '三段式：loop 次数每次随机（2~5），不是写死的常数',
    loopCounts,
    loopCounts.min >= 2 && loopCounts.max <= 5 && loopCounts.distinct >= 2,
  );

  /* 3) loop 阶段被打断 -> 先播 end，再播打断它的动画 */
  const interrupted = await run(`(async () => {
    const anim = window.petDebug.anim;
    anim.stop('probe');
    anim.resetCooldowns();
    await anim.play('sleep', { reason: 'diag-interrupt', source: 'system', interrupt: 'force' });
    // 等到进入 loop 段（start 段约 1.8s）
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const phaseBefore = anim.getPersistentPhase();
    const result = await anim.play('catch_down', { reason: 'diag-interrupt-next', source: 'system', interrupt: 'force' });
    const phaseAfter = anim.getPersistentPhase();
    const currentAfterRequest = anim.getCurrentAnimation();
    const pending = anim.hasPendingAfterEnd();
    // 等收尾段播完（sleep-end 约 4.2s），看接上的是不是 catch_down
    let settled = null;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (anim.getCurrentAnimation() === 'catch_down') { settled = 'catch_down'; break; }
      if (anim.getCurrentAnimation() === null) { settled = '(none)'; break; }
    }
    return { phaseBefore, phaseAfter, currentAfterRequest, pending, accepted: result.accepted, settled };
  })()`);
  step(
    'loop 中被打断：先播 end 段（暂停新动画），收尾播完再接上新动画',
    interrupted,
    interrupted.phaseBefore === 'loop' &&
      interrupted.phaseAfter === 'end' &&
      interrupted.currentAfterRequest === 'sleep' &&
      interrupted.pending === true &&
      interrupted.settled === 'catch_down',
  );

  /* 4) end 阶段被打断 -> 立刻让位 */
  const cutInEnd = await run(`(async () => {
    const anim = window.petDebug.anim;
    anim.stop('probe');
    anim.resetCooldowns();
    await anim.play('read', { reason: 'diag-end-cut', source: 'system', interrupt: 'force' });
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
    anim.endPersistent('diag-force-end');
    for (let i = 0; i < 30 && anim.getPersistentPhase() !== 'end'; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const phaseBefore = anim.getPersistentPhase();
    await anim.play('play', { reason: 'diag-end-cut-next', source: 'force', interrupt: 'force' });
    return {
      phaseBefore,
      current: anim.getCurrentAnimation(),
      pending: anim.hasPendingAfterEnd(),
      phaseAfter: anim.getPersistentPhase(),
    };
  })()`);
  step(
    'end 中被打断：立刻结束并直接播新动画（不再排 end）',
    cutInEnd,
    cutInEnd.phaseBefore === 'end' && cutInEnd.current === 'play' && cutInEnd.pending === false,
  );

  /* 5) 点击动画不可打断（含 force） */
  const locked = await run(`(async () => {
    const anim = window.petDebug.anim;
    anim.stop('probe');
    anim.resetCooldowns();
    await anim.play('cute', { reason: 'diag-lock', source: 'user', interrupt: 'force' });
    const lockedNow = anim.isLocked();
    const forced = await anim.play('bomb', { reason: 'diag-lock-force', source: 'system', interrupt: 'force' });
    const sameAgain = await anim.play('cute', { reason: 'diag-lock-again', source: 'user' });
    const current = anim.getCurrentAnimation();
    // 等她播完（cute 约 6s）
    let released = null;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (!anim.isLocked()) { released = anim.getCurrentAnimation(); break; }
    }
    return {
      lockedNow,
      forcedAccepted: forced.accepted,
      forcedReason: forced.reason ?? '',
      sameAgainAccepted: sameAgain.accepted,
      current,
      released,
    };
  })()`);
  step(
    '点击动画不可打断：force 也被拒（必须等她播完才能再点）',
    locked,
    locked.lockedNow === true &&
      locked.forcedAccepted === false &&
      locked.forcedReason === 'not-interruptible' &&
      locked.current === 'cute' &&
      locked.released !== null,
  );

  /* 6) 显示状态：贴边收起 -> watch / lie；拖离边缘 -> 自动展开 */
  const docking = await run(`(async () => {
    const api = window.petAPI;
    const model = window.petDebug.animationModel;
    // 先把窗口挪到工作区正中间，保证起点是"没贴边"
    const before = await api.window.getPosition();
    await api.window.setPosition(500, 300);
    await new Promise((r) => setTimeout(r, 400));
    const free0 = await api.window.dragEnd();

    // 拖到右下角（主进程会收敛到工作区内）再松手
    await api.window.setPosition(100000, 100000);
    await new Promise((r) => setTimeout(r, 400));
    const cornerPos = await api.window.getPosition();
    const right = await api.window.dragEnd();
    await new Promise((r) => setTimeout(r, 1400));
    const animAfterRight = window.petDebug.anim.getCurrentAnimation();
    const posRight = await api.window.getPosition();

    // 拖离边缘（向左上 300px）应该自动展开
    await api.window.setPosition(posRight.x - 300, posRight.y - 300);
    await new Promise((r) => setTimeout(r, 600));
    const free = await api.window.dragEnd();
    /*
     * 回到 idle 需要等 watch 的**收尾段**播完（三段式语义：loop 中被打断先播 end）。
     * watch-end 约 4.4s，所以这里轮询等待而不是固定 sleep。
     */
    let animAfterFree = null;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      if (window.petDebug.anim.getCurrentAnimation() === 'idle') { animAfterFree = 'idle'; break; }
      animAfterFree = window.petDebug.anim.getCurrentAnimation();
    }

    // 再拖到下边缘（横向放到中间，避免又判成右边）
    await api.window.setPosition(500, 100000);
    await new Promise((r) => setTimeout(r, 400));
    const bottom = await api.window.dragEnd();
    let animAfterBottom = null;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      animAfterBottom = window.petDebug.anim.getCurrentAnimation();
      if (animAfterBottom === 'lie') break;
    }
    return {
      startPos: before,
      free0: free0.dock,
      cornerPos,
      rightDock: right.dock,
      animAfterRight,
      freeDock: free.dock,
      animAfterFree,
      bottomDock: bottom.dock,
      animAfterBottom,
      display: window.petDebug.display(),
      threshold: model.DOCK_EDGE_THRESHOLD_PX,
    };
  })()`);
  step(
    '拖到右下角 -> 右侧收起并演 watch；拖到下边缘 -> 下方收起并演 lie；拖离边缘 -> 自动展开回 idle',
    docking,
    docking.free0 === 'free' &&
      docking.rightDock === 'right' &&
      docking.animAfterRight === 'watch' &&
      docking.freeDock === 'free' &&
      docking.animAfterFree === 'idle' &&
      docking.bottomDock === 'bottom' &&
      docking.animAfterBottom === 'lie',
  );

  /* 7) 收起时点一下 -> 先播 end 再播 idle（不插点击反应） */
  const undock = await run(`(async () => {
    const api = window.petAPI;
    const anim = window.petDebug.anim;
    // 先回到"没贴边"，再贴右边缘，确保 lastFreePosition 是自由位置
    await api.window.setPosition(500, 300);
    await new Promise((r) => setTimeout(r, 300));
    await api.window.dragEnd();
    await api.window.setPosition(100000, 100000);
    await new Promise((r) => setTimeout(r, 400));
    const docked = await api.window.dragEnd();
    await new Promise((r) => setTimeout(r, 1200));
    const posDocked = await api.window.getPosition();
    const beforeClick = anim.getCurrentAnimation();

    /*
     * 走真实点击路径（handleIntent 里"收起状态下点一下就展开"）。
     * 需求：先播 end 再播 idle —— 因此这里逐步记录过程：
     *   1) 立刻进 end 段，且当前**仍是** watch（没有别的动画插进来）；
     *   2) 收尾播完后变成 idle；
     *   3) 全程没有出现点击反应动画（cute/fawning/stroke）。
     */
    const sawAnimations = new Set();
    let sawEndPhase = false;
    window.petDebug.click('head', 0.5, 0.4);
    const t0 = Date.now();
    let afterClick = null;
    while (Date.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 60));
      const current = anim.getCurrentAnimation();
      if (current !== null) sawAnimations.add(current);
      if (anim.getPersistentPhase() === 'end' && current === 'watch') sawEndPhase = true;
      if (current === 'idle') { afterClick = Date.now() - t0; break; }
    }
    return {
      docked: docked.dock,
      posDocked,
      beforeClick,
      sawEndPhase,
      afterClickMs: afterClick,
      finalAnimation: anim.getCurrentAnimation(),
      sequence: [...sawAnimations],
      stateAfterClick: window.petDebug.display().dock,
      // 展开应该回到"收起前的位置"（500,300 附近），而不是留在屏幕边缘
      posAfter: await api.window.getPosition(),
    };
  })()`);
  step(
    '收起状态下点一下宠物：先播 end（仍是 watch，没有点击反应插进来）→ 再回 idle，并回到收起前的位置',
    undock,
    undock.docked === 'right' &&
      undock.beforeClick === 'watch' &&
      undock.sawEndPhase === true &&
      typeof undock.afterClickMs === 'number' &&
      undock.finalAnimation === 'idle' &&
      // 全程只应看到 watch -> idle；cute/fawning/stroke 出现在这里就是"多插了一段"
      undock.sequence.every((id) => id === 'watch' || id === 'idle') &&
      undock.stateAfterClick === 'free' &&
      Math.abs(undock.posAfter.x - 500) < 40,
  );

  /*
   * 下方收起同理（默认动画是 lie）。
   *
   * ⚠️ 这里能断言的只有"点一下就回 idle，且中途没有点击反应"：
   * `lie` 是**单文件素材**（没有 start/loop/end 三段），所以它没有 `end` 可播，
   * 过渡靠交叉淡化而不是收尾段。写清楚这一点，免得以后有人看到"下方收起没有 end"
   * 以为又是漏接线。
   */
  const undockBottom = await run(`(async () => {
    const api = window.petAPI;
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await api.window.setPosition(500, 300);
    await wait(300);
    await api.window.dragEnd();
    await api.window.setPosition(500, 100000);
    await wait(400);
    const docked = await api.window.dragEnd();
    await wait(1500);
    const beforeClick = anim.getCurrentAnimation();
    const hasEnd = Boolean((anim.getDefinition('lie').segments || {}).end);
    const saw = new Set();
    window.petDebug.click('head', 0.5, 0.4);
    const t0 = Date.now();
    let afterClick = null;
    while (Date.now() - t0 < 15000) {
      await wait(60);
      const current = anim.getCurrentAnimation();
      if (current !== null) saw.add(current);
      if (current === 'idle') { afterClick = Date.now() - t0; break; }
    }
    return {
      docked: docked.dock,
      beforeClick,
      lieHasEndSegment: hasEnd,
      afterClickMs: afterClick,
      finalAnimation: anim.getCurrentAnimation(),
      sequence: [...saw],
      stateAfterClick: window.petDebug.display().dock,
    };
  })()`);
  step(
    '下方收起点一下：同样只回 idle（lie 没有 end 段，过渡走交叉淡化）',
    undockBottom,
    undockBottom.docked === 'bottom' &&
      undockBottom.beforeClick === 'lie' &&
      undockBottom.lieHasEndSegment === false &&
      typeof undockBottom.afterClickMs === 'number' &&
      undockBottom.finalAnimation === 'idle' &&
      undockBottom.sequence.every((id) => id === 'lie' || id === 'idle') &&
      undockBottom.stateAfterClick === 'free',
  );

  /* 8) 隐藏 / 显示 */
  const hidden = await run(`(async () => {
    const api = window.petAPI;
    // 先确保没贴边：隐藏的在场状态与收起不同（隐藏 = 看不到主人）
    await api.window.setPosition(500, 300);
    await new Promise((r) => setTimeout(r, 300));
    await api.window.dragEnd();
    await new Promise((r) => setTimeout(r, 800));
    const before = await api.ai.status();
    const trayVisibleBefore = window.petDebug.anim.isPlaying();
    api.window.hide();
    await new Promise((r) => setTimeout(r, 800));
    const during = await api.ai.status();
    api.window.show();
    await new Promise((r) => setTimeout(r, 1200));
    const after = await api.ai.status();
    return {
      presenceBefore: before.presence,
      presenceDuringHide: during.presence,
      presenceAfterShow: after.presence,
      wasPlaying: trayVisibleBefore,
      animationAfterShow: window.petDebug.anim.getCurrentAnimation(),
    };
  })()`);
  step(
    '隐藏 / 显示：窗口显隐与在场状态（visible / hidden）一起变',
    hidden,
    hidden.presenceBefore === 'visible' &&
      hidden.presenceDuringHide === 'hidden' &&
      hidden.presenceAfterShow === 'visible',
  );

  /* 9) 随机池按显示状态切换 */
  const pools = await run(`(async () => {
    const api = window.petAPI;
    const behaviors = window.petDebug.behaviors;
    // 正常状态：先把窗口放到中间
    await api.window.setPosition(500, 300);
    await new Promise((r) => setTimeout(r, 300));
    await api.window.dragEnd();
    await new Promise((r) => setTimeout(r, 900));
    const normal = behaviors.describePools();
    // 收起：贴右下角，再看池
    await api.window.setPosition(100000, 100000);
    await new Promise((r) => setTimeout(r, 400));
    await api.window.dragEnd();
    await new Promise((r) => setTimeout(r, 1200));
    const docked = behaviors.describePools();
    return {
      normal: normal.map((p) => ({ id: p.poolId, animations: p.animations, interval: p.intervalMs })),
      docked: docked.map((p) => ({ id: p.poolId, animations: p.animations, interval: p.intervalMs })),
      config: behaviors.getConfig().states,
    };
  })()`);
  const normalPool = (pools.normal ?? []).find((p) => p.id === 'normal-random');
  const dockedPool = (pools.docked ?? [])[0];
  step(
    '随机池：正常状态 9 个候选、25~60 秒；收起状态只有 1 个候选且 3~8 分钟',
    pools,
    Boolean(normalPool) &&
      normalPool.animations.length === 9 &&
      normalPool.interval[0] === 25000 &&
      normalPool.interval[1] === 60000 &&
      Boolean(dockedPool) &&
      dockedPool.animations.length === 1 &&
      dockedPool.interval[0] === 180000 &&
      dockedPool.interval[1] === 480000 &&
      pools.config['docked-bottom'].defaultAnimation === 'lie' &&
      pools.config['docked-right'].defaultAnimation === 'watch',
  );

  report.ok = report.steps.every((item) => item.ok);
  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');
  console.log(`\n=== 动画系统诊断：${report.steps.filter((s) => s.ok).length}/${report.steps.length} 通过 ===`);
  app.exit(report.ok ? 0 : 1);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack, steps: report.steps }, null, 1), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 300000);
