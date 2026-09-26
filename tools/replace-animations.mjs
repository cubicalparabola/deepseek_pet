// @ts-check
/**
 * 用桌面上的新素材**整体替换**现有动画。
 *
 * 来源：E:\Desktop\webm
 *   顶层 *.webm            -> 一次性动画（含 peek_ 需改名为 peek）
 *   <name>/<name>_{start,loop,end}.webm -> 持续动画三段（overheat/read/sad/sleep/watch/work）
 *
 * 目标：assets/animations/ 下扁平存放，命名统一用连字符：
 *   <name>.webm                 一次性
 *   <name>-start/-loop/-end.webm 持续动画三段
 *
 * 安全性：
 * - 先把现有 assets/animations 整体复制到 build/backup-animations/ 作为额外保险
 *   （git 里也有备份点 tag: backup-before-new-assets）
 * - 只删除本仓库**自己管理**的 .webm，不动其它文件
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const target = join(root, 'assets', 'animations');
const source = 'E:/Desktop/webm';
const backup = join(root, 'build', 'backup-animations');

/** 需要改名的文件（源名 -> 目标 id）。 */
const RENAME = { 'peek_': 'peek' };

/* ------------------------------- 1) 备份 ------------------------------- */

rmSync(backup, { recursive: true, force: true });
mkdirSync(backup, { recursive: true });
cpSync(target, backup, { recursive: true });
const backedUp = readdirSync(backup).filter((f) => f.endsWith('.webm')).length;
console.log(`[replace] 已备份 ${backedUp} 个 webm -> ${backup}`);

/* --------------------------- 2) 清空旧素材 --------------------------- */

for (const file of readdirSync(target)) {
  if (file.endsWith('.webm')) rmSync(join(target, file), { force: true });
}
console.log('[replace] 旧素材已清除');

/* --------------------------- 3) 复制一次性动画 --------------------------- */

const oneShots = [];
for (const file of readdirSync(source).filter((f) => f.endsWith('.webm'))) {
  const id = RENAME[file.replace(/\.webm$/, '')] ?? file.replace(/\.webm$/, '');
  copyFileSync(join(source, file), join(target, `${id}.webm`));
  oneShots.push(id);
}

// 桌面源目录里 read/sleep/work 的"单文件版"也在顶层，但它们是持续动画，必须排除
// （sad 是后加的：桌面既有 sad/ 三段目录，顶层没有 sad.webm，但一起列上更保险）
const PERSISTENT_NAMES = ['overheat', 'read', 'sad', 'sleep', 'watch', 'work'];
const finalOneShots = oneShots.filter((id) => !PERSISTENT_NAMES.includes(id));
for (const id of oneShots.filter((id) => PERSISTENT_NAMES.includes(id))) {
  rmSync(join(target, `${id}.webm`), { force: true });
}
console.log(`[replace] 一次性动画 ${finalOneShots.length} 个: ${finalOneShots.join(', ')}`);

/* --------------------------- 4) 复制持续动画三段 --------------------------- */

const persistent = [];
for (const dir of readdirSync(source)) {
  const dirPath = join(source, dir);
  if (!statSync(dirPath).isDirectory()) continue;
  const parts = ['start', 'loop', 'end'];
  const found = parts.filter((p) => existsSync(join(dirPath, `${dir}_${p}.webm`)));
  if (found.length === 0) continue;
  for (const part of found) {
    copyFileSync(join(dirPath, `${dir}_${part}.webm`), join(target, `${dir}-${part}.webm`));
  }
  persistent.push({ id: dir, parts: found });
}
console.log(`[replace] 持续动画 ${persistent.length} 个: ${persistent.map((p) => `${p.id}(${p.parts.join('+')})`).join(', ')}`);

/* --------------------------------- 5) 汇总 --------------------------------- */

const files = readdirSync(target).filter((f) => f.endsWith('.webm')).sort();
const totalBytes = files.reduce((sum, f) => sum + statSync(join(target, f)).size, 0);
console.log(`[replace] 目标目录共 ${files.length} 个 webm，合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
console.log('[replace] 完成');
