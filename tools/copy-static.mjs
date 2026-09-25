// @ts-check
/**
 * 把静态资源拷进 dist：
 *   src/renderer/index.html   -> dist/renderer/index.html
 *   src/renderer/styles.css   -> dist/renderer/styles.css
 *   src/settings/index.html   -> dist/settings/index.html
 *   src/settings/settings.css -> dist/settings/settings.css
 *   src/settings/ai-panel.css -> dist/settings/ai-panel.css
 *   src/chat/index.html       -> dist/chat/index.html
 *   src/chat/chat.css         -> dist/chat/chat.css
 *
 * assets/ 与 plugins/ 不打进 dist：
 * - 开发模式直接从仓库根目录读取；
 * - 打包模式由 electron-builder 的 extraResources 放到 resources/ 下。
 * 两条路径都由 main 进程解析后通过 bootstrap 告知 renderer。
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  ['src/renderer/index.html', 'dist/renderer/index.html'],
  ['src/renderer/styles.css', 'dist/renderer/styles.css'],
  ['src/settings/index.html', 'dist/settings/index.html'],
  ['src/settings/settings.css', 'dist/settings/settings.css'],
  ['src/settings/ai-panel.css', 'dist/settings/ai-panel.css'],
  ['src/settings/perception-panel.css', 'dist/settings/perception-panel.css'],
  ['src/settings/growth-panel.css', 'dist/settings/growth-panel.css'],
  ['src/chat/index.html', 'dist/chat/index.html'],
  ['src/chat/chat.css', 'dist/chat/chat.css'],
];

for (const [from, to] of targets) {
  const source = join(root, from);
  const dest = join(root, to);
  if (!existsSync(source)) {
    console.error(`[copy-static] missing ${from}`);
    process.exitCode = 1;
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  console.log(`[copy-static] ${from} -> ${to}`);
}

/*
 * 构建戳：写进 `dist/build-info.json`，主进程启动时读出来打进日志。
 *
 * 为什么需要：桌宠带**单实例锁** —— 已经有一个桌宠在跑时，`npm start` 起的新进程会
 * **静默退出**（退出码 0），跑着的还是旧代码。用户看到"改了没用"时，第一件要确认的就是
 * "现在跑的是哪一版"，这条日志让这个问题一眼可判。
 */
const buildInfoPath = join(root, 'dist', 'build-info.json');
mkdirSync(dirname(buildInfoPath), { recursive: true });
writeFileSync(
  buildInfoPath,
  JSON.stringify({ builtAt: new Date().toISOString(), node: process.version }, null, 1) + '\n',
  'utf8',
);
console.log(`[copy-static] build-info -> dist/build-info.json`);
