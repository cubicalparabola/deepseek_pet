// @ts-check
/**
 * 给两个新窗口（设置窗口的 AI 面板、聊天窗口）各截一张图，用于**肉眼验收**。
 *
 * 为什么需要它：自动化能断言"元素存在、状态正确"，但排版错位、
 * 文字被截断、配色刺眼这类问题只有看图才发现。
 *
 * 用法：npx electron tools/shot-windows.cjs
 * 输出：build/shot-settings.png、build/shot-chat.png
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const { guardSingleInstance } = require('./lib/instance-guard.cjs');
const dataDir = join(tmpdir(), 'desktop-pet-shot-data');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// 没有这一步：已有实例时 require(main.js) 会静默 app.quit()，截图会保持上一次的旧文件
guardSingleInstance(app);
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const petWin = BrowserWindow.getAllWindows()[0];
  const petRun = (js) => petWin.webContents.executeJavaScript(js, true);

  /* 造一点内容，免得截图全是空状态：打开记忆/情绪，说两句话，写一篇日记 */
  await petRun(`(async () => {
    await window.petAPI.ai.setSettings({ enabled: true, chat: true, memory: true, emotion: true, diary: true, userName: '主人' });
    await window.petAPI.ai.chat('我叫小明，最近在写一个桌宠项目');
    await window.petAPI.ai.chat('今天有点累，不过和你说话好多了');
    await window.petAPI.ai.writeDiary();
    return true;
  })()`);
  await wait(1200);

  await petRun(`window.petAPI.window.showSettingsWindow()`);
  await petRun(`window.petAPI.ai.openChatWindow()`);
  await wait(3000);

  for (const [name, part] of [['settings', '/settings/'], ['chat', '/chat/']]) {
    const win = BrowserWindow.getAllWindows().find((w) => {
      try { return w.webContents.getURL().includes(part); } catch (error) { return false; }
    });
    if (!win) continue;
    win.show();
    win.focus();
    await wait(700);
    const image = await win.capturePage();
    const file = join(root, 'build', `shot-${name}.png`);
    writeFileSync(file, image.toPNG());
    console.log(`[shot] ${name} -> ${file}  ${image.getSize().width}x${image.getSize().height}`);
  }

  /* 截图用的假配置不要留下 */
  await petRun(`(async () => {
    await window.petAPI.ai.setSettings({ enabled: false, chat: false, memory: false, emotion: false, diary: false, clearApiKey: true, resetUsage: true });
    return true;
  })()`);
  app.exit(0);
}).catch((error) => {
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
