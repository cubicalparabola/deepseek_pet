/**
 * PluginInstaller —— 插件的安装与卸载（**唯一**会动插件目录的地方）。
 *
 * 职责边界：
 * - `PluginManager` 只负责"读"（发现、编译、清单读写）；
 * - 这里负责"写"：把用户挑中的插件文件夹复制进 `plugins/<id>/`，以及把它整个删掉。
 *
 * 为什么安装是"复制目录"而不是"运行安装脚本"：
 * 插件是纯前端代码（一个入口 + 若干资源），没有任何需要构建的依赖树。
 * 复制最可解释：装完之后用户能在文件管理器里看到它、能手工改、也能随时删掉。
 *
 * 四条安全约束（都是"别让一次误操作破坏别的东西"）：
 * 1. **先校验再复制**：源目录必须有 `package.json` 且入口能解析出来，
 *    否则用户挑了 `C:\` 这种目录也会被当成插件；
 * 2. **规模上限**：文件数 2000 / 总体积 64MB 以上直接拒绝（避免复制一整个盘）；
 * 3. **只删自己该删的**：卸载只允许删 `plugins/` **根下一层**的目录
 *    （`plugins/examples/*` 这类随包内置示例一律拒绝）；
 * 4. **不复制符号链接**：符号链接可能指向插件目录之外，复制过去等于留一个后门。
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { PetConfig } from '../shared/config';
import { baseName, safeJoin } from '../shared/config';
import { describeError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import type { PluginInstallResult, PluginManifestEntry, PluginRecord } from '../shared/plugin-types';
import { isRemovableDir, PLUGIN_ENTRY_CANDIDATES, type PluginManager } from './plugin-manager';

/** 一次安装允许复制的文件数 / 字节数上限（超过就说明用户挑错了目录）。 */
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** 一律不复制的东西：依赖树、版本库元数据、编辑器目录、Python 缓存。 */
const SKIP_NAMES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

export interface PluginInstallerOptions {
  readonly config: PetConfig;
  readonly logger: Logger;
  readonly plugins: PluginManager;
  /**
   * 卸载成功后清理这个插件留下的**数据**（`data/plugins/<id>/` 之类）。
   *
   * 与"删代码目录"分开：数据清理失败不该让卸载失败（代码已经删了，
   * 用户看到的插件已经消失），因此这个回调里的错误只记日志。
   */
  readonly purgeData?: (pluginId: string) => void;
}

