/**
 * 感知配置持久化（3.1~3.6 的开关都在这里）。
 *
 * 与 AI 配置分开两个文件（`ai-settings.json` / `perception-settings.json`）：
 * 两块的隐私含义完全不同 —— "感知"决定**要不要看屏幕/摄像头**，
 * 用户可能会想"AI 开着，但别看我屏幕"。分开存，语义清楚、也便于单独备份/删除。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_PERCEPTION_SETTINGS,
  applyPerceptionPatch,
  sanitizePerceptionSettings,
  type PerceptionSettings,
  type PerceptionSettingsPatch,
} from '../../shared/perception-types';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export interface PerceptionSettingsStoreOptions {
  /** 数据根目录（`%APPDATA%\DesktopPet`）。 */
  readonly dataDir: string;
  readonly logger: Logger;
}

export class PerceptionSettingsStore {
  private readonly file: string;
  private readonly logger: Logger;
  private settings: PerceptionSettings = { ...DEFAULT_PERCEPTION_SETTINGS };

  public constructor(options: PerceptionSettingsStoreOptions) {
    this.file = join(options.dataDir, 'perception-settings.json');
    this.logger = options.logger;
  }

  public load(): PerceptionSettings {
    if (!existsSync(this.file)) {
      this.logger.info('perception-settings.json not found; using defaults (all on, camera needs consent)', {
        data: { file: this.file },
      });
      this.settings = { ...DEFAULT_PERCEPTION_SETTINGS };
      return this.settings;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      this.settings = sanitizePerceptionSettings(parsed);
      this.logger.info('perception settings loaded', {
        data: {
          screen: this.settings.screen,
          behavior: this.settings.behavior,
          camera: this.settings.camera,
          habits: this.settings.habits,
          privacyMode: this.settings.privacyMode,
          cameraAuthorized: this.settings.cameraAuthorized,
          intervalMs: this.settings.captureIntervalMs,
        },
      });
    } catch (error) {
      this.logger.error('perception-settings.json parse failed; using defaults', {
        error: describeError(error),
        data: { file: this.file },
      });
      this.settings = { ...DEFAULT_PERCEPTION_SETTINGS };
    }
    return this.settings;
  }

  public get(): PerceptionSettings {
    return this.settings;
  }

  public get filePath(): string {
    return this.file;
  }

  public update(patch: PerceptionSettingsPatch): PerceptionSettings {
    this.settings = applyPerceptionPatch(this.settings, patch);
    this.save();
    return this.settings;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
      renameSync(temp, this.file);
    } catch (error) {
      this.logger.error('perception settings save failed', { error: describeError(error), data: { file: this.file } });
    }
  }
}
