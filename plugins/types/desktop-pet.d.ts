/**
 * 插件类型垫片：让示例插件在 IDE 中获得完整类型提示。
 *
 * 运行时这个模块**不存在**：主进程用 esbuild 打包插件时把 `desktop-pet` 标记为 external，
 * 编译产物里的 `require('desktop-pet', ...)` 由 PluginHost 的 require shim 提供
 * （只返回 `definePlugin`，不暴露任何系统能力）。
 *
 * 因此插件作者只需要这一个 d.ts，不需要把主工程作为依赖安装。
 */

declare module 'desktop-pet' {
  /** 事件订阅句柄。 */
  export interface Subscription {
    unsubscribe(): void;
  }

  export interface LogFields {
    readonly module?: string;
    readonly event?: string;
    readonly error?: unknown;
    readonly data?: Record<string, unknown>;
  }

  export interface Logger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
  }

  /** 与主工程 src/shared 中的同名类型保持一致（结构兼容即可）。 */
  export interface AnimationDefinition {
    readonly id: string;
    readonly type: 'video' | 'image';
    readonly source: string;
    readonly loop?: boolean;
    readonly priority?: number;
    readonly interruptible?: boolean;
    readonly cooldown?: number;
    readonly tags?: readonly string[];
    readonly label?: string;
    readonly fallback?: boolean;
    readonly render?: {
      readonly className?: string;
      readonly scale?: number;
      readonly offsetX?: number;
      readonly offsetY?: number;
      readonly keying?: 'auto' | 'none' | 'luma' | 'screen';
    };
  }

  export type PetState = 'IDLE' | 'PLAYING' | 'SLEEPING' | 'BUSY';
  export type ActionSource = 'user' | 'behavior' | 'system' | 'ai-agent' | 'plugin' | (string & {});

  export interface PetAction {
    readonly type: 'animation' | 'state' | 'event';
    readonly target?: string;
    readonly animationId?: string;
    readonly priority?: number;
    readonly source?: ActionSource;
    readonly reason?: string;
    readonly interrupt?: 'auto' | 'force' | 'queue';
    readonly payload?: unknown;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }

  export interface ActionResult {
    readonly accepted: boolean;
    readonly type: 'animation' | 'state' | 'event';
    readonly rejection?: string;
    readonly animationId?: string;
    readonly state?: PetState;
    readonly detail?: string;
  }

  export interface PlayResult {
    readonly accepted: boolean;
    readonly animationId: string;
    readonly reason?: string;
    readonly queued?: boolean;
  }

  export interface PetClickPayload {
    readonly button: 'left' | 'middle' | 'right';
    readonly x: number;
    readonly y: number;
    /** 归一化坐标（0-1）。点击反应与点在哪无关（不再有"命中区域"）。 */
    readonly nx: number;
    readonly ny: number;
    readonly detail: number;
  }

  export interface AnimationEndPayload {
    readonly animationId: string;
    readonly reason?: string;
    readonly source?: string;
    readonly completed: boolean;
  }

  export interface StateChangePayload {
    readonly from: PetState;
    readonly to: PetState;
    readonly reason: string;
    readonly source?: string;
    readonly at: number;
  }

  /** 事件名 -> 负载（允许自定义事件名）。 */
  export interface PetEventMap {
    'pet:click': PetClickPayload;
    'pet:dblclick': PetClickPayload;
    'pet:pointer-enter': { readonly nx: number; readonly ny: number };
    'pet:pointer-move': { readonly nx: number; readonly ny: number };
    'pet:pointer-leave': { readonly nx: number; readonly ny: number };
    'pet:drag': { readonly phase: 'start' | 'move' | 'end'; readonly screenX: number; readonly screenY: number };
    'animation:request': { readonly animationId: string; readonly priority?: number };
    'animation:start': { readonly animationId: string; readonly priority: number; readonly loop: boolean };
    'animation:end': AnimationEndPayload;
    'animation:rejected': { readonly animationId: string; readonly rejection: string };
    'state:change': StateChangePayload;
    'action:received': { readonly type: string; readonly source: string };
    'action:rejected': { readonly type: string; readonly rejection: string };
    'plugin:loaded': { readonly pluginId: string };
    'plugin:activated': { readonly pluginId: string; readonly name?: string; readonly version?: string };
    'plugin:deactivated': { readonly pluginId: string };
    'behavior:triggered': { readonly animationId: string; readonly reason: string };
    'behavior:paused': { readonly paused: boolean };
    'app:ready': { readonly version: string; readonly animations: number; readonly plugins: number };
  }

  export type PetEventName = keyof PetEventMap | (string & {});
  export type PetEventPayload<K extends PetEventName> = K extends keyof PetEventMap
    ? PetEventMap[K]
    : Record<string, unknown>;

  export interface PluginEventAPI {
    on<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): Subscription;
    once<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): Subscription;
    off<K extends PetEventName>(event: K, handler: (payload: PetEventPayload<K>) => void): void;
    emit<K extends PetEventName>(event: K, payload?: PetEventPayload<K>): void;
  }

  export interface PluginAnimationOptions {
    readonly priority?: number;
    readonly interrupt?: 'auto' | 'force' | 'queue';
    readonly reason?: string;
  }

  export interface PluginAnimationAPI {
    play(animationId: string, options?: PluginAnimationOptions): Promise<PlayResult>;
    stop(): void;
    isPlaying(): boolean;
    getCurrent(): string | null;
    getDefinition(animationId: string): AnimationDefinition | null;
    list(): readonly string[];
    register(definition: AnimationDefinition): void;
  }

  export interface PluginStateAPI {
    get(): PetState;
    is(state: PetState): boolean;
    onChange(handler: (change: { from: PetState; to: PetState; reason: string }) => void): Subscription;
    list(): readonly PetState[];
  }

  export interface PluginStorageAPI {
    get<T>(key: string, fallback?: T): T | undefined;
    set<T>(key: string, value: T): void;
    remove(key: string): void;
    keys(): readonly string[];
  }

  export interface PluginBehaviorAPI {
    pause(): void;
    resume(): void;
    isPaused(): boolean;
  }

  export interface PluginSystemAPI {
    getVersion(): Promise<string>;
    getPlatform(): string;
    showNotification(title: string, body: string): void;
    log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
    /** 用系统默认浏览器打开 http(s) 链接（权限 `ui`）。 */
    openExternal(url: string): Promise<boolean>;
  }

  export interface PluginActionAPI {
    execute(action: PetAction): Promise<ActionResult>;
  }

  /* ------------------------------------------------------------------ */
  /* 系统能力（全部要在 package.json 的 permissions 里声明）                 */
  /* ------------------------------------------------------------------ */

  /** 插件可申请的权限：`net` / `process` / `python` / `notify` / `ui` / `mail`。 */
  export type PluginPermission = 'net' | 'process' | 'python' | 'notify' | 'ui' | 'mail';

  export interface PluginLifecycleAPI {
    /** 实际生效的权限（已按 `assets/config/plugins.json` 收窄）。 */
    readonly permissions: readonly PluginPermission[];
    has(permission: PluginPermission): boolean;
    /** 登记停用回调：插件被关掉时宿主会按登记顺序调用它们。 */
    onDispose(dispose: () => void): Subscription;
  }

  export interface PluginTimerHandle {
    readonly id: string;
    cancel(): void;
  }

  /**
   * 定时器（由**主进程**计时）。
   *
   * 为什么不用 `setTimeout`：隐藏/后台窗口的定时器会被 Chromium 降频到分钟级，
   * 番茄钟这类"到点必须准"的插件会失准；而且停用插件时主进程能直接清表。
   */
  export interface PluginTimerAPI {
    after(ms: number, handler: () => void): PluginTimerHandle;
    every(ms: number, handler: () => void): PluginTimerHandle;
    cancel(id: string): void;
  }

  export interface PluginNetRequest {
    readonly url: string;
    readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly timeoutMs?: number;
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

  export interface PluginNetJsonResult<T> {
    readonly ok: boolean;
    readonly status: number;
    readonly data: T | null;
    readonly truncated: boolean;
    readonly error?: string;
  }

  /** 网络（权限 `net`）：渲染层 CSP 不允许联网，请求由主进程代发。 */
  export interface PluginNetAPI {
    request(request: PluginNetRequest): Promise<PluginNetResponse>;
    json<T = unknown>(request: PluginNetRequest): Promise<PluginNetJsonResult<T>>;
  }

  export interface PluginProcessRequest {
    readonly command: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly env?: Readonly<Record<string, string>>;
  }

  export interface PluginProcessResult {
    readonly ok: boolean;
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly truncated: boolean;
    readonly error?: string;
  }

  /** 本机命令（权限 `process`）：`shell` 永远为 false，参数按数组传。 */
  export interface PluginProcessAPI {
    run(request: PluginProcessRequest): Promise<PluginProcessResult>;
    which(command: string): Promise<string | null>;
  }

  export interface PluginPythonRequest {
    readonly script?: string;
    readonly file?: string;
    readonly args?: readonly string[];
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }

  export interface PluginPythonInfo {
    readonly ok: boolean;
    readonly interpreter: string | null;
    readonly version: string | null;
    readonly error?: string;
  }

  /** Python（权限 `python`）：解释器按 python3 -> python -> py -3 探测。 */
  export interface PluginPythonAPI {
    available(): Promise<PluginPythonInfo>;
    run(request: PluginPythonRequest): Promise<PluginProcessResult>;
  }

  export interface PluginNotificationRequest {
    readonly title: string;
    readonly body: string;
    readonly silent?: boolean;
    readonly id?: string;
  }

  /** 系统通知（权限 `notify`）。 */
  export interface PluginNotifyAPI {
    send(request: PluginNotificationRequest): Promise<boolean>;
    onClick(handler: (notificationId?: string) => void): Subscription;
  }

  /* --------------------- 投递：往「交互」收件箱放东西（权限 mail） --------------------- */

  /** 一个附件。内容是**字符串**（插件拿不到文件系统）。 */
  export interface PluginMailAttachment {
    readonly name: string;
    /** 文本（`utf8`，缺省）或二进制（`base64`）。 */
    readonly content: string;
    readonly encoding?: 'utf8' | 'base64';
  }

  export interface PluginMailRequest {
    /** 主题（最长 60 字）。 */
    readonly subject: string;
    /** 正文（可选，最长 2000 字）。 */
    readonly body?: string;
    /** 附件（最多 5 个，每个解码后 ≤ 4MB）。 */
    readonly attachments?: readonly PluginMailAttachment[];
  }

  export interface PluginMailResult {
    readonly ok: boolean;
    readonly messageId?: string;
    readonly files?: readonly { readonly name: string; readonly size: number }[];
    readonly error?: string;
  }

  /**
   * 收件箱投递：插件生成的文件（导出的清单、抓下来的 PDF、Python 画的图）
   * 连同一条说明交给「交互」收件箱 —— 用户在一个地方就能看到"谁给了什么"。
   *
   * 只投递、**不读**：插件拿不到收件箱里的内容。
   */
  export interface PluginMailAPI {
    send(request: PluginMailRequest): Promise<PluginMailResult>;
  }

  export interface PluginMenuItem {
    readonly id: string;
    readonly label: string;
    readonly hint?: string;
    readonly checked?: boolean;
  }

  export interface PluginPanelAction {
    readonly pluginId: string;
    readonly panelId: string;
    readonly actionId: string;
    readonly fields: Readonly<Record<string, string>>;
  }

  /**
   * 插件面板（渲染在聊天窗口的插件页签里）。
   *
   * 面板是**声明式**的：一段被净化的 HTML + `data-plugin-action="id"` 按钮 +
   * `data-plugin-field="name"` 输入控件。点一下就回调 `onAction`，
   * 返回新的 HTML 字符串即刷新面板。
   */
  export interface PluginPanel {
    readonly id: string;
    readonly title: string;
    readonly html: string;
    onAction?(action: Omit<PluginPanelAction, 'pluginId'>): string | void | Promise<string | void>;
  }

  /** 菜单项 / 面板 / 说话（权限 `ui`）。 */
  export interface PluginUIAPI {
    registerMenuItem(item: PluginMenuItem, handler: () => void): Subscription;
    updateMenuItem(itemId: string, patch: Partial<Omit<PluginMenuItem, 'id'>>): boolean;
    registerPanel(panel: PluginPanel): Subscription;
    updatePanel(panelId: string, patch: { html?: string; title?: string }): boolean;
    say(text: string): Promise<boolean>;
    openPanel(panelId: string): Promise<boolean>;
  }

  export interface PluginIdentity {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly description?: string;
    readonly author?: string;
  }

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
    readonly timers: PluginTimerAPI;
    readonly net: PluginNetAPI;
    readonly process: PluginProcessAPI;
    readonly python: PluginPythonAPI;
    readonly notify: PluginNotifyAPI;
    /** 往「交互」收件箱投递消息与文件（权限 `mail`）。 */
    readonly mail: PluginMailAPI;
    readonly ui: PluginUIAPI;
    readonly plugin: PluginIdentity;
    readonly pluginDir: string;
  }

  export interface PetPlugin {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly description?: string;
    readonly author?: string;
    activate(context: PluginContext): void | Promise<void>;
    deactivate?(): void | Promise<void>;
  }

  /** 定义插件（恒等函数，仅用于类型收窄与稳定导出）。 */
  export function definePlugin(plugin: PetPlugin): PetPlugin;

  const _default: { definePlugin: typeof definePlugin };
  export default _default;
}
