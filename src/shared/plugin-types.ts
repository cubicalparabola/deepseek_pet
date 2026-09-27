/**
 * 插件系统契约。
 *
 * 安全边界（第一版即必须成立）：
 * 插件运行在 Renderer 的独立宿主（PluginHost）中，只能看到一个受控的
 * `PluginContext`，**不能**访问：
 *   BrowserWindow / ipcMain / Electron internals / Node.js fs / process / require
 * 任何系统能力都必须经由 Plugin API -> Action Pipeline / IPC 白名单完成。
 *
 * 系统能力一律**按权限声明**（见 `PluginPermission`）：
 * - 权限写在插件自己的 `package.json` 的 `permissions` 字段里（静态可读，不执行代码）；
 * - 用户可以在 `assets/config/plugins.json` 的 `permissions` 字段里**收窄**（只减不增）；
 * - Main 进程是唯一的执法点：没声明的权限，插件调用一律被拒绝并记日志。
 *
 * 插件异常由 PluginHost 逐插件隔离：单个插件抛错只记录日志并禁用该插件，
 * 绝不允许影响桌宠核心或其他插件。
 */

import type { Logger } from './logger';
import type { PetEventName, PetEventPayload, Subscription } from './events';
import type { PetState } from './state-types';
import type { PetAction, ActionResult } from './action-types';
import type {
  AnimationDefinition,
  InterruptPolicy,
  PlayResult,
} from './animation-types';

/* -------------------------------------------------------------------------- */
/* 权限                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 插件可申请的权限。
 *
 * | 权限 | 打开什么 | 谁用得上 |
 * | --- | --- | --- |
 * | `net` | `context.net`：由主进程代发的 HTTP(S) 请求 | 搜索网页 / 新闻 / 论文 / GitHub |
 * | `process` | `context.process`：启动本机命令 | 调用外部工具（ffmpeg、git…） |
 * | `python` | `context.python`：探测并运行 Python 解释器 | 调用 Python |
 * | `notify` | `context.notify`：系统通知 | 番茄钟 / TODO 提醒 / 新闻推送 |
 * | `ui` | `context.ui`：托盘菜单项、聊天窗口插件面板、"说一句话" | TODO / 课程表 / 番茄钟 |
 * | `mail` | `context.mail`：把消息与文件投递到「交互」收件箱 | 生成文件的插件（TODO 导出、课程表快照、Python 产物） |
 *
 * 设计取舍：权限是**粗粒度**的（一封就是一大块能力），因为它的目的不是
 * 精细配额，而是"这个插件到底要碰哪些系统东西"必须写在明面上、并且用户能一眼看到。
 */
export type PluginPermission = 'net' | 'process' | 'python' | 'notify' | 'ui' | 'mail';

/** 全部合法权限（顺序即 UI 展示顺序）。 */
export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'net',
  'process',
  'python',
  'notify',
  'ui',
  'mail',
];

/** 权限的中文说明（设置窗口直接展示给用户）。 */
export const PLUGIN_PERMISSION_LABELS: Readonly<Record<PluginPermission, string>> = {
  net: '联网（由主进程代发 HTTP 请求）',
  process: '启动本机命令',
  python: '调用 Python',
  notify: '发系统通知',
  ui: '界面（菜单项 / 面板 / 说话）',
  mail: '往「交互」收件箱投递消息与文件',
};

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

/** 把任意来源（package.json / plugins.json）的字段解析成权限数组（去重 + 过滤未知项）。 */
export function parsePluginPermissions(value: unknown): PluginPermission[] {
  if (!Array.isArray(value)) return [];
  const result: PluginPermission[] = [];
  for (const item of value) {
    if (!isPluginPermission(item)) continue;
    if (!result.includes(item)) result.push(item);
  }
  return PLUGIN_PERMISSIONS.filter((permission) => result.includes(permission));
}

/**
 * 收窄权限：`granted` 是用户给的额度（plugins.json），`declared` 是插件声明的。
 *
 * - `granted` 未配置（undefined）→ 完全按声明放行；
 * - `granted` 配置了 → 取交集（**只减不增**：用户给不出插件没声明的权限）。
 */
