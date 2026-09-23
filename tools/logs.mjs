// @ts-check
/**
 * 实时查看桌宠日志（推荐方式）。
 *
 * ## 为什么需要它
 *
 * Electron 在 Windows 上是 GUI 子系统程序，它的 stdout 在 npm 下是管道，
 * 中文经这条链路到达终端时会被按活动代码页误解 —— 这与"Node 脚本的中文正常"
 * 形成对比，且已确认**不是**编码选择问题（UTF-8 与 GBK 都被实测否定）。
 *
 * 因此**日志的唯一可靠出口是文件**：
 *   `%APPDATA%\DesktopPet\logs\desktop-pet.log`
 * 它由 file sink 以 UTF-8 写入，内容始终正确（验收里有断言）。
 *
 * 本脚本在**纯 Node** 进程里读这个文件并以 UTF-8 输出，因此中文必定正常。
 *
 * 用法：
 *   npm run logs           # 打印现有日志后持续跟随新内容
 *   npm run logs -- --no-follow   # 只打印现有内容
 *   npm run logs -- --tail 50     # 只看最后 50 行
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const noFollow = args.includes('--no-follow');
const tailIndex = args.indexOf('--tail');
const tailLines = tailIndex >= 0 ? Number(args[tailIndex + 1] ?? 50) : 0;

const logFile = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming'),
  'DesktopPet',
  'logs',
  'desktop-pet.log',
);

if (!existsSync(logFile)) {
  console.error(`[logs] 日志文件还不存在：${logFile}`);
  console.error('[logs] 先启动一次桌宠（npm start）再看。');
  process.exit(1);
}

console.log(`[logs] ${logFile}`);
console.log('[logs] 按 Ctrl+C 结束\n');

/** 读取并打印（可选只取最后 N 行）。 */
async function printAll() {
  if (tailLines <= 0) {
    await new Promise((resolve) => {
      const stream = createReadStream(logFile, { encoding: 'utf8' });
      stream.on('data', (chunk) => process.stdout.write(chunk));
      stream.on('end', resolve);
      stream.on('error', resolve);
    });
    return;
  }
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(logFile, 'utf8').split('\n');
  const slice = lines.slice(-tailLines - 1);
  process.stdout.write(slice.join('\n'));
}

await printAll();
if (noFollow) process.exit(0);

// 跟随新内容：按字节偏移轮询（比 fs.watch 在各种 Windows 场景下更可靠）
let offset = statSync(logFile).size;
setInterval(() => {
  try {
    const size = statSync(logFile).size;
    if (size < offset) offset = 0; // 文件被轮转/清空
    if (size === offset) return;
    const stream = createReadStream(logFile, { start: offset, end: size - 1, encoding: 'utf8' });
    stream.on('data', (chunk) => process.stdout.write(chunk));
    stream.on('end', () => {
      offset = size;
    });
  } catch {
    /* 文件暂时不可读时忽略，下一轮再试 */
  }
}, 400);
