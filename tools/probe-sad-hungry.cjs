// @ts-check
/**
 * 探针：**心情低（sad）与饿（hungry）这两条触发，真机跑得通吗**。
 *
 * 和 `probe-offline-overheat.cjs` 是一对：那个管"外部条件"（断网 / GPU 温度），
 * 这个管"她自己的状态"（心情 / 饥饿）。两条都不是靠造一个假信号，
 * 而是**改真实的状态来源**，让规则自己去判定：
 *
 *   1. 先只让心情低：`emotion.json` 写 mood = 18（低于 sad 阈值 25），
 *      预算留着（budget 1000 / used 0 -> hunger 0）-> 启动时只该演 sad；
 *   2. 等 sad 演完，再把预算用光（`ai.setSettings({budget:{used:1000}})` +
 *      `ai.resetEmotion()` 让它立刻重算）-> hunger = (1-0)*100 = 100
 *      （高于 hungry 阈值 60）-> 30 秒内的状态轮询该演一次 hungry。
 *
 * 为什么不一次把两个条件都造出来：实测那样两条会在**同一瞬间**触发，
 * 仲裁只会让优先级高的那条（sad）演出来 —— 那是正确行为（她没法同时做两件事），
 * 但就证明不了 hungry 也能演。分开造条件才看得出两条都真的走上了画面。
 *
 * 为什么这也算"真实"：情绪状态是**真的**从磁盘读进来、真的经过 EmotionService 的
 * 衰减/换算、真的进了 AIService.status()，再由 TriggerService 按 shared/pet-triggers
 * 的规则判定 —— 只有"她现在心情多少 / 预算用掉多少"这两个输入是我们安排的，
 * 而它们正是用户能亲手造出来的条件（预算用光、被冷落久了）。
 *
 * 数据目录与 userData 都指到临时目录：这个探针要**写**情绪文件，
 * 绝不能碰用户真实的 `%APPDATA%\DesktopPet`。
 *
 * 用法：npx electron tools/probe-sad-hungry.cjs
 * 输出：build/sad-hungry.json
 */
const { app } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'sad-hungry.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-sad-hungry');
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(dataDir, 'mood'), { recursive: true });

/* 隔离落盘位置（必须在 require(main) 之前） */
app.setPath('userData', dataDir);
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;

/** 安排好的输入：心情 18；预算**先不动**（后面再"用光"）。 */
const PROBE_MOOD = 18;
const PROBE_BUDGET_INITIAL = { budget: 1000, used: 0, resetAt: '' };
const PROBE_BUDGET_SPENT = { used: 1000 };
const now = Date.now();

writeFileSync(join(dataDir, 'ai-settings.json'), JSON.stringify({
  enabled: true,
  // 不聊天：这个探针只测"状态 -> 触发"，不测模型
  chat: false,
  memory: false,
  emotion: true,
  diary: false,
  provider: {
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'probe-model',
    apiKey: 'sk-probe-not-a-real-key',
    temperature: 0.8,
    maxTokens: 64,
    timeoutMs: 8000,
  },
  budget: PROBE_BUDGET_INITIAL,
  // 关掉余额查询：这样 hunger 用**本地预算**算（余额优先，会把本地预算盖掉）
  balance: { enabled: false },
}, null, 2), 'utf8');

writeFileSync(join(dataDir, 'emotion.json'), JSON.stringify({
  mood: PROBE_MOOD,
  hunger: 0,
  // 10 分钟没互动：过了宽限期，衰减照常（但衰减只会让 mood 更低，不影响判定）
  lastInteractionAt: now - 10 * 60000,
  lastUpdateAt: now - 10 * 60000,
  updatedAt: new Date(now).toISOString(),
}, null, 2), 'utf8');

/* 收集日志：必须在 require main 之前劫持 */
const captured = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  try { captured.push(String(chunk)); } catch (error) { /* 忽略 */ }
  return originalWrite(chunk, ...rest);
};

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logText = () => captured.join('');

