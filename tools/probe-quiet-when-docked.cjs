// @ts-check
/**
 * 探针：**收起/隐藏时不发生对话**（用户要求："收起时不应该发生对话"）。
 *
 * 为什么要单独立一个探针：验收能钉死纯函数（`isQuietDisplay`），但
 * "她真的没在屏幕边上冒泡"只有跑起来才知道 —— 气泡是主进程控制器 +
 * 渲染层 DOM + 窗口尺寸三处一起动的东西。这里用真机读三处证据：
 *   1. 气泡 DOM（`#pet-bubble` 有没有 `pet-bubble-off`）与气泡正文；
 *   2. 宠物窗口的位置/尺寸（气泡是把窗口**撑大**出来的）；
 *   3. 显示状态（`window.petDebug.display()`：收起方向 / 隐藏）。
 *
 * 覆盖四条：
 *   A. 收起状态下"用户自己发的对话"：回复只进**聊天窗口**，不在屏幕边上冒泡；
 *   B. 收起状态下"托盘让她说句话"（用户主动要的）：**先把她请回桌面再开口**；
 *   C. 正说着话时被收起：**已经在冒的气泡要收掉**（不能挂在屏幕边缘）；
 *   D. 反向对照：展开状态下说话，气泡正常出现（gating 没把对话整体弄坏）。
 *
 * 隔离数据目录 + userData；AI 关掉（走本地兜底回复，不联网、结果确定）。
 *
 * 用法：npx electron tools/probe-quiet-when-docked.cjs
 * 输出：build/quiet-when-docked.json + build/shot-quiet-*.png
 */
const { app, BrowserWindow, screen } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'quiet-when-docked.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-quiet');
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

