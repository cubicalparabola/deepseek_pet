/**
 * AI 配置持久化（2.1~2.4 的总开关与密钥都在这里）。
 *
 * 为什么**不**放进 `assets/config/settings.json`：
 * `assets/` 在仓库里（开发态就是 git 工作区），把 API Key 写进去会被提交、
 * 被同步、被截图带走。因此 AI 配置单独落在 `%APPDATA%\DesktopPet\ai-settings.json`：
 * 与日志、记忆、日记同一处，属于"用户数据"，不进版本库。
 *
 * 健壮性：文件缺失/损坏一律回落默认值（全部关闭），
 * 绝不因为一个坏字段让桌宠起不来。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_AI_SETTINGS,
  applyAISettingsPatch,
  sanitizeAISettings,
  type AISettings,
  type AISettingsPatch,
} from '../../shared/ai-types';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export interface AIConfigStoreOptions {
  /** 数据根目录（`%APPDATA%\DesktopPet`）。 */
  readonly dataDir: string;
  readonly logger: Logger;
}

export class AIConfigStore {
  private readonly file: string;
  private readonly logger: Logger;
  private settings: AISettings = { ...DEFAULT_AI_SETTINGS };

  public constructor(options: AIConfigStoreOptions) {
    this.file = join(options.dataDir, 'ai-settings.json');
    this.logger = options.logger;
  }

  public load(): AISettings {
    if (!existsSync(this.file)) {
      this.logger.info('ai-settings.json not found; AI features stay off by default', {
        data: { file: this.file },
      });
      this.settings = { ...DEFAULT_AI_SETTINGS };
      return this.settings;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      this.settings = sanitizeAISettings(parsed);
      this.logger.info('ai settings loaded', {
        data: {
          file: this.file,
          enabled: this.settings.enabled,
          chat: this.settings.chat,
          memory: this.settings.memory,
          emotion: this.settings.emotion,
          diary: this.settings.diary,
          provider: this.settings.provider.kind,
          model: this.settings.provider.model,
          apiKeySet: this.settings.provider.apiKey !== '',
        },
      });
    } catch (error) {
      this.logger.error('ai-settings.json parse failed; using defaults (all off)', {
        error: describeError(error),
        data: { file: this.file },
      });
      this.settings = { ...DEFAULT_AI_SETTINGS };
    }
    return this.settings;
  }

  public get(): AISettings {
    return this.settings;
  }

  public get filePath(): string {
    return this.file;
  }

  /** 应用补丁（含"省略 apiKey = 不改动密钥"的约定）。 */
  public update(patch: AISettingsPatch): AISettings {
    this.settings = applyAISettingsPatch(this.settings, patch);
    this.save();
    return this.settings;
  }

  /**
   * 累计 token 用量。
   *
   * 用量只增不减（除手动重置），因为它是"预算还剩多少 = 她还有多少力气"的依据，
   * 中途回退会让"饿"这个状态变得不可信。
   */
  public addUsage(tokens: number): AISettings {
    const used = Math.max(0, Math.round(tokens));
    if (used <= 0) return this.settings;
    this.settings = {
      ...this.settings,
      budget: {
        ...this.settings.budget,
        used: this.settings.budget.used + used,
        resetAt: this.settings.budget.resetAt === '' ? new Date().toISOString() : this.settings.budget.resetAt,
      },
    };
    this.save();
    return this.settings;
  }

  public resetUsage(): AISettings {
    this.settings = {
      ...this.settings,
      budget: { ...this.settings.budget, used: 0, resetAt: new Date().toISOString() },
    };
    this.save();
    return this.settings;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
      renameSync(temp, this.file);
      this.logger.debug('ai settings saved', { data: { file: this.file } });
    } catch (error) {
      // 配置写不进去也不能影响运行
      this.logger.error('ai settings save failed', { error: describeError(error), data: { file: this.file } });
    }
  }
}
