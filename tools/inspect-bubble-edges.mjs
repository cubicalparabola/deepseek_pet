// @ts-check
/**
 * 把气泡截图里的**边缘条带**单独统计出来，判断"内缩 0"到底是
 * 文字越界、还是滚动条/描边被误判成文字。
 *
 * 做法：对气泡矩形的最外 8 像素的每一列/行，统计暗像素数量。
 *   - 若越界是滚动条造成的：只有最右侧几列有暗像素（垂直条带）；
 *   - 若越界是描边造成的：四周整圈都有；
 *   - 若越界是文字造成的：会出现成片的字符形状。
 *
 * 用法：node tools/inspect-bubble-edges.mjs build/bubble/bubble-long-default.png
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
        default: throw new Error('unknown filter');
      }
      cur[x] = value & 0xff;
    }
  }
  return out;
}

function decodePng(file) {
  const buf = readFileSync(file);
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, channels, pixels: unfilter(raw, width, height, channels) };
}

const file = process.argv[2];
const img = decodePng(file);
const px = (x, y) => {
  const i = (y * img.width + x) * img.channels;
  return { r: img.pixels[i], g: img.pixels[i + 1], b: img.pixels[i + 2], a: img.channels === 4 ? img.pixels[i + 3] : 255 };
};
const isDark = (p) => p.a > 128 && p.r < 160 && p.g < 160 && p.b < 190;

/* bubble-long-default.png 是整窗截图，气泡在 (14,15) 540x537（来自 diag-bubble 输出）。
   但为了通用，这里扫描整图，并打印每一条边缘的暗像素分布。 */
const cols = new Map();
const rows = new Map();
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    if (!isDark(px(x, y))) continue;
    cols.set(x, (cols.get(x) ?? 0) + 1);
    rows.set(y, (rows.get(y) ?? 0) + 1);
  }
}
const xs = [...cols.keys()].sort((a, b) => a - b);
const ys = [...rows.keys()].sort((a, b) => a - b);

/** 找出"暗像素很集中"的列（可能是一根滚动条）。 */
const thickCols = [...cols.entries()].filter(([, n]) => n > img.height * 0.2).map(([x, n]) => ({ x, n }));
const thickRows = [...rows.entries()].filter(([, n]) => n > img.width * 0.2).map(([y, n]) => ({ y, n }));

console.log(JSON.stringify({
  file,
  imageSize: `${img.width}x${img.height}`,
  darkBounds: { xMin: xs[0], xMax: xs[xs.length - 1], yMin: ys[0], yMax: ys[ys.length - 1] },
  /** 暗像素很多的列/行 —— 滚动条会表现为"某一列特别厚" */
  columnsWithManyDarkPixels: thickCols,
  rowsWithManyDarkPixels: thickRows,
  /** 最右侧 12 列的暗像素数，用来判断右边缘那条是不是滚动条 */
  rightEdgeColumns: Array.from({ length: 12 }, (_, i) => {
    const x = img.width - 12 + i;
    return { x, dark: cols.get(x) ?? 0 };
  }),
  bottomEdgeRows: Array.from({ length: 12 }, (_, i) => {
    const y = img.height - 12 + i;
    return { y, dark: rows.get(y) ?? 0 };
  }),
}, null, 1));
