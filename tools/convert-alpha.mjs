// @ts-check
/**
 * 把「premultiplied alpha 渲染到纯黑底」的原始 WebM 转成**真正带 alpha 通道**的透明 WebM。
 *
 * 原理（已逐像素验证，见 tools/decode-png.mjs 与 README）：
 *   原始素材 rgb = 真实颜色 C × alpha（预乘），因此
 *     alpha = 亮度(luma)   —— 直接用源的灰度平面当作蒙版
 *     C     = rgb × 255 / max(r,g,b)  —— 反预乘还原直通颜色
 *
 * 滤镜链（关键：蒙版必须从**源**取，不能从 un-premultiply 之后的流里取，
 * 因为一旦转成 gbrap/rgba，alpha 平面会被填成 255）：
 *
 *   [0:v] split[srcA][srcB];
 *   [srcA] format=gbrp,geq=r/g/b='x*255/max(1,max(max(r,g),b))',format=rgb24 [rgb];
 *   [srcB] format=gray [matte];
 *   [rgb][matte] alphamerge, format=yuva420p [out]
 *
 * 编码：libvpx-vp9 + yuva420p（alpha 走 WebM alpha side channel）。
 * Chromium 能正确解码（已实测：四角 alpha=0，角色区域 alpha≈112~240）。
 *
 * 用法：
 *   node tools/convert-alpha.mjs                 # 转换 assets/animations 下全部 .webm
 *   node tools/convert-alpha.mjs idle sleep      # 只转换指定素材（不含扩展名）
 *   node tools/convert-alpha.mjs --force         # 重新转换已存在的输出
 *
 * 注意：这是**离线烘焙**步骤，产物直接进 assets/animations/，
 * 运行时不再做任何逐帧像素处理。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'assets', 'animations');
const sourceDir = join(assetsDir, 'source-premultiplied');

/* -------------------------------------------------------------------------- */
/* 参数                                                                        */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const force = argv.includes('--force');
const only = argv.filter((a) => !a.startsWith('--'));

/** 编码参数：CRF 越低越清晰、体积越大。32 在本项目的素材上观感与体积平衡良好。 */
const CRF = process.env.PET_ALPHA_CRF ?? '32';
const CPU_USED = process.env.PET_ALPHA_CPU_USED ?? '5';

/* -------------------------------------------------------------------------- */
/* 滤镜链                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 反预乘表达式。
 * `max(1, ...)` 防止 alpha=0 时除零；结果再 clamp 到 255（FFmpeg 会自动裁）。
 */
function unpremultiplyExpr(channel) {
  const k = 'max(1,max(max(r(X,Y),g(X,Y)),b(X,Y)))';
  return `${channel}(X,Y)*255/${k}`;
}

/**
 * alpha 蒙版的分段阈值。
 *
 * 为什么不能直接用 `alpha = 亮度`：
 * 素材是「premultiplied alpha 渲染到纯黑底」，亮度确实等于 alpha，
 * 但那是**合成结果**的亮度 —— 角色本身的深色部分（深蓝头发、深色描边）
 * 在预乘后亮度同样很低，于是被判成半透明，整个角色看起来发虚、像蒙了层雾。
 *
 * 实测对比（见 build/matte/idle-variants.png）：
 *   luma = alpha        -> 不透明像素  0.0%，半透明 51.5%（角色整体发虚）
 *   分段 lo=8  hi=48    -> 不透明像素 40.1%，半透明  8.6%  ← 采用
 *   分段 lo=8  hi=96    -> 不透明像素 24.3%（角色仍偏透）
 *   分段 lo=16 hi=64    -> 不透明像素 35.9%
 *
 * 语义：
 *   luma >= 48   -> 255   角色实体，完全不透明
 *   8 .. 48      -> 线性过渡（抗锯齿边缘、脚下软阴影保持真实半透明）
 *   luma <= 8    -> 0     纯黑背景，完全透明
 *
 * 想自己调：PET_ALPHA_LO=8 PET_ALPHA_HI=40 npm run convert:alpha -- --force
 */