export function narrowPluginPermissions(
  declared: readonly PluginPermission[],
  granted?: readonly PluginPermission[] | undefined,
): PluginPermission[] {
  if (granted === undefined) return [...declared];
  return declared.filter((permission) => granted.includes(permission));
}

/* -------------------------------------------------------------------------- */
/* Plugin API 子接口                                                           */
/* -------------------------------------------------------------------------- */

/** 事件 API：插件与桌宠通信的唯一事件通道。 */
export interface PluginEventAPI {
  on<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): Subscription;
  once<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): Subscription;
  off<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): void;
  emit<K extends PetEventName>(event: K, payload?: PetEventPayload<K>): void;
}

/** 动画 API：插件唯一被允许的“播放手段”，内部走 Action Pipeline。 */
export interface PluginAnimationAPI {
  play(animationId: string, options?: PluginAnimationOptions): Promise<PlayResult>;
  stop(): void;
  isPlaying(): boolean;
  getCurrent(): string | null;
  /** 读取动画定义（含未注册的 Manifest 条目），用于插件做条件判断。 */
  getDefinition(animationId: string): AnimationDefinition | null;
  list(): readonly string[];
  /** 高级：注册临时动画（例如插件自带的 WebM）。 */
  register(definition: AnimationDefinition): void;
}

export interface PluginAnimationOptions {
  readonly priority?: number;
  readonly interrupt?: InterruptPolicy;
  readonly reason?: string;
}

/** 状态 API（只读）。插件不允许直接改状态，改状态必须走 Action。 */
export interface PluginStateAPI {
  get(): PetState;
  is(state: PetState): boolean;
  /** 订阅状态变化，返回取消订阅句柄。 */
  onChange(handler: (change: { from: PetState; to: PetState; reason: string }) => void): Subscription;
  /** 允许的状态名列表（便于 AI/插件生成合法取值）。 */
  list(): readonly PetState[];
}

/** 存储 API（Renderer 侧持久化，第一版用 localStorage，不引入数据库）。 */
export interface PluginStorageAPI {
  get<T>(key: string, fallback?: T): T | undefined;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
  keys(): readonly string[];
}

/** 行为 API：暂停/恢复自动行为，供插件与托盘菜单使用。 */
export interface PluginBehaviorAPI {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}

/** 系统能力 API（白名单，全部通过 preload -> IPC）。 */
export interface PluginSystemAPI {
  getVersion(): Promise<string>;
  getPlatform(): string;
  showNotification(title: string, body: string): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /**
   * 用系统默认浏览器打开一个 http(s) 链接（权限 `ui`）。
   *
   * 面板里的 `<a href>` 由宿主自动走这条路径（动作 id 是保留的 `@open-external`），
   * 因此插件不需要为"点开一个 issue / 一篇论文"写额外代码。
   */
  openExternal(url: string): Promise<boolean>;
}

/** Action API：与 AI Agent 共用同一条 Pipeline。 */
export interface PluginActionAPI {
  execute(action: PetAction): Promise<ActionResult>;
}

/* -------------------------------------------------------------------------- */
/* 生命周期：停用即回收                                                          */
/* -------------------------------------------------------------------------- */

/** 定时器句柄。插件被停用时，宿主会取消该插件**全部**未触发的定时器。 */
export interface PluginTimerHandle {
  readonly id: string;
  cancel(): void;
}

/**
 * 定时器 API（**由主进程计时的定时器**）。
 *
 * 为什么不用渲染层的 `setTimeout`：Chromium 会把后台/隐藏窗口的定时器降频到
 * 分钟级，番茄钟、新闻轮询这类"到点必须准"的插件会因此失准；而且插件被停用时
 * 渲染层的裸定时器没人能替你清干净。因此定时器由 Main 持有（`plugin-runtime`），
 * 到点通过 IPC 把 tick 送回渲染层执行；停用插件时 Main 直接清表。
 */
