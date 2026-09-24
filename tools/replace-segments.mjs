// @ts-check
/**
 * 替换指定动画的持续动画三段素材。
 *
 * 来源约定：E:\Desktop\webm\<name>\<name>_{start,loop,end}.webm
 * 目标约定：assets/animations/<name>-{start,loop,end}.webm（连字符）
 *
 * 安全性：替换前把旧文件复制到 build/backup-segments/<name>/ 作为回退点
 * （git 里也有提交历史，但素材是二进制，单独留一份更直观）。
 *
 * 用法：node tools/replace-segments.mjs watch [read sleep ...]
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const targetDir = join(root, 'assets', 'animations');
const backupDir = join(root, 'build', 'backup-segments');
const sourceRoot = 'E:/Desktop/webm';

const names = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (names.length === 0) {
  console.error('用法: node tools/replace-segments.mjs <name...>');
  process.exit(1);
}

let replaced = 0;
let missing = 0;

for (const name of names) {
  const srcDir = join(sourceRoot, name);
  if (!existsSync(srcDir)) {
    console.error(`跳过 ${name}: 找不到源目录 ${srcDir}`);
    missing += 1;
    continue;
  }
  mkdirSync(join(backupDir, name), { recursive: true });

  for (const part of ['start', 'loop', 'end']) {
    const src = join(srcDir, `${name}_${part}.webm`);
    const dst = join(targetDir, `${name}-${part}.webm`);
    if (!existsSync(src)) {
      console.error(`  缺少 ${src}`);
      missing += 1;
      continue;
    }
    // 备份旧文件（如果存在）
    if (existsSync(dst)) copyFileSync(dst, join(backupDir, name, `${name}-${part}.webm`));
    copyFileSync(src, dst);
    const mb = (statSync(dst).size / 1024 / 1024).toFixed(2);
    console.log(`${name}-${part}.webm  <-  ${src}  (${mb} MB)`);
    replaced += 1;
  }
}

console.log(`\n替换 ${replaced} 个文件${missing ? `，${missing} 个缺失` : ''}`);
if (replaced > 0) {
  console.log(`旧文件已备份到 ${backupDir}`);
  console.log('接下来请运行：node tools/refresh-media-meta.mjs && npm run verify:loop-seam');
}