const ALPHA_LO = Number.parseInt(process.env.PET_ALPHA_LO ?? '8', 10);
const ALPHA_HI = Number.parseInt(process.env.PET_ALPHA_HI ?? '48', 10);

/** 分段（steppy）蒙版表达式。 */
const MATTE_EXPR =
  `if(lt(val,${ALPHA_LO}),0,` +
  `if(gt(val,${ALPHA_HI}),255,` +
  `255*(val-${ALPHA_LO})/(${ALPHA_HI}-${ALPHA_LO})))`;

const FILTER_COMPLEX = [
  '[0:v]split[srcA][srcB]',
  `[srcA]format=gbrp,geq=r='${unpremultiplyExpr('r')}':g='${unpremultiplyExpr('g')}':b='${unpremultiplyExpr('b')}',format=rgb24[rgb]`,
  // 蒙版取自源：灰度平面 -> 分段阈值（注意不能用 alphaextract，见文件头说明）
  `[srcB]format=gray,lut=y='${MATTE_EXPR}'[matte]`,
  '[rgb][matte]alphamerge,format=yuva420p[out]',
].join(';');

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

/** 探测视频流基本信息。 */
function ffprobeStream(file) {
  const out = execFileSync(
    'ffprobe',
    ['-hide_banner', '-v', 'error', '-select_streams', 'v:0',
     '-show_entries', 'stream=width,height,r_frame_rate',
     '-of', 'default=noprint_wrappers=1', file],
    { encoding: 'utf8' },
  );
  const map = {};
  for (const line of out.split('\n')) {
    const [key, value] = line.split('=');
    if (key && value !== undefined) map[key.trim()] = value.trim();
  }
  return map;
}

/**
 * 判断某个素材是否已经是「透明素材」。
 *
 * 重要：不能依赖 ffprobe 的 pix_fmt —— VP9 的 alpha 存在 WebM 的 alpha side channel 里，
 * ffprobe 依然报告 `yuv420p`（实测确认）。因此这里用两个客观依据：
 *   1. 是否存在 source-premultiplied/ 备份（存在 => 当前文件是转换产物）；
 *   2. 文件体积是否明显大于原始预乘版本（原始素材均为 0.6~0.9MB）。
 *
 * 真正的 alpha 正确性由 `npm run verify:alpha` 在 Chromium 里逐帧核验。
 */
function isAlreadyConverted(file) {
  if (existsSync(join(sourceDir, basename(file)))) return true;
  return statSync(file).size > 1_500_000;
}

/** 把素材按原始/转换中/已转换分类，并备份尚未备份的原始文件。 */
function prepareSource(file) {
  mkdirSync(sourceDir, { recursive: true });
  const backup = join(sourceDir, basename(file));

  if (existsSync(backup)) return { ready: true, source: backup, converted: true };

  // 体积很小 => 还是原始预乘素材，先备份
  if (statSync(file).size < 1_500_000) {
    ffmpeg(['-i', file, '-c', 'copy', backup]);
    console.log(`  备份原始素材 -> assets/animations/source-premultiplied/${basename(file)}`);
    return { ready: true, source: backup, converted: false };
  }

  // 体积已经很大但没有备份：可能是上一次转换中途失败留下的产物
  return { ready: false, source: backup, converted: true };
}

function humanSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

function convert(file) {
  const name = basename(file, extname(file));
  const prepared = prepareSource(file);
  if (!prepared.ready) {
    return {
      name,
      skipped: true,
      reason: '缺少原始备份且当前文件体积异常，请从版本库恢复后再转换',
    };
  }

  const temp = join(assetsDir, `${name}.alpha.tmp.webm`);
  const started = Date.now();

  ffmpeg([
    '-i', prepared.source,
    '-filter_complex', FILTER_COMPLEX,
    '-map', '[out]',
    '-c:v', 'libvpx-vp9',
    '-pix_fmt', 'yuva420p',
    '-crf', CRF,
    '-b:v', '0',
    // VP9 的 alt-ref 帧与 alpha side channel 兼容性较差，关掉最稳妥
    '-auto-alt-ref', '0',
    '-row-mt', '1',
    '-cpu-used', CPU_USED,
    '-an', // 桌宠动画不需要音轨
    temp,
  ]);

  // 原子替换：转换成功才覆盖目标文件，避免失败时留下半个文件
  renameSync(temp, file);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const size = statSync(file).size;
  return { name, ok: size > 1_000_000, seconds, size, sourceBytes: statSync(prepared.source).size };
}

