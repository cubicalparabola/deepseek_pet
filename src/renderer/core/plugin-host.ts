/**
 * PluginHost —— Renderer 侧的插件宿主（插件真正运行的地方）。
 *
 * 与 Main 侧 PluginManager 的分工：
 *   Main    : discover / 读元数据与权限 / 编译（esbuild 或预编译产物）/ 运行期能力 / 日志
 *   Renderer: 执行插件代码 + 提供受控 PluginContext + 隔离插件异常
 *
 * 沙箱约束（实现见 plugin-code-loader.ts）：
 * - 插件代码以 blob ES module 形式执行，**不使用** unsafe-eval（CSP 仍禁止 eval / new Function）；
 * - `require` 只放行虚拟模块 `desktop-pet`，`window` / `document` / `fetch` / `process` 等被显式屏蔽；
 * - 插件拿不到 fs / path / electron / BrowserWindow / ipcRenderer / window.petAPI；
 * - 想碰系统（联网、起进程、发通知、画界面）必须走 PluginContext，并在 package.json 里声明权限。
 *
 * **"插件可随时关闭"在这里的兑现方式**（`disablePlugin`）：
 *   退订事件 -> 取消全部定时器（含主进程持有的那些）-> 下线菜单项与面板
 *   -> 跑插件登记的 onDispose 回调 -> 调插件自己的 deactivate()
 * 任何一步抛错都只记日志，不影响其它插件与桌宠核心。
 *
 * 隔离策略：
 * - activate / deactivate 用 try/catch + 超时保护；
 * - 激活失败会回滚该插件的全部事件订阅并标记 failed，不影响桌宠与其他插件；
 * - 单个插件的事件 handler 抛错由 EventBus 统一捕获并记录来源。
 */

import type {
  DiscoveredPlugin,
  PetPlugin,
  PluginAnimationAPI,
  PluginAnimationOptions,
  PluginBehaviorAPI,
  PluginContext,
  PluginEventAPI,
  PluginIdentity,
  PluginLifecycleAPI,
  PluginMailAPI,
  PluginMailResult,
  PluginMenuItem,
  PluginNetAPI,
  PluginNetJsonResult,
  PluginNetRequest,
  PluginNetResponse,
  PluginNotifyAPI,
  PluginPanel,
  PluginPanelView,
  PluginPermission,
  PluginProcessAPI,
  PluginProcessRequest,
  PluginProcessResult,
  PluginPythonAPI,
  PluginPythonInfo,
  PluginPythonRequest,
  PluginRecord,
  PluginStateAPI,
  PluginStatus,
  PluginSystemAPI,
  PluginTimerAPI,
  PluginTimerHandle,
  PluginUIAPI,
  PluginUIEvent,
  PluginActionAPI,
} from '../../shared/plugin-types';
import type { Subscription } from '../../shared/events';
import type { PluginBridgeAPI } from '../../shared/ipc';
import type { AnimationDefinition, PlayRejectionReason } from '../../shared/animation-types';
import type { ActionRejectionReason } from '../../shared/action-types';
import type { PetState } from '../../shared/state-types';
import type { PetAction, ActionResult } from '../../shared/action-types';
import { PetError, describeError } from '../../shared/errors';
import { PetEvents } from '../../shared/events';
import type { Logger } from '../../shared/logger';
import { PluginCodeLoader } from './plugin-code-loader';
import { PluginStorage, purgePluginStorage } from './plugin-storage';
import type { EventBus } from './event-bus';

const ACTIVATE_TIMEOUT_MS = 5000;
const DEACTIVATE_TIMEOUT_MS = 3000;
/** 定时器的最小间隔（与 Main 侧一致：防止插件把自己变成忙循环）。 */
const MIN_TIMER_MS = 200;
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
/** 面板 HTML 上限（与 shared/plugin-panel-html.ts 的净化上限一致）。 */
const MAX_PANEL_HTML = 256 * 1024;

interface LoadedPlugin {
  readonly record: PluginRecord;
  readonly instance: PetPlugin;
  readonly subscriptions: Subscription[];
  /** 该插件实际生效的权限（激活时定下，停用即作废）。 */
  readonly permissions: readonly PluginPermission[];
}

interface TimerEntry {
  readonly kind: 'after' | 'every';
  readonly handler: () => void;
  readonly cancel: () => void;
}

interface MenuEntry {
  readonly item: PluginMenuItem;
  readonly handler: () => void;
}

/* -------------------------------------------------------------------------- */
/* 依赖端口（以接口注入，避免模块之间循环依赖）                                   */
/* -------------------------------------------------------------------------- */

export interface PluginAnimationPort {
  stop(reason?: string): void;
  isPlaying(): boolean;
  getCurrentAnimation(): string | null;
  getDefinition(animationId: string): AnimationDefinition | null;
  list(): readonly string[];
  registerAnimation(animation: AnimationDefinition): boolean;
}

export interface PluginStatePort {
  get(): PetState;
  is(state: PetState): boolean;
  list(): readonly PetState[];
}

export interface PluginBehaviorPort {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}

export interface ActionPortResult {
  readonly accepted: boolean;
  readonly rejection?: string;
  readonly animationId?: string;
  readonly state?: PetState;
  readonly detail?: string;
}

export interface PluginActionPort {
  execute(action: PetAction): Promise<ActionPortResult>;
}

