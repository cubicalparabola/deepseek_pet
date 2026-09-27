/**
 * 插件代码加载器（Renderer 沙箱）。
 *
 * 为什么不是 `new Function(code)`：
 * 页面 CSP 是 `script-src 'self' blob:`，**没有** `unsafe-eval`，
 * 所以 `new Function` / `eval` / `setTimeout('code')` 都会被 CSP 拒绝 —— 这正是我们想要的。
 *
 * 因此插件代码以 **blob ES module** 形式执行：
 *   1. Main 进程（PluginManager）把插件编译成自包含 CommonJS；
 *   2. 这里把 CJS 代码**直接内联进模块体**，并把 `module` / `exports` / `require` / `console`
 *      绑定到受控垫片上，最后 `export default module.exports`；
 *   3. `import(blobUrl)` 取回插件对象。
 *
 * 插件代码是模块体的一部分，由浏览器正常编译，因此不需要 eval。
 *
 * 安全边界（与 new Function 方案等价或更严）：
 * - 插件作用域内没有 Node 全局：`require` 只放行虚拟模块 `desktop-pet`；
 *   `process` / `global` / `module` / `exports` 都被声明为本地受控值；
 * - 没有 `window.petAPI` 之外的系统能力（插件拿不到 preload bridge）；
 * - 代码来自本机 plugins/ 目录，属于受信任的应用内容。
 *
 * 想彻底禁用插件代码执行？把 index.html 的 `script-src` 改回 `'self'` 即可，
 * 核心桌宠功能不受影响，只是插件系统停用。
 */

import type { PetPlugin } from '../../shared/plugin-types';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';
import * as pluginApi from './plugin-api';

/** 插件可 require 的虚拟模块名。 */
const VIRTUAL_MODULES: readonly string[] = [
  'desktop-pet',
  'desktop-pet/api',
  '@desktop-pet/plugin-api',
];

/** 临时挂在 globalThis 上的沙箱垫片（导入前后立即设置/清理）。 */
const SHIM_API = '__petPluginApiShim__';
const SHIM_CONSOLE = '__petPluginConsoleShim__';

type ShimGlobal = typeof globalThis & {
  [SHIM_API]?: () => unknown;
  [SHIM_CONSOLE]?: (level: 'debug' | 'info' | 'warn' | 'error', args: readonly unknown[]) => void;
};

export interface PluginCodeLoaderOptions {
  readonly logger: Logger;
}

export class PluginCodeLoader {
  private readonly logger: Logger;

  public constructor(options: PluginCodeLoaderOptions) {
    this.logger = options.logger;
  }

  /** 执行插件代码并取回插件对象；失败返回 null（调用方标记 failed），绝不向上抛。 */
  public async evaluate(pluginId: string, cjsCode: string): Promise<PetPlugin | null> {
    if (typeof cjsCode !== 'string' || cjsCode.trim() === '') {
      this.logger.error('plugin code is empty', { data: { pluginId } });
      return null;
    }
    try {
      const exportsObject = await this.loadModule(pluginId, cjsCode);
      const candidate = this.extractPlugin(exportsObject);
      if (!candidate) {
        this.logger.error('plugin did not export a valid object (need { id, name, version, activate })', {
          data: { pluginId },
        });
        return null;
      }
      return candidate;
    } catch (error) {
      this.logger.error('plugin code execution failed (isolated)', { error: describeError(error), data: { pluginId } });
      return null;
    }
  }

  private async loadModule(pluginId: string, cjsCode: string): Promise<unknown> {
    const globals = globalThis as ShimGlobal;
    globals[SHIM_API] = () => pluginApi;
    globals[SHIM_CONSOLE] = (level, args) => this.forwardConsole(pluginId, level, args);

    const source = this.buildModuleSource(pluginId, cjsCode);
    const blob = new Blob([source], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      const namespace = (await import(/* webpackIgnore: true */ url)) as { default?: unknown };
      return namespace.default;
    } finally {
      URL.revokeObjectURL(url);
      delete globals[SHIM_API];
      delete globals[SHIM_CONSOLE];
    }
  }

