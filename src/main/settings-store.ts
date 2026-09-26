/**
 * 设置持久化（Main 进程）。
 *
 * 第一版设置很少（尺寸 + 置顶），因此直接用 JSON 文件，不引入数据库：
 *   <assets>/config/settings.json
 *
 * 放在 assets/config 下有两个好处：
 * - 与 animations.json / plugins.json 放一起，用户只需要知道一个目录；
 * - 打包后 extraResources 已经把 assets/ 放在 asar 之外，因此**可写**。
 *
 * 健壮性：文件缺失/损坏一律回落到默认值，绝不让桌宠因为设置读不出来而启动失败。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_PET_SETTINGS, clampPetScale, type PetSettings } from '../shared/pet-size';
import type { Logger } from '../shared/logger';
import { describeError } from '../shared/errors';

export interface SettingsStoreOptions {
  /** assets/config 目录（绝对路径）。 */
  readonly configPath: string;
  readonly logger: Logger;
}

export class SettingsStore {
  private readonly file: string;
  private readonly logger: Logger;
  private settings: PetSettings = { ...DEFAULT_PET_SETTINGS };

  public constructor(options: SettingsStoreOptions) {
    this.file = join(options.configPath, 'settings.json');
    this.logger = options.logger;
  }

  public load(): PetSettings {
    if (!existsSync(this.file)) {
      this.logger.info('settings.json not found; using defaults', { data: { file: this.file } });
      this.settings = { ...DEFAULT_PET_SETTINGS };
      return this.settings;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      this.settings = this.sanitize(parsed);
      this.logger.info('settings loaded', { data: { ...this.settings, file: this.file } });
    } catch (error) {
      this.logger.error('settings.json parse failed; using defaults', {
        error: describeError(error),
        data: { file: this.file },
      });
      this.settings = { ...DEFAULT_PET_SETTINGS };
    }
    return this.settings;
  }

  public get(): PetSettings {
    return this.settings;
  }

  public update(patch: Partial<PetSettings>): PetSettings {
    const next = this.sanitize({ ...this.settings, ...patch });
    this.settings = next;
    this.save();
    return next;
  }

  /** 写入磁盘（先写临时文件再改名，避免中途失败留下损坏的 JSON）。 */
  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
      renameSync(temp, this.file);
      this.logger.info('settings saved', { data: { ...this.settings, file: this.file } });
    } catch (error) {
      // 设置写不进去也不能影响运行
      this.logger.error('settings save failed', { error: describeError(error), data: { file: this.file } });
    }
  }

  private sanitize(raw: unknown): PetSettings {
    if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_PET_SETTINGS };
    const record = raw as Record<string, unknown>;
    return {
      scale: typeof record.scale === 'number' ? clampPetScale(record.scale) : DEFAULT_PET_SETTINGS.scale,
      alwaysOnTop:
        typeof record.alwaysOnTop === 'boolean' ? record.alwaysOnTop : DEFAULT_PET_SETTINGS.alwaysOnTop,
      dockOnEdge:
        typeof record.dockOnEdge === 'boolean' ? record.dockOnEdge : DEFAULT_PET_SETTINGS.dockOnEdge,
    };
  }
}