export interface PluginTimerAPI {
  /** 一次性定时器（毫秒，最小 200ms）。 */
  after(ms: number, handler: () => void): PluginTimerHandle;
  /** 周期定时器。间隔不会叠加：上一次 handler 还没跑完也不会堆积。 */
  every(ms: number, handler: () => void): PluginTimerHandle;
  cancel(id: string): void;
}

/**
 * 生命周期 API：把"停用时需要收尾的东西"交给宿主。
 *
 * 停用插件时 PluginHost 会依次：退订事件订阅 → 取消定时器 → 面板与菜单项下线 →
 * 跑 `onDispose()` 回调 → 调 `deactivate()`。因此插件自己开的文件句柄、
 * 在别的窗口里挂的东西，只要在这里登记就能被回收。
 */
export interface PluginLifecycleAPI {
  /** 本插件**实际生效**的权限（已按 `plugins.json` 收窄）。 */
  readonly permissions: readonly PluginPermission[];
  /** 是否拿到某个权限（没拿到的 API 调用会被拒绝）。 */
  has(permission: PluginPermission): boolean;
  /** 登记一个停用回调（返回取消登记句柄）。 */
  onDispose(dispose: () => void): Subscription;
}

/* -------------------------------------------------------------------------- */
/* 网络：主进程代发                                                            */
/* -------------------------------------------------------------------------- */

export interface PluginNetRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** 超时（毫秒，默认 15000，上限 60000）。 */
  readonly timeoutMs?: number;
  /** 响应体上限（字节，默认 2MB，上限 8MB）；超出部分截断并置 `truncated`。 */
  readonly maxBytes?: number;
}

export interface PluginNetResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly truncated: boolean;
  readonly error?: string;
}

/** 网络 API（权限 `net`）。渲染层 CSP 是 `connect-src 'none'`，所以只能走主进程。 */
export interface PluginNetAPI {
  request(request: PluginNetRequest): Promise<PluginNetResponse>;
  /**
   * 便捷方法：请求并按 JSON 解析（解析失败时 `data` 为 null，`error` 说明原因）。
   * 失败**不抛**，插件可以当成"这一次没拿到数据"处理。
   */
  json<T = unknown>(request: PluginNetRequest): Promise<PluginNetJsonResult<T>>;
}

export interface PluginNetJsonResult<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly data: T | null;
  readonly truncated: boolean;
  readonly error?: string;
}

/* -------------------------------------------------------------------------- */
/* 进程 / Python                                                               */
/* -------------------------------------------------------------------------- */

export interface PluginProcessRequest {
  readonly command: string;
  readonly args?: readonly string[];
  /** 工作目录（默认：插件自己的目录）。相对路径按插件目录解析。 */
  readonly cwd?: string;
  readonly stdin?: string;
  /** 超时（毫秒，默认 20000，上限 300000）。超时会杀掉子进程。 */
  readonly timeoutMs?: number;
  /** 单路输出上限（字节，默认 256KB，上限 4MB）。 */
  readonly maxOutputBytes?: number;
  /** 追加/覆盖环境变量（与主进程环境合并）。 */
  readonly env?: Readonly<Record<string, string>>;
}

export interface PluginProcessResult {
  readonly ok: boolean;
  /** 退出码；被信号杀掉或启动失败时为 null。 */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly error?: string;
}

/** 进程 API（权限 `process`）。`shell` 永远为 false：参数按数组传递，不经过命令行解析。 */
export interface PluginProcessAPI {
  run(request: PluginProcessRequest): Promise<PluginProcessResult>;
  /** 探测命令是否存在（返回解析到的绝对路径或 null）。 */
  which(command: string): Promise<string | null>;
}

