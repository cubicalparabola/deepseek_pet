/**
 * PluginManager —— Main 进程侧的插件宿主。
 *
 * 职责划分（关键架构决策）：
 * - Main 进程：**发现 / 读取元数据 / 编译 TS / 生命周期编排 / 日志隔离**；
 * - Renderer 进程：通过 PluginHost 真正执行插件代码（有 DOM、有 EventBus）。
 *
 * 这样做的原因：
 * 1. 插件需要访问 EventBus / AnimationManager / StateMachine，这些都在 Renderer；
 * 2. 插件绝不允许拿到 BrowserWindow / ipcMain / Node fs / process；
 * 3. Main 只通过 IPC 白名单把「编译后的代码字符串」交给 Renderer，
 *    Renderer 内的 PluginHost 用受控沙箱执行（见 renderer/core/plugin-host.ts）。
 *
 * 生命周期：discover -> load -> activate -> running -> deactivate -> unload
 * 接口：discoverPlugins / loadPlugin / activatePlugin / deactivatePlugin / reloadPlugin / getLoadedPlugins
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PetConfig } from '../shared/config';
import { safeJoin } from '../shared/config';
import type { Logger } from '../shared/logger';
import {
  describeError,
  serializeError,
} from '../shared/errors';
import type {
  DiscoveredPlugin,
  PluginManifest,
  PluginManifestEntry,
  PluginRecord,
  PluginStatus,
} from '../shared/plugin-types';
import type { PluginCodePayload } from '../shared/ipc';
import { PluginCompiler } from './plugin-compiler';

export interface PluginManagerOptions {
  readonly config: PetConfig;
  readonly logger: Logger;
}

const DEFAULT_ENTRY_CANDIDATES = [
  'index.js',
  'index.cjs',
  'index.mjs',
  'index.ts',
  'main.js',
  'main.ts',
  'src/index.ts',
  'src/index.js',
] as const;

const JS_EXTENSIONS = ['.js', '.cjs', '.mjs'] as const;
const TS_EXTENSIONS = ['.ts', '.mts', '.cts'] as const;

interface PluginEntryResolution {
  readonly relative: string;
  readonly absolute: string;
  readonly needsCompile: boolean;
}

/** 插件模块在 Renderer 中可 require 的虚拟模块名（避免打包进插件代码）。 */
const VIRTUAL_MODULES = ['desktop-pet', 'desktop-pet/api', '@desktop-pet/plugin-api'];

export class PluginManager {
  private readonly config: PetConfig;
  private readonly logger: Logger;
  /** 已发现但未加载的插件。 */
  private readonly discovered = new Map<string, DiscoveredPlugin>();
  /** 运行期记录（discover 后即存在，状态随生命周期变化）。 */
  private readonly records = new Map<string, PluginRecord>();
  /** 编译缓存（reload 时失效）。 */
  private readonly codeCache = new Map<string, PluginCodePayload>();
  /** 插件源码编译器（运行时 esbuild 或预编译产物）。 */
  private readonly compiler: PluginCompiler;

  public constructor(options: PluginManagerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.compiler = new PluginCompiler({
      logger: options.logger,
      compiledPluginsPath: options.config.compiledPluginsPath,
    });
  }

  /* ------------------------------------------------------------------ */
  /* 配置                                                                */
  /* ------------------------------------------------------------------ */

