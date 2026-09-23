/**
 * PluginHost —— Renderer 侧的插件宿主（插件真正运行的地方）。
 *
 * 与 Main 侧 PluginManager 的分工：
 *   Main    : discover / 读元数据 / 编译（esbuild 或预编译产物）/ 编排生命周期 / 日志
 *   Renderer: 执行插件代码 + 提供受控 PluginContext + 隔离插件异常
 *
 * 沙箱约束（实现见 plugin-code-loader.ts）：
 * - 插件代码以 blob ES module 形式执行，**不使用** unsafe-eval（CSP 仍禁止 eval / new Function）；
 * - `require` 只放行虚拟模块 `desktop-pet`，`process` / `global` / `Buffer` 被显式屏蔽；
 * - 插件拿不到 fs / path / electron / BrowserWindow / ipcRenderer / window.petAPI；
 * - 插件只能通过 PluginContext 访问事件、动画、状态、存储、系统信息。
 *
 * 隔离策略：
 * - activate / deactivate 用 try/catch + 超时保护；
 * - 激活失败会回滚该插件的全部事件订阅并标记 failed，不影响桌宠与其他插件；
 * - 单个插件的事件 handler 抛错由 EventBus 统一捕获并记录来源。
 */

import type {
  DiscoveredPlugin,
  PetPlugin,
  PluginContext,
  PluginIdentity,
  PluginRecord,
  PluginStatus,
  PluginAnimationAPI,
  PluginAnimationOptions,
  PluginBehaviorAPI,
  PluginEventAPI,
  PluginStateAPI,
  PluginSystemAPI,
  PluginActionAPI,
} from '../../shared/plugin-types';
import type { Subscription } from '../../shared/events';
import type { AnimationDefinition, PlayRejectionReason } from '../../shared/animation-types';
import type { ActionRejectionReason } from '../../shared/action-types';
import type { PetState } from '../../shared/state-types';
import type { PetAction, ActionResult } from '../../shared/action-types';
import { PetError, describeError } from '../../shared/errors';
import { PetEvents } from '../../shared/events';
import type { Logger } from '../../shared/logger';
import { PluginCodeLoader } from './plugin-code-loader';
import { PluginStorage } from './plugin-storage';
import type { EventBus } from './event-bus';

const ACTIVATE_TIMEOUT_MS = 5000;
const DEACTIVATE_TIMEOUT_MS = 3000;

interface LoadedPlugin {
  readonly record: PluginRecord;
  readonly instance: PetPlugin;
  readonly subscriptions: Subscription[];
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
  private readonly loader: PluginCodeLoader;
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly records = new Map<string, PluginRecord>();

  public constructor(options: PluginHostOptions) {
    this.logger = options.logger;
    this.eventBus = options.eventBus;
    this.stateMachine = options.state;
    this.animationManager = options.animations;
    this.actionManager = options.actions;
    this.behaviorManager = options.behaviors;
    this.runtime = options.runtime;
    this.loader = new PluginCodeLoader({ logger: options.logger });
  }

  /* ------------------------------------------------------------------ */
  /* 批量装载                                                            */
  /* ------------------------------------------------------------------ */

  /** 从 Main 下发的插件清单加载并激活插件；单个插件失败不会中断循环。 */
  public async bootstrap(plugins: readonly DiscoveredPlugin[]): Promise<void> {
    this.logger.info('loading plugins', { data: { count: plugins.length } });
    for (const plugin of plugins) {
      try {
        await this.loadAndActivate(plugin);
      } catch (error) {
        this.logger.error('plugin load failed (isolated)', { error: describeError(error), data: { id: plugin.id } });
      }
    }
    this.logger.info('plugins loaded', {
      data: {
        active: this.getLoadedPlugins().filter((record) => record.status === 'active').length,
        total: plugins.length,
      },
    });
  }