const all = readdirSync(assetsDir)
  .filter((f) => f.toLowerCase().endsWith('.webm'))
  .filter((f) => !f.includes('.tmp.'));

const targets = only.length > 0
  ? all.filter((f) => only.includes(basename(f, '.webm')))
  : all;

if (targets.length === 0) {
  console.error('[convert-alpha] 没有匹配的素材。可用素材：' + all.map((f) => basename(f, '.webm')).join(', '));
  process.exit(1);
}

console.log(`[convert-alpha] 待处理 ${targets.length} 个素材（CRF=${CRF}, cpu-used=${CPU_USED}, force=${force}）`);
console.log('[convert-alpha] filter chain: un-premultiply(RGB) + luma matte(alpha) -> VP9 yuva420p');

const results = [];
let failed = 0;
for (const [index, file] of targets.entries()) {
  const name = basename(file, '.webm');
  const target = join(assetsDir, file);
  process.stdout.write(`[${index + 1}/${targets.length}] ${name} ... `);
  try {
    if (isAlreadyConverted(target) && !force) {
      console.log(`跳过（已是透明素材，${(statSync(target).size / 1024 / 1024).toFixed(2)} MB）`);
      results.push({ name, skipped: true });
      continue;
    }
    const result = convert(target);
    results.push(result);
    if (result.skipped) {
      console.log(`跳过（${result.reason}）`);
    } else if (result.ok) {
      console.log(`OK  ${result.seconds}s  ${humanSize(result.size)}（原始 ${humanSize(result.sourceBytes)}）`);
    } else {
      failed += 1;
      console.log(`警告：产物体积异常（${humanSize(result.size)}），请检查素材`);
    }
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`失败: ${message.split('\n').slice(0, 3).join(' | ')}`);
    results.push({ name, error: message });
  }
}

/* -------------------------------------------------------------------------- */
/* 汇总 + 生成 media-meta.json                                                 */
/* -------------------------------------------------------------------------- */

const videos = [];
for (const file of all) {
  const target = join(assetsDir, file);
  const stream = ffprobeStream(target);
  const [num, den] = (stream.r_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den ? Math.round(num / den) : null;
  videos.push({
    file,
    name: basename(file, '.webm'),
    width: Number(stream.width),
    height: Number(stream.height),
    fps,
  });
}

const metaPath = join(root, 'assets', 'config', 'media-meta.json');
let existing = {};
try {
  existing = JSON.parse(readFileSync(metaPath, 'utf8'));
} catch {
  existing = {};
}
const meta = {
  _comment:
    existing._comment ??
    '素材分辨率元数据。主进程用它推导桌宠窗口宽高比；新增素材后重新运行 npm run convert:alpha 即可刷新。',
};
for (const video of videos) {
  const previous = existing[video.file] ?? {};
  meta[video.file] = {
    width: video.width,
    height: video.height,
    ...(previous.duration !== undefined ? { duration: previous.duration } : {}),
    ...(video.fps ? { fps: video.fps } : {}),
    // 所有经过本脚本处理的素材都带 alpha 通道
    alpha: true,
  };
}
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

console.log('');
console.log(`[convert-alpha] 完成：成功 ${results.filter((r) => r.ok).length}，跳过 ${results.filter((r) => r.skipped).length}，失败 ${failed}`);
console.log(`[convert-alpha] media-meta.json 已更新（${videos.length} 条，全部标记 alpha: true）`);
if (failed > 0) process.exitCode = 1;
