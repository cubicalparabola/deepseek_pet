// @ts-check
/**
 * 量出气泡素材里**每一行的实心宽度**，用来回答两件事：
 *   1. 主体从哪一行开始明显收窄（右下角尾巴把下方裁成了锥形）；
 *   2. 文字区放在哪个纵向区间才"不显空"。
 *
 * 用法：node tools/probe-bubble-rows.mjs assets/bubble.png [step]
 */
import { decodePng, pixelAt } from './lib/png.mjs';

const file = process.argv[2] ?? 'assets/bubble.png';
const step = Number(process.argv[3] ?? 5);
const img = decodePng(file);

const rows = [];
for (let pct = 0; pct <= 100; pct += step) {
  const y = Math.min(img.height - 1, Math.round((img.height * pct) / 100));
  let min = -1;
  let max = -1;
  let n = 0;
  for (let x = 0; x < img.width; x++) {
    if (pixelAt(img, x, y).a >= 200) {
      if (min < 0) min = x;
      max = x;
      n++;
    }
  }
  const span = max < 0 ? 0 : max - min + 1;
  rows.push({ pct, y, min, max, span, pctOfWidth: +((span / img.width) * 100).toFixed(1), solid: n });
}

console.log(`图 ${img.width}x${img.height}`);
console.log('纵向%  y     实心宽度   占宽%   x 范围        备注');
for (const r of rows) {
  const narrow = r.pctOfWidth < 55 ? '  <-- 收窄（尾巴区）' : '';
  console.log(
    `${String(r.pct).padStart(4)}%  ${String(r.y).padStart(4)}  ${String(r.span).padStart(5)}px  ${String(r.pctOfWidth).padStart(5)}%  ${String(r.min).padStart(4)}..${String(r.max).padEnd(4)}${narrow}`,
  );
}

/** 找出"宽度 >= 90% 最大宽度"的连续区间 —— 那就是最饱满的正文字段。 */
const maxSpan = Math.max(...rows.map((r) => r.span));
const full = rows.filter((r) => r.span >= maxSpan * 0.9);
if (full.length > 0) {
  console.log(
    `\n最饱满区间（宽度 >= ${(maxSpan * 0.9).toFixed(0)}px）：y=${full[0].y}..${full[full.length - 1].y}  (${full[0].pct}%~${full[full.length - 1].pct}%)`,
  );
  console.log(`  占整图高度 ${full[0].pct}% ~ ${full[full.length - 1].pct}%，可用于放置正文。`);
}