export interface PluginRuntimePort {
  readonly version: string;
  readonly platform: string;
  /** 插件状态变化时同步给 Main（用于托盘菜单展示）。 */
  updatePluginRecords(records: readonly PluginRecord[]): void;
  notifyActivated(payload: { id: string; status: PluginStatus }): void;
  notifyDeactivated(payload: { id: string; status: PluginStatus }): void;
  /** 向 Main 索取已编译的插件代码。 */
  fetchPluginCode(id: string): Promise<{ readonly code: string } | null>;
}

export interface PluginHostOptions {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly state: PluginStatePort;
  readonly animations: PluginAnimationPort;
  readonly actions: PluginActionPort;
  readonly behaviors: PluginBehaviorPort;
  readonly runtime: PluginRuntimePort;
  /**
   * preload 的插件桥（启停 / 系统能力 / 界面贡献 / 事件订阅）。
   *
   * 允许为 null（preload 注入失败）：此时插件仍能加载与运行，
   * 只是所有需要过主进程的能力返回"不可用"，而不是让整个桌宠起不来。
   */
  readonly bridge: PluginBridgeAPI | null;
  /** 让桌宠说一句话（走对话气泡；`ui.say` 的落地点）。 */
  readonly say: (text: string) => void;
}

/* -------------------------------------------------------------------------- */

export class PluginHost {
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly stateMachine: PluginStatePort;
  private readonly animationManager: PluginAnimationPort;
  private readonly actionManager: PluginActionPort;
  private readonly behaviorManager: PluginBehaviorPort;
  private readonly runtime: PluginRuntimePort;
  private readonly bridge: PluginBridgeAPI | null;
  private readonly say: (text: string) => void;
  private readonly loader: PluginCodeLoader;
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly records = new Map<string, PluginRecord>();
  /** 停用回调（`lifecycle.onDispose`），按插件分组。 */
  private readonly disposables = new Map<string, Array<() => void>>();
  /** 定时器：pluginId -> timerId -> 条目（取消时既清 Main 的表也清本地表）。 */
  private readonly timers = new Map<string, Map<string, TimerEntry>>();
  /** 插件面板：pluginId -> panelId -> 面板定义（含动作回调）。 */
  private readonly panels = new Map<string, Map<string, PluginPanel>>();
  /** 插件菜单项：pluginId -> itemId -> 定义 + 点击回调。 */
  private readonly menuItems = new Map<string, Map<string, MenuEntry>>();
  /** 通知点击回调（`notify.onClick`）。 */
  private readonly notifyClicks = new Map<string, Array<(id?: string) => void>>();
  /** 每个插件的启停链（保证同一插件的 enable/disable 不会互相插队）。 */
  private readonly transitions = new Map<string, Promise<void>>();
  private timerSeq = 0;

  public constructor(options: PluginHostOptions) {
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.stateMachine = options.state;
    this.animationManager = options.animations;
    this.actionManager = options.actions;
    this.behaviorManager = options.behaviors;
    this.runtime = options.runtime;
    this.bridge = options.bridge;
    this.say = options.say;
    this.loader = new PluginCodeLoader({ logger: options.logger });
  }

  /* ------------------------------------------------------------------ */
  /* 批量装载                                                            */
  /* ------------------------------------------------------------------ */

  /** 从 Main 下发的插件清单加载并激活插件；单个插件失败不会中断循环。 */
  public async bootstrap(plugins: readonly DiscoveredPlugin[]): Promise<void> {
    this.logger.info('loading plugins', { data: { count: plugins.length } });
    for (const plugin of plugins) {
      await this.enablePlugin(plugin);
    }
    this.logger.info('plugins loaded', {
      data: {
        active: this.getLoadedPlugins().filter((record) => record.status === 'active').length,
        total: plugins.length,
      },
    });
  }

  /**
   * 启用（或重新启用）单个插件：取代码 -> 沙箱求值 -> activate。
   *
   * 运行期开关注解：用户可以在设置窗口或托盘菜单里把插件打开，
   * 走的正是这条路（不需要重启，也不需要"重载全部插件"）。
   */
  public async enablePlugin(entry: DiscoveredPlugin): Promise<boolean> {
    if (this.loaded.has(entry.id)) {
      this.logger.debug('plugin already loaded; skip enable', { data: { id: entry.id } });
      return true;
    }
    try {
      return await this.loadAndActivate(entry);
    } catch (error) {
      this.logger.error('plugin enable failed (isolated)', { error: describeError(error), data: { id: entry.id } });
      this.markRecord(entry.id, { status: 'failed', error: describeError(error) });
      return false;
    }
  }

