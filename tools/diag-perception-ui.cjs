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
const { guardSingleInstance } = require('./lib/instance-guard.cjs');

/* 数据目录隔离：这个工具会改感知配置，不能污染用户真实设置 */
const dataDir = join(tmpdir(), 'desktop-pet-diag-perception');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 没有这一步：已有实例时 require(main.js) 会静默 app.quit()，本脚本"跑过了"是假象
guardSingleInstance(app, {
  onBlocked: (message) => {
    try { writeFileSync(outFile, JSON.stringify({ fatal: message, steps: [] }, null, 1), 'utf8'); } catch (error) { /* 忽略 */ }
  },
});
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
      hasCloseUp: !!document.getElementById('perception-window-close-up'),
      hasCloseUpWidth: !!document.getElementById('perception-window-close-up-width'),
      mounted: !!document.querySelector('#perception-panel-root .perception-panel'),
    };
  })()`);
  step('设置窗口的「环境与用户感知」面板已挂载', panel, panel.mounted && panel.sections >= 5 && panel.hasPrivacy && panel.hasAuth);
  step(
    '面板：「窗口特写」两个控件在（开关 + 宽度）——终端文字靠它才读得清',
    panel,
    panel.hasCloseUp && panel.hasCloseUpWidth,
  );

  /*
   * 2) + 3) **开关回显必须与主进程一致**。
   *
   * 这条是"截图验收"抓出来的真实 bug：默认全开时面板上的复选框却是空的，
   * 状态行写着"正在采集" —— 自相矛盾的画面比功能坏了更伤信任。
   * 断言方式：把主进程状态与 DOM 上的勾选态逐个比对。
   *
   * ⚠️ 还额外数了一遍**开关项的个数与文案**：只按 id 查的话，"同一个开关被 append 了
   * 两次"这种错误查不出来（第二次会把它绑定的那个 checkbox 从第一行挪走，
   * 于是第一行剩一个没有复选框的标题 —— 实测真的漏过一次，是截图看出来的）。
   */
  const echo = await run(`(async () => {
    const status = await window.settingsAPI.perception.status();
    const ids = ['perception-screen', 'perception-behavior', 'perception-camera', 'perception-habits'];
    const fields = ['screen', 'behavior', 'camera', 'habits'];
    const mismatches = [];
    for (let i = 0; i < ids.length; i++) {
      const control = document.getElementById(ids[i]);
      const expected = status.settings[fields[i]];
      if (!control) { mismatches.push(ids[i] + ':missing'); continue; }
      if (control.checked !== expected) mismatches.push(ids[i] + '=' + control.checked + ' expected=' + expected);
    }
    const items = Array.from(document.querySelectorAll('#perception-panel-root .perception-switch-item'));
    const labels = items.map((item) => (item.querySelector('label')?.textContent ?? '').trim());
    const duplicates = labels.filter((label, index) => labels.indexOf(label) !== index);
    const withoutCheckbox = items.length - items.filter((item) => item.querySelector('input[type="checkbox"]')).length;
    return { mismatches, status: status.settings.screen, itemCount: items.length, labels, duplicates, withoutCheckbox };
  })()`);
  step(
    '面板：四个开关的勾选态与主进程状态一致（默认全开时必须都是勾上的）',
    echo,
    echo.mismatches.length === 0,
  );
  step(
    '面板：开关项不多不少（4 项、无重复文案、每项都有自己的复选框）',
    echo,
    echo.itemCount === 4 && echo.duplicates.length === 0 && echo.withoutCheckbox === 0,
  );

  /* 4) 隐私模式：点一下必须真的停采（读主进程状态确认） */
  const privacy = await run(`(async () => {
    const box = document.getElementById('perception-privacy-mode');
    const before = await window.settingsAPI.perception.status();
    box.click();
    await new Promise((r) => setTimeout(r, 800));
    const after = await window.settingsAPI.perception.status();
    const view = await window.settingsAPI.perception.viewNow('scene');
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

  /* 5) 摄像头授权：点按钮 -> 主进程状态变化 -> 撤销 */
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

  /* 6) 「看屏幕」按钮：没配密钥时要给出人话，不是空白/报错 */
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

  /* 7) 日志列表能刷新出来 */
  const log = await run(`(async () => {
    const btn = document.getElementById('perception-log-refresh');
    if (btn) { btn.click(); await new Promise((r) => setTimeout(r, 1200)); }
    const items = document.querySelectorAll('#perception-log-list li');
    return { count: items.length, first: (items[0]?.textContent ?? '').slice(0, 60) };
  })()`);
  step('面板：感知日志能列出来（可审计她看见了什么）', log, log.count >= 1);

  /* 8) 场景纠正规则：面板上改完必须落到主进程（"浏览器被认成笔记软件"的兜底口子） */
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

  /* 9) 窗口上下文：真机验证"最上层窗口 + 窗口列表"能读到（这是本轮新增的证据来源） */
  const windowCtx = await run(`(async () => {
    const before = await window.settingsAPI.perception.status();
    const sampled = await window.settingsAPI.perception.sampleNow();
    const rect = sampled.windowContext.foregroundRect;
    return {
      beforeCount: before.windowContext.count,
      count: sampled.windowContext.count,
      foregroundTitle: sampled.windowContext.foregroundTitle,
      foregroundProcess: sampled.windowContext.foregroundProcess,
      sample: sampled.windowContext.sample.slice(0, 3),
      rect,
      // 逻辑坐标（DIP）与物理像素两套都要比一遍："特写"能不能裁对就看它落在哪套里
      screenSize: { width: window.screen.width, height: window.screen.height },
      devicePixelRatio: window.devicePixelRatio,
      backingOff: sampled.windowContext.backingOff,
    };
  })()`);
  step(
    '感知面板：窗口上下文真的读到（最上层窗口 + 窗口列表；真机 Windows 枚举）',
    windowCtx,
    windowCtx.count >= 1 && windowCtx.foregroundTitle.length > 0 && windowCtx.backingOff === false,
  );
  /*
   * 这一条是"窗口特写"能不能工作的**真机前提**：必须真的拿到前台窗口矩形，
   * 而且它得落在屏幕范围内（逻辑坐标或物理像素任意一套即可）。
   * 拿到一个明显在屏幕外的矩形，特写就会被纯函数判成"没法裁"而放弃 ——
   * 那时功能是"安静降级"，但我们会在这里先看见。
   */
  const rectInScreen = (() => {
    const rect = windowCtx.rect;
    if (!rect) return false;
    const logical = { width: windowCtx.screenSize.width, height: windowCtx.screenSize.height };
    const physical = {
      width: Math.round(logical.width * windowCtx.devicePixelRatio),
      height: Math.round(logical.height * windowCtx.devicePixelRatio),
    };
    const fits = (space) =>
      rect.x >= -8 && rect.y >= -8 && rect.x + rect.width <= space.width + 8 && rect.y + rect.height <= space.height + 8;
    return fits(logical) || fits(physical);
  })();
  step(
    '感知面板：拿到最上层窗口矩形且落在屏幕内（窗口特写的前提；逻辑坐标/物理像素任一即可）',
    windowCtx,
    windowCtx.rect !== null && windowCtx.rect.width >= 160 && windowCtx.rect.height >= 120 && rectInScreen,
  );

  /*
   * 截图：滚到感知面板，肉眼验收排版。
   *
   * ⚠️ 这一段**不是断言**，也没有包在 `step()` 里 ——
   * `build/perception-ui.json` 的 `steps.length` 等于上面的 `step()` 个数（不含本段）。
   */
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