  /**
   * 构造内联模块源码：CJS 代码原样成为模块体，
   * `module` / `exports` / `require` / `console` 绑定到受控垫片。
   */
  private buildModuleSource(pluginId: string, cjsCode: string): string {
    // 防止插件代码里出现 </script> 造成 HTML 层注入
    const safeCode = cjsCode.replace(/<\/script/gi, '<\\/script');
    return [
      `/* eslint-disable */`,
      `/* 自动生成：桌宠插件沙箱模块（plugin: ${pluginId}）—— 请勿手工编辑 */`,
      `const __allowedModules = new Set(${JSON.stringify([...VIRTUAL_MODULES])});`,
      `const __apiShim = globalThis.${SHIM_API};`,
      `const __consoleShim = globalThis.${SHIM_CONSOLE};`,
      'const module = { exports: {} };',
      'const exports = module.exports;',
      'const require = (name) => {',
      '  if (__allowedModules.has(name)) return __apiShim();',
      `  throw new Error('插件 "${pluginId}" 试图 require("' + name + '")，但插件只能使用 Plugin API');`,
      '};',
      'const console = {',
      `  log: (...args) => __consoleShim('info', args),`,
      `  info: (...args) => __consoleShim('info', args),`,
      `  debug: (...args) => __consoleShim('debug', args),`,
      `  warn: (...args) => __consoleShim('warn', args),`,
      `  error: (...args) => __consoleShim('error', args),`,
      '};',
      /*
       * 沙箱：用**块级作用域 + let** 遮住全局名。
       *
       * ⚠️ 为什么不能声明在模块顶层：`const/var globalThis = undefined` 会连
       * **上面几行读取垫片**（`globalThis.__petPluginApiShim__`）一起挡掉 ——
       * 实测报 `Cannot access 'globalThis' before initialization`，插件全部加载失败。
       * 放进块里之后，垫片读取在块外完成，块内才遮蔽；用 `let` 而不是 `const`
       * 是为了让"插件自己写了个同名变量"不会变成 Assignment to constant variable。
       *
       * 为什么要遮这些名字：插件跑在桌宠页面里，如果它能随手碰 `window.petAPI`，
       * 那"权限声明"就是摆设（绕过 PluginContext 直接用桌宠的 IPC 面）。
       * CSP 的 `script-src 'self' blob:`（无 unsafe-eval）已经堵死 eval / new Function
       * 这类绕路，这里再遮住直接可用的全局名，插件的系统能力就只剩 PluginContext 一条路。
       * 需要界面？那正是 `context.ui`（托盘菜单项 + 聊天窗口插件面板）存在的理由。
       */
      '{',
      '  let process = undefined;',
      '  let global = undefined;',
      '  let Buffer = undefined;',
      '  let __filename = undefined;',
      '  let __dirname = undefined;',
      '  let window = undefined;',
      '  let self = undefined;',
      '  let globalThis = undefined;',
      '  let document = undefined;',
      '  let navigator = undefined;',
      '  let localStorage = undefined;',
      '  let sessionStorage = undefined;',
      '  let indexedDB = undefined;',
      '  let fetch = undefined;',
      '  let XMLHttpRequest = undefined;',
      '  let WebSocket = undefined;',
      '  let EventSource = undefined;',
      '  let Worker = undefined;',
      '  let SharedWorker = undefined;',
      '  let importScripts = undefined;',
      '  let postMessage = undefined;',
      /*
       * 有意**不**遮 `location` / `open` / `name` / `status` 这类名字：
       * 它们既可能被插件当成普通变量名（课程表里的"地点"就叫 location），
       * 又都被 Main 侧的导航拦截兜住了（`will-navigate` / `setWindowOpenHandler`）。
       * 遮蔽列表只放"真正构成提权"的名字，避免把插件写崩在语法上。
       */
      safeCode,
      '}',
      'export default module.exports;',
      '',
    ].join('\n');
  }

  private forwardConsole(
    pluginId: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    args: readonly unknown[],
  ): void {
    const message = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    this.logger[level](message, { module: `Plugin:${pluginId}` });
  }

  /** 兼容多种导出形式：module.exports = plugin / { default } / { plugin }。 */
  private extractPlugin(exportsObject: unknown): PetPlugin | null {
    const candidates: unknown[] = [exportsObject];
    if (exportsObject && typeof exportsObject === 'object') {
      const record = exportsObject as Record<string, unknown>;
      if ('default' in record) candidates.push(record.default);
      if ('plugin' in record) candidates.push(record.plugin);
    }
    for (const candidate of candidates) {
      if (this.isPetPlugin(candidate)) return candidate;
    }
    return null;
  }

  private isPetPlugin(value: unknown): value is PetPlugin {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return (
      typeof record.id === 'string' &&
      typeof record.name === 'string' &&
      typeof record.version === 'string' &&
      typeof record.activate === 'function'
    );
  }
}
