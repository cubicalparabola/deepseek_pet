// @ts-check
/**
 * 校验持续动画的 `loop` 段是否**真的能无缝循环**。
 *
 * 为什么必须验：上一次实现持续动画就是栽在这里 —— 素材本身没有可循环的中间段，
 * 硬切出来的循环段首尾接不上，肉眼可见跳变。所以这次在写 Manifest 之前先量。
 *
 * 判定方式（纯离线，不需要跑应用）：
 *   1. ffmpeg 解出 loop 段全部 RGBA 帧；
 *   2. 比较**首帧 vs 末帧**的差异（loopSeam）；
 *   3. 同时算**相邻帧**的平均差异（frameStep），作为"正常帧间变化"的基准；
 *   4. 判定：loopSeam 与 frameStep 处于同一量级 => 接缝不可见（无缝）。
 *
 * 经验阈值：loopSeam <= frameStep * 2.5 视为无缝；
 * 超过则说明首尾画面差得较多，循环时会有明显跳变。
 *
 * 用法：
 *   node tools/verify-loop-seam.mjs              # 检查所有 *-loop.webm
 *   node tools/verify-loop-seam.mjs read sleep   # 只查指定动画
 * 输出：build/loop-seam.json
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const root = join(import.meta.dirname, '..');
const assetsDir = join(root, 'assets', 'animations');
const workDir = join(root, 'build', 'seam-frames');
const outFile = join(root, 'build', 'loop-seam.json');

/* ------------------------------- PNG 解码 ------------------------------- */

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 只解出 alpha 通道（够用来判断动作差异，且比 RGB 快）。 */
function decodeAlpha(buf) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp++];
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[rp++];
      const a = i >= channels ? out[row + i - channels] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = y > 0 && i >= channels ? out[prev + i - channels] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else v = x + paeth(a, b, c);
      out[row + i] = v & 0xff;
    }
  }
  // 取 alpha 平面
  const alpha = Buffer.alloc(width * height);
  for (let i = 0, n = width * height; i < n; i += 1) {
    alpha[i] = colorType === 6 ? out[i * 4 + 3] : out[i * channels];
  }
  return alpha;
}

/** 平均绝对差（每 3 像素抽 1，提速且足够稳定）。 */
function diff(a, b) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 3) {
    sum += Math.abs(a[i] - b[i]);
    count += 1;
  }
  return sum / Math.max(1, count);
}

/* --------------------------------- 检查 --------------------------------- */

const names = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const loopFiles = (names.length > 0
  ? names.map((n) => `${n}-loop.webm`)
  : readdirSync(assetsDir).filter((f) => f.endsWith('-loop.webm'))
).sort();

if (loopFiles.length === 0) {
  console.error('没有找到任何 *-loop.webm');
  process.exit(1);
}

mkdirSync(workDir, { recursive: true });
const results = [];
let seamless = 0;

for (const file of loopFiles) {
  const name = file.replace(/-loop\.webm$/, '');
  const full = join(assetsDir, file);
  if (!existsSync(full)) {
    console.error(`跳过 ${file}: 文件不存在`);
    continue;
  }

  const dir = join(workDir, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-c:v', 'libvpx-vp9', '-i', full, '-vf', 'format=rgba', join(dir, '%04d.png')],
    { stdio: 'pipe' },
  );

  const frames = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  const alphas = frames.map((f) => decodeAlpha(readFileSync(join(dir, f))));
  if (alphas.length < 2) {
    console.error(`跳过 ${file}: 解出的帧太少 (${alphas.length})`);
    continue;
  }

  // 首帧 vs 末帧 = 接缝差异
  const seam = diff(alphas[0], alphas[alphas.length - 1]);
  // 相邻帧平均差异 = 正常帧间变化基准
  let stepSum = 0;
  for (let i = 1; i < alphas.length; i += 1) stepSum += diff(alphas[i - 1], alphas[i]);
  const frameStep = stepSum / (alphas.length - 1);

  const ratio = frameStep > 0.001 ? seam / frameStep : Number.POSITIVE_INFINITY;
  const ok = seam <= frameStep * 2.5;
  if (ok) seamless += 1;

  results.push({
    name,
    frames: alphas.length,
    seam: Number(seam.toFixed(3)),
    frameStep: Number(frameStep.toFixed(3)),
    ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null,
    seamless: ok,
  });

  console.log(
    `${ok ? 'OK  ' : 'JUMP'} ${name.padEnd(9)} frames=${String(alphas.length).padStart(3)} ` +
      `seam=${seam.toFixed(2).padStart(6)} frameStep=${frameStep.toFixed(2).padStart(6)} ` +
      `ratio=${Number.isFinite(ratio) ? ratio.toFixed(2) : 'inf'}`,
  );
}

writeFileSync(
  outFile,
  JSON.stringify({ generatedAt: new Date().toISOString(), threshold: 'seam <= frameStep * 2.5', results }, null, 1),
  'utf8',
);
console.log(`\n${seamless}/${results.length} 个循环段接缝在阈值内（详细数据见 ${outFile}）`);
process.exitCode = seamless === results.length ? 0 : 1;
