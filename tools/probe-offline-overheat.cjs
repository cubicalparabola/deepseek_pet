// @ts-check
/**
 * 探针：**断网（offline）与 GPU 过热（overheat）这两条触发，真机跑得通吗**。
 *
 * 为什么要单独一个探针：这两条是"需要外部条件才能复现"的触发源 ——
 * 验收只能钉死纯规则（阈值 / 回差 / 重新武装），"真信号 -> 真判定 -> 真动画"
 * 这三段接线必须有一条真机证据。这里同时造两个**真实**条件：
 *
 *   1. GPU 过热：真读 `nvidia-smi`（这台是 RTX 3050），把感知设置里的过热阈值
 *      调到 **45℃**（低于当前真实温度 50 多度）-> 真温度越过阈值 -> 演 overheat。
 *      证据里带上真实读数（`gpu-hot:52C>=45C`），一眼能看出不是编的。
 *   2. 断网：`ai-settings.json` 指向一个**连不上**的地址（127.0.0.1:9，discard 端口），
 *      然后真的发一次对话请求 -> 连接失败 -> `LLMError('NETWORK')`
 *      -> `lastError` = `网络请求失败：…` -> 30 秒后的状态轮询判定 `offline:network`
 *      -> 演 offline。
 *
 * 同时做**反向对照**：启动时（还没发那次必失败的请求之前）**不该**有 offline 触发 ——
 * 否则"她一直说掉线"这种误报会被这个探针放过。
 *
 * 数据目录与 userData 都指到临时目录：这个探针要**写**设置文件，
 * 绝不能碰用户真实的 `%APPDATA%\DesktopPet`。
 *
 * 用法：npx electron tools/probe-offline-overheat.cjs
 * 输出：build/offline-overheat.json
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'offline-overheat.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-offline');
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

/* 隔离一切落盘位置：必须在 require(main) 之前（main 只在默认目录时才会纠正 userData） */
app.setPath('userData', dataDir);
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;

/** 探针用的过热阈值：45℃ 低于本机真实温度，真信号才能越过去。 */
const PROBE_OVERHEAT_C = 45;
/** 连不上的地址（127.0.0.1:9 是 discard 端口，没人监听 -> 立刻 ECONNREFUSED）。 */
const UNREACHABLE_BASE_URL = 'http://127.0.0.1:9/v1';

writeFileSync(join(dataDir, 'ai-settings.json'), JSON.stringify({
  enabled: true,
  chat: true,
  provider: {
    kind: 'openai',
    baseUrl: UNREACHABLE_BASE_URL,
    model: 'probe-model',
    apiKey: 'sk-probe-not-a-real-key',
    temperature: 0.8,
    maxTokens: 64,
    timeoutMs: 8000,
  },
}, null, 2), 'utf8');

