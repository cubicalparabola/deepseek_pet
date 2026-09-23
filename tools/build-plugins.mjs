// @ts-check
/**
 * 构建阶段预编译插件。
 *
 * 为什么需要这一步：
 * esbuild 是 devDependency（打包后不存在），所以运行时编译只在开发期可用。
 * 这里在构建阶段把 plugins/ 下所有启用的插件编译成自包含 CommonJS 放到 dist/plugins/，
 * 打包后的应用直接读取这些产物 —— 插件架构在发布版本里同样成立。
 *
 * 输出与运行时编译完全一致（同样把 desktop-pet 保持 external），
 * 因此 PluginHost 的执行路径只有一条。
 */

import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsRoot = join(root, 'plugins');
const outRoot = join(root, 'dist', 'plugins');
const configFile = join(root, 'assets', 'config', 'plugins.json');

const VIRTUAL_MODULES = ['desktop-pet', 'desktop-pet/api', '@desktop-pet/plugin-api'];

/** 读取 plugins.json，得到 { id, path } 列表。 */
function readManifest() {
  if (!existsSync(configFile)) {
    console.warn('[build-plugins] plugins.json 不存在，跳过插件构建');
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(configFile, 'utf8'));
    if (!Array.isArray(parsed.plugins)) {
      console.warn('[build-plugins] plugins.json 缺少 plugins 数组，跳过');
      return [];
    }
    return parsed.plugins.filter((entry) => entry && typeof entry.id === 'string');
  } catch (error) {
    console.error('[build-plugins] plugins.json 解析失败:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return [];
  }
}

const ENTRY_CANDIDATES = ['index.ts', 'index.js', 'index.mts', 'index.cts', 'main.ts', 'main.js'];

function resolveEntry(dir) {
  for (const candidate of ENTRY_CANDIDATES) {
    const target = join(dir, candidate);
    if (existsSync(target)) return { target, candidate };
  }
  return null;
}

const manifest = readManifest();
if (manifest.length === 0) {
  console.log('[build-plugins] 没有需要构建的插件');
}

let built = 0;
for (const entry of manifest) {
  const relativeDir = typeof entry.path === 'string' && entry.path.trim() !== '' ? entry.path : entry.id;
  const pluginDir = join(pluginsRoot, relativeDir);
  if (!existsSync(pluginDir)) {
    console.warn(`[build-plugins] 跳过 ${entry.id}：目录不存在 (${relativeDir})`);
    continue;
  }
  const resolved = resolveEntry(pluginDir);
  if (!resolved) {
    console.warn(`[build-plugins] 跳过 ${entry.id}：找不到入口文件`);
    continue;
  }

  const outFile = join(outRoot, relativeDir, 'index.js');
  mkdirSync(dirname(outFile), { recursive: true });

  try {
    await build({
      entryPoints: [resolved.target],
      bundle: true,
      write: true,
      outfile: outFile,
      format: 'cjs',
      platform: 'neutral',
      target: 'chrome120',
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'warning',
      external: VIRTUAL_MODULES,
      absWorkingDir: pluginDir,
    });
    built += 1;
    const size = readFileSync(outFile, 'utf8').length;
    console.log(`[build-plugins] ${entry.id} (${resolved.candidate}) -> dist/plugins/${relativeDir}/index.js (${size} bytes)`);
  } catch (error) {
    // 单个插件编译失败不能让整个构建失败，但也必须显式告警
    console.error(`[build-plugins] ${entry.id} 编译失败:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

console.log(`[build-plugins] 完成，共 ${built}/${manifest.length} 个插件`);
