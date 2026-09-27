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

/**
 * 清空某个插件的**全部**存储（卸载插件时调用）。
 *
 * 为什么卸载要连数据一起清：插件已经从磁盘上删掉了，它的键却永远留在用户
 * 的 localStorage 里 —— 既占地方，也让人无法回答"卸载干净了没有"。
 * 返回清掉的键数（写日志用），任何异常都吞掉：卸载不该因为清理失败而失败。
 */
export function purgePluginStorage(pluginId: string): number {
  const prefix = `${NAMESPACE}:${pluginId}:`;
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) {
      window.localStorage.removeItem(key);
      removed += 1;
    }
  } catch {
    // 存储不可用时什么都不做：卸载流程本身不该被它拖住
  }
  return removed;
}