export interface PluginPythonRequest {
  /** 要执行的代码（与 `file` 二选一）。 */
  readonly script?: string;
  /** 相对**插件目录**的 .py 文件路径（与 `script` 二选一）。 */
  readonly file?: string;
  readonly args?: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface PluginPythonInfo {
  readonly ok: boolean;
  /** 实际使用的解释器路径。 */
  readonly interpreter: string | null;
  /** `python --version` 的第一行。 */
  readonly version: string | null;
  readonly error?: string;
}

/**
 * Python API（权限 `python`）。
 *
 * 解释器按 `python3` -> `python` -> `py -3` 的顺序探测一次并缓存；
 * 都没找到时 `available()` 的 `ok` 为 false，`run()` 返回带 `error` 的结果
 * （插件应当据此给出"这台机器没装 Python"的提示，而不是静默失败）。
 */
export interface PluginPythonAPI {
  available(): Promise<PluginPythonInfo>;
  run(request: PluginPythonRequest): Promise<PluginProcessResult>;
}

/* -------------------------------------------------------------------------- */
/* 投递：往「交互」收件箱放消息与文件（权限 mail）                                 */
/* -------------------------------------------------------------------------- */

/**
 * 一个附件。**内容直接在请求里**（插件拿不到文件系统，只能把内容交上来）。
 *
 * `encoding` 缺省 `utf8`（文本）；二进制（Python 生成的 PNG、导出的 xlsx…）
 * 用 `base64`。上限见 `PluginMailLimits`。
 */
export interface PluginMailAttachment {
  /** 文件名（会被清洗成安全文件名；同名会覆盖上一次的同名附件）。 */
  readonly name: string;
  readonly content: string;
  readonly encoding?: 'utf8' | 'base64';
}

/** 投递一封"邮件"到收件箱。 */
export interface PluginMailRequest {
  /** 主题（列表上那一行，最长 60 字）。 */
  readonly subject: string;
  /** 正文（可选，最长 2000 字）。 */
  readonly body?: string;
  /** 附件（最多 5 个，每个解码后不超过 4MB）。 */
  readonly attachments?: readonly PluginMailAttachment[];
}

export interface PluginMailResult {
  readonly ok: boolean;
  /** 存进来之后的消息 id（可以再交给 `ui.openPanel` 之类做提示）。 */
  readonly messageId?: string;
  /** 实际存下来的附件（名字可能与请求里的不同 —— 被清洗过）。 */
  readonly files?: readonly { readonly name: string; readonly size: number }[];
  /** 失败或部分失败的原因（可直接展示）。 */
  readonly error?: string;
}

/**
 * 收件箱投递（权限 `mail`）。
 *
 * 用途（需求）："宠物可能在插件中生成文件然后保存到这里" —— 插件把生成的东西
 * （导出的清单、抓下来的论文 PDF、Python 画出来的图表）连同一条说明一起交给
 * 「交互」收件箱，用户在一个地方就能看到"谁给了什么"。
 *
 * 只投递、**不读**：插件拿不到收件箱里的内容（最小权限）。将来要读再加。
 */
export interface PluginMailAPI {
  send(request: PluginMailRequest): Promise<PluginMailResult>;
}

/* -------------------------------------------------------------------------- */
/* 通知                                                                        */
/* -------------------------------------------------------------------------- */

export interface PluginNotificationRequest {
  readonly title: string;
  readonly body: string;
  readonly silent?: boolean;
  /** 同 id 的通知在部分平台上会被合并更新（番茄钟"同一个计时"用得上）。 */
  readonly id?: string;
}

/** 通知 API（权限 `notify`）：走系统通知，点一下就回调插件。 */
export interface PluginNotifyAPI {
  send(request: PluginNotificationRequest): Promise<boolean>;
  /**
   * 点通知的回调（权限 `notify`）。
   *
   * 番茄钟"到点了点一下就开始下一轮"、TODO"点通知跳回清单"都靠它。
   * 回调在插件被停用后不会再触发（宿主会连同其它资源一起回收）。
   */
  onClick(handler: (notificationId?: string) => void): Subscription;
}

/* -------------------------------------------------------------------------- */
/* 界面：菜单项 / 面板 / 说话                                                    */
/* -------------------------------------------------------------------------- */

/** 插件注册的托盘/右键菜单项（挂在「插件」子菜单里，按插件分组）。 */
export interface PluginMenuItem {
  readonly id: string;
  readonly label: string;
  /** 次要说明（原生菜单的 sublabel）。 */
  readonly hint?: string;
  /** 复选状态（番茄钟"正在计时"这类开关用得上）。 */
  readonly checked?: boolean;
}

/** 面板里的一个动作（由 `data-plugin-action="add"` 触发）。 */
export interface PluginPanelAction {
  readonly pluginId: string;
  readonly panelId: string;
  readonly actionId: string;
  /** 面板里全部 `data-plugin-field="name"` 控件的当前值。 */
  readonly fields: Readonly<Record<string, string>>;
}

/** 插件面板：一段（被净化过的）HTML + 一个动作回调。 */
export interface PluginPanel {
  readonly id: string;
  readonly title: string;
  readonly html: string;
  /**
   * 面板里点了 `data-plugin-action` 就回调这里；
   * 返回新的 HTML 字符串则立即刷新面板（返回 void 表示不改动）。
   */
  onAction?(action: Omit<PluginPanelAction, 'pluginId'>): string | void | Promise<string | void>;
}

/** 下发给聊天窗口的面板快照（只带能渲染的东西，不带函数）。 */
export interface PluginPanelView {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly panelId: string;
  readonly title: string;
  readonly html: string;
  readonly updatedAt: number;
}

/** Main -> Renderer 的插件界面事件（菜单点击 / 通知点击 / 面板动作）。 */
export type PluginUIEvent =
  | { readonly kind: 'menu'; readonly pluginId: string; readonly itemId: string }
  | { readonly kind: 'notification'; readonly pluginId: string; readonly notificationId?: string }
  | {
      readonly kind: 'panel-action';
      readonly pluginId: string;
      readonly panelId: string;
      readonly actionId: string;
      readonly fields: Readonly<Record<string, string>>;
    };

/**
 * 界面 API（权限 `ui`）。
 *
 * 菜单项：注册后出现在托盘与桌宠右键菜单的「插件」子菜单里 —— 这是插件
 * "被用户主动叫起来"的入口（番茄钟开始/暂停、TODO 打开面板…）。
 * 面板：渲染在**聊天窗口**的插件页签里（普通窗口、可滚动、能打字），
 * 内容是一段被净化的 HTML + `data-plugin-action` 交互（**没有脚本**）。
 */
export interface PluginUIAPI {
  registerMenuItem(item: PluginMenuItem, handler: () => void): Subscription;
  /** 更新已注册菜单项（例如把 checked 改成"正在计时"）。 */
  updateMenuItem(itemId: string, patch: Partial<Omit<PluginMenuItem, 'id'>>): boolean;
  registerPanel(panel: PluginPanel): Subscription;
  /** 只更新面板内容（重渲染整个 HTML），返回是否命中。 */
  updatePanel(panelId: string, patch: { html?: string; title?: string }): boolean;
  /** 让桌宠说一句话（走对话气泡，不打断动画）。 */
  say(text: string): Promise<boolean>;
  /** 打开聊天窗口并切到本插件的某个面板。 */
  openPanel(panelId: string): Promise<boolean>;
}

/* -------------------------------------------------------------------------- */
/* 插件上下文                                                                   */
/* -------------------------------------------------------------------------- */

export interface PluginContext {
  readonly events: PluginEventAPI;
  readonly animations: PluginAnimationAPI;
  readonly state: PluginStateAPI;
  readonly logger: Logger;
  readonly storage: PluginStorageAPI;
  readonly behavior: PluginBehaviorAPI;
  readonly system: PluginSystemAPI;
  readonly actions: PluginActionAPI;
  /** 生命周期：权限查询 + 停用回调登记。 */
  readonly lifecycle: PluginLifecycleAPI;
  /** 主进程计时器（停用时自动清空）。 */
  readonly timers: PluginTimerAPI;
  /** HTTP(S) 请求（权限 `net`）。 */
  readonly net: PluginNetAPI;
  /** 本机命令（权限 `process`）。 */
  readonly process: PluginProcessAPI;
  /** Python（权限 `python`）。 */
  readonly python: PluginPythonAPI;
  /** 系统通知（权限 `notify`）。 */
  readonly notify: PluginNotifyAPI;
  /** 往「交互」收件箱投递消息与文件（权限 `mail`）。 */
  readonly mail: PluginMailAPI;
  /** 菜单项 / 面板 / 说话（权限 `ui`）。 */
  readonly ui: PluginUIAPI;
  /** 插件自身 id / name / version，便于日志与存储 key 前缀。 */
  readonly plugin: PluginIdentity;
  /** 插件目录标识（相对 plugins/ 的路径），只读字符串，不是文件系统句柄。 */
  readonly pluginDir: string;
}

/* -------------------------------------------------------------------------- */
/* 插件定义                                                                    */
/* -------------------------------------------------------------------------- */

export interface PluginIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
}