  private async loadAndActivate(entry: DiscoveredPlugin): Promise<boolean> {
    const payload = await this.runtime.fetchPluginCode(entry.id);
    if (!payload) {
      this.markRecord(entry.id, { status: 'failed', error: '插件代码获取失败' });
      this.eventBus.emit(PetEvents.PluginError, {
        pluginId: entry.id,
        hook: 'load',
        message: '插件代码获取失败',
      });
      return false;
    }

    const instance = await this.loader.evaluate(entry.id, payload.code);
    if (!instance) {
      this.markRecord(entry.id, { status: 'failed', error: '插件入口未导出合法插件对象' });
      this.eventBus.emit(PetEvents.PluginError, {
        pluginId: entry.id,
        hook: 'evaluate',
        message: '插件入口未导出合法插件对象',
      });
      return false;
    }

    if (instance.id !== entry.id) {
      this.logger.warn('plugin declared id differs from directory id (directory wins)', {
        data: { declared: instance.id, expected: entry.id },
      });
    }

    const record: PluginRecord = {
      id: entry.id,
      name: instance.name || entry.name || entry.id,
      version: instance.version || entry.version || '0.0.0',
      dir: entry.dir,
      enabled: true,
      status: 'loaded',
      permissions: entry.permissions,
      declaredPermissions: entry.declaredPermissions,
    };
    this.records.set(entry.id, record);
    this.eventBus.emit(PetEvents.PluginLoaded, {
      pluginId: record.id,
      name: record.name,
      version: record.version,
    });

    return this.activate(instance, record);
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  /** 激活插件：注入 PluginContext，调用 activate()，并跟踪其全部订阅。 */
  public async activate(instance: PetPlugin, record: PluginRecord): Promise<boolean> {
    const subscriptions: Subscription[] = [];
    const permissions = record.permissions ?? [];
    const identity: PluginIdentity = {
      id: record.id,
      name: instance.name,
      version: instance.version,
      ...(instance.description !== undefined ? { description: instance.description } : {}),
      ...(instance.author !== undefined ? { author: instance.author } : {}),
    };

    const pluginLogger = this.createPluginLogger(record.id);
    const context = this.createContext(identity, record.dir, subscriptions, pluginLogger, permissions);

    this.markRecord(record.id, { status: 'activating' });
    try {
      await this.withTimeout(
        Promise.resolve(instance.activate(context)),
        ACTIVATE_TIMEOUT_MS,
        `插件 ${record.id} activate() 超时`,
      );
    } catch (error) {
      // 回滚订阅，避免半激活状态的插件继续影响桌宠
      this.disposeSubscriptions(subscriptions);
      this.releaseResources(record.id);
      const message = describeError(error);
      this.logger.error('plugin activate failed (isolated)', { error, data: { id: record.id } });
      this.markRecord(record.id, { status: 'failed', error: message });
      this.eventBus.emit(PetEvents.PluginError, { pluginId: record.id, hook: 'activate', message });
      return false;
    }

    this.loaded.set(record.id, { record, instance, subscriptions, permissions });
    this.markRecord(record.id, { status: 'active', permissions });
    this.logger.info(`activated ${record.id}`, {
      data: { name: record.name, version: record.version, permissions: permissions.join(',') || '(none)' },
    });
    this.eventBus.emit(PetEvents.PluginActivated, {
      pluginId: record.id,
      name: record.name,
      version: record.version,
    });
    this.runtime.notifyActivated({ id: record.id, status: 'active' });
    return true;
  }

  /**
   * 停用插件（"随时关闭"的核心实现）。
   *
   * 顺序：先退订事件（它最可能立刻再触发）-> 再回收定时器/菜单/面板/插件登记的回调
   * -> 最后才调 `deactivate()`（插件自己收尾时不该还能收到事件）。
   * 每一步都独立兜错：插件在 deactivate 里抛错也必须被完全回收。
   */
  public async deactivate(pluginId: string): Promise<boolean> {
    const entry = this.loaded.get(pluginId);
    if (!entry) {
      // 没加载过也要把残留资源清掉（例如 activate 失败留下的半截注册）
      this.releaseResources(pluginId);
      return false;
    }
    this.markRecord(pluginId, { status: 'deactivating' });
    this.disposeSubscriptions(entry.subscriptions);
    this.releaseResources(pluginId);

    try {
      await this.withTimeout(
        Promise.resolve(entry.instance.deactivate?.()),
        DEACTIVATE_TIMEOUT_MS,
        `插件 ${pluginId} deactivate() 超时`,
      );
    } catch (error) {
      this.logger.error('plugin deactivate threw (isolated)', { error, data: { id: pluginId } });
      this.eventBus.emit(PetEvents.PluginError, {
        pluginId,
        hook: 'deactivate',
        message: describeError(error),
      });
    }

    this.loaded.delete(pluginId);
    this.markRecord(pluginId, { status: 'inactive' });
    this.logger.info(`deactivated ${pluginId}`);
    this.eventBus.emit(PetEvents.PluginDeactivated, { pluginId });
    this.runtime.notifyDeactivated({ id: pluginId, status: 'inactive' });
    return true;
  }

  /**
   * 停用插件并把它从"清单"里也去掉（用户明确关掉了它）。
   *
   * 与 `deactivate` 的区别只在语义：这条是"用户关掉了插件"，
   * 状态记成 `inactive`，且必须把 Main 侧的面板/菜单贡献清空 ——
   * 否则关掉之后托盘里还留着它的菜单项，聊天窗口里还留着它的页签。
   */
  public async disablePlugin(pluginId: string): Promise<boolean> {
    const result = await this.deactivate(pluginId);
    this.pushContribution(pluginId);
    return result;
  }

  /** 重载全部插件（设置窗口 / 主进程指令触发）。 */
  public async reloadAll(entries: readonly DiscoveredPlugin[]): Promise<void> {
    this.logger.info('reloading all plugins');
    for (const id of [...this.loaded.keys()]) {
      await this.deactivate(id);
    }
    // 记录清空：被删掉/关掉的插件不该继续挂在清单里
    this.records.clear();
    await this.bootstrap(entries);
  }

  public getLoadedPlugins(): readonly PluginRecord[] {
    return [...this.records.values()];
  }

  public deactivateAll(): void {
    for (const [id, entry] of this.loaded) {
      this.disposeSubscriptions(entry.subscriptions);
      this.releaseResources(id);
      try {
        void entry.instance.deactivate?.();
      } catch (error) {
        this.logger.error('plugin deactivate failed', { error, data: { id } });
      }
    }
    this.loaded.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Main 指令：启停 / 界面事件 / 定时器                                   */
  /* ------------------------------------------------------------------ */

  /** Main 要求启用或停用某个插件（用户在设置窗口 / 托盘菜单点了开关）。 */
  public applyEnabledCommand(id: string, enabled: boolean, entry: DiscoveredPlugin | null): Promise<void> {
    /*
     * 同一个插件的启停**串行执行**。
     *
     * 为什么必须串行：activate/deactivate 都是异步的（要取代码、要跑插件回调），
     * 而"覆盖安装"会连着下发停用 + 启用两条指令 —— 不排队的话，启用那条会在
     * 停用还没跑完时看到"已经加载过"而直接跳过，结果是**新代码根本没上**
     * （用户看到的现象是"装了但行为没变"）。用户连点两下开关同理。
     */
    const previous = this.transitions.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (enabled) {
          if (!entry) {
            this.logger.warn('enable command without plugin entry; ignored', { data: { id } });
            return;
          }
          await this.enablePlugin(entry);
          return;
        }
        await this.disablePlugin(id);
      });
    this.transitions.set(id, next);
    return next;
  }