  /** 读取 assets/config/plugins.json；缺失或损坏时回落为空清单（不崩溃）。 */
  public readManifest(): PluginManifest {
    const file = join(this.config.configPath, 'plugins.json');
    if (!existsSync(file)) {
      this.logger.warn('plugins.json not found, no plugins will be loaded', { data: { file } });
      return { plugins: [] };
    }
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { plugins?: unknown }).plugins)) {
        throw new Error('顶层必须包含 plugins 数组');
      }
      const entries = (parsed as { plugins: unknown[] }).plugins;
      const result: PluginManifestEntry[] = [];
      const seen = new Set<string>();
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) {
          this.logger.warn('plugins.json: skipping non-object entry');
          continue;
        }
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (id === '') {
          this.logger.warn('plugins.json: skipping entry without id');
          continue;
        }
        if (seen.has(id)) {
          this.logger.warn('plugins.json: duplicate plugin id ignored', { data: { id } });
          continue;
        }
        seen.add(id);
        result.push({
          id,
          enabled: record.enabled !== false,
          ...(typeof record.path === 'string' ? { path: record.path } : {}),
        });
      }
      return { plugins: result };
    } catch (error) {
      this.logger.error('plugins.json parse failed; plugins disabled', { error: describeError(error), data: { file } });
      return { plugins: [] };
    }
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期：discover                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * 发现插件：只读取元数据，绝不执行插件代码。
   * 返回启用状态下的插件清单（按 plugins.json 顺序）。
   */
  public discoverPlugins(): readonly DiscoveredPlugin[] {
    this.discovered.clear();
    const manifest = this.readManifest();

    for (const entry of manifest.plugins) {
      this.records.set(entry.id, {
        id: entry.id,
        name: entry.id,
        version: '0.0.0',
        dir: entry.path ?? entry.id,
        enabled: entry.enabled !== false,
        status: 'discovered',
      });
      if (entry.enabled === false) {
        this.logger.info('plugin disabled by manifest', { data: { id: entry.id } });
        continue;
      }
      const plugin = this.inspectPlugin(entry);
      if (plugin) {
        this.discovered.set(plugin.id, plugin);
        this.records.set(plugin.id, {
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          dir: plugin.dir,
          enabled: true,
          status: 'discovered',
        });
      }
    }

    this.logger.info('plugin discovery finished', {
      data: { discovered: this.discovered.size, configured: manifest.plugins.length },
    });
    return [...this.discovered.values()];
  }

  /** 读取单个插件的 package.json + 入口文件信息。失败只记录，不抛出。 */
  private inspectPlugin(entry: PluginManifestEntry): DiscoveredPlugin | null {
    const relativeDir = entry.path ?? entry.id;
    const dir = safeJoin(this.config.pluginsPath, relativeDir);
    if (!dir) {
      this.logger.error('plugin path escapes plugins directory', { data: { id: entry.id, path: relativeDir } });
      return null;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      this.logger.error('plugin directory not found', { data: { id: entry.id, dir } });
      this.markFailed(entry.id, 'PLUGIN_NOT_FOUND', '插件目录不存在');
      return null;
    }

    const packageJson = this.readPluginPackageJson(dir);
    if (!packageJson) {
      this.markFailed(entry.id, 'PLUGIN_INVALID', 'package.json 缺失或格式错误');
      return null;
    }

    const entryResolution = this.resolveEntry(dir, packageJson.main);
    if (!entryResolution) {
      this.markFailed(entry.id, 'PLUGIN_INVALID', '找不到插件入口文件');
      return null;
    }

    const displayName = typeof packageJson.displayName === 'string'
      ? packageJson.displayName
      : typeof packageJson.name === 'string'
        ? packageJson.name
        : entry.id;

    return {
      id: entry.id,
      dir,
      name: displayName,
      version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
      ...(typeof packageJson.description === 'string' ? { description: packageJson.description } : {}),
      ...(typeof packageJson.author === 'string' ? { author: packageJson.author } : {}),
      enabled: true,
      entryPath: entryResolution.absolute,
      needsCompile: entryResolution.needsCompile,
    };
  }

  private readPluginPackageJson(dir: string): Record<string, unknown> | null {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch (error) {
      this.logger.error('plugin package.json parse failed', { error: describeError(error), data: { file } });
      return null;
    }
  }

  private resolveEntry(dir: string, mainField: unknown): PluginEntryResolution | null {
    const candidates: string[] = [];
    if (typeof mainField === 'string' && mainField.trim() !== '') candidates.push(mainField.trim());
    candidates.push(...DEFAULT_ENTRY_CANDIDATES);

    for (const candidate of candidates) {
      const absolute = safeJoin(dir, candidate);
      if (!absolute) continue;
      if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
      const lower = absolute.toLowerCase();
      const isTs = TS_EXTENSIONS.some((ext) => lower.endsWith(ext));
      const isJs = JS_EXTENSIONS.some((ext) => lower.endsWith(ext));
      if (!isTs && !isJs) continue;
      return { relative: candidate, absolute, needsCompile: isTs };
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期：load / activate / deactivate / reload                     */
  /* ------------------------------------------------------------------ */

  /**
   * 加载插件：返回可执行的 CommonJS 代码字符串。
   * 真正的模块实例化发生在 Renderer 的 PluginHost 中。
   *
   * 编译策略（两条路径产出格式一致，PluginHost 无需区分）：
   *   1. 优先运行时用 esbuild 编译（开发期，改完代码重载插件即可生效）；
   *   2. 无 esbuild（打包后）时回退到 dist/plugins 的预编译产物。
   */
  public async loadPlugin(id: string): Promise<PluginCodePayload | null> {
    const cached = this.codeCache.get(id);
    if (cached) return cached;

    const plugin = this.discovered.get(id);
    if (!plugin) {
      this.logger.error('loadPlugin: unknown plugin', { data: { id } });
      return null;
    }

    this.setStatus(id, 'loading');
    try {
      const code = await this.bundlePlugin(id, plugin);
      if (!code) {
        this.markFailed(id, 'PLUGIN_LOAD_FAILED', '插件代码不可用（无 esbuild 且缺少预编译产物）');
        return null;
      }
      const payload: PluginCodePayload = { id, code };
      this.codeCache.set(id, payload);
      this.setStatus(id, 'loaded');
      this.logger.info('plugin code loaded', { data: { id, bytes: code.length } });
      return payload;
    } catch (error) {
      const serialized = serializeError(error);
      this.markFailed(id, 'PLUGIN_LOAD_FAILED', serialized.message);
      this.logger.error('plugin load failed', { error, data: { id } });
      return null;
    }
  }

  /** 运行时编译优先，失败则回退预编译产物。 */
  private async bundlePlugin(id: string, plugin: DiscoveredPlugin): Promise<string | null> {
    if (this.compiler.supportsRuntimeCompile) {
      const code = await this.compiler.bundle({
        id,
        entryPath: plugin.entryPath,
        workingDir: plugin.dir,
        externalModules: VIRTUAL_MODULES,
      });
      if (code) return code;
    }

    const precompiled = this.compiler.hasPrecompiled(id, plugin.dir);
    if (precompiled) {
      this.logger.debug('using precompiled plugin bundle', { data: { id, precompiled } });
      return this.compiler.readPrecompiled(precompiled);
    }
    return null;
  }

  /** 标记插件进入 active（真正激活发生在 Renderer）。 */
  public activatePlugin(id: string): boolean {
    if (!this.discovered.has(id)) return false;
    this.setStatus(id, 'active');
    this.logger.info('plugin activated', { data: { id } });
    return true;
  }

  public deactivatePlugin(id: string): boolean {
    if (!this.records.has(id)) return false;
    this.setStatus(id, 'inactive');
    this.logger.info('plugin deactivated', { data: { id } });
    return true;
  }

  /** 卸载：清理编译缓存，允许重新加载。 */
  public unloadPlugin(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    this.codeCache.delete(id);
    if (record.enabled) this.setStatus(id, 'discovered');
    this.logger.info('plugin unloaded', { data: { id } });
    return true;
  }

  /** 重载：清缓存 -> 重新编译。由 Renderer 负责先 deactivate 再 activate。 */
  public async reloadPlugin(id: string): Promise<PluginCodePayload | null> {
    this.codeCache.delete(id);
    this.logger.info('plugin reload requested', { data: { id } });
    return this.loadPlugin(id);
  }

  public getLoadedPlugins(): readonly PluginRecord[] {
    return [...this.records.values()];
  }

  public getDiscoveredPlugin(id: string): DiscoveredPlugin | undefined {
    return this.discovered.get(id);
  }

  private setStatus(id: string, status: PluginStatus): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.set(id, { ...record, status, error: undefined });
  }

  private markFailed(id: string, code: string, message: string): void {
    const existing = this.records.get(id);
    const record: PluginRecord = {
      id,
      name: existing?.name ?? id,
      version: existing?.version ?? '0.0.0',
      dir: existing?.dir ?? id,
      enabled: existing?.enabled ?? true,
      status: 'failed',
      error: `${code}: ${message}`,
    };
    this.records.set(id, record);
  }
}
