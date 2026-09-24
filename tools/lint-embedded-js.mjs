// @ts-check
/**
 * 找出 acceptance.cjs 里 `run(\`...\`)` 模板字符串内部出现的反引号。
 *
 * 为什么要这个工具：这些断言体是**模板字符串**，注释里写反引号会把字符串提前
 * 截断，报错却是 `missing ) after argument list`，定位很费时间（已经踩过 4 次）。
 *
 * 算法：按"外层模板字符串"逐行扫描 —— 从 `await run(\`` 开始，
 * 该行之后的第一个反引号只可能是**结束符**（内部若再出现反引号就是错）;
 * 因此模板体内的任何一行只要含反引号且不是结束形态，就是问题。
 *
 * 用法：node tools/lint-embedded-js.mjs tools/acceptance.cjs
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'tools/acceptance.cjs';
const lines = readFileSync(file, 'utf8').split('\n');
const BACKTICK = String.fromCharCode(96);

/** 结束行的形态：`})()`);` / `)`);` / `);` 等，都以反引号 + ) 结尾 */
const looksLikeEnd = (trimmed) => /`\)+;?$/.test(trimmed) || /`\s*$/.test(trimmed);

let inTemplate = false;
let templateStart = 0;
const problems = [];

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const trimmed = raw.trim();
  const count = (raw.match(/`/g) ?? []).length;

  if (!inTemplate) {
    // 进入模板字符串：本行出现奇数个反引号，且不是以反引号收尾的结束形态
    if (count % 2 === 1 && i > 0 && /run\(`/.test(raw)) {
      inTemplate = true;
      templateStart = i + 1;
    }
    continue;
  }

  if (count === 0) continue;

  // 在模板体内遇到反引号：只有"结束形态"才允许
  if (!looksLikeEnd(trimmed)) {
    problems.push({ line: i + 1, text: trimmed, templateStart });
  }
  // 结束（或该行含反引号且形态正确）-> 退出模板
  inTemplate = false;
}

if (inTemplate) {
  console.log(`警告：模板字符串起始于 ${templateStart} 行但未找到结束符`);
}
if (problems.length === 0) {
  console.log('OK: 未发现模板字符串内部的反引号');
  process.exit(0);
}
console.log(`发现 ${problems.length} 处模板字符串内部的反引号（会把字符串提前截断）：`);
for (const p of problems) {
  console.log(`  行 ${p.line}（模板起始于 ${p.templateStart}）: ${p.text.slice(0, 120)}`);
}
process.exit(1);
