// @ts-check
/**
 * 生成兜底占位图标（**仅在真实美术图标缺失时**）。
 *
 *   build/tray.png         托盘图标（32x32 实心圆点）
 *   build/icon.png         256x256 应用图标
 *   build/icon.ico         单尺寸 ICO
 *
 * 真实图标请用 `npm run icons`（从 assets/brand/ds.png 生成）；
 * 一旦存在由它产出的多尺寸 ICO，本脚本不会再覆盖，避免把好图标冲掉。
 */
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 真实图标是否是"多尺寸 ICO"（本脚本只产出单尺寸，用它区分）。 */
function hasRealIcons() {
  const file = join(root, 'build', 'icon.ico');
  if (!existsSync(file)) return false;
  try {
    const buffer = readFileSync(file);
    if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return false;
    return buffer.readUInt16LE(4) > 1;
  } catch {
    return false;
  }
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number, number]} paint RGBA
 */
function png(width, height, paint) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {string} rel @param {Buffer} data */
function write(rel, data) {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  console.log(`[generate-assets] wrote ${rel} (${data.length} bytes)`);
}

/* -------------------------------- 托盘图标 -------------------------------- */
if (hasRealIcons()) {
  console.log('[generate-assets] 已存在真实图标（多尺寸 icon.ico），跳过占位图标生成');
} else {
  const tray = png(32, 32, (x, y) => {
    const dx = x - 15.5;
    const dy = y - 15.5;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 14) return [0, 0, 0, 0];
    if (d > 12) return [0x2b, 0x3a, 0x55, 220];
    return [0x6e, 0xc7, 0xff, 255];
  });
  write('build/tray.png', tray);

  /* ------------------------------ 应用图标 ------------------------------ */
  const icon256 = png(256, 256, (x, y) => {
    const dx = x - 127.5;
    const dy = y - 127.5;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 124) return [0, 0, 0, 0];
    if (d > 116) return [0x2b, 0x3a, 0x55, 235];
    const t = d / 116;
    return [
      Math.round(0x6e + t * 20),
      Math.round(0xc7 - t * 40),
      Math.round(0xff - t * 30),
      255,
    ];
  });
  write('build/icon.png', icon256);
  write('build/icon.ico', pngToIco(icon256, 256));
}

/* ------------------------- 应用图标（ICO，供打包用） ------------------------- */
/**
 * electron-builder 在 Windows 上需要 .ico。这里直接用一个 PNG 压缩的 ICO
 * （ICO 支持内嵌 PNG，Vista 以后所有 Windows 版本都可用），
 * 免去引入图像库或依赖外部工具。
 *
 * ICONDIR(6B) + ICONDIRENTRY(16B) + PNG 原始数据
 */
function pngToIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width（0 表示 256）
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8); // data size
  entry.writeUInt32LE(6 + 16, 12); // data offset

  return Buffer.concat([header, entry, pngBuffer]);
}
