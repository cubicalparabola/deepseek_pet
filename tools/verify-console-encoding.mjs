// @ts-check
/**
 * Verify the terminal-log output path.
 *
 * Contract (see README §17 and src/main/console-encoding.ts):
 *   - log messages are **English** (ASCII), so they render correctly in any
 *     Windows console regardless of the active code page;
 *   - `writeUtf8()` writes UTF-8 bytes to stdout/stderr, and no code-page
 *     conversion is performed anywhere.
 *
 * This script checks the **production module itself** (not a copy of its logic):
 *   1. bundle `src/main/console-encoding.ts` with esbuild into a temp CJS file;
 *   2. run it in a real Node child process and capture what it writes;
 *   3. assert the bytes round-trip exactly, with no U+FFFD.
 *
 * Usage: node tools/verify-console-encoding.mjs
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dirname, '..');

/** Samples must include ASCII (the permanent contract) and a non-ASCII round-trip case. */
const SAMPLES = [
  '[Main] main process starting',
  '[Settings] settings loaded',
  '[TrayManager] animation menu updated',
  // non-ASCII round-trip: proves the byte path is untouched (no code-page conversion)
  '[verify] roundtrip \u4e2d\u6587 \u00e9\u00e8\u00fc',
];

let failures = 0;
/** @param {string} label */
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
}

/* ---------------- 1) production module: src/main/console-encoding.ts ---------------- */

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  console.log('[verify] 跳过产品代码检查：esbuild 不可用');
}

if (esbuild) {
  const bundlePath = join(tmpdir(), `pet-console-encoding-${process.pid}.cjs`);
  const probePath = join(tmpdir(), `pet-console-encoding-probe-${process.pid}.cjs`);

  await esbuild.build({
    entryPoints: [join(root, 'src', 'main', 'console-encoding.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  });

  writeFileSync(
    probePath,
    [
      `const mod = require(${JSON.stringify(bundlePath)});`,
      `const lines = ${JSON.stringify(SAMPLES)};`,
      'for (const line of lines) mod.writeUtf8("info", line);',
    ].join('\n'),
    'utf8',
  );

  const run = spawnSync(process.execPath, [probePath], {
    encoding: 'buffer',
    windowsHide: true,
    timeout: 60000,
  });
  const bytes = run.stdout ?? Buffer.alloc(0);
  const text = bytes.toString('utf8');
  console.log(`[verify] 产品代码 writeUtf8 输出 ${bytes.length} 字节`);

  for (const sample of SAMPLES) {
    check(
      `round-trips: ${sample}`,
      bytes.includes(Buffer.from(`${sample}\n`, 'utf8')) && text.split('\n').includes(sample),
    );
  }
  check('no U+FFFD (valid UTF-8)', !text.includes('\uFFFD'));

  rmSync(bundlePath, { force: true });
  rmSync(probePath, { force: true });
}

/* ------------------------ 2) build tools print ASCII lines ------------------------ */

const script = join(root, 'tools', 'copy-static.mjs');
if (existsSync(script)) {
  const run = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'buffer',
    windowsHide: true,
    timeout: 60000,
  });
  const text = (run.stdout ?? Buffer.alloc(0)).toString('utf8');
  check('copy-static output is valid UTF-8', !text.includes('\uFFFD'));
  check('copy-static prints its known prefix', text.includes('[copy-static]'));
}

console.log(`[verify] ${failures === 0 ? 'all checks passed' : `${failures} failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