function firedTriggers(text) {
  const out = [];
  for (const match of text.matchAll(/trigger fired \| (\{[^\n]*\})/g)) {
    try { out.push(JSON.parse(match[1])); } catch (error) { /* 半行日志忽略 */ }
  }
  return out;
}

function playedSequence(text) {
  const out = [];
  for (const match of text.matchAll(/"current":"([^"]+)"/g)) {
    const id = match[1];
    if (id !== '(none)' && out[out.length - 1] !== id) out.push(id);
  }
  return out;
}

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron');
  /* 触发服务在 did-finish-load 后 1.5 秒启动，启动时先查一次心情/饿 */
  await wait(12000);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('桌宠窗口不存在');
  const run = (js) => win.webContents.executeJavaScript(js, true);

  const result = {
    probeMood: PROBE_MOOD,
    probeBudgetInitial: PROBE_BUDGET_INITIAL,
    probeBudgetSpent: PROBE_BUDGET_SPENT,
  };

  /** 此刻的日志快照：分别检查"第一步只演 sad"与"第二步才演 hungry"。 */
  const afterSad = logText();
  result.triggersAfterSad = firedTriggers(afterSad);
  result.playedAfterSad = playedSequence(afterSad);

  /* 第二步：把预算用光（真实设置补丁）+ 立刻重算情绪 -> hunger 100 */
  result.budgetPatch = await run(`(async () => {
    const after = await window.petAPI.ai.setSettings({ budget: { used: 1000 } });
    const reset = await window.petAPI.ai.resetEmotion();
    return { budget: after.settings.budget, mood: reset.emotion.mood, hunger: reset.emotion.hunger };
  })()`);

  /* 等 30 秒的状态轮询把"饿"判出来（多等一会儿留余量） */
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (playedSequence(logText()).includes('hungry')) break;
    await wait(500);
  }
  await wait(1500);

  const log = logText();
  result.triggers = firedTriggers(log);
  result.played = playedSequence(log);

  const sad = result.triggers.filter((item) => item.animationId === 'sad');
  const hungry = result.triggers.filter((item) => item.animationId === 'hungry');
  const moodInReason = /mood-low:(\d+(?:\.\d+)?)/.exec(sad.map((item) => item.reason).join(' '));
  const hungerInReason = /hunger-high:(\d+(?:\.\d+)?)/.exec(hungry.map((item) => item.reason).join(' '));
  result.sad = sad;
  result.hungry = hungry;

  result.verdict = {
    // 第一步：心情 18 <= 25 -> 演一次 sad（理由是**真实的心情读数**）
    sadFired: sad.length === 1 &&
      moodInReason !== null && Number(moodInReason[1]) <= 25,
    sadPlayed: result.playedAfterSad.includes('sad'),
    // 第二步（预算用光之前）hungry 一次都不许触发：证明第一步的"只演 sad"是真结论
    nothingHungryBeforeBudget:
      result.triggersAfterSad.every((item) => item.animationId !== 'hungry') &&
      result.playedAfterSad.includes('hungry') === false,
    // 预算用光 -> 情绪里 hunger 真的变成 100
    hungerRecomputed: result.budgetPatch.hunger >= 60 && result.budgetPatch.mood > 25,
    // 第二步：hunger >= 60 -> 演一次 hungry，而且理由里是真实读数
    hungryFired: hungry.length === 1 &&
      hungerInReason !== null && Number(hungerInReason[1]) >= 60,
    hungryPlayed: result.played.includes('hungry'),
    // 两条都只演一次（持续越界只演一次）
    firedOnce: sad.length === 1 && hungry.length === 1,
  };

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log(`\n[verdict] ${JSON.stringify(result.verdict, null, 1)}`);
  console.log(`[triggers] ${JSON.stringify(result.triggers)}`);
  console.log(`[played] ${result.played.join(' -> ')}`);
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
