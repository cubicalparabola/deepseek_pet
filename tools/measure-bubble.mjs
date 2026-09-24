// @ts-check
/**
 * 量出 bubble.png 的**内边距**与**尾巴**位置，用来把 HTML 文字区精确放进气泡里。
 *
 * 气泡是"PNG 拉伸铺满 + 绝对定位的文字层"，文字区必须避开：
 *   - 四周的半透明外发光/描边（否则文字会压在描边上）；
 *   - 底部中央的尾巴（那里没有可写区域）。
 *
 * 做法：逐行统计"不透明像素"的水平跨度（span），
 *   - 正文区域的跨度 ≈ 气泡宽度；
 *   - 尾巴区域的跨度会骤然收窄 -> 那就是正文的下边界。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      const v = line[x];
      let value;
      switch (filter) {
        case 0: value = v; break;
        case 1: value = v + a; break;
        case 2: value = v + b; break;
        case 3: value = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('unknown filter ' + filter);
      }
      cur[x] = value & 0xff;
    }
  }
  return out;
}

function decodePng(file) {
  const buf = readFileSync(file);
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit png supported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, channels, pixels: unfilter(raw, width, height, channels) };
}

const file = process.argv[2] ?? 'assets/bubble.png';
/**
 * alpha 阈值：只把"实心"像素算进去，忽略外发光/抗锯齿。
 *
 * 阈值太低（如 40）会把很淡的外发光也算成图形，导致正文下边界与尾巴起点
 * 都被拉到底部（实测：把 51px 高的尾巴量成了 100px+，且尾巴中心偏到 91%）。
 */
const ALPHA_MIN = Number(process.argv[3] ?? 200);
const img = decodePng(file);
const alpha = (x, y) => {
  const i = (y * img.width + x) * img.channels;
  return img.channels === 4 ? img.pixels[i + 3] : 255;
};

/** 逐行的跨度。 */
const rows = [];
for (let y = 0; y < img.height; y++) {
  let min = -1, max = -1;
  for (let x = 0; x < img.width; x++) {
    if (alpha(x, y) > ALPHA_MIN) {
      if (min < 0) min = x;
      max = x;
    }
  }
  rows.push({ y, min, max, span: max < 0 ? 0 : max - min + 1 });
}

const bodyRows = rows.filter((r) => r.span > 0);
const firstRow = bodyRows[0]?.y ?? 0;
const lastRow = bodyRows[bodyRows.length - 1]?.y ?? img.height - 1;
const W = img.width, H = img.height;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/* 自检解码：alpha 直方图 —— 若这里不对，后面的跨度量测没有意义 */
let maxAlpha = 0;
const hist = {};
if (img.channels === 4) {
  for (let i = 3; i < img.pixels.length; i += 4) {
    const a = img.pixels[i];
    if (a > maxAlpha) maxAlpha = a;
    const bucket = a === 0 ? 'zero' : a === 255 ? 'opaque' : 'semi';
    hist[bucket] = (hist[bucket] ?? 0) + 1;
  }
}

/*
 * "正文宽度"用**中位数**而不是最大值：
 * 最大值可能来自某一行异常（外发光/阴影），中位数更能代表气泡主体的宽度。
 */
const sortedSpans = rows.map((r) => r.span).sort((a, b) => a - b);
const medianSpan = sortedSpans[sortedSpans.length >> 1];

/*
 * 尾巴起点：从底部往上找"连续保持正文宽度"的行。
 * 尾巴是底部中央一条窄柱，跨度会骤降到正文宽度的一半以下。
 */
let tailStart = -1;
for (let y = rows.length - 1; y >= 0; y--) {
  const r = rows[y];
  if (r.span > medianSpan * 0.5) { tailStart = y + 1; break; }
}
if (tailStart < 0) tailStart = lastRow + 1;
if (tailStart > lastRow) tailStart = lastRow + 1;

/*
 * 水平内边距：按 alpha 量不出来 —— 气泡描边本身是完全不透明的，
 * bodyLeft/bodyRight 会等于整图边界。改为找"描边（较深的蓝）-> 内部（近白）"
 * 的颜色过渡，取若干行取中位数，避免被星星/气泡装饰干扰。
 */