export interface PetPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  /** 兼容 loader 的静态元数据（未提供时使用 PetPlugin 的字段）。 */
  readonly manifest?: PluginIdentity;
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/**
 * 插件生命周期状态。
 *
 * `disabled` 是"用户在配置里关掉了它"——与 `inactive`（曾经激活、现在停了）区分开，
 * 前者根本没被加载过，后者是运行期停下来的。
 */
export type PluginStatus =
  | 'discovered'
  | 'loading'
  | 'loaded'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'inactive'
  | 'disabled'
  | 'failed';

export interface PluginRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly enabled: boolean;
  readonly status: PluginStatus;
  readonly error?: string;
  readonly activatedAt?: number;
  /** 实际生效的权限（声明 ∩ 用户额度）。 */
  readonly permissions?: readonly PluginPermission[];
  /** 插件自己声明的权限（用于向用户解释"它想要什么"）。 */
  readonly declaredPermissions?: readonly PluginPermission[];
  /**
   * 是否**可卸载**（能从磁盘上安全删除）。
   *
   * 判据是"目录就是 plugins/ 根下的一个独立目录"：`plugins/examples/*` 这类
   * 随程序一起发布的内置示例为 false —— 卸掉它们会破坏随包内容，
   * 而用户自己安装进来的插件才应该能一键卸掉。
   */
  readonly removable?: boolean;
}

