// @ts-check
/**
 * 从美术素材生成应用图标与托盘图标（零第三方依赖，只用 node:zlib）。
 *
 * 输入（按顺序找第一个存在的）：
 *   assets/brand/ds.png          项目内副本（推荐，随仓库走）
 *   <桌面>/assets/ds.png         用户放到桌面的原始素材
 *
 * 输出：
 *   build/icon.png          256×256，electron-builder 的 png 图标
 *   build/icon.ico          16/24/32/48/64/128/256 多尺寸 ICO（打包用）
 *   build/tray.png          32×32 托盘图标
 *   build/tray@2x.png       64×64 托盘图标（高 DPI 下 Windows 会挑这一张）
 *   build/tray-16.png       16×16（托盘实际显示尺寸，用于核对清晰度）
 *
 * 为什么要自己解码 PNG：
 * 工程约定不引入图像库（见 package.json 只有 4 个 devDependency），
 * 而 ICO 只是"目录 + 若干张 PNG"，PNG 又是 zlib + 逐行滤波，
 * 两者都可以用 node:zlib 直接搞定。
 *
 * 用法：node tools/make-icons.mjs
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* PNG 编解码                                                                  */
/* -------------------------------------------------------------------------- */

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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
 * 编码 RGBA 为 PNG。
 * @param {number} width @param {number} height @param {Uint8Array} rgba
 */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[p++] = rgba[i];
      raw[p++] = rgba[i + 1];
      raw[p++] = rgba[i + 2];
      raw[p++] = rgba[i + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {number} a @param {number} b @param {number} t */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG（支持 8bit 灰度/RGB/调色板/灰度+A/RGBA，非隔行）。
 * @param {Buffer} buf
 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let offset = 8;
  /** @type {{width:number,height:number,bitDepth:number,colorType:number,interlace:number}|null} */
  let header = null;
  /** @type {Buffer[]} */
  const idat = [];
  /** @type {Buffer|null} */
  let palette = null;
  let transparency = null;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!header) throw new Error('PNG 缺少 IHDR');
  if (header.interlace !== 0) throw new Error('不支持隔行扫描的 PNG');
  if (header.bitDepth !== 8) throw new Error(`不支持的位深: ${header.bitDepth}`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (!channels) throw new Error(`不支持的颜色类型: ${header.colorType}`);

  const { width, height } = header;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);

  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[rp++];
      const a = i >= channels ? out[rowStart + i - channels] : 0;
      const b = y > 0 ? out[prevStart + i] : 0;
      const c = y > 0 && i >= channels ? out[prevStart + i - channels] : 0;
      let value;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else if (filter === 4) value = x + paeth(a, b, c);
      else throw new Error(`未知的行滤波类型: ${filter}`);
      out[rowStart + i] = value & 0xff;
    }
  }

  // 统一转成 RGBA
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels;
    let r = 0;
    let g = 0;
    let b = 0;
    let alpha = 255;
    if (header.colorType === 0) {
      r = g = b = out[s];
    } else if (header.colorType === 2) {
      r = out[s];
      g = out[s + 1];
      b = out[s + 2];
    } else if (header.colorType === 3) {
      if (!palette) throw new Error('调色板 PNG 缺少 PLTE');
      const index = out[s];
      r = palette[index * 3];
      g = palette[index * 3 + 1];
      b = palette[index * 3 + 2];
      if (transparency && index < transparency.length) alpha = transparency[index];
    } else if (header.colorType === 4) {
      r = g = b = out[s];
      alpha = out[s + 1];
    } else {
      r = out[s];
      g = out[s + 1];
      b = out[s + 2];
      alpha = out[s + 3];
    }
    const d = i * 4;
    rgba[d] = r;
    rgba[d + 1] = g;
    rgba[d + 2] = b;
    rgba[d + 3] = alpha;
  }

  return { width, height, rgba };
}

/* -------------------------------------------------------------------------- */
/* 缩放（盒式平均，避免最近邻的锯齿）                                            */
/* -------------------------------------------------------------------------- */

/**
 * 把 `src` 中指定矩形区域缩放成 `size×size`。
 *
 * 用"面积平均"而不是最近邻：图标缩到 16px 时最近邻会丢掉整条描边，
 * 平均后至少能保住轮廓和主色。
 *
 * 透明像素的处理很关键 —— 彩边像素的 RGB 在透明处通常是无意义的黑/白，
 * 直接平均会让角色边缘发暗（黑边）。这里按**预乘 alpha** 加权平均后再还原，
 * 这是标准的正确做法。
 *
 * @param {{width:number,height:number,rgba:Uint8Array}} src
 * @param {{x:number,y:number,w:number,h:number}} area
 * @param {number} size
 * @param {number} [padRatio] 额外内缩比例（0.08 = 四周留 8% 空白）
 */
