/**
 * 数据目录解析 —— 她的"记忆"放在**项目文件夹**里，而不是 C 盘。
 *
 * 背景（需求原文）："所有记忆应该移动到项目文件夹中，而不是 C 盘"。
 *
 * 三种来源，优先级从高到低：
 * 1. **环境变量** `DESKTOP_PET_AI_DATA_DIR`（自动化验收用它把测试数据隔离到临时目录）；
 * 2. **项目目录** `<appRoot>/data`（默认，开发/绿色版都直观：数据跟代码在一起）；
 * 3. **userData**（兜底）—— 项目目录不可写时（例如装到 Program Files、或只读盘）自动退回，
 *    并记一条 warning。宁可回到 C 盘也不能"写不进去还装没事"。
 *
 * ⚠️ `data/` 里有 `ai-settings.json`（含 API Key），因此它**必须**在 `.gitignore` 里。
 *
 * 另外做一次**一次性迁移**：老版本的记忆都在 `%APPDATA%\DesktopPet`，
 * 换目录后不能让她"失忆"。迁移是**复制**（源文件保留，作为安全网），
 * 并且在 userData 里写一个标记文件，之后永不再迁（否则用户删掉 data/ 又会被"复活"）。
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../shared/logger';
import { describeError } from '../shared/errors';

/** 数据目录的来源（写进日志/自检，回答"她现在把记忆存在哪"）。 */
export type DataDirSource = 'override' | 'project' | 'userdata';

export interface DataDirResolution {
  readonly dir: string;
  readonly source: DataDirSource;
  /** 从 userData 复制过来的条目（空数组 = 没有迁移）。 */
  readonly migrated: readonly string[];
  /** 人类可读的说明（退回兜底时写原因）。 */
  readonly note: string;
}

export interface DataDirOptions {
  /** 仓库/安装根目录（`resolveAppRoot()` 的结果）。 */
  readonly appRoot: string;
  /** Electron 的 userData（老数据所在地 + 兜底目录）。 */
  readonly userDataDir: string;
  readonly logger: Logger;
  readonly envOverride?: string | undefined;
}

/**
 * 属于"她的记忆"的条目 —— 迁移只复制这些，**不碰 Chromium 的缓存目录**
 * （Cache / GPUCache / Local Storage / Network … 留在 userData）。
 */
export const DATA_ENTRIES: readonly string[] = [
  'memory',
  'diary',
  'notes',
  'mood',
  'reflection',
  'perception',
  'ai-settings.json',
  'perception-settings.json',
  'growth-settings.json',
  'emotion.json',
];

/** 迁移标记：放在 **userData** 里，保证"一辈子只迁一次"。 */
const MIGRATION_MARKER = '.migrated-to-project';

/** 项目内的数据目录名。 */
const PROJECT_DATA_DIR = 'data';

export function resolveDataDir(options: DataDirOptions): DataDirResolution {
  const override = (options.envOverride ?? '').trim();
  if (override !== '') {
    return { dir: override, source: 'override', migrated: [], note: '环境变量覆盖（验收/调试用）' };
  }

  const projectDir = join(options.appRoot, PROJECT_DATA_DIR);
  const existed = existsSync(projectDir);
  const writable = ensureWritable(projectDir, options.logger);

  if (!writable) {
    return {
      dir: options.userDataDir,
      source: 'userdata',
      migrated: [],
      note: `项目目录不可写（${projectDir}），已退回 userData`,
    };
  }

  const migrated = migrateOnce({
    target: projectDir,
    source: options.userDataDir,
    wasEmpty: !existed,
    logger: options.logger,
  });

  return {
    dir: projectDir,
    source: 'project',
    migrated,
    note: '数据在项目目录下（data/）',
  };
}

/**
 * 确保目录存在且**真的可写**：只 `mkdirSync` 不够 —— 目录可能已存在但只读
 * （例如从别处拷来的仓库、或 UAC 保护的位置）。写一个临时文件再删掉才作数。
 */
function ensureWritable(dir: string, logger: Logger): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, '.write-probe');
    writeFileSync(probe, 'ok', 'utf8');
    unlinkSync(probe);
    return true;
  } catch (error) {
    logger.warn('project data dir is not writable; falling back to userData', {
      error: describeError(error),
      data: { dir },
    });
    return false;
  }
}

/**
 * 从 userData 一次性复制老数据进来。
 *
 * 三个条件同时满足才迁移：目标目录此前**不存在**、userData 里**没有**迁移标记、
 * 源目录里确实有她的数据。复制用 `force: false`：绝不覆盖新目录里已有的东西。
 */
function migrateOnce(input: {
  readonly target: string;
  readonly source: string;
  readonly wasEmpty: boolean;
  readonly logger: Logger;
}): string[] {
  const marker = join(input.source, MIGRATION_MARKER);
  if (!input.wasEmpty || existsSync(marker)) return [];
  if (!existsSync(input.source)) return [];

  const present = DATA_ENTRIES.filter((entry) => existsSync(join(input.source, entry)));
  if (present.length === 0) return [];

  const copied: string[] = [];
  for (const entry of present) {
    try {
      const from = join(input.source, entry);
      const to = join(input.target, entry);
      if (statSync(from).isDirectory()) {
        cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
      } else {
        copyFileSync(from, to);
      }
      copied.push(entry);
    } catch (error) {
      // 单个条目失败不影响其它：记忆宁可少迁一块，也不能整体起不来
      input.logger.warn('migrating a data entry failed', {
        error: describeError(error),
        data: { entry },
      });
    }
  }

  try {
    writeFileSync(marker, new Date().toISOString(), 'utf8');
  } catch (error) {
    input.logger.warn('writing migration marker failed', { error: describeError(error) });
  }

  input.logger.info('data dir migrated into the project folder', {
    data: { from: input.source, to: input.target, entries: copied.join(',') },
  });
  return copied;
}
