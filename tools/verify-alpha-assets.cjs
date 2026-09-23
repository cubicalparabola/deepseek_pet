// @ts-check
/**
 * 逐个核验 assets/animations 下的素材是否**真的带 alpha 通道**，并且蒙版没有退化成
 * 「整只角色都半透明」。
 *
 * 为什么必须在 Chromium 里验：
 * VP9 的 alpha 存在 WebM 的 alpha side channel 里，ffprobe 依然报告 `yuv420p`，
 * 所以文件层面的检测不可靠。这里把开头的帧画到 canvas 上看真实 alpha 分布。
 *
 * 判定标准（分两层，避免四角带实体内容的素材被误判）：
 *   结构层（可靠）：WebM 里确实存在 alpha side channel（EBML: BlockAdditional/addID=1）。
 *                   缺了就一定是坏的。
 *   像素层（防退化）：解码后
 *     - 存在可观的**完全不透明**像素（角色实体）—— 防止蒙版退化成 `alpha = 亮度`：
 *       那样整只角色都是半透明、看起来发虚；
 *     - 存在半透明像素（软边与阴影被保留）；
 *     - 存在完全透明像素（背景被扣掉）。
 *   注意：**不再要求四角透明**——像 peek 这种角色/道具占满画幅的素材，四角本来就是实体。
 *
 * 本文件是项目自带工具，**不依赖任何外部转换脚本**（自带 EBML 解析）。
 *
 * 用法：npx electron tools/verify-alpha-assets.cjs
 * 结果：build/alpha-assets.json
 */
