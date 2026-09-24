// @ts-check
/**
 * 判定"知道了"按钮的垂直中心是否落在气泡的**实心区域**内。
 *
 * 为什么要这个：DOM 的矩形只能说明"按钮在容器盒子里"，而气泡贴图底部有一段
 * 透明区（尾巴带），按钮落在那里视觉上就在气泡外面。这里直接扫截图像素：
 *   1. 找出气泡实心区域（描边/底色）的垂直范围；
 *   2. 找出按钮的矩形（DOM 提供）；
 *   3. 判断按钮中心是否在实心区之内。
 *
 * 用法：node tools/probe-button-inside.mjs build/bubble-adaptive/04-长.png <bubbleRectJson>
 */
import { decodePng, pixelAt } from './lib/png.mjs';

const file = process.argv[2];
const img = decodePng(file);

/**
 * 气泡"实心"像素：偏白/浅蓝的填充 或 蓝色描边。
 * 正文色（#2f3a56）与宠物（深蓝）都不算 —— 判气泡轮廓时避开它们。
 */
const isBubble = (c) => c.a > 128 && c.b > 150 && c.r > 90 && !(c.r < 110 && c.g < 110 && c.b < 140);

/* 逐行统计"气泡色"的横向跨度，找出主体的上下边界（跨度大的区间） */
const rows = [];
for (let y = 0; y < img.height; y++) {
  let min = -1;
  let max = -1;
  let n = 0;
  for (let x = 0; x < img.width; x++) {
    const c = pixelAt(img, x, y);
    if (isBubble(c)) {
      if (min < 0) min = x;
      max = x;
      n++;
    }
  }
  rows.push({ y, min, max, span: max < 0 ? 0 : max - min + 1, n });
}

const maxSpan = Math.max(...rows.map((r) => r.span));
/* 主体：跨度在最大跨度 80% 以上的连续区间 */
const bodyRows = rows.filter((r) => r.span >= maxSpan * 0.8);
const bodyTop = bodyRows.length ? bodyRows[0].y : -1;
const bodyBottom = bodyRows.length ? bodyRows[bodyRows.length - 1].y : -1;
/* 整条气泡（含尾巴）：任何有气泡色的行 */
const anyRows = rows.filter((r) => r.n > 3);
const allTop = anyRows.length ? anyRows[0].y : -1;
const allBottom = anyRows.length ? anyRows[anyRows.length - 1].y : -1;

console.log(JSON.stringify({
  file,
  imageSize: `${img.width}x${img.height}`,
  bubbleBody: { top: bodyTop, bottom: bodyBottom, height: bodyBottom - bodyTop + 1 },
  bubbleAnySolid: { top: allTop, bottom: allBottom },
  maxSpan,
  /** 主体底边之后还有多少行"有气泡色"（那就是尾巴带） */
  tailBandHeight: allBottom - bodyBottom,
}, null, 1));
