// Temporary diagnostic: parse EBML/WebM headers without external deps.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const VINT = (buf, pos, keepMarker) => {
  const first = buf[pos];
  if (first === 0) return null;
  let len = 1;
  for (let i = 7; i >= 0; i--) {
    if (first & (1 << i)) break;
    len++;
  }
  if (len > 8 || pos + len > buf.length) return null;
  let raw = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i++) raw = raw * 256 + buf[pos + i];
  return { value: raw, len };
};

const IDS = {
  '18538067': 'Segment',
  '1549a966': 'Info',
  '2ad7b1': 'TimecodeScale',
  '4489': 'Duration',
  '1654ae6b': 'Tracks',
  'ae': 'TrackEntry',
  'd7': 'TrackNumber',
  '83': 'TrackType',
  '86': 'CodecID',
  'e0': 'Video',
  'b0': 'PixelWidth',
  'ba': 'PixelHeight',
  '53b8': 'AlphaMode',
  '9c': 'FlagLacing',
  'b9': 'FlagEnabled',
};

function walk(buf, start, end, depth, out) {
  let pos = start;
  while (pos < end) {
    const id = VINT(buf, pos, true);
    if (!id) return;
    const size = VINT(buf, pos + id.len, false);
    if (!size) return;
    const idHex = id.value.toString(16);
    const dataStart = pos + id.len + size.len;
    const dataEnd = dataStart + size.value;
    const name = IDS[idHex];
    const isMaster = ['18538067', '1549a966', '1654ae6b', 'ae', 'e0'].includes(idHex);
    if (name === 'TimecodeScale' || name === 'TrackType' || name === 'PixelWidth' ||
        name === 'PixelHeight' || name === 'AlphaMode' || name === 'TrackNumber') {
      let v = 0;
      for (let i = dataStart; i < dataEnd; i++) v = v * 256 + buf[i];
      out[name] = v;
    } else if (name === 'CodecID') {
      out.CodecID = buf.toString('utf8', dataStart, dataEnd);
    } else if (name === 'Duration') {
      if (size.value === 4) out.Duration = buf.readFloatBE(dataStart);
      else if (size.value === 8) out.Duration = buf.readDoubleBE(dataStart);
    }
    if (isMaster && depth < 6 && dataEnd <= end) {
      walk(buf, dataStart, dataEnd, depth + 1, out);
    }
    if (size.value === 0xffffffffffffffffn || dataEnd > end) return;
    pos = dataEnd;
  }
}

const dir = process.argv[2];
const rows = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.webm')).sort()) {
  const buf = readFileSync(join(dir, f));
  const out = {};
  walk(buf, 0, buf.length, 0, out);
  const scale = out.TimecodeScale ?? 1000000;
  const seconds = out.Duration ? (out.Duration * scale) / 1e9 : NaN;
  rows.push({
    file: f,
    codec: out.CodecID ?? '?',
    w: out.PixelWidth ?? '?',
    h: out.PixelHeight ?? '?',
    alpha: out.AlphaMode ?? 0,
    sec: Number.isFinite(seconds) ? seconds.toFixed(2) : '?',
    fps30: Number.isFinite(seconds) ? Math.round(seconds * 30) : '?',
  });
}
console.table(rows);