writeFileSync(join(dataDir, 'perception-settings.json'), JSON.stringify({
  overheatThresholdC: PROBE_OVERHEAT_C,
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

/** 所有"真的触发了某条动画"的日志行（TriggerService.fire 打的）。 */
function firedTriggers(text) {
  const out = [];
  for (const match of text.matchAll(/trigger fired \| (\{[^\n]*\})/g)) {
    try { out.push(JSON.parse(match[1])); } catch (error) { /* 半行日志忽略 */ }
  }
  return out;
}

/** 托盘状态里"画面上正在演哪条动画"的序列（主进程自己发的，最可靠）。 */
function playedSequence(text) {
  const out = [];
  for (const match of text.matchAll(/"current":"([^"]+)"/g)) {
    const id = match[1];
    if (id !== '(none)' && out[out.length - 1] !== id) out.push(id);
  }
  return out;
}

app.whenReady().then(async () => {
  const result = { probeOverheatC: PROBE_OVERHEAT_C, unreachableBaseUrl: UNREACHABLE_BASE_URL };

  /* 1) 等触发服务起来（它在 did-finish-load 之后 1.5 秒启动，启动时各查一次） */
  await wait(12000);
  const logAtStartup = logText();
  result.startupLog = (logAtStartup.match(/trigger service started \| \{[^\n]*\}/) ?? [''])[0];
  result.startupTriggers = firedTriggers(logAtStartup);
  result.playedAtStartup = playedSequence(logAtStartup);

  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('桌宠窗口不存在');
  const run = (js) => win.webContents.executeJavaScript(js, true);

  result.aiBeforeChat = await run(`window.petAPI.ai.status().then((s) => ({
    usable: s.usable, lastError: s.lastError, balanceError: s.balanceError, mode: s.mode,
    providerBaseUrl: s.settings.provider.baseUrl,
  }))`);

  /* 2) 真的发一次对话请求：地址连不上 -> NETWORK 失败（不依赖任何外部服务） */
  result.chatReply = await run(`window.petAPI.ai.chat('探针：这条请求注定连不上').then((r) => ({
    ok: r.ok, mode: r.mode, error: r.error || '',
  }))`);
  result.aiAfterChat = await run(`window.petAPI.ai.status().then((s) => ({
    lastError: s.lastError, balanceError: s.balanceError,
  }))`);

  /* 3) 等状态轮询（默认 30 秒一轮）把"断网"判出来并演 one offline */
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (playedSequence(logText()).includes('offline')) break;
    await wait(1000);
  }
  await wait(1500);

  const finalLog = logText();
  result.triggers = firedTriggers(finalLog);
  result.played = playedSequence(finalLog);
  result.overheatFired = result.triggers.filter((item) => item.animationId === 'overheat');
  result.offlineFired = result.triggers.filter((item) => item.animationId === 'offline');

  const overheatReason = result.overheatFired.map((item) => String(item.reason)).join(' ');
  const overheatMatch = /gpu-hot:(\d+(?:\.\d+)?)C>=(\d+)C/.exec(overheatReason);
  const realTemp = overheatMatch ? Number(overheatMatch[1]) : null;
  const startupThreshold = /"overheatThresholdC":(\d+)/.exec(result.startupLog);

  result.verdict = {
    // 感知设置里的过热阈值真的传到了触发服务（启动日志里就写着）
    thresholdFromPerceptionSettings: startupThreshold !== null && Number(startupThreshold[1]) === PROBE_OVERHEAT_C,
    // 过热是**真温度**越阈值触发的，而且报出来的就是真读数
    overheatFiredOnRealTemperature:
      result.overheatFired.length === 1 &&
      overheatMatch !== null &&
      Number(overheatMatch[2]) === PROBE_OVERHEAT_C &&
      realTemp !== null && realTemp > PROBE_OVERHEAT_C && realTemp < 150,
    // 画面上真的演了 overheat
    overheatPlayed: result.played.includes('overheat'),
    // 反向对照：启动时（还没发那次必败请求）不该说有掉线
    noOfflineBeforeRequest:
      result.playedAtStartup.includes('offline') === false &&
      result.aiBeforeChat.lastError === '' &&
      result.startupTriggers.every((item) => item.animationId !== 'offline'),
    // 那次请求**真的**是网络层面失败的（不是 401、不是别的），而且打的就是那个连不上的地址
    chatFailedAsNetwork:
      String(result.aiAfterChat.lastError).includes('网络请求失败') &&
      result.aiBeforeChat.providerBaseUrl === UNREACHABLE_BASE_URL,
    // 断网被判定成 offline:network（而不是 invalid-key / no-balance）
    offlineNetworkFired: result.offlineFired.length === 1 && result.offlineFired[0].reason === 'offline:network',
    // 画面上真的演了 offline
    offlinePlayed: result.played.includes('offline'),
  };

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log(`\n[verdict] ${JSON.stringify(result.verdict, null, 1)}`);
  console.log(`[startup log] ${result.startupLog}`);
  console.log(`[triggers] ${JSON.stringify(result.triggers)}`);
  console.log(`[played] ${result.played.join(' -> ')}`);
  console.log(`[chat] ${JSON.stringify(result.chatReply)} lastError=${result.aiAfterChat.lastError}`);
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
