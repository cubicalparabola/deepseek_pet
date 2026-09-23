// @ts-check
/**
 * 直接解码 PNG（只用 node:zlib），取出指定像素的 RGBA —— 不依赖浏览器/图像库，
 * 用于确认 ffmpeg 滤镜链是否真的产出了 alpha 通道。
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { basename } from 'node:path';

/** 还原 PNG 逐行滤波。 */
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

/** 解码 8bit PNG，返回 { width, height, channels, pixels }。 */
function decodePng(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
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
      if (data[12] !== 0) throw new Error('interlaced png not supported');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit png supported, got ' + bitDepth);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported color type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = unfilter(raw, width, height, channels);
  return { width, height, channels, pixels };
}

const files = process.argv.slice(2);
const rows = [];
for (const file of files) {
  try {
    const img = decodePng(file);
    const at = (x, y) => {
      const i = (y * img.width + x) * img.channels;
      const a = img.channels === 4 ? img.pixels[i + 3] : 255;
      return [img.pixels[i], img.pixels[i + 1], img.pixels[i + 2], a];
    };
    const cx = img.width >> 1;
    const samples = {
      corner_2_2: at(2, 2),
      topMid: at(cx, 2),
      mid: at(cx, Math.round(img.height * 0.45)),
      midFace: at(cx, Math.round(img.height * 0.30)),
      lower: at(cx, Math.round(img.height * 0.75)),
      midLeft: at(Math.round(img.width * 0.25), Math.round(img.height * 0.45)),
    };
    // 统计 alpha 分布
    let zero = 0, semi = 0, opaque = 0, minAlpha = 255;
    if (img.channels === 4) {
      for (let i = 3; i < img.pixels.length; i += 4) {
        const a = img.pixels[i];
        if (a === 0) zero++;
        else if (a === 255) opaque++;
        else semi++;
        if (a < minAlpha) minAlpha = a;
      }
    }
    const total = img.width * img.height;
    rows.push({
      file: basename(file),
      size: `${img.width}x${img.height}`,
      channels: img.channels,
      alphaZeroPct: img.channels === 4 ? +(zero / total * 100).toFixed(1) : null,
      alphaSemiPct: img.channels === 4 ? +(semi / total * 100).toFixed(1) : null,
      alphaOpaquePct: img.channels === 4 ? +(opaque / total * 100).toFixed(1) : null,
      minAlpha,
      samples,
    });
  } catch (error) {
    rows.push({ file: basename(file), error: String(error && error.message) });
  }
}
console.log(JSON.stringify(rows, null, 1));
