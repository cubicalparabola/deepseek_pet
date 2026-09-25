// @ts-check
/**
 * 端到端检查**两个新窗口**（设置窗口的 AI 面板、聊天窗口）真的能用。
 *
 * 为什么单独一个工具：验收脚本只断言"桥注入了 / 窗口开了 / 状态对"，
 * 而这两个窗口的价值全在**交互**上 —— 面板能不能点、输入框能不能发、
 * 消息能不能回显。这些只能靠真实地"点一下、打一句话"来验证。
 *
 * 用法：npx electron tools/diag-ai-ui.cjs
 * 输出：build/ai-ui.json + 控制台摘要
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'ai-ui.json');

/* 数据目录隔离：这个工具也会改 AI 配置，不能污染用户真实数据 */
const dataDir = join(tmpdir(), 'desktop-pet-diag-ai-ui');
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
    if (level >= 2 && !message.includes('Electron Security Warning')) {
      consoleErrors.push(message.slice(0, 400));
    }
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

  const findByUrl = (part) => BrowserWindow.getAllWindows().find((w) => {
    try { return w.webContents.getURL().includes(part); } catch (error) { return false; }
  });

  /* ------------------------- 1) 设置窗口 + AI 面板 ------------------------- */
  await petRun(`window.petAPI.window.showSettingsWindow()`);
  await wait(2500);
  const settingsWin = findByUrl('/settings/');
  if (!settingsWin) throw new Error('设置窗口没打开');
  const settingsRun = (js) => settingsWin.webContents.executeJavaScript(js, true);

  const panel = await settingsRun(`(() => {
    const root = document.getElementById('ai-panel-root');
    return {
      sections: document.querySelectorAll('#ai-panel-root .ai-section').length,
      headings: Array.from(document.querySelectorAll('#ai-panel-root .ai-section h2')).map((h) => h.textContent),
      hasEnabled: !!document.getElementById('ai-enabled'),
      hasChat: !!document.getElementById('ai-chat'),
      hasMemory: !!document.getElementById('ai-memory'),
      hasEmotion: !!document.getElementById('ai-emotion'),
      hasDiary: !!document.getElementById('ai-diary'),
      hasKey: !!document.getElementById('ai-provider-api-key'),
      hasTest: !!document.getElementById('ai-test'),
      hasDiaryList: !!document.getElementById('ai-diary-list'),
      hasFacts: !!document.getElementById('ai-memory-facts'),
      rootText: (root?.textContent ?? '').slice(0, 120),
    };
  })()`);
  step('设置窗口的 AI 面板已挂载（8 个分区）', panel, panel.sections >= 6 && panel.hasEnabled && panel.hasKey);

  /*
   * 真实点击「启用 AI」复选框，看主进程状态是否跟着变。
   *
   * ⚠️ 不要假设初始值是关的：AI 与其它模块一样**默认全开**（`DEFAULT_AI_SETTINGS`），
   * 所以这里断言"点一下就翻转"，而不是"点一下就变成开"；最后再点回来复原。
   */
  const toggle = await settingsRun(`(async () => {
    const box = document.getElementById('ai-enabled');
    const before = await window.settingsAPI.ai.status();
    box.click();
    await new Promise((r) => setTimeout(r, 700));
    const after = await window.settingsAPI.ai.status();
    const flipped = { before: before.settings.enabled, after: after.settings.enabled, checked: box.checked };
    box.click();
    await new Promise((r) => setTimeout(r, 700));
    const restored = await window.settingsAPI.ai.status();
    return { ...flipped, restored: restored.settings.enabled };
  })()`);
  step(
    '设置面板：勾选「启用 AI」真的写进主进程（默认全开，点一下翻转）',
    toggle,
    toggle.after === !toggle.before && toggle.checked === toggle.after && toggle.restored === toggle.before,
  );

  /* 填一个假的不可达地址 + 密钥，点「测试连接」，必须显示失败而不是卡住 */
  const testConn = await settingsRun(`(async () => {
    const set = (id, value) => { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
    /* 测试连接需要"总开关 + 对话开关"都打开，否则主进程会直接说"对话开关未打开" */
    const chatBox = document.getElementById('ai-chat');
    if (!chatBox.checked) chatBox.click();
    await new Promise((r) => setTimeout(r, 400));
    set('ai-provider-base-url', 'http://127.0.0.1:9/v1');
    set('ai-provider-model', 'diag-model');
    set('ai-provider-api-key', 'sk-diag-key-1234567890');
    await new Promise((r) => setTimeout(r, 400));
    const saveBtn = document.getElementById('ai-provider-save');
    if (saveBtn) { saveBtn.click(); await new Promise((r) => setTimeout(r, 900)); }
    const testBtn = document.getElementById('ai-test');
    testBtn.click();
    await new Promise((r) => setTimeout(r, 4000));
    const result = document.getElementById('ai-test-result');
    return {
      text: result ? result.textContent : '(缺元素)',
      disabledAfter: testBtn.disabled,
      status: (document.getElementById('ai-panel-status')?.textContent ?? '').slice(0, 160),
    };
  })()`);
  step('设置面板：测试连接失败时给出可读错误（按钮恢复可用）', testConn, testConn.disabledAfter === false && testConn.text.length > 0);

  /* 「立即写今天的日记」：点一下必须真的写出文件并在列表里出现 */
  const diary = await settingsRun(`(async () => {
    const count = () => document.querySelectorAll('#ai-diary-list .ai-diary-item').length;
    const before = count();
    const btn = document.getElementById('ai-diary-write');
    btn.click();
    await new Promise((r) => setTimeout(r, 2500));
    return { before, after: count(), disabledAfter: btn.disabled };
  })()`);
  step('设置面板：点「立即写今天的日记」后列表出现条目', diary, diary.after >= 1 && diary.disabledAfter === false);

  /* ------------------------------ 2) 聊天窗口 ------------------------------ */
  await petRun(`window.petAPI.ai.openChatWindow()`);
  await wait(2500);
  const chatWin = findByUrl('/chat/');
  if (!chatWin) throw new Error('聊天窗口没打开');
  const chatRun = (js) => chatWin.webContents.executeJavaScript(js, true);

  const chatLayout = await chatRun(`(() => ({
    hasInput: !!document.getElementById('input'),
    hasMessages: !!document.getElementById('messages'),
    badge: document.getElementById('mode-badge')?.textContent ?? '',
    mood: document.getElementById('mood-line')?.textContent ?? '',
    hunger: document.getElementById('hunger-line')?.textContent ?? '',
    emptyVisible: !document.getElementById('empty-hint')?.hidden,
  }))()`);
  step('聊天窗口：布局元素齐全（输入框/消息区/状态条）', chatLayout, chatLayout.hasInput && chatLayout.hasMessages && /心情/.test(chatLayout.mood));

  /* 真的打一句话并回车：消息区必须出现"我"和"她"各一条 */
  const send = await chatRun(`(async () => {
    const input = document.getElementById('input');
    input.value = '你好呀，今天过得怎么样？';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 2500));
    const nodes = Array.from(document.querySelectorAll('#messages .msg'));
    return {
      count: nodes.length,
      user: nodes.filter((n) => n.classList.contains('msg-user')).map((n) => (n.querySelector('.bubble')?.textContent ?? '').slice(0, 40)),
      pet: nodes.filter((n) => n.classList.contains('msg-pet')).map((n) => (n.querySelector('.bubble')?.textContent ?? '').slice(0, 60)),
      error: document.getElementById('error-bar')?.hidden === false ? (document.getElementById('error-bar')?.textContent ?? '') : '',
      typingLeft: document.querySelectorAll('#messages .typing').length,
      mood: document.getElementById('mood-line')?.textContent ?? '',
    };
  })()`);
  step(
    '聊天窗口：Enter 发送 -> 用户消息 + 宠物回复都上屏',
    send,
    send.count >= 2 && send.user.length >= 1 && send.pet.length >= 1 && send.typingLeft === 0,
  );

  /* 「让她说句话」按钮 */
  const speakUp = await chatRun(`(async () => {
    const before = document.querySelectorAll('#messages .msg-pet').length;
    document.getElementById('speak-up').click();
    await new Promise((r) => setTimeout(r, 2500));
    const after = document.querySelectorAll('#messages .msg-pet').length;
    return { before, after, disabledAfter: document.getElementById('speak-up').disabled };
  })()`);
  step('聊天窗口：「让她说句话」会多出一条宠物消息', speakUp, speakUp.after > speakUp.before && speakUp.disabledAfter === false);

  /* 聊天窗口里的「设置」按钮应该能拉起设置窗口（复用而非新开） */
  const windowsBefore = BrowserWindow.getAllWindows().length;
  await chatRun(`document.getElementById('open-settings').click()`);
  await wait(800);
  const windowsAfter = BrowserWindow.getAllWindows().length;
  step('聊天窗口：「设置」按钮复用已存在的设置窗口', { windowsBefore, windowsAfter }, windowsAfter === windowsBefore);

  /* 收尾：隐藏两个窗口并把 AI 关回去（别把诊断用的假配置留下） */
  await chatRun(`document.getElementById('close-window').click()`);
  await petRun(`(async () => {
    await window.petAPI.ai.setSettings({
      enabled: false, chat: false, memory: false, emotion: false, diary: false,
      clearApiKey: true, resetUsage: true,
      provider: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    });
    return true;
  })()`);

  report.consoleErrors = consoleErrors;
  report.ok = report.steps.every((item) => item.ok);
  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');
  console.log(`\n=== AI UI 诊断：${report.steps.filter((s) => s.ok).length}/${report.steps.length} 通过 ===`);
  if (consoleErrors.length > 0) {
    console.log('渲染层错误：');
    for (const message of consoleErrors.slice(0, 8)) console.log('  ' + message);
  }
  app.exit(report.ok ? 0 : 1);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack, steps: report.steps }, null, 1), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
