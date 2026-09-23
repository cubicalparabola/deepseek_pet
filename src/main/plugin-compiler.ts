/**
 * 插件源码编译器（Main 进程）。
 *
 * 为什么单独成文件并做惰性 require：
 * esbuild 的 JS API **不能被 bundle**（它需要通过相对路径找到自己的二进制文件）。
 * 因此这里用 `createRequire` 在运行时按需加载：
 * - 开发/源码运行：能加载到 esbuild，支持运行时直接编译 `.ts` 插件（改完即可重载）；
 * - 打包运行：esbuild 是 devDependency，不会被安装；此时依赖 `dist/plugins/`
 *   下的预编译产物（由 `tools/build-plugins.mjs` 在构建阶段生成）。
 *
 * 两条路径产出格式一致（自包含 CommonJS），PluginHost 无需区分。
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Logger } from '../shared/logger';
import { describeError } from '../shared/errors';

export interface BundlePluginOptions {
  readonly id: string;
  readonly entryPath: string;
  readonly workingDir: string;
  /** 插件可用的虚拟模块（保持 external，交给 PluginHost 的 require shim 处理）。 */
  readonly externalModules: readonly string[];
}

interface EsbuildResult {
  readonly outputFiles?: readonly { readonly text: string }[];
}

interface EsbuildApi {
  build(options: Record<string, unknown>): Promise<EsbuildResult>;
}

const require = createRequire(import.meta.url ?? __filename);

let esbuildModule: EsbuildApi | null | undefined;

/** 惰性加载 esbuild；不可用时返回 null（不抛异常）。 */
function loadEsbuild(): EsbuildApi | null {
  if (esbuildModule !== undefined) return esbuildModule;
  try {
    // 动态解析：不写成静态 import，避免被 esbuild 打进产物
    const resolved = require.resolve('esbuild');
    const loaded = require(resolved) as EsbuildApi;
    esbuildModule = typeof loaded.build === 'function' ? loaded : null;
  } catch {
    esbuildModule = null;
  }
  return esbuildModule;
}

export interface PluginCompilerOptions {
  readonly logger: Logger;
  /** 预编译产物根目录（dist/plugins）。 */
  readonly compiledPluginsPath: string;
}

export class PluginCompiler {
  private readonly logger: Logger;
  private readonly compiledPluginsPath: string;
  /** 是否具备运行时编译能力（缺失时只用预编译产物）。 */
  private readonly hasRuntimeCompiler: boolean;

  public constructor(options: PluginCompilerOptions) {
    this.logger = options.logger;
    this.compiledPluginsPath = options.compiledPluginsPath;
    this.hasRuntimeCompiler = loadEsbuild() !== null;
    this.logger.debug('plugin compiler ready', {
      data: { runtimeEsbuild: this.hasRuntimeCompiler, compiledPluginsPath: options.compiledPluginsPath },
    });
  }

  public get supportsRuntimeCompile(): boolean {
    return this.hasRuntimeCompiler;
  }

  /** 某个插件是否存在预编译产物。 */
  public hasPrecompiled(id: string, pluginDir: string): string | null {
    // 优先按插件目录结构（与 plugins/ 镜像），其次按插件 id
    const relative = pluginDir.replace(/\\/g, '/').replace(/^.*\/plugins\//, '');
    const candidates = [
      join(this.compiledPluginsPath, relative, 'index.js'),
      join(this.compiledPluginsPath, id, 'index.js'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  public readPrecompiled(filePath: string): string | null {
    try {
      return readFileSync(filePath, 'utf8');
    } catch (error) {
      this.logger.error('reading precompiled plugin failed', { error: describeError(error), data: { filePath } });
      return null;
    }
  }

  /**
   * 运行时编译插件源码为自包含 CommonJS。
   * 没有 esbuild 时返回 null，由调用方回退到预编译产物。
   */
  public async bundle(options: BundlePluginOptions): Promise<string | null> {
    const esbuild = loadEsbuild();
    if (!esbuild) {
      this.logger.debug('esbuild unavailable; skipping runtime compile', { data: { id: options.id } });
      return null;
    }
    const result = await esbuild.build({
      entryPoints: [options.entryPath],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'neutral',
      target: 'chrome120',
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'silent',
      // 让插件只能用虚拟模块名访问 Plugin API，不打包任何外部依赖
      external: [...options.externalModules],
      absWorkingDir: options.workingDir,
    });
    const output = result.outputFiles?.[0];
    if (!output) {
      this.logger.error('esbuild produced no output', { data: { id: options.id } });
      return null;
    }
    return output.text;
  }
}

/** 供 main 进程判定：某个路径是否位于 dist/plugins 下（避免误读源码）。 */
export function isCompiledPluginPath(compiledRoot: string, target: string): boolean {
  const root = resolve(compiledRoot);
  const candidate = resolve(target);
  return candidate === root || candidate.startsWith(root + (process.platform === 'win32' ? '\\' : '/'));
}

export { dirname };