/* -------------------------------------------------------------------------- */
/* 安装 / 卸载                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 安装或卸载的结果。
 *
 * 一律返回**卸载/安装后的完整清单**（而不是只回一个 ok）：界面据此重画，
 * 不需要再拉一次列表 —— 少一次往返，也少一次"清单与界面不一致"的机会。
 */
export interface PluginInstallResult {
  readonly ok: boolean;
  /** 安装成功时的插件 id（卸载时是卸掉的那个 id）。 */
  readonly id?: string;
  /** 失败原因（可直接展示给用户）。 */
  readonly error?: string;
  readonly records: readonly PluginRecord[];
}

/* -------------------------------------------------------------------------- */
/* 插件 Manifest                                                               */
/* -------------------------------------------------------------------------- */

/** `assets/config/plugins.json` 的单条记录。 */
export interface PluginManifestEntry {
  readonly id: string;
  readonly enabled?: boolean;
  /** 可选：覆盖插件目录（默认 plugins/<id>）。 */
  readonly path?: string;
  /**
   * 可选：**用户额度**（只减不增）。省略 = 完全按插件声明放行；
   * 写了 = 取交集，可以用来"给插件留着但先不给它联网"。
   */
  readonly permissions?: readonly PluginPermission[];
}

export interface PluginManifest {
  readonly plugins: readonly PluginManifestEntry[];
}

/* -------------------------------------------------------------------------- */
/* 静态分析结果（Main 进程只做发现与读取，不执行插件逻辑）                        */
/* -------------------------------------------------------------------------- */

export interface DiscoveredPlugin {
  readonly id: string;
  readonly dir: string;
  /** 主进程解析 package.json 得到的元数据（不含任何可执行代码）。 */
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly enabled: boolean;
  /** 插件入口的源文件绝对路径（可能是 index.js 或 index.ts）。 */
  readonly entryPath: string;
  /** 入口是否需要先编译（.ts -> .js）。 */
  readonly needsCompile: boolean;
  /** 实际生效的权限（`package.json` 声明 ∩ `plugins.json` 额度）。 */
  readonly permissions: readonly PluginPermission[];
  /** 插件声明的权限（未收窄），用于日志与界面解释。 */
  readonly declaredPermissions: readonly PluginPermission[];
}
