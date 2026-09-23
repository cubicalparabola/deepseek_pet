// @ts-check
/**
 * 把静态资源拷进 dist：
 *   src/renderer/index.html   -> dist/renderer/index.html
 *   src/renderer/styles.css   -> dist/renderer/styles.css
 *   src/settings/index.html   -> dist/settings/index.html
 *   src/settings/settings.css -> dist/settings/settings.css
 *
 * assets/ 与 plugins/ 不打进 dist：
 * - 开发模式直接从仓库根目录读取；
 * - 打包模式由 electron-builder 的 extraResources 放到 resources/ 下。
 * 两条路径都由 main 进程解析后通过 bootstrap 告知 renderer。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  ['src/renderer/index.html', 'dist/renderer/index.html'],
  ['src/renderer/styles.css', 'dist/renderer/styles.css'],
  ['src/settings/index.html', 'dist/settings/index.html'],
  ['src/settings/settings.css', 'dist/settings/settings.css'],
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