/* 隔离落盘位置（必须在 require(main) 之前） */
app.setPath('userData', dataDir);
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
/* AI 关掉：`chat()` / `speakUp()` 都走本地兜底文本，不联网、不等模型 */
writeFileSync(join(dataDir, 'ai-settings.json'), JSON.stringify({
  enabled: false, chat: false, memory: false, emotion: false, diary: false,
}, null, 2), 'utf8');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  await wait(9000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('桌宠窗口不存在');
  const run = (js) => win.webContents.executeJavaScript(js, true);
  const petBounds = () => win.getBounds();

  /* 收集日志（E 段要证明"自动开口被拦下"，读的就是主进程日志）——
     注意 main 已经 require 过了，这里只劫持**之后**的输出即可 */
  const captured = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    try { captured.push(String(chunk)); } catch (error) { /* 忽略 */ }
    return originalWrite(chunk, ...rest);
  };

  /**
   * 气泡状态（渲染层 DOM）。
   *
   * "她真的在屏幕上说话了" = 气泡元素**没有 `pet-bubble-off`** 且**有文字**：
   * 元素是常驻的（用 class 控显隐），刚启动还没说过话时 class 也还没同步过，
   * 只看 class 会把"从没说过话"误判成"正在说话"（实测踩过）。
   */
  const bubbleState = () => run(`(() => {
    const el = document.getElementById('pet-bubble');
    const body = document.getElementById('pet-bubble-body');
    const text = body ? String(body.textContent || '').trim() : '';
    return {
      exists: !!el,
      off: el ? el.classList.contains('pet-bubble-off') : null,
      text: text.slice(0, 40),
      visible: el ? !el.classList.contains('pet-bubble-off') && text !== '' : null,
    };
  })()`);

  const display = () => run('window.petDebug.display()');

  const result = {};

  /* 打开聊天窗口：验证"收起时对话发生在聊天窗口里" */
  const chatWin = await (async () => {
    await run('window.petAPI.ai.openChatWindow()');
    for (let i = 0; i < 30; i += 1) {
      await wait(200);
      const found = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/chat/'));
      if (found) return found;
    }
    return null;
  })();
  if (!chatWin) throw new Error('聊天窗口没打开');
  const chatRun = (js) => chatWin.webContents.executeJavaScript(js, true);

  /* ---------------- A. 收起 + 用户自己发的对话 ---------------- */
  await run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(500, 320);
    await new Promise((r) => setTimeout(r, 500));
    await api.window.dragEnd();
    await api.window.setPosition(999999, 320);
    await new Promise((r) => setTimeout(r, 500));
    return (await api.window.dragEnd()).dock;
  })()`);
  await wait(2500);
  result.dockedDisplay = await display();
  result.dockedBounds = petBounds();
  const petMessagesBefore = await chatRun(`document.querySelectorAll('#messages .msg-pet').length`);

  await chatRun(`(async () => {
    const box = document.getElementById('input');
    box.value = '收起的时候我不该看到你冒泡';
    document.getElementById('send').click();
    return true;
  })()`);
  await wait(2500);
  result.dockedBubble = await bubbleState();
  result.dockedBoundsAfterChat = petBounds();
  result.dockedDisplayAfterChat = await display();
  result.chatGotReply = (await chatRun(`document.querySelectorAll('#messages .msg-pet').length`)) > petMessagesBefore;

  /* ---------------- C. 正说着话时被收起：气泡该收掉 ---------------- */
  await run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(500, 320);
    await new Promise((r) => setTimeout(r, 500));
    await api.window.dragEnd();
    return window.petDebug.display().dock;
  })()`);
  /*
   * 等回到 idle 再发：本轮起"日常对话只在 idle 状态触发"（F 段验证），
   * 展开的第一瞬还在播收尾段，那时发消息会被闸门拦下（本段要测的是"说话说到一半被收起"）。
   */
  for (let i = 0; i < 60; i += 1) {
    if ((await run('window.petDebug.anim.getCurrentAnimation()')) === 'idle') break;
    await wait(200);
  }
  await wait(400);
  result.midSpeechIdleAnimation = await run('window.petDebug.anim.getCurrentAnimation()');
  const midBubbleBefore = await bubbleState();
  await chatRun(`(async () => {
    const box = document.getElementById('input');
    box.value = '这句话说到一半我就把你收起来';
    document.getElementById('send').click();
    return true;
  })()`);
  await wait(1800);
  result.freeBubble = await bubbleState();
  result.freeBounds = petBounds();
  result.midSpeechBubbleAppeared = result.freeBubble.visible === true && result.freeBubble.text !== midBubbleBefore.text;
  // 拖到右边缘收起（说话中途）
  await run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(999999, 320);
    await new Promise((r) => setTimeout(r, 600));
    return (await api.window.dragEnd()).dock;
  })()`);
  await wait(2200);
  result.afterDockBubble = await bubbleState();
  result.afterDockBounds = petBounds();

  /* ---------------- B. 收起 + 托盘/聊天窗口"让她说句话"（用户主动要） ---------------- */
  await wait(1500);
  const before = { display: await display(), bubble: await bubbleState() };
  // 聊天窗口那个「让她说句话」按钮与托盘菜单「让她说句话」走同一个主进程处理器
  await chatRun(`document.getElementById('speak-up').click()`);
  await wait(2500);
  result.traySpeak = {
    before,
    after: { display: await display(), bubble: await bubbleState(), bounds: petBounds() },
  };

  writeFileSync(join(root, 'build', 'shot-quiet-docked.png'), (await win.capturePage()).toPNG());

  /* ---------------- E. 收起 + **自动**开口（日记写完的主动搭话）：整条不发生 ---------------- */
  /*
   * 怎么造出一个"自动开口"：日记服务**每分钟**检查一次"到点且今天有活动"就写日记，
   * 写完会走 `onSpeak(kind: 'proactive')` 主动说一句 —— 这正是"她自发开口"那条路。
   *   - `diaryHour: 0` 让"到点"恒成立；
   *   - 先在展开状态下聊一句（`memory: true` 会记一轮对话），`hasActivity` 就为真；
   *   - 然后**收起**，等那一分钟里的自动写入。
   * 判据不能只看"没冒泡"（那可能是压根没触发）：**日记文件必须真的写出来了**，
   * 再加上日志里那条 `speech suppressed ... "kind":"proactive"`。
   */
  await run(`window.petAPI.ai.setSettings({
    enabled: true, chat: true, memory: true, emotion: true, diary: true, diaryHour: 0,
    provider: { baseUrl: 'http://127.0.0.1:9/v1', model: 'probe-model', apiKey: 'sk-probe-not-a-real-key' },
  })`);
  await wait(1200);
  await chatRun(`(async () => {
    const box = document.getElementById('input');
    box.value = '留一条今天的活动记录，好让日记有得写';
    document.getElementById('send').click();
    return true;
  })()`);
  await wait(2500);
  // 收起
  await run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(999999, 320);
    await new Promise((r) => setTimeout(r, 600));
    return (await api.window.dragEnd()).dock;
  })()`);
  await wait(2000);
  result.beforeAutoSpeak = { display: await display(), bubble: await bubbleState() };
  const autoLogBefore = captured.length;
  const autoMark = Date.now();
  const diaryDir = join(dataDir, 'diary');
  const diaryFiles = () => {
    try { return require('node:fs').readdirSync(diaryDir).filter((name) => name.startsWith('diary-')); } catch { return []; }
  };
  const beforeDiaryFiles = diaryFiles().length;
  // 等日记调度器那一分钟（最长 90 秒）
  for (let i = 0; i < 180; i += 1) {
    if (diaryFiles().length > beforeDiaryFiles) break;
    await wait(500);
  }
  await wait(2500);
  const autoLog = captured.slice(autoLogBefore).join('');
  const diaryState = await run('window.petAPI.ai.diary()');
  result.autoSpeak = {
    waitedMs: Date.now() - autoMark,
    diaryBefore: beforeDiaryFiles,
    diaryAfter: diaryFiles().length,
    // "今天的日记写好了"这件事用 API 读（文件名规则不重要，只关心真的写了）
    todayWritten: diaryState.todayWritten === true,
    diaryDir: diaryState.dataDir,
    suppressedLog: (autoLog.match(/speech suppressed[^\n]*/) ?? [''])[0],
    display: await display(),
    bubble: await bubbleState(),
    bounds: petBounds(),
  };

  /* ---------------- F. 日常对话只在 IDLE 状态触发 ---------------- */
  /*
   * 用户要求："日常对话只能在 idle 状态触发"。
   * 造法：先把状态弄回"好好待在桌面上"，然后用渲染层调试接口**真的播一条非 idle
   * 动画**（`spin`，随机池里的长动画之一，播的时候 `currentAnimation` 不是 idle）
   * → 这时在聊天窗口发一句，**不该冒泡**（回复仍进聊天窗口）；
   * 等它播完回到 idle 再发一句 → 该冒泡 ✓（反向对照，证明闸门不是"永远不冒泡"）。
   */
  await run(`(async () => {
    const api = window.petAPI;
    await api.window.setPosition(500, 300);
    await new Promise((r) => setTimeout(r, 400));
    await api.window.dragEnd();
    await new Promise((r) => setTimeout(r, 800));
    return window.petDebug.display().dock;
  })()`);
  await wait(1500);
  const busyPhase = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    /*
     * 把她按在一条**动作**动画上（force 抢占）：用 cute（点击反应，约 6 秒、
     * 不可打断）比随机池的 spin 稳 —— spin 在有些时序下会被兜底 idle 顶回去（实测）。
     */
    for (let i = 0; i < 60; i += 1) {
      if (anim.getCurrentAnimation() === 'idle') break;
      await wait(200);
    }
    anim.resetCooldowns();
    await anim.play('cute', { interrupt: 'force', reason: 'quiet-probe-busy' });
    for (let i = 0; i < 40 && anim.getCurrentAnimation() === 'idle'; i += 1) await wait(100);
    return { animation: anim.getCurrentAnimation(), phase: anim.getPersistentPhase() };
  })()`);
  result.busyPhase = busyPhase;
  const busyBubbleBefore = await bubbleState();
  const busyMessagesBefore = await chatRun(`document.querySelectorAll('#messages .msg-pet').length`);
  await chatRun(`(async () => {
    const box = document.getElementById('input');
    box.value = '你正忙着的时候我不该冒泡';
    document.getElementById('send').click();
    return true;
  })()`);
  await wait(2500);
  result.busyBubble = await bubbleState();
  result.busyAnimationAfter = await run('window.petDebug.anim.getCurrentAnimation()');
  result.busyChatGotReply = (await chatRun(`document.querySelectorAll('#messages .msg-pet').length`)) > busyMessagesBefore;
  // "没冒泡" = 气泡文本没有被她这句回复换掉（气泡可能还挂着上一段的话）
  result.busyBubbleUnchanged = result.busyBubble.text === busyBubbleBefore.text;

  // 等她回到 idle（最多 20 秒）再发一句：这次该冒泡
  let idleAnimation = null;
  for (let i = 0; i < 100; i += 1) {
    idleAnimation = await run('window.petDebug.anim.getCurrentAnimation()');
    if (idleAnimation === 'idle') break;
    await wait(200);
  }
  await wait(600);
  result.idleAnimationBeforeChat = idleAnimation;
  const idleMessagesBefore = await chatRun(`document.querySelectorAll('#messages .msg-msg-pet, #messages .msg-pet').length`);
  await chatRun(`(async () => {
    const box = document.getElementById('input');
    box.value = '现在你闲着了，应该冒泡';
    document.getElementById('send').click();
    return true;
  })()`);
  await wait(2500);
  result.idleBubble = await bubbleState();
  result.idleChatGotReply = (await chatRun(`document.querySelectorAll('#messages .msg-pet').length`)) > idleMessagesBefore;

  result.verdict = {
    // A：收起时用户发的对话**不在屏幕边上冒泡**
    noBubbleWhileDocked: result.dockedDisplay.dock === 'right' &&
      result.dockedBubble.visible === false &&
      result.dockedBoundsAfterChat.width === result.dockedBounds.width,
    // A：但回复没丢 —— 落在聊天窗口里（对话发生在聊天窗口）
    replyStillDelivered: result.chatGotReply === true,
    // A：收起状态没有被这次对话顺带展开
    stillDockedAfterChat: result.dockedDisplayAfterChat.dock === 'right',
    // C：展开且 idle 时说话 -> 气泡出现；把她收到边上 -> 气泡被收掉
    bubbleHiddenWhenDockedMidSpeech: result.midSpeechIdleAnimation === 'idle' &&
      result.midSpeechBubbleAppeared === true &&
      result.afterDockBubble.visible === false,
    // B：收起时用户点"让她说句话" -> 先请回桌面（dock 变 free）再开口
    traySpeakExpandsFirst: result.traySpeak.before.display.dock === 'right' &&
      result.traySpeak.after.display.dock === 'free' &&
      result.traySpeak.after.bubble.visible === true,
    // E：**自动**开口（日记写完的主动搭话）在收起时整条不发生 ——
    //    但日记真的写了（不是"没触发"），日志里也有 suppressed 记录
    autoSpeakSuppressed: result.autoSpeak.todayWritten === true &&
      result.autoSpeak.suppressedLog.includes('"kind":"proactive"') &&
      result.autoSpeak.bubble.visible === false &&
      result.autoSpeak.bounds.width === result.dockedBounds.width,
    // F：非 idle 状态下日常对话不冒泡（回复仍进聊天窗口）
    noBubbleWhileBusy: result.busyPhase.animation !== 'idle' &&
      result.busyBubbleUnchanged === true &&
      result.busyChatGotReply === true,
    // F 反向对照：回到 idle 后同一路径该冒泡（闸门不是"永远不冒泡"）
    bubbleWhenIdle: result.idleAnimationBeforeChat === 'idle' &&
      result.idleBubble.visible === true &&
      result.idleBubble.text !== result.busyBubble.text,
  };

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log(`\n[verdict] ${JSON.stringify(result.verdict, null, 1)}`);
  console.log(`[docked] display=${JSON.stringify(result.dockedDisplay)} bubble=${JSON.stringify(result.dockedBubble)} bounds=${JSON.stringify(result.dockedBounds)} -> ${JSON.stringify(result.dockedBoundsAfterChat)} chatGotReply=${result.chatGotReply}`);
  console.log(`[mid-speech] freeBubble=${JSON.stringify(result.freeBubble)} afterDock=${JSON.stringify(result.afterDockBubble)}`);
  console.log(`[traySpeak] ${JSON.stringify(result.traySpeak)}`);
  console.log(`[autoSpeak] todayWritten=${result.autoSpeak.todayWritten} bubble=${JSON.stringify(result.autoSpeak.bubble)} log=${result.autoSpeak.suppressedLog}`);
  console.log(`[busy] phase=${JSON.stringify(result.busyPhase)} bubble=${JSON.stringify(result.busyBubble)} unchanged=${result.busyBubbleUnchanged} chatGotReply=${result.busyChatGotReply}`);
  console.log(`[idle] animation=${result.idleAnimationBeforeChat} bubble=${JSON.stringify(result.idleBubble)} chatGotReply=${result.idleChatGotReply}`);
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 300000);
