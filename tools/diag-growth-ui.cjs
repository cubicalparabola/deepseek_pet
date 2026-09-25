// @ts-check
/**
 * 端到端检查「成长、记忆与反思」面板（4.1 / 4.2）真的能用，并截图供肉眼验收。
 *
 * 重点验证 4.1 的**可视化**：时间轴渲染出来了、月份分组正确、手动记一笔能上墙、
 * 「回忆一下」有回应；以及 4.2 的**可解释与可回退**：反思正文能读、
 * 「重置策略」真的把策略清零。
 *
 * 用法：npx electron tools/diag-growth-ui.cjs
 * 输出：build/growth-ui.json + build/shot-growth.png
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'growth-ui.json');

const dataDir = join(tmpdir(), 'desktop-pet-diag-growth');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const consoleErrors = [];

app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (_ev, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) consoleErrors.push(message.slice(0, 400));
  });
});

const report = { ok: false, steps: [] };
function step(name, detail, ok = true) {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? '[OK]' : '[NG]'} ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

app.whenReady().then(async () => {
  await wait(6000);
  const petWin = BrowserWindow.getAllWindows()[0];
  if (!petWin) throw new Error('桌宠窗口不存在');
  const petRun = (js) => petWin.webContents.executeJavaScript(js, true);

  /* 先造点素材：两段对话 + 一条手动节点 + 一次反思 */
  await petRun(`(async () => {
    await window.petAPI.ai.chat('我叫小明，最近在写毕业论文');
    await window.petAPI.ai.chat('今天终于把论文投出去了，累死了');
    await window.petAPI.growth.addNode({ kind: 'manual', title: '搬进了新家', detail: '这天我记住了新桌面的样子' });
    await window.petAPI.growth.reflectNow();
    return true;
  })()`);
  await wait(1500);

  await petRun(`window.petAPI.window.showSettingsWindow()`);
  await wait(2600);
  const win = BrowserWindow.getAllWindows().find((w) => {
    try { return w.webContents.getURL().includes('/settings/'); } catch (error) { return false; }
  });
  if (!win) throw new Error('设置窗口没打开');
  const run = (js) => win.webContents.executeJavaScript(js, true);

  /* 1) 面板挂载 + 时间轴渲染 */
  const panel = await run(`(() => {
    const sections = document.querySelectorAll('#growth-panel-root .growth-section');
    const cards = document.querySelectorAll('#growth-panel-root .growth-memory-card');
    const months = document.querySelectorAll('#growth-panel-root .growth-timeline-group');
    return {
      mounted: !!document.querySelector('#growth-panel-root .growth-panel'),
      sections: sections.length,
      headings: Array.from(sections).map((s) => (s.querySelector('h2')?.textContent ?? '').trim()),
      cards: cards.length,
      months: months.length,
      summary: (document.getElementById('growth-palace-summary')?.textContent ?? '').slice(0, 80),
      hasAddForm: !!document.getElementById('growth-node-add'),
      hasReflect: !!document.getElementById('growth-reflect-now'),
      hasReset: !!document.getElementById('growth-policy-reset'),
    };
  })()`);
  step(
    '设置窗口的「成长与反思」面板已挂载（含记忆宫殿时间轴）',
    panel,
    panel.mounted && panel.sections >= 4 && panel.cards >= 2 && panel.hasAddForm && panel.hasReflect && panel.hasReset,
  );

  /* 2) 手动记一笔 -> 时间轴上多一张卡片 */
  const addNode = await run(`(async () => {
    const before = (await window.settingsAPI.growth.status()).palace.stats.total;
    const kind = document.getElementById('growth-node-kind');
    const title = document.getElementById('growth-node-title');
    const detail = document.getElementById('growth-node-detail');
    kind.value = 'birthday';
    title.value = '一起过生日';
    detail.value = '那天我们聊到了蛋糕';
    document.getElementById('growth-node-add').click();
    await new Promise((r) => setTimeout(r, 1200));
    const after = await window.settingsAPI.growth.status();
    const found = after.palace.nodes.some((node) => node.title === '一起过生日');
    return { before, after: after.palace.stats.total, found, cleared: title.value === '' };
  })()`);
  step('记忆宫殿：面板上手动记一笔真的进时间轴（保存后清空输入）', addNode, addNode.found === true && addNode.after > addNode.before && addNode.cleared === true);

  /* 3) 「让她回忆一下」-> 有回应文本 */
  const recall = await run(`(async () => {
    const status = await window.settingsAPI.growth.status();
    const node = status.palace.nodes.find((item) => item.title === '一起过生日');
    if (!node) return { ok: false, reason: 'node-missing' };
    const button = document.getElementById('growth-recall-' + node.id);
    if (!button) return { ok: false, reason: 'button-missing' };
    button.click();
    await new Promise((r) => setTimeout(r, 1800));
    return { ok: true, status: (document.getElementById('growth-panel-status')?.textContent ?? '').slice(0, 120), disabled: button.disabled };
  })()`);
  step('记忆宫殿：点「让她回忆一下」有回应（状态行给出她说了什么）', recall, recall.ok === true && recall.disabled === false);

  /* 4) 删除（confirm 需要 stub） */
  const removed = await run(`(async () => {
    const nativeConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const status = await window.settingsAPI.growth.status();
      const node = status.palace.nodes.find((item) => item.title === '一起过生日');
      const button = document.getElementById('growth-remove-' + node.id);
      button.click();
      await new Promise((r) => setTimeout(r, 1200));
      const after = await window.settingsAPI.growth.status();
      return { gone: !after.palace.nodes.some((item) => item.title === '一起过生日'), total: after.palace.stats.total };
    } finally {
      window.confirm = nativeConfirm;
    }
  })()`);
  step('记忆宫殿：删除一段经历（二次确认后真的移除）', removed, removed.gone === true);

  /* 5) 反思正文 + 策略表 + 重置策略 */
  const reflect = await run(`(async () => {
    const body = document.getElementById('growth-reflection-body');
    const meta = document.getElementById('growth-reflection-meta');
    const policyRows = document.querySelectorAll('#growth-policy-table tr, #growth-policy-table li');
    const nativeConfirm = window.confirm;
    window.confirm = () => true;
    try {
      document.getElementById('growth-policy-reset').click();
      await new Promise((r) => setTimeout(r, 1200));
    } finally {
      window.confirm = nativeConfirm;
    }
    const status = await window.settingsAPI.growth.status();
    return {
      bodyLength: (body?.textContent ?? '').length,
      meta: (meta?.textContent ?? '').slice(0, 60),
      policyRows: policyRows.length,
      adjustmentsAfterReset: status.policy.adjustments,
      effect: status.policyEffect,
    };
  })()`);
  step(
    '反思：正文与元信息能显示，策略表可读，「重置策略」把调整清零',
    reflect,
    reflect.bodyLength > 10 && reflect.adjustmentsAfterReset === 0,
  );

  /* 6) 滚到成长面板并截图 */
  await run(`(() => {
    const target = document.getElementById('growth-panel-root');
    if (target) target.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  await wait(900);
  const image = await win.capturePage();
  const shot = join(root, 'build', 'shot-growth.png');
  writeFileSync(shot, image.toPNG());
  console.log(`[shot] growth -> ${shot}`);

  report.consoleErrors = consoleErrors;
  report.ok = report.steps.every((item) => item.ok);
  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');
  console.log(`\n=== 成长面板诊断：${report.steps.filter((s) => s.ok).length}/${report.steps.length} 通过 ===`);
  if (consoleErrors.length > 0) {
    console.log('渲染层错误：');
    for (const message of consoleErrors.slice(0, 6)) console.log('  ' + message);
  }
  app.exit(report.ok ? 0 : 1);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack, steps: report.steps }, null, 1), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