  /**
   * 插件被**卸载**了：停用 + 忘掉记录 + 清掉它的存储。
   *
   * 与"停用"的区别在最后两步：卸载之后清单里已经没有它了，渲染层不该再留着
   * 一条"已停止"的记录（否则托盘菜单会显示一个并不存在的插件），
   * 它的 localStorage 命名空间也该一起清掉。
   */
  public async removePlugin(id: string): Promise<void> {
    await this.applyEnabledCommand(id, false, null);
    this.records.delete(id);
    this.timers.delete(id);
    this.disposables.delete(id);
    this.menuItems.delete(id);
    this.panels.delete(id);
    this.notifyClicks.delete(id);
    const purged = purgePluginStorage(id);
    this.logger.info('plugin removed from host', { data: { id, purgedKeys: purged } });
    this.runtime.updatePluginRecords(this.getLoadedPlugins());
  }

  /**
   * Main 转来的插件界面事件。
   *
   * 三种来源：菜单点击（托盘「插件」子菜单）、通知点击、聊天窗口里的面板动作。
   * 一律在 try/catch 里跑：插件在回调里抛错不能影响别的插件，更不能影响 IPC。
   */
  public handleUIEvent(event: PluginUIEvent): void {
    try {
      if (event.kind === 'menu') {
        const handler = this.menuItems.get(event.pluginId)?.get(event.itemId)?.handler;
        if (!handler) {
          this.logger.debug('menu click for unknown item', { data: { pluginId: event.pluginId, itemId: event.itemId } });
          return;
        }
        this.runPluginCallback(event.pluginId, 'menu-item', handler);
        return;
      }
      if (event.kind === 'notification') {
        const handlers = this.notifyClicks.get(event.pluginId) ?? [];
        for (const handler of [...handlers]) {
          this.runPluginCallback(event.pluginId, 'notification-click', () => handler(event.notificationId));
        }
        return;
      }
      void this.handlePanelAction(event);
    } catch (error) {
      this.logger.error('plugin ui event failed (isolated)', { error: describeError(error), data: { pluginId: event.pluginId } });
    }
  }

  private async handlePanelAction(event: Extract<PluginUIEvent, { kind: 'panel-action' }>): Promise<void> {
    const panel = this.panels.get(event.pluginId)?.get(event.panelId);
    if (!panel) {
      this.logger.debug('panel action for unknown panel', {
        data: { pluginId: event.pluginId, panelId: event.panelId },
      });
      return;
    }

    /*
     * 保留动作：面板里的 `<a href>` 由宿主代开浏览器。
     * 这样插件不需要为"点开一个 issue / 一篇论文"写额外代码，
     * 而权限检查仍然在 Main（`system.openExternal` -> 权限 `ui`）。
     */
    if (event.actionId === '@open-external') {
      const href = event.fields.href ?? '';
      if (href) await this.openExternal(event.pluginId, href);
      return;
    }

    if (!panel.onAction) {
      this.logger.debug('panel has no action handler', { data: { pluginId: event.pluginId, panelId: event.panelId } });
      return;
    }
    try {
      const next = await panel.onAction({
        panelId: event.panelId,
        actionId: event.actionId,
        fields: event.fields,
      });
      if (typeof next === 'string') {
        this.updatePanel(event.pluginId, event.panelId, { html: next });
      }
    } catch (error) {
      this.logger.error('plugin panel action threw (isolated)', {
        error: describeError(error),
        data: { pluginId: event.pluginId, panelId: event.panelId, actionId: event.actionId },
      });
      this.eventBus.emit(PetEvents.PluginError, {
        pluginId: event.pluginId,
        hook: 'panel-action',
        message: describeError(error),
      });
    }
  }