function resizeArea(src, area, size, padRatio = 0) {
  const out = new Uint8Array(size * size * 4);
  const inset = padRatio > 0 ? Math.round(size * padRatio) : 0;
  const usable = Math.max(1, size - inset * 2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 目标像素反查源区域（含 padding：落在 padding 上的像素直接透明）
      const inside =
        x >= inset && y >= inset && x < inset + usable && y < inset + usable;
      const d = (y * size + x) * 4;
      if (!inside) {
        out[d + 3] = 0;
        continue;
      }

      const sx0 = area.x + ((x - inset) / usable) * area.w;
      const sy0 = area.y + ((y - inset) / usable) * area.h;
      const sx1 = area.x + ((x - inset + 1) / usable) * area.w;
      const sy1 = area.y + ((y - inset + 1) / usable) * area.h;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      const ix0 = Math.max(0, Math.floor(sx0));
      const iy0 = Math.max(0, Math.floor(sy0));
      const ix1 = Math.min(src.width, Math.max(ix0 + 1, Math.ceil(sx1)));
      const iy1 = Math.min(src.height, Math.max(iy0 + 1, Math.ceil(sy1)));

      for (let sy = iy0; sy < iy1; sy++) {
        for (let sx = ix0; sx < ix1; sx++) {
          const s = (sy * src.width + sx) * 4;
          const sa = src.rgba[s + 3] / 255;
          // 预乘 alpha 累加
          r += src.rgba[s] * sa;
          g += src.rgba[s + 1] * sa;
          b += src.rgba[s + 2] * sa;
          a += sa;
          count += 1;
        }
      }

      if (count === 0 || a === 0) {
        out[d + 3] = 0;
        continue;
      }
      // 还原非预乘
      out[d] = Math.round(r / a);
      out[d + 1] = Math.round(g / a);
      out[d + 2] = Math.round(b / a);
      out[d + 3] = Math.round((a / count) * 255);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* ICO（多尺寸内嵌 PNG）                                                        */
/* -------------------------------------------------------------------------- */

/** @param {{size:number,png:Buffer}[]} images */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let dataOffset = 6 + 16 * images.length;
  images.forEach((image, index) => {
    const at = index * 16;
    directory[at] = image.size >= 256 ? 0 : image.size; // 0 表示 256
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0; // 调色板数
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // color planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.png.length, at + 8);
    directory.writeUInt32LE(dataOffset, at + 12);
    dataOffset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

/** 候选素材路径（先项目内，再桌面）。 */
function resolveSource() {
  const candidates = [
    join(root, 'assets', 'brand', 'ds.png'),
    join(homedir(), 'Desktop', 'assets', 'ds.png'),
    join('E:', 'Desktop', 'assets', 'ds.png'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  console.error('[make-icons] 找不到素材 ds.png，尝试过：');
  for (const candidate of candidates) console.error(`  - ${candidate}`);
  process.exitCode = 1;
  return null;
}

const source = resolveSource();
if (source) {
  console.log(`[make-icons] 素材: ${source}`);
  const image = decodePng(readFileSync(source));
  console.log(`[make-icons] 解码: ${image.width}×${image.height}`);

  // 只统计有内容的最小外接矩形，避免素材自带大片留白导致图标缩得很小
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.rgba[(y * image.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const opaque = maxX >= minX && maxY >= minY;
  const content = opaque
    ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
    : { x: 0, y: 0, w: image.width, h: image.height };
  console.log(
    `[make-icons] 内容外接框: ${content.w}×${content.h} @ (${content.x},${content.y})` +
      (opaque ? '' : '（整图无 alpha，按全图处理）'),
  );

  // 正方形中心裁剪（图标必须正方形，否则会被拉变形）
  const side = Math.max(content.w, content.h);
  const square = {
    x: Math.round(content.x + content.w / 2 - side / 2),
    y: Math.round(content.y + content.h / 2 - side / 2),
    w: side,
    h: side,
  };

  /*
   * 图标内边距：**0**。
   *
   * 之前留了 3%，但用户反馈"系统托盘的图标太小" —— 托盘槽位本身只有 16 逻辑像素，
   * Windows 还会再留一圈空白，再叠加我们的内边距，角色就只剩十来个像素。
   * 这里直接按内容外接框铺满，把每一像素都用在角色上。
   */
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const icons = sizes.map((size) => ({
    size,
    png: encodePng(size, size, resizeArea(image, square, size, 0)),
  }));

  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(join(root, 'build', 'icon.ico'), buildIco(icons));
  // 应用图标走 png（electron-builder 也接受 png，且 Linux/开发模式都用得上）
  writeFileSync(join(root, 'build', 'icon.png'), icons[sizes.indexOf(256)].png);
  /*
   * 托盘图标：
   * - `tray.png`    32×32 —— Windows 托盘槽位的标准 1x 尺寸
   * - `tray@2x.png` 64×64 —— 125%/150% 缩放时 Electron/Windows 会优先挑它，
   *                           否则高 DPI 下会把 32px 放大，边缘发糊、看起来更小
   * - `tray-16.png` 16×16 —— 实际显示尺寸，留作肉眼核对
   */
  writeFileSync(join(root, 'build', 'tray.png'), icons[sizes.indexOf(32)].png);
  writeFileSync(join(root, 'build', 'tray@2x.png'), icons[sizes.indexOf(64)].png);
  writeFileSync(join(root, 'build', 'tray-16.png'), icons[sizes.indexOf(16)].png);

  for (const icon of icons) {
    console.log(`[make-icons]   ICO ${icon.size}×${icon.size} (${icon.png.length} bytes)`);
  }
  console.log(
    '[make-icons] 完成：build/icon.ico · build/icon.png · build/tray.png · build/tray@2x.png · build/tray-16.png',
  );
}
