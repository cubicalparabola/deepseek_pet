/**
 * PluginStorage 实现（第一版使用 localStorage，不引入数据库）。
 *
 * - 每个插件独立命名空间：`desktop-pet:plugin:<pluginId>:<key>`；
 * - 只支持 JSON 可序列化数据；
 * - 读写失败不影响插件与桌宠主体。
 */

import type { PluginStorageAPI } from '../../shared/plugin-types';
import type { Logger } from '../../shared/logger';

const NAMESPACE = 'desktop-pet:plugin';

export class PluginStorage implements PluginStorageAPI {
  private readonly pluginId: string;
  private readonly logger: Logger;
  private readonly prefix: string;

  public constructor(pluginId: string, logger: Logger) {
    this.pluginId = pluginId;
    this.prefix = `${NAMESPACE}:${pluginId}:`;
    this.logger = logger;
  }

  public get<T>(key: string, fallback?: T): T | undefined {
    try {
      const raw = window.localStorage.getItem(this.prefix + key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.warn('plugin storage read failed', { error, data: { pluginId: this.pluginId, key } });
      return fallback;
    }
  }

  public set<T>(key: string, value: T): void {
    try {
      window.localStorage.setItem(this.prefix + key, JSON.stringify(value ?? null));
    } catch (error) {
      this.logger.warn('plugin storage write failed', { error, data: { pluginId: this.pluginId, key } });
    }
  }

  public remove(key: string): void {
    try {
      window.localStorage.removeItem(this.prefix + key);
    } catch (error) {
      this.logger.warn('plugin storage remove failed', { error, data: { pluginId: this.pluginId, key } });
    }
  }

  public keys(): readonly string[] {
    const result: string[] = [];
    try {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key && key.startsWith(this.prefix)) result.push(key.slice(this.prefix.length));
      }
    } catch (error) {
      this.logger.warn('plugin storage keys failed', { error, data: { pluginId: this.pluginId } });
    }
    return result;
  }
}