  /** Main 转来的定时器到点（定时器由 Main 持有，见 shared/plugin-types.ts 的说明）。 */
  public handleTimerTick(pluginId: string, timerId: string, kind: 'after' | 'every'): void {
    const bucket = this.timers.get(pluginId);
    const entry = bucket?.get(timerId);
    if (!entry) {
      this.logger.debug('timer tick for unknown timer', { data: { pluginId, timerId } });
      return;
    }
    if (kind === 'after') bucket?.delete(timerId);
    this.runPluginCallback(pluginId, `timer:${timerId}`, entry.handler);
  }

  private runPluginCallback(pluginId: string, hook: string, callback: () => void | Promise<void>): void {
    try {
      const result = callback();
      if (result instanceof Promise) {
        void result.catch((error: unknown) => {
          this.logger.error('plugin async callback rejected (isolated)', {
            error: describeError(error),
            data: { pluginId, hook },
          });
        });
      }
    } catch (error) {
      this.logger.error('plugin callback threw (isolated)', { error: describeError(error), data: { pluginId, hook } });
      this.eventBus.emit(PetEvents.PluginError, { pluginId, hook, message: describeError(error) });
    }
  }

  /* ------------------------------------------------------------------ */
  /* PluginContext 构造                                                  */
  /* ------------------------------------------------------------------ */

