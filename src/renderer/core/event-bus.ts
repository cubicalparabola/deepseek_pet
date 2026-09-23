/**
 * EventBus —— 全局事件总线（Renderer 权威实现，插件通过 PluginEventAPI 访问）。
 *
 * 职责：
 * - on / off / once / emit；
 * - 异步 handler 的 rejection 被捕获并通过 onError 上报（插件抛错不能崩桌宠）；
 * - 支持拦截器（未来 AI Agent / 审计插件可以在事件流上做观察或改写）；
 * - `emit` 永不抛异常：任何监听器异常都被隔离。
 */

import type { EventHandler, EventInterceptor, PetEventName, Subscription } from '../../shared/events';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

type AnyHandler = (payload: unknown) => unknown;
type ErrorReporter = (error: unknown, context: { readonly event: PetEventName; readonly source: string }) => void;

export interface EventBusOptions {
  readonly logger: Logger;
  readonly onError?: ErrorReporter;
}

export class EventBus {
  private readonly listeners = new Map<PetEventName, Set<AnyHandler>>();
  private readonly interceptors = new Set<EventInterceptor>();
  private readonly logger: Logger;
  private readonly onError: ErrorReporter;

  public constructor(options: EventBusOptions) {
    this.logger = options.logger;
    this.onError =
      options.onError ??
      ((error, context) => {
        this.logger.error('event listener failed', {
          error: describeError(error),
          event: context.event,
          data: { source: context.source },
        });
      });
  }

  public on<K extends PetEventName>(event: K, handler: EventHandler<K>): Subscription {
    return this.addListener(event, handler as AnyHandler, false, 'unknown');
  }

  public once<K extends PetEventName>(event: K, handler: EventHandler<K>): Subscription {
    return this.addListener(event, handler as AnyHandler, true, 'unknown');
  }

  /**
   * 带来源的订阅（内部使用）：日志中能看到是哪个模块的 handler 抛错。
   */
  public onFrom<K extends PetEventName>(source: string, event: K, handler: EventHandler<K>): Subscription {
    return this.addListener(event, handler as AnyHandler, false, source);
  }

  public onceFrom<K extends PetEventName>(source: string, event: K, handler: EventHandler<K>): Subscription {
    return this.addListener(event, handler as AnyHandler, true, source);
  }

  public off<K extends PetEventName>(event: K, handler: EventHandler<K>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler as AnyHandler);
    if (set.size === 0) this.listeners.delete(event);
  }

  /**
   * 派发事件。
   * @param payload 负载；无负载事件可省略（内部补 {}）。
   */
  public emit<K extends PetEventName>(event: K, payload?: unknown): void {
    // 无负载事件统一补 {}，保证监听器拿到的永远是对象（避免 undefined 解构崩溃）
    let effective: unknown = payload === undefined || payload === null ? {} : payload;
    for (const interceptor of this.interceptors) {
      try {
        const result = interceptor(event, effective);
        if (!result) continue;
        if (result.cancel) {
          this.logger.debug('event cancelled by interceptor', { event });
          return;
        }
        if (result.payload !== undefined) effective = result.payload;
      } catch (error) {
        this.onError(error, { event, source: 'interceptor' });
      }
    }

    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // 复制一份，避免 handler 内部 off/on 影响本次遍历
    for (const handler of [...set]) {
      try {
        const result = handler(effective);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          void (result as Promise<unknown>).catch((error) => {
            this.onError(error, { event, source: 'async-handler' });
          });
        }
      } catch (error) {
        this.onError(error, { event, source: 'handler' });
      }
    }
  }

  public addInterceptor(interceptor: EventInterceptor): Subscription {
    this.interceptors.add(interceptor);
    return {
      unsubscribe: () => {
        this.interceptors.delete(interceptor);
      },
    };
  }

  public listenerCount(event?: PetEventName): number {
    if (event) return this.listeners.get(event)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  /** 只读快照，便于调试与未来的插件管理面板。 */
  public describe(): readonly { readonly event: string; readonly listeners: number }[] {
    return [...this.listeners.entries()].map(([event, set]) => ({ event, listeners: set.size }));
  }

  /** 清空所有订阅（用于热重载/退出）。 */
  public clear(): void {
    this.listeners.clear();
    this.interceptors.clear();
  }

  private addListener(
    event: PetEventName,
    handler: AnyHandler,
    once: boolean,
    source: string,
  ): Subscription {
    const wrapper: AnyHandler = once
      ? (payload: unknown) => {
          this.remove(event, wrapper);
          return handler(payload);
        }
      : handler;

    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(wrapper);
    this.logger.debug('listener added', { event, data: { source, once } });

    return {
      unsubscribe: () => {
        this.remove(event, wrapper);
      },
    };
  }

  private remove(event: PetEventName, handler: AnyHandler): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.listeners.delete(event);
  }
}