  private async loadAndActivate(entry: DiscoveredPlugin): Promise<void> {
    const payload = await this.runtime.fetchPluginCode(entry.id);
    if (!payload) {
      this.markRecord(entry.id, { status: 'failed', error: '插件代码获取失败' });
      this.eventBus.emit(PetEvents.PluginError, {
        pluginId: entry.id,
        hook: 'load',
        message: '插件代码获取失败',
      });
      return;
    }

    const instance = await this.loader.evaluate(entry.id, payload.code);
    if (!instance) {
      this.markRecord(entry.id, { status: 'failed', error: '插件入口未导出合法插件对象' });
      this.eventBus.emit(PetEvents.PluginError, {
        pluginId: entry.id,
        hook: 'evaluate',
        message: '插件入口未导出合法插件对象',
      });
      return;
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
    };
    this.records.set(entry.id, record);
    this.eventBus.emit(PetEvents.PluginLoaded, {
      pluginId: record.id,
      name: record.name,
      version: record.version,
    });

    await this.activate(instance, record);
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  /** 激活插件：注入 PluginContext，调用 activate()，并跟踪其全部订阅。 */
  public async activate(instance: PetPlugin, record: PluginRecord): Promise<boolean> {
    const subscriptions: Subscription[] = [];
    const identity: PluginIdentity = {
      id: record.id,
      name: instance.name,
      version: instance.version,
      ...(instance.description !== undefined ? { description: instance.description } : {}),
      ...(instance.author !== undefined ? { author: instance.author } : {}),
    };

    const pluginLogger = this.createPluginLogger(record.id);
    const context = this.createContext(identity, record.dir, subscriptions, pluginLogger);

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
      const message = describeError(error);
      this.logger.error('plugin activate failed (isolated)', { error, data: { id: record.id } });
      this.markRecord(record.id, { status: 'failed', error: message });
      this.eventBus.emit(PetEvents.PluginError, { pluginId: record.id, hook: 'activate', message });
      return false;
    }

    this.loaded.set(record.id, { record, instance, subscriptions });
    this.markRecord(record.id, { status: 'active' });
    this.logger.info(`activated ${record.id}`, {
      data: { name: record.name, version: record.version },
    });
    this.eventBus.emit(PetEvents.PluginActivated, {
      pluginId: record.id,
      name: record.name,
      version: record.version,
    });
    this.runtime.notifyActivated({ id: record.id, status: 'active' });
    return true;
  }

  /** 停用插件：先退订事件，再调用 deactivate()。 */
  public async deactivate(pluginId: string): Promise<boolean> {
    const entry = this.loaded.get(pluginId);
    if (!entry) return false;
    this.markRecord(pluginId, { status: 'deactivating' });
    this.disposeSubscriptions(entry.subscriptions);

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

  /** 重载全部插件（托盘菜单 / 主进程指令触发）。 */
  public async reloadAll(entries: readonly DiscoveredPlugin[]): Promise<void> {
    this.logger.info('reloading all plugins');
    for (const id of [...this.loaded.keys()]) {
      await this.deactivate(id);
    }
    this.records.clear();
    await this.bootstrap(entries);
  }

  public getLoadedPlugins(): readonly PluginRecord[] {
    return [...this.records.values()];
  }

  public deactivateAll(): void {
    for (const [id, entry] of this.loaded) {
      this.disposeSubscriptions(entry.subscriptions);
      try {
        void entry.instance.deactivate?.();
      } catch (error) {
        this.logger.error('plugin deactivate failed', { error, data: { id } });
      }
    }
    this.loaded.clear();
  }

  /* ------------------------------------------------------------------ */
  /* PluginContext 构造                                                  */
  /* ------------------------------------------------------------------ */

  private createContext(
    identity: PluginIdentity,
    pluginDir: string,
    subscriptions: Subscription[],
    logger: Logger,
  ): PluginContext {
    const track = (subscription: Subscription): Subscription => {
      subscriptions.push(subscription);
      return subscription;
    };
    const source = `plugin:${identity.id}`;

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

    return {
      events,
      animations,
      state,
      logger,
      storage: new PluginStorage(identity.id, logger),
      behavior,
      system,
      actions,
      plugin: identity,
      pluginDir,
    };
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