  private createContext(
    identity: PluginIdentity,
    pluginDir: string,
    subscriptions: Subscription[],
    logger: Logger,
    permissions: readonly PluginPermission[],
  ): PluginContext {
    const track = (subscription: Subscription): Subscription => {
      subscriptions.push(subscription);
      return subscription;
    };
    const source = `plugin:${identity.id}`;
    const pluginId = identity.id;
    const has = (permission: PluginPermission): boolean => permissions.includes(permission);
    /** 统一的"没权限"返回：渲染层先给一次可读的原因，真正的执法在 Main。 */
    const denial = (permission: PluginPermission): string =>
      `插件 ${pluginId} 没有 ${permission} 权限：请在它的 package.json 的 permissions 里声明` +
      `（并确认 assets/config/plugins.json 没有把它收窄掉）`;

    const events: PluginEventAPI = {
      on: (event, handler) => track(this.eventBus.onFrom(identity.id, event, handler)),
      once: (event, handler) => track(this.eventBus.onceFrom(identity.id, event, handler)),
      off: (event, handler) => this.eventBus.off(event, handler),
      emit: (event, payload) => this.eventBus.emit(event, payload),
    };

    const animations: PluginAnimationAPI = {
      play: async (animationId: string, options: PluginAnimationOptions = {}) => {
        // 插件不允许直接播放：必须经过 Action Pipeline，便于统一裁决与审计
        const result = await this.actionManager.execute({
          type: 'animation',
          animationId,
          source,
          reason: options.reason ?? `plugin:${identity.id}`,
          ...(options.priority !== undefined ? { priority: options.priority } : {}),
          ...(options.interrupt !== undefined ? { interrupt: options.interrupt } : {}),
        });
        return {
          accepted: result.accepted,
          animationId,
          ...(result.rejection !== undefined ? { reason: mapRejection(result.rejection) } : {}),
        };
      },
      stop: () => this.animationManager.stop(source),
      isPlaying: () => this.animationManager.isPlaying(),
      getCurrent: () => this.animationManager.getCurrentAnimation(),
      getDefinition: (animationId: string) => this.animationManager.getDefinition(animationId),
      list: () => this.animationManager.list(),
      register: (definition) => this.animationManager.registerAnimation(definition),
    };

    const state: PluginStateAPI = {
      get: () => this.stateMachine.get(),
      is: (value: PetState) => this.stateMachine.is(value),
      onChange: (handler) =>
        track(
          this.eventBus.onFrom(identity.id, PetEvents.StateChange, (payload) => {
            handler({ from: payload.from, to: payload.to, reason: payload.reason });
          }),
        ),
      list: () => this.stateMachine.list(),
    };

    const behavior: PluginBehaviorAPI = {
      pause: () => this.behaviorManager.pause(),
      resume: () => this.behaviorManager.resume(),
      isPaused: () => this.behaviorManager.isPaused(),
    };

    const system: PluginSystemAPI = {
      getVersion: async () => this.runtime.version,
      getPlatform: () => this.runtime.platform,
      showNotification: (title: string, body: string) => {
        // 第一版规范做法：通过事件暴露，而不是让插件直接触碰 Notification API
        this.eventBus.emit('plugin:notification', { pluginId: identity.id, title, body });
        logger.info(`notification: ${title}`, { data: { body } });
      },
      log: (level, message) => logger[level](message),
      openExternal: async (url: string) => this.openExternal(pluginId, url),
    };

    const actions: PluginActionAPI = {
      execute: async (action: PetAction): Promise<ActionResult> => {
        // 插件不能伪造 source：统一改写成 plugin:<id>，保证审计清晰
        const guarded = { ...action, source } as PetAction;
        const outcome = await this.actionManager.execute(guarded);
        return {
          accepted: outcome.accepted,
          type: action.type,
          ...(outcome.rejection !== undefined ? { rejection: mapActionRejection(outcome.rejection) } : {}),
          ...(outcome.animationId !== undefined ? { animationId: outcome.animationId } : {}),
          ...(outcome.state !== undefined ? { state: outcome.state } : {}),
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        };
      },
    };

    const lifecycle: PluginLifecycleAPI = {
      permissions: [...permissions],
      has,
      onDispose: (dispose) => this.registerDispose(pluginId, dispose),
    };

    const timers: PluginTimerAPI = {
      after: (ms, handler) => this.startTimer(pluginId, 'after', ms, handler),
      every: (ms, handler) => this.startTimer(pluginId, 'every', ms, handler),
      cancel: (id) => this.cancelTimer(pluginId, id),
    };

    const net: PluginNetAPI = {
      request: async (request: PluginNetRequest): Promise<PluginNetResponse> => {
        if (!has('net')) return netFailure(denial('net'));
        const bridge = this.bridge;
        if (!bridge) return netFailure('插件桥不可用（preload 未注入）');
        try {
          return await bridge.net(pluginId, request);
        } catch (error) {
          return netFailure(describeError(error));
        }
      },
      json: async <T>(request: PluginNetRequest): Promise<PluginNetJsonResult<T>> => {
        const response = await net.request(request);
        if (response.error !== undefined) {
          return { ok: false, status: response.status, data: null, truncated: response.truncated, error: response.error };
        }
        try {
          return {
            ok: response.ok,
            status: response.status,
            data: JSON.parse(response.body) as T,
            truncated: response.truncated,
          };
        } catch (error) {
          return {
            ok: false,
            status: response.status,
            data: null,
            truncated: response.truncated,
            error: `响应不是合法 JSON：${describeError(error)}`,
          };
        }
      },
    };

    const process: PluginProcessAPI = {
      run: async (request: PluginProcessRequest): Promise<PluginProcessResult> => {
        if (!has('process')) return processFailure(denial('process'));
        const bridge = this.bridge;
        if (!bridge) return processFailure('插件桥不可用（preload 未注入）');
        try {
          return await bridge.process(pluginId, request);
        } catch (error) {
          return processFailure(describeError(error));
        }
      },
      which: async (command: string): Promise<string | null> => {
        if (!has('process')) return null;
        try {
          return (await this.bridge?.which(pluginId, command)) ?? null;
        } catch (error) {
          logger.warn('which failed', { error: describeError(error) });
          return null;
        }
      },
    };

    const python: PluginPythonAPI = {
      available: async (): Promise<PluginPythonInfo> => {
        if (!has('python')) return { ok: false, interpreter: null, version: null, error: denial('python') };
        try {
          return (
            (await this.bridge?.pythonInfo(pluginId)) ?? {
              ok: false,
              interpreter: null,
              version: null,
              error: '插件桥不可用（preload 未注入）',
            }
          );
        } catch (error) {
          return { ok: false, interpreter: null, version: null, error: describeError(error) };
        }
      },
      run: async (request: PluginPythonRequest): Promise<PluginProcessResult> => {
        if (!has('python')) return processFailure(denial('python'));
        const bridge = this.bridge;
        if (!bridge) return processFailure('插件桥不可用（preload 未注入）');
        try {
          return await bridge.pythonRun(pluginId, request);
        } catch (error) {
          return processFailure(describeError(error));
        }
      },
    };

    const notify: PluginNotifyAPI = {
      send: async (request): Promise<boolean> => {
        if (!has('notify')) {
          logger.warn(`notification blocked: ${denial('notify')}`);
          return false;
        }
        try {
          return (await this.bridge?.notify(pluginId, request)) ?? false;
        } catch (error) {
          logger.warn('notification failed', { error: describeError(error) });
          return false;
        }
      },
      onClick: (handler) => this.registerNotifyClick(pluginId, handler),
    };

    /*
     * 收件箱投递（权限 `mail`）。
     *
     * 插件生成的文件（导出的清单、抓下来的 PDF、Python 画的图）连同一条说明
     * 交给「交互」收件箱 —— 用户在**一个地方**就能看到"谁给了什么"。
     * 内容以字符串交上来（`utf8` 或 `base64`）：插件拿不到文件系统，
     * 落盘由主进程做（那里还有一道体积与权限校验）。
     */
    const mail: PluginMailAPI = {
      send: async (request): Promise<PluginMailResult> => {
        if (!has('mail')) return { ok: false, files: [], error: denial('mail') };
        const bridge = this.bridge;
        if (!bridge) return { ok: false, files: [], error: '插件桥不可用（preload 未注入）' };
        try {
          return await bridge.mail(pluginId, request);
        } catch (error) {
          return { ok: false, files: [], error: describeError(error) };
        }
      },
    };

    const ui: PluginUIAPI = {
      registerMenuItem: (item, handler) => {
        if (!has('ui')) {
          logger.warn(`registerMenuItem blocked: ${denial('ui')}`);
          return { unsubscribe: () => undefined };
        }
        const bucket = this.menuItems.get(pluginId) ?? new Map<string, MenuEntry>();
        bucket.set(item.id, { item, handler });
        this.menuItems.set(pluginId, bucket);
        this.pushContribution(pluginId);
        return {
          unsubscribe: () => {
            this.menuItems.get(pluginId)?.delete(item.id);
            this.pushContribution(pluginId);
          },
        };
      },
      updateMenuItem: (itemId, patch) => {
        const bucket = this.menuItems.get(pluginId);
        const existing = bucket?.get(itemId);
        if (!bucket || !existing) return false;
        bucket.set(itemId, { ...existing, item: { ...existing.item, ...patch } });
        this.pushContribution(pluginId);
        return true;
      },
      registerPanel: (panel) => {
        if (!has('ui')) {
          logger.warn(`registerPanel blocked: ${denial('ui')}`);
          return { unsubscribe: () => undefined };
        }
        const bucket = this.panels.get(pluginId) ?? new Map<string, PluginPanel>();
        bucket.set(panel.id, panel);
        this.panels.set(pluginId, bucket);
        this.pushContribution(pluginId);
        return {
          unsubscribe: () => {
            this.panels.get(pluginId)?.delete(panel.id);
            this.pushContribution(pluginId);
          },
        };
      },
      updatePanel: (panelId, patch) => this.updatePanel(pluginId, panelId, patch),
      say: async (text) => {
        if (!has('ui')) {
          logger.warn(`say blocked: ${denial('ui')}`);
          return false;
        }
        this.say(String(text ?? '').slice(0, 500));
        return true;
      },
      openPanel: async (panelId) => {
        if (!has('ui')) return false;
        try {
          return (await this.bridge?.openPanel(pluginId, panelId)) ?? false;
        } catch (error) {
          logger.warn('opening panel failed', { error: describeError(error) });
          return false;
        }
      },
    };

    return {
      events,
      animations,
      state,
      logger,
      storage: new PluginStorage(identity.id, logger),
      behavior,
      system,
      actions,
      lifecycle,
      timers,
      net,
      process,
      python,
      notify,
      mail,
      ui,
      plugin: identity,
      pluginDir,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 资源：定时器 / 面板 / 菜单项 / 停用回调                                */
  /* ------------------------------------------------------------------ */

  private startTimer(
    pluginId: string,
    kind: 'after' | 'every',
    ms: number,
    handler: () => void,
  ): PluginTimerHandle {
    const raw = typeof ms === 'number' && Number.isFinite(ms) ? ms : MIN_TIMER_MS;
    const intervalMs = Math.min(Math.max(Math.round(raw), MIN_TIMER_MS), MAX_TIMER_MS);
    this.timerSeq += 1;
    const timerId = `t${this.timerSeq}`;
    const fire = (): void => this.runPluginCallback(pluginId, `timer:${timerId}`, handler);

    /*
     * 计时优先交给**主进程**：Chromium 会把隐藏/后台窗口的定时器降频到分钟级，
     * 番茄钟、新闻轮询这类"到点必须准"的插件不能依赖渲染层的 setTimeout；
     * 而且停用插件时 Main 能直接清表（渲染层卡住也不影响回收）。
     *
     * 主进程只为自己认识的插件计时（未知/已停用的 id 一律拒绝），
     * 被拒时退化为渲染层定时器：宁可精度差一点，也不要插件"莫名没有定时器"。
     */
    let localHandle: number | null = null;
    const startLocal = (): void => {
      // 已经停用（条目被清掉）就不要再起了，否则会留下没人回收的定时器
      if (!this.timers.get(pluginId)?.has(timerId) || localHandle !== null) return;
      localHandle = kind === 'every'
        ? window.setInterval(fire, intervalMs)
        : window.setTimeout(() => {
            this.timers.get(pluginId)?.delete(timerId);
            fire();
          }, intervalMs);
    };

    const bridge = this.bridge;
    if (bridge === null) {
      startLocal();
    } else {
      void bridge
        .startTimer(pluginId, { timerId, kind, intervalMs })
        .then((ok) => {
          if (!ok) {
            this.logger.debug('main-process timer refused; falling back to renderer timer', {
              data: { pluginId, timerId },
            });
            startLocal();
          }
        })
        .catch((error: unknown) => {
          this.logger.warn('starting plugin timer failed; falling back to renderer timer', {
            error: describeError(error),
            data: { pluginId },
          });
          startLocal();
        });
    }

    const bucket = this.timers.get(pluginId) ?? new Map<string, TimerEntry>();
    bucket.set(timerId, {
      kind,
      handler,
      cancel: () => {
        if (localHandle !== null) {
          if (kind === 'every') window.clearInterval(localHandle);
          else window.clearTimeout(localHandle);
          localHandle = null;
          return;
        }
        void bridge?.cancelTimer(pluginId, timerId).catch(() => undefined);
      },
    });
    this.timers.set(pluginId, bucket);

    return { id: timerId, cancel: () => this.cancelTimer(pluginId, timerId) };
  }

  private cancelTimer(pluginId: string, timerId: string): boolean {
    const bucket = this.timers.get(pluginId);
    const entry = bucket?.get(timerId);
    if (!bucket || !entry) return false;
    entry.cancel();
    bucket.delete(timerId);
    if (bucket.size === 0) this.timers.delete(pluginId);
    return true;
  }

  private registerDispose(pluginId: string, dispose: () => void): Subscription {
    const list = this.disposables.get(pluginId) ?? [];
    list.push(dispose);
    this.disposables.set(pluginId, list);
    return {
      unsubscribe: () => {
        const current = this.disposables.get(pluginId);
        if (!current) return;
        const index = current.indexOf(dispose);
        if (index >= 0) current.splice(index, 1);
      },
    };
  }

  private registerNotifyClick(pluginId: string, handler: (id?: string) => void): Subscription {
    const list = this.notifyClicks.get(pluginId) ?? [];
    list.push(handler);
    this.notifyClicks.set(pluginId, list);
    return {
      unsubscribe: () => {
        const current = this.notifyClicks.get(pluginId);
        if (!current) return;
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      },
    };
  }

  private updatePanel(pluginId: string, panelId: string, patch: { html?: string; title?: string }): boolean {
    const bucket = this.panels.get(pluginId);
    const existing = bucket?.get(panelId);
    if (!bucket || !existing) return false;
    bucket.set(panelId, {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.html !== undefined ? { html: patch.html } : {}),
    });
    this.pushContribution(pluginId);
    return true;
  }

  /**
   * 把该插件的界面贡献（菜单项 + 面板）全量推给 Main。
   *
   * 全量而不是增量：Main 只需要保存一份快照给托盘菜单与聊天窗口，
   * 增量协议要维护两边的差异状态，是"面板消失后页签还在"这类 bug 的温床。
   */
  private pushContribution(pluginId: string): void {
    const bridge = this.bridge;
    if (!bridge) return;
    const name = this.records.get(pluginId)?.name ?? pluginId;
    const menuItems = [...(this.menuItems.get(pluginId)?.values() ?? [])].map((entry) => entry.item);
    const panels: PluginPanelView[] = [...(this.panels.get(pluginId)?.values() ?? [])].map((panel) => ({
      pluginId,
      pluginName: name,
      panelId: panel.id,
      title: panel.title,
      html: typeof panel.html === 'string' ? panel.html.slice(0, MAX_PANEL_HTML) : '',
      updatedAt: Date.now(),
    }));
    try {
      bridge.contributeUI({ pluginId, menuItems, panels });
    } catch (error) {
      this.logger.warn('pushing plugin ui contribution failed', { error: describeError(error), data: { pluginId } });
    }
  }

  /** 收回插件留下的一切（停用 / 激活失败 / 退出时都走这里）。 */
  private releaseResources(pluginId: string): void {
    const timers = this.timers.get(pluginId);
    if (timers) {
      for (const entry of timers.values()) {
        try {
          entry.cancel();
        } catch {
          // 取消失败（例如桥已断开）不该阻塞其它回收
        }
      }
      timers.clear();
      this.timers.delete(pluginId);
    }

    const disposables = this.disposables.get(pluginId);
    if (disposables) {
      for (const dispose of [...disposables]) {
        try {
          dispose();
        } catch (error) {
          this.logger.warn('plugin dispose callback threw', { error: describeError(error), data: { pluginId } });
        }
      }
      disposables.length = 0;
      this.disposables.delete(pluginId);
    }

    this.menuItems.delete(pluginId);
    this.panels.delete(pluginId);
    this.notifyClicks.delete(pluginId);
    this.pushContribution(pluginId);
  }

  /** 用系统默认浏览器打开链接（权限 `ui`；面板里的 `<a href>` 也走这里）。 */
  private async openExternal(pluginId: string, url: string): Promise<boolean> {
    try {
      return (await this.bridge?.openExternal(pluginId, url)) ?? false;
    } catch (error) {
      this.logger.warn('openExternal failed', { error: describeError(error), data: { pluginId } });
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  private createPluginLogger(pluginId: string): Logger {
    const base = this.logger;
    const wrap =
      (level: 'debug' | 'info' | 'warn' | 'error') =>
      (message: string, fields?: Parameters<Logger['info']>[1]): void => {
        base[level](message, { ...fields, module: `Plugin:${pluginId}` });
      };
    return {
      debug: wrap('debug'),
      info: wrap('info'),
      warn: wrap('warn'),
      error: wrap('error'),
    };
  }

  private disposeSubscriptions(subscriptions: Subscription[]): void {
    for (const subscription of subscriptions) {
      try {
        subscription.unsubscribe();
      } catch (error) {
        this.logger.warn('unsubscribing plugin events failed', { error });
      }
    }
    subscriptions.length = 0;
  }

  private markRecord(pluginId: string, patch: Partial<PluginRecord> & { status: PluginStatus }): void {
    const existing = this.records.get(pluginId);
    const record: PluginRecord = {
      id: pluginId,
      name: existing?.name ?? pluginId,
      version: existing?.version ?? '0.0.0',
      dir: existing?.dir ?? pluginId,
      enabled: existing?.enabled ?? true,
      ...patch,
    };
    this.records.set(pluginId, record);
    this.runtime.updatePluginRecords(this.getLoadedPlugins());
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new PetError(message, { code: 'PLUGIN_RUNTIME_ERROR', module: 'PluginHost' }));
      }, timeoutMs);
      promise.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          window.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 拒绝原因映射（保持插件可见的类型收窄）                                        */
/* -------------------------------------------------------------------------- */

function mapRejection(rejection: string): PlayRejectionReason {
  const known: readonly string[] = [
    'not-registered',
    'unsupported-type',
    'cooldown',
    'lower-priority',
    'equal-priority',
    'not-interruptible',
    'same-animation',
    'load-failed',
  ];
  return known.includes(rejection) ? (rejection as PlayRejectionReason) : 'not-registered';
}

function mapActionRejection(rejection: string): ActionRejectionReason {
  const known: readonly string[] = [
    'invalid-action',
    'unknown-action-type',
    'missing-target',
    'animation-not-found',
    'state-transition-rejected',
    'blocked-by-guard',
    'behaviour-paused',
  ];
  return known.includes(rejection) ? (rejection as ActionRejectionReason) : 'invalid-action';
}

function netFailure(error: string): PluginNetResponse {
  return { ok: false, status: 0, headers: {}, body: '', truncated: false, error };
}

function processFailure(error: string): PluginProcessResult {
  return { ok: false, code: null, stdout: '', stderr: '', timedOut: false, truncated: false, error };
}
