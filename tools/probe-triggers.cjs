// @ts-check
/**
 * 探针：**触发动画真的被触发了吗**（真机、真链路）。
 *
 * 为什么单独立一个探针：验收覆盖的是纯规则（阈值、回差、重新武装），
 * 但"规则算出要演 -> 主进程发指令 -> 渲染层演出来"这三段接线只有跑起来才知道。
 * 这里挑了一个**不需要外部条件**就能复现的触发源：
 *
 *   隔离数据目录里**没有 ai-settings.json** -> 没配 API Key
 *   -> `offlineReason() === 'no-key'` -> 启动时应该演一次 `offline`
 *
 * 同时做**反向对照**（同一轮里检查）：心情 62 / 饿 0 的正常启动**不该**演
 * sad / hungry —— 否则"启动就难过"这种误触发会一直存在却没人发现。
 *
 * 实现方式：劫持主进程 stdout 收集日志，再从托盘状态更新里读"她当前在演哪条动画"
 * （`[TrayManager] animation menu updated | {"current":"offline"}`）。
 * 为什么不用渲染层的日志行：渲染层 logger 走 IPC 汇总，级别与时机都不如
 * 托盘状态这条**主进程自己发的**记录可靠 —— 而它恰好就是"画面上在演什么"。
 *
 * 用法：npx electron tools/probe-triggers.cjs
 * 输出：build/trigger-probe.json
 */
const { app } = require('electron');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'trigger-probe.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-triggers');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

/* 收集日志：必须在 require main 之前劫持 */
const captured = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  try { captured.push(String(chunk)); } catch (error) { /* 忽略 */ }
  return originalWrite(chunk, ...rest);
};

app.disableHardwareAcceleration();
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  // 启动后给触发服务一点时间（它在渲染层订阅就绪后延迟启动，见 main.createWindow）
  await wait(11000);
  const log = captured.join('');
  /** 按顺序取出"她当时在演哪条动画"（托盘状态更新里的 current 字段）。 */
  const playedSequence = [];
  for (const match of log.matchAll(/"current":"([^"]+)"/g)) {
    const id = match[1];
    if (id !== '(none)' && playedSequence[playedSequence.length - 1] !== id) playedSequence.push(id);
  }
  const result = {
    playedSequence,
    verdict: {
      // 没配 key -> 必须演一次 offline
      offlineOnNoKey: playedSequence.includes('offline'),
      // 正常心情/不饿 -> 不能演 sad / hungry（误触发会让桌宠一启动就委屈）
      noSadOnStartup: !playedSequence.includes('sad'),
      noHungryOnStartup: !playedSequence.includes('hungry'),
    },
  };
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  originalWrite(`[result] ${JSON.stringify(result.verdict)}\n`);
  originalWrite(`played: ${playedSequence.join(' -> ')}\n`);
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
