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

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PetConfig } from '../shared/config';
import { safeJoin } from '../shared/config';
import type { Logger } from '../shared/logger';
import {
  describeError,
  serializeError,
} from '../shared/errors';
import {
  narrowPluginPermissions,
  parsePluginPermissions,
  type DiscoveredPlugin,
  type PluginManifest,
  type PluginManifestEntry,
  type PluginPermission,
  type PluginRecord,
  type PluginStatus,
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

/**
 * 插件入口的候选文件名（安装时校验"这个目录到底是不是一个插件"也用它）。
 *
 * 导出是刻意的：安装器与发现器必须用**同一份**候选表 ——
 * 两边各写一份的话，会出现"安装时说这是插件、装进去却找不到入口"这种最难查的不一致。
 */
export const PLUGIN_ENTRY_CANDIDATES: readonly string[] = DEFAULT_ENTRY_CANDIDATES;

const JS_EXTENSIONS = ['.js', '.cjs', '.mjs'] as const;
const TS_EXTENSIONS = ['.ts', '.mts', '.cts'] as const;

interface PluginEntryResolution {
  readonly relative: string;
  readonly absolute: string;
  readonly needsCompile: boolean;
}

export interface PluginToggleResult {
  readonly ok: boolean;
  readonly reason?: string;
  /** 启停后的完整清单（含被关掉的插件，供界面展示）。 */
  readonly records: readonly PluginRecord[];
  /** 启用时：新发现的插件静态信息（要推给渲染层去加载）；停用时为 null。 */
  readonly entry: DiscoveredPlugin | null;
}

/**
 * 一个插件的目录能不能被"卸载"（整目录删掉）。
 *
 * 判据只有一条：它就在 `plugins/` **根下的一层**里。用相对路径判断而不是比绝对路径，
 * 是因为清单里的 `path` 本来就是相对 `plugins/` 的：
 *   `hello-plugin`          -> 可卸载（用户自己安装进来的都是这种）
 *   `examples/hello-plugin` -> 不可卸载（随程序发布的内置示例）
 */
export function isRemovableDir(relativeDir: string): boolean {
  const normalized = relativeDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return normalized !== '' && !normalized.includes('/') && normalized !== '.' && normalized !== '..';
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
          // 用户额度：写了就按交集放行（只减不增），没写就完全按插件声明放行
          ...(Array.isArray(record.permissions) ? { permissions: parsePluginPermissions(record.permissions) } : {}),
        });
      }
      return { plugins: result };
    } catch (error) {
      this.logger.error('plugins.json parse failed; plugins disabled', { error: describeError(error), data: { file } });
      return { plugins: [] };
    }
  }

  /* ------------------------------------------------------------------ */
  /* 配置：运行期启停（"插件可随时关闭"）                                  */
  /* ------------------------------------------------------------------ */

  /**
   * 运行期启用/停用一个插件。
   *
   * 顺序是刻意的：**先落盘，再发现**。
   * - 先落盘：用户点了开关就算数（`plugins.json` 立刻变），即使后面发现失败，
   *   重启后的状态也与用户的点击一致；
   * - 再发现：`discoverPlugins()` 是唯一读清单元数据的地方，重新跑一遍就得到
   *   新的"启用清单"，调用方据此把启用插件的静态信息推给渲染层去加载。
   *
   * 停用时**不删除**代码缓存：用户往往是"关一下看看"，再打开时不该重新编译。
   */
  public setPluginEnabled(id: string, enabled: boolean): PluginToggleResult {
    const written = this.writeManifestEnabled(id, enabled);
    if (!written.ok) {
      this.logger.error('plugin toggle not persisted', { data: { id, enabled, reason: written.reason } });
      return {
        ok: false,
        ...(written.reason !== undefined ? { reason: written.reason } : {}),
        records: this.getPluginRecords(),
        entry: null,
      };
    }

    const discovered = this.discoverPlugins();
    const entry = enabled ? (this.discovered.get(id) ?? null) : null;
    if (enabled && !entry) {
      // 登记了但目录/package.json 有问题：discoverPlugins 已把记录标成 failed
      this.logger.warn('plugin enabled but not discoverable', { data: { id, discovered: discovered.length } });
    }
    return { ok: true, records: this.getPluginRecords(), entry };
  }

  /** 把 `enabled` 写回 `assets/config/plugins.json`（保留其它字段，原子替换）。 */
  private writeManifestEnabled(id: string, enabled: boolean): { ok: boolean; reason?: string } {
    const file = join(this.config.configPath, 'plugins.json');
    if (!existsSync(file)) return { ok: false, reason: 'plugins.json 不存在' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      return { ok: false, reason: `plugins.json 解析失败：${describeError(error)}` };
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { plugins?: unknown }).plugins)) {
      return { ok: false, reason: 'plugins.json 缺少 plugins 数组' };
    }

    const container = parsed as Record<string, unknown> & { plugins: unknown[] };
    let found = false;
    for (const item of container.plugins) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (record.id !== id) continue;
      record.enabled = enabled;
      found = true;
    }
    if (!found) return { ok: false, reason: `plugins.json 里没有 id 为 ${id} 的条目` };

    // 原子写回（先写 tmp 再改名）：中途崩溃不会留下半截 JSON
    const temp = `${file}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(container, null, 2)}\n`, 'utf8');
      renameSync(temp, file);
    } catch (error) {
      return { ok: false, reason: describeError(error) };
    }
    this.logger.info('plugin enabled state persisted', { data: { id, enabled } });
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* 配置：安装 / 卸载（清单增删）                                          */
  /* ------------------------------------------------------------------ */

  /**
   * 往 `plugins.json` 里加一条（安装插件时调用；已存在则原样返回 false）。
   *
   * 与启停一样是"读原文件 -> 只改该改的 -> 原子替换"：`_comment` 之类的
   * 顶层字段必须原样保留，否则用户手写的注释会被程序吃掉。
   */
  public addManifestEntry(entry: PluginManifestEntry): { ok: boolean; reason?: string } {
    return this.patchManifest((container) => {
      const exists = container.plugins.some(
        (item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).id === entry.id,
      );
      if (exists) return { ok: false, reason: `plugins.json 里已经有 id 为 ${entry.id} 的条目` };
      container.plugins.push({
        id: entry.id,
        path: entry.path ?? entry.id,
        enabled: entry.enabled !== false,
        ...(entry.permissions ? { permissions: [...entry.permissions] } : {}),
      });
      return { ok: true };
    });
  }

  /** 从 `plugins.json` 里删掉一条（卸载插件时调用）。 */
  public removeManifestEntry(id: string): { ok: boolean; reason?: string } {
    return this.patchManifest((container) => {
      const index = container.plugins.findIndex(
        (item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).id === id,
      );
      if (index < 0) return { ok: false, reason: `plugins.json 里没有 id 为 ${id} 的条目` };
      container.plugins.splice(index, 1);
      return { ok: true };
    });
  }

  /** 读-改-原子写 `plugins.json`（安装/卸载/启停共用同一套写盘语义）。 */
  private patchManifest(
    patch: (container: { plugins: unknown[] } & Record<string, unknown>) => { ok: boolean; reason?: string },
  ): { ok: boolean; reason?: string } {
    const file = join(this.config.configPath, 'plugins.json');
    if (!existsSync(file)) return { ok: false, reason: 'plugins.json 不存在' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      return { ok: false, reason: `plugins.json 解析失败：${describeError(error)}` };
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { plugins?: unknown }).plugins)) {
      return { ok: false, reason: 'plugins.json 缺少 plugins 数组' };
    }

    const container = parsed as { plugins: unknown[] } & Record<string, unknown>;
    const result = patch(container);
    if (!result.ok) return result;

    const temp = `${file}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(container, null, 2)}\n`, 'utf8');
      renameSync(temp, file);
    } catch (error) {
      return { ok: false, reason: describeError(error) };
    }
    return { ok: true };
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
      if (entry.enabled === false) {
        /*
         * 被关掉的插件也要留下一条记录：设置窗口要靠它显示"这个插件是关着的"，
         * 否则用户关掉之后就再也看不到、也就没法再打开。
         * 状态用 `disabled`（与"曾经激活、现在停了"的 inactive 区分开）。
         */
        this.records.set(entry.id, {
          id: entry.id,
          name: entry.id,
          version: '0.0.0',
          dir: entry.path ?? entry.id,
          enabled: false,
          status: 'disabled',
          permissions: [],
          declaredPermissions: [],
          removable: isRemovableDir(entry.path ?? entry.id),
        });
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
          permissions: plugin.permissions,
          declaredPermissions: plugin.declaredPermissions,
          removable: isRemovableDir(entry.path ?? entry.id),
        });
      }
    }

    /*
     * 剪掉"已经不在清单里"的记录。
     *
     * 为什么必要：插件被删掉/从 plugins.json 移除后，旧记录如果留着，
     * 设置窗口与托盘菜单会继续显示一个并不存在的插件（点它还会报"找不到目录"）。
     */
    const configured = new Set(manifest.plugins.map((entry) => entry.id));
    for (const id of [...this.records.keys()]) {
      if (!configured.has(id)) this.records.delete(id);
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

    /*
     * 权限：插件在**自己的 package.json** 里声明（静态可读，不用先跑它的代码），
     * 用户在 `plugins.json` 里可以收窄（只减不增）。
     */
    const declaredPermissions = parsePluginPermissions(packageJson.permissions);

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
      permissions: narrowPluginPermissions(declaredPermissions, entry.permissions),
      declaredPermissions,
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

  /**
   * 让某个插件的编译产物失效（下一次取代码时重新编译）。
   *
   * 安装/覆盖安装之后必须调它：否则渲染层拿到的还是**旧代码** ——
   * 用户看到的是"装是装上了，行为一点没变"（实测最容易踩的就是这条缓存）。
   */
  public invalidatePluginCode(id: string): void {
    if (this.codeCache.delete(id)) {
      this.logger.info('plugin code cache invalidated', { data: { id } });
    }
  }

  public getLoadedPlugins(): readonly PluginRecord[] {
    return this.getPluginRecords();
  }

  /**
   * 全部插件记录（**含被用户关掉的**）。
   *
   * 语义上这是"清单"而不是"运行中"：设置窗口与托盘菜单都要靠它显示
   * "哪些能打开、哪些是关着的"，只给 active 的话用户就没法再打开关掉的插件。
   */
  public getPluginRecords(): readonly PluginRecord[] {
    return [...this.records.values()];
  }

  /** 单个插件记录（可能来自停用条目，因此不带代码信息）。 */
  public getPluginRecord(id: string): PluginRecord | undefined {
    return this.records.get(id);
  }

  /**
   * 清单里那条原始记录（安装/卸载要用它的 `path` 与 `enabled`）。
   *
   * 每次现读 `plugins.json`：这个文件的真相是磁盘上的文件（用户会手改），
   * 缓存一份在内存里就多一处"程序和用户看到的不一样"。
   */
  public getManifestEntry(id: string): PluginManifestEntry | null {
    return this.readManifest().plugins.find((entry) => entry.id === id) ?? null;
  }

  /**
   * 插件**实际生效**的权限（权限执法的唯一依据）。
   *
   * 停用的插件一律返回空数组：停用 = 权限全部收回，任何残留的异步回调
   * 再去调系统能力都会被 Main 拒绝。
   */
  public getEffectivePermissions(id: string): readonly PluginPermission[] {
    const record = this.records.get(id);
    if (!record || !record.enabled) return [];
    return record.permissions ?? [];
  }

  public getDiscoveredPlugin(id: string): DiscoveredPlugin | undefined {
    return this.discovered.get(id);
  }

  /**
   * 当前**启用且可发现**的插件清单（不重新扫描磁盘）。
   *
   * 与 `discoverPlugins()` 的区别：那个会重读配置、并把记录批量重置成 `discovered`
   * （于是渲染层上报的 active 状态会被抹掉）。启停单个插件之后只是要同步
   * bootstrap 里那份清单，用这个就够。
   */
  public getDiscoveredPlugins(): readonly DiscoveredPlugin[] {
    return [...this.discovered.values()];
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