/** 插件 id 的合法字符（它会变成目录名，必须挡住路径分隔符与 `..`）。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class PluginInstaller {
  private readonly options: PluginInstallerOptions;
  private readonly logger: Logger;

  public constructor(options: PluginInstallerOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /* ------------------------------------------------------------------ */
  /* 安装                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 安装一个插件目录。
   *
   * 目标目录已存在时：**只有"用户安装的"插件才允许覆盖**（相当于升级），
   * 内置示例（`plugins/examples/*`）不会被覆盖，避免用户无意间替换掉随包内容。
   */
  public install(sourceDirectory: string): PluginInstallResult {
    const records = (): readonly PluginRecord[] => this.options.plugins.getPluginRecords();
    const fail = (error: string): PluginInstallResult => {
      this.logger.warn('plugin install rejected', { data: { source: sourceDirectory, reason: error } });
      return { ok: false, error, records: records() };
    };

    const source = typeof sourceDirectory === 'string' ? sourceDirectory.trim() : '';
    if (source === '') return fail('没有选择插件文件夹');

    // 1. 源目录必须存在、是目录、且不在插件目录里面（否则等于自己复制自己）
    if (!existsSync(source)) return fail(`文件夹不存在：${source}`);
    let sourceStat;
    try {
      sourceStat = statSync(source);
    } catch (error) {
      return fail(`读不到这个文件夹：${describeError(error)}`);
    }
    if (!sourceStat.isDirectory()) return fail('请选择一个**文件夹**（插件目录），而不是单个文件');

    const pluginsRoot = this.options.config.pluginsPath.replace(/[/\\]+$/, '');
    const normalizedSource = source.replace(/\\/g, '/').replace(/[/\\]+$/, '');
    const normalizedRoot = pluginsRoot.replace(/\\/g, '/');
    if (normalizedSource === normalizedRoot) return fail('这就是插件目录本身，请选择某个插件文件夹');
    if (normalizedSource.startsWith(`${normalizedRoot}/`)) {
      return fail('这个文件夹已经在插件目录里了（不需要重复安装）');
    }

    // 2. 先校验"它到底是不是一个插件"，再决定 id
    const packageJson = this.readPackageJson(source);
    if (!packageJson.ok) return fail(packageJson.reason);

    const declaredId = typeof packageJson.value.name === 'string' ? packageJson.value.name.trim() : '';
    const id = declaredId !== '' ? declaredId : baseName(source);
    if (!ID_PATTERN.test(id)) {
      return fail(
        `插件 id 不合法：${id}（只允许字母数字与 . _ -，且以字母数字开头 —— 它会成为目录名）`,
      );
    }
    const entry = this.findEntry(source, packageJson.value.main);
    if (!entry) {
      return fail(`这个文件夹里没有找到插件入口（package.json 的 main，或 ${PLUGIN_ENTRY_CANDIDATES[0]}）`);
    }

    // 3. 规模上限（在复制前算，避免复制到一半才发现挑错了目录）
    const budget = this.measure(source);
    if (!budget.ok) return fail(budget.reason);

    // 4. 目标位置与冲突处理
    const dest = safeJoin(this.options.config.pluginsPath, id);
    if (!dest) return fail(`插件 id 会逃出插件目录：${id}`);
    const existingEntry = this.options.plugins.getManifestEntry(id);
    const existingDir = existsSync(dest);
    if (existingDir && (existingEntry === null || !isRemovableDir(existingEntry.path ?? existingEntry.id))) {
      return fail(`已经存在同名插件（plugins/${id}），它不是可以覆盖的安装目录`);
    }

    const upgrading = existingDir;
    try {
      if (existingDir) rmSync(dest, { recursive: true, force: true });
      cpSync(source, dest, { recursive: true, filter: (src) => this.shouldCopy(src) });
    } catch (error) {
      // 复制失败（权限、占用…）：把半截目录收掉，别留一个加载不起来的插件
      try {
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      } catch {
        // 清理失败只能算了：下面的错误信息更重要
      }
      return fail(`复制插件失败：${describeError(error)}`);
    }

    // 5. 登记（已存在则是升级：保留它原来的 enabled 与权限额度）
    if (!existingEntry) {
      const added = this.options.plugins.addManifestEntry({ id, path: id, enabled: true });
      if (!added.ok) {
        try {
          rmSync(dest, { recursive: true, force: true });
        } catch {
          /* 回滚失败：文件留着比清单指向不存在的目录好，反正下面会报错 */
        }
        return fail(added.reason ?? '写入 plugins.json 失败');
      }
    }

    // 6. 重新发现（让清单/记录与新目录一致）
    this.options.plugins.discoverPlugins();
    const record = this.options.plugins.getPluginRecord(id);
    this.logger.info('plugin installed', {
      data: {
        id,
        from: source,
        upgrading,
        version: record?.version ?? '0.0.0',
        permissions: (record?.declaredPermissions ?? []).join(',') || '(none)',
      },
    });
    return { ok: true, id, records: records() };
  }

  /* ------------------------------------------------------------------ */
  /* 卸载                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * 卸载一个插件：删掉它的目录 + 从清单移除。
   *
   * **调用方必须先把它停掉**（`setEnabled(id, false)`）：停用会连带
   * `PluginRuntime.revoke`（杀子进程、清定时器），否则 Windows 上
   * "子进程的工作目录还在这个文件夹里"会让删除直接失败。
   */
  public uninstall(pluginId: string): PluginInstallResult {
    const records = (): readonly PluginRecord[] => this.options.plugins.getPluginRecords();
    const fail = (error: string): PluginInstallResult => {
      this.logger.warn('plugin uninstall rejected', { data: { id: pluginId, reason: error } });
      return { ok: false, id: pluginId, error, records: records() };
    };

    const id = typeof pluginId === 'string' ? pluginId.trim() : '';
    if (id === '') return fail('缺少插件 id');

    const entry: PluginManifestEntry | null = this.options.plugins.getManifestEntry(id);
    const record = this.options.plugins.getPluginRecord(id);
    if (!entry && !record) return fail(`找不到插件：${id}`);

    const relativeDir = entry?.path ?? entry?.id ?? id;
    if (!isRemovableDir(relativeDir)) {
      return fail(
        `「${record?.name ?? id}」是随程序一起发布的内置插件（plugins/${relativeDir}），不能卸载`,
      );
    }
    const dir = safeJoin(this.options.config.pluginsPath, relativeDir);
    if (!dir) return fail(`插件目录不合法：${relativeDir}`);

    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      return fail(`删除插件目录失败：${describeError(error)}（它可能还在运行，先停用再试一次）`);
    }

    if (entry) {
      const removed = this.options.plugins.removeManifestEntry(id);
      if (!removed.ok) {
        // 目录已经删了但清单没改：这条记录会在下次发现时被清掉，但要明确报出来
        this.logger.error('plugin directory removed but manifest entry remained', {
          data: { id, reason: removed.reason ?? '' },
        });
      }
    }

    this.options.plugins.discoverPlugins();
    try {
      this.options.purgeData?.(id);
    } catch (error) {
      this.logger.warn('purging plugin data failed (ignored)', { error: describeError(error), data: { id } });
    }
    this.logger.info('plugin uninstalled', { data: { id, dir } });
    return { ok: true, id, records: records() };
  }

  /* ------------------------------------------------------------------ */
  /* 内部工具                                                            */
  /* ------------------------------------------------------------------ */

  private readPackageJson(dir: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) {
      return { ok: false, reason: '这个文件夹里没有 package.json，看起来不是一个插件（插件必须有 package.json）' };
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, reason: 'package.json 必须是一个 JSON 对象' };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch (error) {
      return { ok: false, reason: `package.json 解析失败：${describeError(error)}` };
    }
  }

  /** 与 PluginManager 用**同一份**候选表找入口（两边不一致会造成"装得进、起不来"）。 */
  private findEntry(dir: string, mainField: unknown): string | null {
    const candidates: string[] = [];
    if (typeof mainField === 'string' && mainField.trim() !== '') candidates.push(mainField.trim());
    candidates.push(...PLUGIN_ENTRY_CANDIDATES);
    for (const candidate of candidates) {
      const absolute = safeJoin(dir, candidate);
      if (!absolute) continue;
      if (!existsSync(absolute)) continue;
      try {
        if (statSync(absolute).isFile()) return absolute;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** 复制前的规模体检：文件数 / 总字节（超过上限说明用户很可能挑错了目录）。 */
  private measure(dir: string): { ok: true } | { ok: false; reason: string } {
    let files = 0;
    let bytes = 0;
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch (error) {
        return { ok: false, reason: `读不到目录内容：${describeError(error)}` };
      }
      for (const entry of entries) {
        if (SKIP_NAMES.has(entry.name)) continue;
        const full = join(current, entry.name);
        if (entry.isSymbolicLink()) continue; // 符号链接一律不复制（可能指向目录之外）
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        files += 1;
        try {
          bytes += statSync(full).size;
        } catch {
          continue;
        }
        if (files > MAX_FILES) return { ok: false, reason: `文件太多（超过 ${MAX_FILES} 个），这不像是一个插件` };
        if (bytes > MAX_TOTAL_BYTES) {
          return { ok: false, reason: `体积太大（超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB），这不像是一个插件` };
        }
      }
    }
    return { ok: true };
  }

  /** `cpSync` 的过滤器：跳过依赖树/版本库/编辑器目录与符号链接。 */
  private shouldCopy(src: string): boolean {
    if (SKIP_NAMES.has(baseName(src))) return false;
    try {
      if (lstatSync(src).isSymbolicLink()) return false;
    } catch {
      return false;
    }
    return true;
  }
}