const { app, BrowserWindow } = require('electron');
const { existsSync, readdirSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const assetsDir = join(root, 'assets', 'animations');
const outFile = join(root, 'build', 'alpha-assets.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const files = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter((f) => f.toLowerCase().endsWith('.webm') && !f.includes('.tmp.'))
  : [];

/**
 * 注入渲染进程的极简 WebM/EBML 解析：判断是否存在 alpha side channel
 * （Cluster -> BlockGroup -> BlockAdditions -> BlockMore，BlockAddID == 1）。
 * 自带一份实现，避免与项目外的转换工具产生依赖。
 */
const EBML_SOURCE = `
function vint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let len = 1;
  for (let i = 7; i >= 0; i--) { if (first & (1 << i)) break; len++; }
  if (len > 8 || pos + len > buf.length) return null;
  let raw = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i++) raw = raw * 256 + buf[pos + i];
  return { value: raw, len };
}
const ELEM = { Segment:'18538067', Tracks:'1654ae6b', TrackEntry:'ae', TrackNumber:'d7', TrackType:'83',
  CodecID:'86', Video:'e0', PixelWidth:'b0', PixelHeight:'ba', Cluster:'1f43b675', BlockGroup:'a0',
  BlockAdditions:'75a1', BlockMore:'a6', BlockAddID:'ee', BlockAdditional:'a5' };
const NAME = Object.fromEntries(Object.entries(ELEM).map(([k, v]) => [v, k]));
function children(buf, start, end) {
  const out = []; let pos = start;
  while (pos < end) {
    const id = vint(buf, pos, true); if (!id) break;
    const size = vint(buf, pos + id.len, false); if (!size) break;
    const dataStart = pos + id.len + size.len;
    let dataEnd = dataStart + size.value;
    if (size.value === Number.MAX_SAFE_INTEGER || dataEnd > end) dataEnd = end;
    out.push({ name: NAME[id.value.toString(16)], dataStart, dataEnd });
    if (dataEnd <= pos) break;
    pos = dataEnd;
  }
  return out;
}
const uintOf = (buf, c) => { let v = 0; for (let i = c.dataStart; i < c.dataEnd; i++) v = v * 256 + buf[i]; return v; };
function scanWebm(buf) {
  const rec = { blockMore: 0, hasAlpha: false, videoTracks: [], audioTracks: 0 };
  const seg = children(buf, 0, buf.length).find((c) => c.name === 'Segment');
  const top = seg ? children(buf, seg.dataStart, seg.dataEnd) : [];
  const tracks = top.find((c) => c.name === 'Tracks');
  if (tracks) {
    for (const te of children(buf, tracks.dataStart, tracks.dataEnd)) {
      if (te.name !== 'TrackEntry') continue;
      const t = { type: null, codec: null, w: null, h: null };
      for (const c of children(buf, te.dataStart, te.dataEnd)) {
        if (c.name === 'TrackType') t.type = uintOf(buf, c);
        else if (c.name === 'CodecID') t.codec = new TextDecoder().decode(buf.subarray(c.dataStart, c.dataEnd));
        else if (c.name === 'Video') {
          for (const vc of children(buf, c.dataStart, c.dataEnd)) {
            if (vc.name === 'PixelWidth') t.w = uintOf(buf, vc);
            if (vc.name === 'PixelHeight') t.h = uintOf(buf, vc);
          }
        }
      }
      if (t.type === 1) rec.videoTracks.push(t); else if (t.type === 2) rec.audioTracks++;
    }
  }
  const ids = new Set();
  for (const cluster of top.filter((c) => c.name === 'Cluster')) {
    for (const bg of children(buf, cluster.dataStart, cluster.dataEnd)) {
      if (bg.name !== 'BlockGroup') continue;
      for (const ba of children(buf, bg.dataStart, bg.dataEnd)) {
        if (ba.name !== 'BlockAdditions') continue;
        for (const bm of children(buf, ba.dataStart, ba.dataEnd)) {
          if (bm.name !== 'BlockMore') continue;
          rec.blockMore++;
          for (const x of children(buf, bm.dataStart, bm.dataEnd)) {
            if (x.name === 'BlockAddID') ids.add(uintOf(buf, x));
          }
        }
      }
    }
  }
  rec.hasAlpha = rec.blockMore > 0 && ids.size === 1 && ids.has(1);
  return rec;
}
`;

const pageFile = join(root, 'build', 'alpha-assets.html');
function buildPage() {
  return `<!doctype html><html><body><canvas id="c"></canvas><script>
${EBML_SOURCE}
// 结构层检查：在渲染进程内解析 WebM，确认存在 alpha side channel。
// 不依赖子进程（沙箱下 spawn 捕获输出会挂死）。
window.__STRUCT__ = async function (url) {
  try {
    const buf = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => (xhr.response ? resolve(new Uint8Array(xhr.response)) : reject(new Error('empty')));
      xhr.onerror = () => reject(new Error('xhr error'));
      xhr.send();
    });
    const r = scanWebm(buf);
    return { hasAlpha: r.hasAlpha, blockMore: r.blockMore, addIds: r.blockAddIds, codec: r.videoTracks[0] && r.videoTracks[0].codec };
  } catch { return null; }
};
window.__PROBE_ONE__ = function (base, file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let settled = false;
    const done = (rec) => { if (settled) return; settled = true; resolve(rec); };
    // 每个片段独立超时，避免个别素材卡死整个流程
    const guard = setTimeout(() => done({ file, hasAlpha: false, error: 'timeout' }), 12000);

    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = base + '/' + file;

    video.onerror = () => {
      clearTimeout(guard);
      done({ file, hasAlpha: false, error: 'media error ' + (video.error && video.error.code) });
    };

    video.onloadeddata = async () => {
      try {
        // 取一个靠前的完整帧；seek 后等一帧再采样
        const target = Math.min(1.0, (video.duration || 2) * 0.25);
        video.currentTime = target;
        await new Promise((res) => {
          const t = setTimeout(res, 2500);
          video.onseeked = () => { clearTimeout(t); res(); };
        });
        await new Promise((r) => setTimeout(r, 120));

        const w = video.videoWidth, h = video.videoHeight;
        canvas.width = w; canvas.height = h;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(video, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        const at = (x, y) => d[((y * w + x) * 4) + 3];

        let zero = 0, semi = 0, opaque = 0;
        for (let i = 3; i < d.length; i += 4) {
          const a = d[i];
          if (a === 0) zero++; else if (a === 255) opaque++; else semi++;
        }
        const total = w * h;
        const edges = [
          at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3),
          at(w >> 1, 2), at(2, h >> 1), at(w - 3, h >> 1), at(w >> 1, h - 3),
        ];
        let bodyMax = 0;
        for (let y = Math.round(h * 0.25); y < Math.round(h * 0.7); y += 4) {
          for (let x = Math.round(w * 0.3); x < Math.round(w * 0.7); x += 4) {
            const a = at(x, y);
            if (a > bodyMax) bodyMax = a;
          }
        }
        const avgEdgeAlpha = Math.round(edges.reduce((a, b) => a + b, 0) / edges.length);
        const transparentPct = +(zero / total * 100).toFixed(1);
        const semiPct = +(semi / total * 100).toFixed(1);
        const opaquePct = +(opaque / total * 100).toFixed(1);
        clearTimeout(guard);
        done({
          file, w, h,
          transparentPct, semiPct, opaquePct,
          maxEdgeAlpha: Math.max(...edges),
          avgEdgeAlpha,
          bodyMaxAlpha: bodyMax,
          // 像素层：背景确实透明 + 有软边 + 有实体。四角是否透明不作为判据。
          pixelsOk: transparentPct > 5 && semiPct > 0.5 && opaquePct > 10 && bodyMax > 200,
          hasAlpha: transparentPct > 5 && semiPct > 0.5 && opaquePct > 10 && bodyMax > 200,
        });
      } catch (err) {
        clearTimeout(guard);
        done({ file, hasAlpha: false, error: String((err && err.message) || err) });
      }
    };
  });
};
</script></body></html>`;
}

mkdirSync(join(root, 'build'), { recursive: true });

function finish(payload) {
  writeFileSync(outFile, JSON.stringify(payload, null, 1), 'utf8');
  console.log('ALPHA_ASSETS_BEGIN');
  console.log(JSON.stringify(payload, null, 1));
  console.log('ALPHA_ASSETS_END');
  app.exit(payload.failed > 0 ? 1 : 0);
}

app.whenReady().then(async () => {
  if (files.length === 0) return finish({ fatal: '未找到任何 .webm 素材', failed: 1, results: [] });
  writeFileSync(pageFile, buildPage(), 'utf8');
  // webSecurity:false 让页面能 fetch file:// 素材做 EBML 结构检查（仅本地离线核验工具）
  const win = new BrowserWindow({ width: 1000, height: 1200, show: false, webPreferences: { webSecurity: false } });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[page]', message);
  });
  await win.loadFile(pageFile);

  const base = 'file:///' + assetsDir.replace(/\\/g, '/');
  // 逐个核验：单个素材卡死不会拖垮整体
  const results = [];
  for (const file of files) {
    try {
      const rec = await win.webContents.executeJavaScript(
        `window.__PROBE_ONE__(${JSON.stringify(base)}, ${JSON.stringify(file)})`,
        true,
      );
      // 结构层：文件里是否真的有 alpha side channel
      const struct = await win.webContents.executeJavaScript(
        `window.__STRUCT__(${JSON.stringify(base + '/' + file)})`,
        true,
      ).catch(() => null);
      rec.sideChannel = struct ? struct.hasAlpha : null;
      rec.blockMore = struct ? struct.blockMore : null;
      rec.hasAlpha = rec.sideChannel === false ? false : rec.pixelsOk;
      results.push(rec);
      const flag = rec.hasAlpha ? 'OK  ' : 'FAIL';
      console.log(
        `${flag} ${file.padEnd(18)} sideChannel=${rec.sideChannel === null ? '?' : rec.sideChannel ? 'yes' : 'NO '} ` +
        `blockMore=${rec.blockMore} transparent=${rec.transparentPct}% semi=${rec.semiPct}% opaque=${rec.opaquePct}% ` +
        `bodyMax=${rec.bodyMaxAlpha}${rec.error ? ' error=' + rec.error : ''}`,
      );
    } catch (error) {
      results.push({ file, hasAlpha: false, error: String((error && error.message) || error) });
      console.log(`FAIL ${file} (evaluate error)`);
    }
  }

  const failed = results.filter((r) => !r.hasAlpha).length;
  finish({ total: results.length, withAlpha: results.length - failed, failed, results });
}).catch((error) => finish({ fatal: String((error && error.stack) || error), failed: 1, results: [] }));

setTimeout(() => finish({ fatal: 'TIMEOUT', failed: 1, results: [] }), 420000);
