// @ts-check
/**
 * 探针：聊天窗口的三个视图（聊天 / 小纸条 / 文件）**真的能来回切**吗。
 *
 * 为什么单独写它：`hidden` 属性会被作者样式里的 `display: flex` 覆盖
 * （作者样式优先于 UA 的 `[hidden] { display: none }`），
 * 于是"两个视图同时显示、页签点了没反应"——而这**不会**让
 * `element.hidden === true` 的断言变红。所以这里只看**计算样式与真实高度**。
 *
 * 用法：npx electron tools/probe-note-views.cjs
 * 输出：build/note-views.json
 *
 * ⚠️ 用**独立的 userData 目录**启动，因此不会和正在运行的桌宠抢单实例锁，
 * 也不会碰到用户真实的纸条与设置。
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'note-views.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-noteviews');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

/*
 * 隔离的 userData：main.ts 只在默认目录未命名时才纠正 userData，
 * 所以这里显式传 `--user-data-dir` 会生效 —— 单实例锁也就落在临时目录上，
 * 不会因为"用户正在用桌宠"而静默退出（这正是本探针要能随便跑的前提）。
 */
const profileDir = join(tmpdir(), 'desktop-pet-probe-noteviews-profile');
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
    await wait(6000);
    const petWin = BrowserWindow.getAllWindows()[0];
    if (!petWin) throw new Error('桌宠窗口不存在');
    const pet = (js) => petWin.webContents.executeJavaScript(js, true);

    // 造一条未看的纸条（无密钥 -> 本地兜底文案，不发网络请求）
    await pet(`(async () => {
      await window.petAPI.ai.clearNotes();
      await window.petAPI.ai.composeNote();
      return true;
    })()`);

    await pet(`window.petAPI.ai.openChatWindow()`);
    await wait(2500);
    const chatWin = BrowserWindow.getAllWindows().find((w) => {
      try { return w.webContents.getURL().includes('/chat/'); } catch (error) { return false; }
    });
    if (!chatWin) throw new Error('聊天窗口没打开');

    const result = await chatWin.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const style = (id) => {
        const el = document.getElementById(id);
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return { hidden: el.hidden, display: cs.display, height: Math.round(rect.height), visible: cs.display !== 'none' && rect.height > 0 };
      };
      const badge = () => {
        const el = document.getElementById('notes-badge');
        const cs = getComputedStyle(el);
        return { hidden: el.hidden, display: cs.display, visible: cs.display !== 'none' };
      };
      const snap = (note) => ({
        note,
        chat: style('view-chat'),
        notes: style('view-notes'),
        files: style('view-files'),
        preview: style('preview'),
        badge: badge(),
        tabChat: document.getElementById('tab-chat').classList.contains('tab-active'),
        tabNotes: document.getElementById('tab-notes').classList.contains('tab-active'),
        tabFiles: document.getElementById('tab-files').classList.contains('tab-active'),
      });

      const steps = [];
      steps.push(snap('初始（应只有聊天）'));

      document.getElementById('tab-notes').click();
      await wait(500);
      steps.push(snap('点「小纸条」'));

      document.getElementById('tab-files').click();
      await wait(500);
      steps.push(snap('点「文件」'));

      document.getElementById('tab-chat').click();
      await wait(500);
      steps.push(snap('点回「聊天」'));

      document.getElementById('tab-notes').click();
      await wait(500);
      steps.push(snap('再点「小纸条」'));

      document.getElementById('tab-chat').click();
      await wait(500);
      steps.push(snap('再点回「聊天」'));

      return steps;
    })()`, true);

    // 每一步都**只能有一个**视图可见（三个视图两两互斥）
    const only = (step, expect) =>
      step.chat.visible === expect.chat && step.notes.visible === expect.notes && step.files.visible === expect.files;
    const visibleCount = (step) => [step.chat.visible, step.notes.visible, step.files.visible].filter(Boolean).length;
    const ok =
      only(result[0], { chat: true, notes: false, files: false }) &&
      only(result[1], { chat: false, notes: true, files: false }) &&
      only(result[2], { chat: false, notes: false, files: true }) &&
      only(result[3], { chat: true, notes: false, files: false }) &&
      only(result[4], { chat: false, notes: true, files: false }) &&
      only(result[5], { chat: true, notes: false, files: false }) &&
      result.every((step) => visibleCount(step) === 1) &&
      result.every((step) => step.preview.visible === false) &&
      // 切到小纸条后她的条目会被算作看过 -> 徽标必须真的隐藏（不是只设了 hidden 属性）
      result[1].badge.visible === false &&
      result[4].badge.visible === false;

    finish({ ok, steps: result });
  } catch (error) {
    finish({ ok: false, error: String((error && error.stack) || error) });
  }
});

setTimeout(() => {
  finish({ ok: false, error: 'PROBE_TIMEOUT' });
}, 60000);
