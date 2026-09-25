// @ts-check
/**
 * 端到端检查「环境与用户感知」面板（3.1~3.6）真的能用，并截一张图供肉眼验收。
 *
 * 为什么单独一个工具：验收脚本只断言"桥/状态/纯函数"，而面板的价值在**交互**上：
 * 点一下隐私模式是否真的停采、授权按钮是否真的改变主进程状态、
 * 「看屏幕」按钮失败时是否给出人话。这些只能靠真实点击来验证。
 *
 * 用法：npx electron tools/diag-perception-ui.cjs
 * 输出：build/perception-ui.json + build/shot-perception.png
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'perception-ui.json');

/* 数据目录隔离：这个工具会改感知配置，不能污染用户真实设置 */
const dataDir = join(tmpdir(), 'desktop-pet-diag-perception');
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

  await petRun(`window.petAPI.window.showSettingsWindow()`);
  await wait(2500);
  const settingsWin = BrowserWindow.getAllWindows().find((w) => {
    try { return w.webContents.getURL().includes('/settings/'); } catch (error) { return false; }
  });
  if (!settingsWin) throw new Error('设置窗口没打开');
  const run = (js) => settingsWin.webContents.executeJavaScript(js, true);

  /* 1) 面板挂载 */
  const panel = await run(`(() => {
    const sections = document.querySelectorAll('#perception-panel-root .perception-section');
    return {
      sections: sections.length,
      headings: Array.from(sections).map((s) => (s.querySelector('h2')?.textContent ?? '').trim()),
      hasScreen: !!document.getElementById('perception-screen'),
      hasPrivacy: !!document.getElementById('perception-privacy-mode'),
      hasAuth: !!document.getElementById('perception-camera-authorize'),
      hasView: !!document.getElementById('perception-view-scene'),
      hasLog: !!document.getElementById('perception-log-list'),
      mounted: !!document.querySelector('#perception-panel-root .perception-panel'),
    };
  })()`);
  step('设置窗口的「环境与用户感知」面板已挂载', panel, panel.mounted && panel.sections >= 5 && panel.hasPrivacy && panel.hasAuth);

  /*
   * 1.5) **开关回显必须与主进程一致**。
   *
   * 这条是"截图验收"抓出来的真实 bug：默认全开时面板上的复选框却是空的，
   * 状态行写着"正在采集" —— 自相矛盾的画面比功能坏了更伤信任。
   * 断言方式：把主进程状态与 DOM 上的勾选态逐个比对。
   */
  const echo = await run(`(async () => {
    const status = await window.settingsAPI.perception.status();
    const ids = ['perception-screen', 'perception-vision', 'perception-behavior', 'perception-camera', 'perception-habits'];
    const fields = ['screen', 'vision', 'behavior', 'camera', 'habits'];
    const mismatches = [];
    for (let i = 0; i < ids.length; i++) {
      const control = document.getElementById(ids[i]);
      const expected = status.settings[fields[i]];
      if (!control) { mismatches.push(ids[i] + ':missing'); continue; }
      if (control.checked !== expected) mismatches.push(ids[i] + '=' + control.checked + ' expected=' + expected);
    }
    return { mismatches, status: status.settings.screen };
  })()`);
  step('面板：五个开关的勾选态与主进程状态一致（默认全开时必须都是勾上的）', echo, echo.mismatches.length === 0);

  /* 2) 隐私模式：点一下必须真的停采（读主进程状态确认） */
  const privacy = await run(`(async () => {
    const box = document.getElementById('perception-privacy-mode');
    const before = await window.settingsAPI.perception.status();
    box.click();
    await new Promise((r) => setTimeout(r, 800));
    const after = await window.settingsAPI.perception.status();
    const view = await window.settingsAPI.perception.viewNow('ocr');
    box.click();
    await new Promise((r) => setTimeout(r, 800));
    const restored = await window.settingsAPI.perception.status();
    return {
      before: before.settings.privacyMode,
      after: after.settings.privacyMode,
      capturing: after.capturing,
      pausedReason: after.pausedReason,
      viewRejected: view.ok === false,
      restored: restored.settings.privacyMode,
      checkedAfterRestore: box.checked,
    };
  })()`);
  step(
    '面板：隐私模式一键停采（且状态由主进程回读驱动）',
    privacy.after === true && privacy.capturing === false && privacy.viewRejected === true && privacy.restored === false,
    privacy,
  );

  /* 3) 摄像头授权：点按钮 -> 主进程状态变化 -> 撤销 */
  const camera = await run(`(async () => {
    /*
     * 撤销授权在面板里会走 window.confirm 二次确认。
     * 自动化里必须把它替换掉：模态框会**阻塞渲染进程**，让 executeJavaScript 永远不返回
     * （实测：整个诊断卡死到超时）。
     */
    const nativeConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const btn = document.getElementById('perception-camera-authorize');
      const before = await window.settingsAPI.perception.status();
      btn.click();
      await new Promise((r) => setTimeout(r, 1200));
      const after = await window.settingsAPI.perception.status();
      const btn2 = document.getElementById('perception-camera-authorize');
      btn2.click();
      await new Promise((r) => setTimeout(r, 900));
      const revoked = await window.settingsAPI.perception.status();
      return {
        before: before.settings.cameraAuthorized,
        after: after.settings.cameraAuthorized,
        revoked: revoked.settings.cameraAuthorized,
        label: btn2.textContent,
      };
    } finally {
      window.confirm = nativeConfirm;
    }
  })()`);
  step(
    '面板：摄像头授权按钮真的改主进程状态（可授权可撤销）',
    camera.before === false && camera.after === true && camera.revoked === false,
    camera,
  );

  /* 4) 「看屏幕」按钮：没配密钥时要给出人话，不是空白/报错 */
  const view = await run(`(async () => {
    const btn = document.getElementById('perception-view-scene');
    btn.click();
    await new Promise((r) => setTimeout(r, 2500));
    const pre = document.querySelector('.perception-view-result');
    return { text: (pre?.textContent ?? '').slice(0, 120), disabled: btn.disabled };
  })()`);
  step(
    '面板：「看屏幕」在没配密钥时给出可读说明（不是错误码，按钮恢复可用）',
    view.text.length > 0 && view.disabled === false && !/no-llm|NO_KEY/.test(view.text),
    view,
  );

  /* 5) 日志列表能刷新出来 */
  const log = await run(`(async () => {
    const btn = document.getElementById('perception-log-refresh');
    if (btn) { btn.click(); await new Promise((r) => setTimeout(r, 1200)); }
    const items = document.querySelectorAll('#perception-log-list li');
    return { count: items.length, first: (items[0]?.textContent ?? '').slice(0, 60) };
  })()`);
  step('面板：感知日志能列出来（可审计她看见了什么）', log, log.count >= 1);

  /* 6) 场景纠正规则：面板上改完必须落到主进程（"浏览器被认成笔记软件"的兜底口子） */
  const fixes = await run(`(async () => {
    const before = await window.settingsAPI.perception.status();
    const input = document.getElementById('perception-scene-fixes');
    if (!input) return { ok: false, reason: 'missing-input' };
    input.value = 'Chrome=browsing\\nMyWeirdApp=browsing';
    document.getElementById('perception-scene-fixes-save').click();
    await new Promise((r) => setTimeout(r, 1200));
    const after = await window.settingsAPI.perception.status();
    return {
      ok: true,
      before: before.settings.sceneFixes.length,
      after: after.settings.sceneFixes.slice(),
      input: input.value.split('\\n').length,
    };
  })()`);
  step(
    '感知面板：场景纠正规则可保存到主进程（用于修掉"浏览器被认成笔记软件"这类误判）',
    fixes,
    fixes.ok === true && fixes.after.includes('Chrome=browsing') && fixes.after.includes('MyWeirdApp=browsing'),
  );

  /* 7) 窗口上下文：真机验证"最上层窗口 + 窗口列表"能读到（这是本轮新增的证据来源） */
  const windowCtx = await run(`(async () => {
    const before = await window.settingsAPI.perception.status();
    const sampled = await window.settingsAPI.perception.sampleNow();
    return {
      beforeCount: before.windowContext.count,
      count: sampled.windowContext.count,
      foregroundTitle: sampled.windowContext.foregroundTitle,
      foregroundProcess: sampled.windowContext.foregroundProcess,
      sample: sampled.windowContext.sample.slice(0, 3),
      backingOff: sampled.windowContext.backingOff,
    };
  })()`);
  step(
    '感知面板：窗口上下文真的读到（最上层窗口 + 窗口列表；真机 Windows 枚举）',
    windowCtx,
    windowCtx.count >= 1 && windowCtx.foregroundTitle.length > 0 && windowCtx.backingOff === false,
  );

  /* 8) 滚到感知面板并截图（肉眼验收排版） */
  await run(`(() => {
    const target = document.getElementById('perception-panel-root');
    if (target) target.scrollIntoView({ block: 'start' });
    return true;
  })()`);
  await wait(900);
  const image = await settingsWin.capturePage();
  const shot = join(root, 'build', 'shot-perception.png');
  writeFileSync(shot, image.toPNG());
  console.log(`[shot] perception -> ${shot}`);

  report.consoleErrors = consoleErrors;
  report.ok = report.steps.every((item) => item.ok);
  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');
  console.log(`\n=== 感知面板诊断：${report.steps.filter((s) => s.ok).length}/${report.steps.length} 通过 ===`);
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
