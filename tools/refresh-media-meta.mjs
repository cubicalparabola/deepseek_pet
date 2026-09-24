// @ts-check
/**
 * 重新生成 assets/config/media-meta.json。
 *
 * 为什么需要它：主进程用 media-meta.json 里的分辨率推导**窗口宽高比**，
 * 用不到时长。但换素材后如果不刷新，新增动画会因为没有元数据而退回兜底比例
 * （宽高比对不上就会出现画面与窗口比例不一致）。
 *
 * 同时输出每条素材的：
 *   width / height  —— ffprobe
 *   duration / fps  —— ffprobe（时长用于"循环次数"预估与诊断）
 *   alpha           —— EBML 结构层判定（BlockMore + BlockAddID=1）
 *
 * 用法：node tools/refresh-media-meta.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'assets', 'animations');
const outFile = join(root, 'assets', 'config', 'media-meta.json');

/* ------------------------- EBML：alpha side channel ------------------------- */

const ELEMENTS = new Map([
  [0x18538067, 'Segment'],
  [0x75a1, 'BlockAdditions'],
  [0xa6, 'BlockMore'],
  [0xee, 'BlockAddID'],
  [0x1f43b675, 'Cluster'],
  [0xa0, 'BlockGroup'],
]);

function vint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8) return null;
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i += 1) value = value * 256 + buf[pos + i];
  const unknown = !keepMarker && value === Math.pow(2, 7 * length) - 1;
  return { value, length, unknown };
}

/** 判定 WebM 是否带 alpha side channel（VP9 alpha 只存在这里）。 */
function hasAlphaChannel(buf) {
  let blockMore = 0;
  const addIds = new Set();
  const walk = (start, end, depth) => {
    let pos = start;
    while (pos < end && depth < 12) {
      const id = vint(buf, pos, true);
      if (!id) return;
      const size = vint(buf, pos + id.length, false);
      if (!size) return;
      const dataStart = pos + id.length + size.length;
      const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
      const name = ELEMENTS.get(id.value);
      if (name === 'BlockMore') {
        blockMore += 1;
        let inner = dataStart;
        while (inner < dataEnd) {
          const iid = vint(buf, inner, true);
          if (!iid) break;
          const isize = vint(buf, inner + iid.length, false);
          if (!isize) break;
          const iData = inner + iid.length + isize.length;
          if (ELEMENTS.get(iid.value) === 'BlockAddID' && isize.value >= 1) addIds.add(buf[iData]);
          inner = iData + isize.value;
        }
      }
      if (name === 'Segment' || name === 'Cluster' || name === 'BlockGroup' || name === 'BlockAdditions') {
        walk(dataStart, dataEnd, depth + 1);
      }
      pos = dataEnd;
      if (size.unknown) return;
    }
  };
  walk(0, buf.length, 0);
  return blockMore > 0 && addIds.size === 1 && addIds.has(1);
}

/* --------------------------------- 探测 --------------------------------- */

const files = readdirSync(dir).filter((f) => f.endsWith('.webm')).sort();
if (files.length === 0) {
  console.error(`没有可探测的素材: ${dir}`);
  process.exit(1);
}

const meta = {};
let alphaOk = 0;
for (const file of files) {
  const full = join(dir, file);
  const probe = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', full],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(probe);
  const stream = parsed.streams?.[0] ?? {};
  const duration = Number(parsed.format?.duration);
  const [num, den] = String(stream.r_frame_rate ?? '24/1').split('/').map(Number);
  const fps = den && Number.isFinite(num) && Number.isFinite(den) && num > 0 ? Math.round(num / den) : 24;

  const alpha = hasAlphaChannel(readFileSync(full));
  if (alpha) alphaOk += 1;

  meta[file] = {
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    duration: Number.isFinite(duration) ? Number(duration.toFixed(2)) : 0,
    fps,
    ...(alpha ? { alpha: true } : {}),
  };
}

const sorted = Object.fromEntries(Object.keys(meta).sort().map((k) => [k, meta[k]]));
const output = {
  _comment:
    '素材分辨率元数据（由 tools/refresh-media-meta.mjs 生成）。主进程用它推导桌宠窗口宽高比，避免窗口与画面比例不一致。换素材后重新运行该工具即可。',
  ...sorted,
};

writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

const totalMb = files.reduce((sum, f) => sum + statSync(join(dir, f)).size, 0) / 1024 / 1024;
console.log(`[meta] ${files.length} 个素材，合计 ${totalMb.toFixed(1)} MB，带 alpha ${alphaOk}/${files.length}`);
console.log(`[meta] 已写入 ${outFile}`);
const odd = Object.entries(sorted).filter(([, v]) => !v.width || !v.height);
if (odd.length) console.warn('[meta] 警告：以下素材分辨率探测失败', odd.map(([k]) => k).join(', '));
