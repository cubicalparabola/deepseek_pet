/**
 * 运行期路径解析。
 *
 * 目录约定：
 * - 开发模式：assets/ 与 plugins/ 直接从仓库根目录读取；
 * - 打包模式：electron-builder 的 extraResources 把两者放到 resources/ 下。
 * 统一在 Main 进程解析一次，renderer / plugin 只能拿到结果，不能自己拼路径。
 *
 * 注意：本文件被 main 与 renderer 共同引用，因此**不能 import node:* 模块**。
 */

export interface PetConfig {
  /** 仓库根目录（开发）或 app 根目录（打包）。 */
  readonly appRoot: string;
  /** assets/ 绝对路径。 */
  readonly assetsPath: string;
  /** assets/config 绝对路径。 */
  readonly configPath: string;
  /** plugins/ 绝对路径。 */
  readonly pluginsPath: string;
  /** 已编译插件输出目录（dist/plugins）。 */
  readonly compiledPluginsPath: string;
  /** dist/ 绝对路径（main / preload / renderer 产物）。 */
  readonly distPath: string;
  /**
   * 设置窗口 preload 产物绝对路径。
   *
   * 与桌宠窗口是**同一个文件**（dist/preload/preload.js）：
   * preload 里用命令行参数 `--pet-window=settings` 区分角色，
   * 设置窗口只会拿到 `window.settingsAPI`（4 个方法），拿不到 `window.petAPI`。
   * 刻意不生成第二份产物 —— 少一个构建步骤，也少一处"两份桥不一致"的风险。
   */
  readonly settingsPreloadPath: string;
  /** 设置窗口页面绝对路径（dist/settings/index.html）。 */
  readonly settingsHtmlPath: string;
  /** 运行模式。 */
  readonly mode: 'development' | 'production';
}

/** 路径拼接（纯字符串实现，避免在共享层引入 node:path）。 */
export function joinPath(...segments: readonly string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment === '') continue;
    parts.push(segment.replace(/^[/\\]+|[/\\]+$/g, ''));
  }
  const joined = parts.join('/').replace(/\/{2,}/g, '/');
  // 保留 Windows 盘符（C:/...）与 UNC 前缀
  return joined;
}

/** 判断是否为绝对路径（Windows 盘符 / UNC / POSIX）。 */
export function isAbsolutePath(target: string): boolean {
  return /^[a-zA-Z]:[/\\]/.test(target) || target.startsWith('\\\\') || target.startsWith('/');
}

/**
 * 把相对路径解析到 root 之下，并阻止 `..` 越界。
 * 返回 null 表示该路径非法（插件/配置试图逃出白名单目录）。
 */
export function safeJoin(root: string, relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return null;
  if (isAbsolutePath(relativePath)) return null;
  const segments = relativePath.replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return null; // 试图逃出 root
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  const base = root.replace(/[/\\]+$/, '');
  return stack.length === 0 ? base : `${base}/${stack.join('/')}`;
}

/** 取路径最后一段（用于日志/展示）。 */
export function baseName(target: string): string {
  const normalized = target.replace(/[/\\]+$/, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export interface PetConfigInput {
  /** 应用根目录（开发：仓库根；打包：由 main 显式传入，见 resolveAppRoot）。 */
  readonly appRoot: string;
  /** 代码/产物根目录（打包时是 app.asar，开发时与 appRoot 相同）。 */
  readonly distRoot: string;
  /** 打包后 resources/ 的绝对路径；开发时忽略。 */
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly mode: 'development' | 'production';
}

/**
 * 解析“项目根目录”（开发模式的基准）。
 *
 * 为什么不直接用 `app.getAppPath()`：
 * 它取决于 Electron 的启动方式（`electron .` 得到项目根；
 * `electron tools/xxx.cjs` 会得到 tools/），作为路径基准并不可靠。
 * 注意：解析结果里不能把 `app.asar` 当成根（它本身是文件），
 * 因此 `looksLikeRoot` 会显式排除 `.asar`。
 *
 * 探测顺序：
 *   1. 源码布局：<root>/dist/main -> 上溯两级
 *   2. 打包布局：resources/app.asar/dist/main -> 上溯三级
 *   3. 标准场景：app.getAppPath()
 *   4. resources/ 的上一级
 *   5. 兜底：当前工作目录
 */
export function resolveAppRoot(candidates: {
  readonly mainDir: string;
  readonly appPath: string;
  readonly resourcesPath: string;
  readonly cwd: string;
  /** 目录存在性探测函数（由 Main 注入 fs.existsSync，保持本文件零 Node 依赖）。 */
  readonly exists: (target: string) => boolean;
}): string {
  const strip = (target: string): string => target.replace(/[/\\]+$/, '');

  const looksLikeRoot = (candidate: string): boolean => {
    if (!candidate) return false;
    const base = strip(candidate);
    // app.asar 是文件，不能作为根目录
    if (base.toLowerCase().endsWith('.asar')) return false;
    return candidates.exists(`${base}/package.json`) || candidates.exists(`${base}/assets`);
  };

  const up = (base: string, levels: number): string => {
    let current = strip(base);
    for (let index = 0; index < levels; index += 1) {
      const cut = Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\'));
      if (cut <= 0) break;
      current = current.slice(0, cut);
    }
    return current;
  };

  const fromMainDir2 = up(candidates.mainDir, 2);
  if (looksLikeRoot(fromMainDir2)) return fromMainDir2;
  const fromMainDir3 = up(candidates.mainDir, 3);
  if (looksLikeRoot(fromMainDir3)) return fromMainDir3;
  if (looksLikeRoot(candidates.appPath)) return strip(candidates.appPath);
  const fromResources = up(candidates.resourcesPath, 1);
  if (looksLikeRoot(fromResources)) return fromResources;

  return strip(candidates.cwd);
}

export function resolvePetConfig(input: PetConfigInput): PetConfig {
  // 素材与插件：打包后在 resources/ 下（extraResources），开发时在仓库根目录
  const resourceBase = input.isPackaged ? input.resourcesPath : input.appRoot;
  // 代码产物：打包后在 app.asar 内，开发时在 <root>/dist
  const distPath = joinPath(input.distRoot, 'dist');

  return {
    appRoot: input.appRoot,
    assetsPath: joinPath(resourceBase, 'assets'),
    configPath: joinPath(resourceBase, 'assets', 'config'),
    pluginsPath: joinPath(resourceBase, 'plugins'),
    // 预编译插件产物随代码一起打包（dist/plugins），因此基于 distRoot
    compiledPluginsPath: joinPath(distPath, 'plugins'),
    distPath,
    settingsPreloadPath: joinPath(distPath, 'preload', 'preload.js'),
    settingsHtmlPath: joinPath(distPath, 'settings', 'index.html'),
    mode: input.mode,
  };
}