const rgbAt = (x, y) => {
  const i = (y * img.width + x) * img.channels;
  return [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]];
};
/** 内部填充近似白色（#f4f8fe 左右），描边明显更暗。 */
const isInterior = (x, y) => {
  const [r, g, b] = rgbAt(x, y);
  return r > 225 && g > 235 && b > 240;
};
const interiorSpans = [];
for (let y = Math.round(H * 0.34); y < Math.round(H * 0.58); y += 12) {
  let left = -1, right = -1;
  for (let x = 0; x < W; x++) if (isInterior(x, y)) { left = x; break; }
  for (let x = W - 1; x >= 0; x--) if (isInterior(x, y)) { right = x; break; }
  if (left >= 0 && right > left) interiorSpans.push({ y, left, right });
}
const interiorLeft = interiorSpans.length ? Math.round(median(interiorSpans.map((s) => s.left))) : 0;
const interiorRight = interiorSpans.length ? Math.round(median(interiorSpans.map((s) => s.right))) : W - 1;

const selfCheck = {
  channels: img.channels,
  maxAlpha,
  hist,
  sampleCenter: [alpha(W >> 1, H >> 1), alpha(W >> 1, H >> 2), alpha(W >> 1, 4), alpha(4, 4)],
  spanAtMiddleRow: rows[H >> 1]?.span ?? null,
  maxSpanOverall: Math.max(...rows.map((r) => r.span)),
  medianSpan,
  spanStats: {
    min: Math.min(...rows.map((r) => r.span)),
    nonzeroRows: rows.filter((r) => r.span > 0).length,
    firstNonzero: rows.find((r) => r.span > 0)?.y ?? null,
    lastNonzero: [...rows].reverse().find((r) => r.span > 0)?.y ?? null,
  },
};
if (maxAlpha === 0 || img.channels !== 4) {
  console.log(JSON.stringify({ file, size: `${W}x${H}`, selfCheck, note: 'alpha 通道异常，跨度量测不可用' }, null, 1));
  process.exit(0);
}

const report = {
  file,
  size: `${W}x${H}`,
  alphaMin: ALPHA_MIN,
  selfCheck,
  measured: {
    contentTop: firstRow,
    contentBottom: lastRow,
    bodyLeft: interiorLeft,
    bodyRight: interiorRight,
    tailStart,
    tailHeight: lastRow - tailStart + 1,
    interiorRows: interiorSpans.length,
  },
  ratio: {
    /** 文字区建议内缩（相对整图宽/高），留出描边与外发光。 */
    padLeftPct: +((interiorLeft / W) * 100).toFixed(2),
    padRightPct: +(((W - 1 - interiorRight) / W) * 100).toFixed(2),
    padTopPct: +((firstRow / H) * 100).toFixed(2),
    /** 底部要避开尾巴。 */
    tailPct: +(((lastRow - tailStart + 1) / H) * 100).toFixed(2),
  },
  /** 叠加一点额外留白后的最终建议值（供 CSS 直接使用）。 */
  suggestedInset: {
    left: +((interiorLeft / W) * 100 + 2).toFixed(1),
    right: +(((W - 1 - interiorRight) / W) * 100 + 2).toFixed(1),
    top: +((firstRow / H) * 100 + 4).toFixed(1),
    bottom: +(((lastRow - tailStart + 1) / H) * 100 + 3).toFixed(1),
  },
};

/* 尾巴的水平位置（按每行跨度的**加权平均**，而不是包围盒中点：
   包围盒会被同行残留的浅色装饰拉偏 —— 实测把 76% 处的尾巴算成了 91.7%） */
const tailRows = rows.filter((r) => r.y >= tailStart && r.span > 0);
if (tailRows.length) {
  let weightSum = 0;
  let weighted = 0;
  for (const r of tailRows) {
    const center = (r.min + r.max) / 2;
    weightSum += r.span;
    weighted += center * r.span;
  }
  const weightedCenter = weightSum > 0 ? weighted / weightSum : 0;
  report.measured.tailCenterPct = +((weightedCenter / W) * 100).toFixed(2);
  report.measured.tailRowsSampled = tailRows.length;
  /* 最底部那一行的 x 范围最能代表尾巴尖本身 */
  const tip = tailRows[tailRows.length - 1];
  report.measured.tailTip = { y: tip.y, minX: tip.min, maxX: tip.max, centerPct: +((((tip.min + tip.max) / 2) / W) * 100).toFixed(2) };
  report.measured.tailWidthAtTipPx = tip.span;
}

console.log(JSON.stringify(report, null, 1));
