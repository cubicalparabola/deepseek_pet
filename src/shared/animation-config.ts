/**
 * 动画 Manifest 校验 / 归一化（Main 与 Renderer 共用同一套规则）。
 *
 * 校验目标（对应“错误处理”要求）：
 * - Manifest 结构错误 -> ConfigError(CONFIG_INVALID)
 * - 重复 animation ID  -> ConfigError(DUPLICATE_ID)
 * - 未知 type          -> 跳过并记录（不阻塞其它动画）
 * - source 越界/非法    -> 跳过并记录
 */

import {
  ANIMATION_DEFAULTS,
  type AnimationDefinition,
  type AnimationKind,
  type AnimationManifest,
  type AnimationManifestEntry,
  type AnimationType,
  type PersistentSegments,
  type ResolvedAnimation,
} from './animation-types';
import { ConfigError } from './errors';

const SUPPORTED_TYPES: readonly AnimationType[] = ['video', 'image'];
const VIDEO_EXTENSIONS = ['.webm', '.mp4', '.m4v', '.ogv'] as const;
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'] as const;

export interface ManifestValidationIssue {
  readonly id: string;
  readonly level: 'warn' | 'error';
  readonly message: string;
}

export interface ManifestValidationResult {
  readonly animations: ReadonlyMap<string, ResolvedAnimation>;
  readonly issues: readonly ManifestValidationIssue[];
  /** 兜底动画 id（manifest 中 fallback=true 的那条，否则 'idle'，再否则第一条）。 */
  readonly fallbackId: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRelativeSource(source: string): string | null {
  const trimmed = source.trim().replace(/\\/g, '/');
  if (trimmed === '') return null;
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return null;
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) return null;
  return segments.join('/');
}

/** 路径扩展名是否与该动画类型匹配。 */
function extensionMatches(source: string, type: AnimationType): boolean {
  const extension = source.slice(source.lastIndexOf('.')).toLowerCase();
  const allowed = type === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
  return (allowed as readonly string[]).includes(extension);
}

/**
 * 归一化持续动画的分段配置。
 *
 * 规则：
 * - `start` / `loop` / `end` 都是可选的，但**至少要有一个**（否则不叫分段动画）；
 * - 每段路径都必须合法且扩展名与 type 匹配；
 * - `loopCount` 必须是正整数；0 或非法值 = 无限循环（省略该字段）；
 * - **只有 `loop` 而没有 `end`** 时给出警告（循环次数用完后会直接结束，没有收尾动作）。
 */
function normalizeSegments(
  raw: unknown,
  type: AnimationType,
  id: string,
  issues: ManifestValidationIssue[],
): { segments: PersistentSegments } | { error: string } {
  if (!isPlainObject(raw)) return { error: 'segments 必须是对象' };

  const normalize = (key: 'start' | 'loop' | 'end'): string | undefined | { error: string } => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') return { error: `segments.${key} 必须是字符串路径` };
    const normalized = normalizeRelativeSource(value);
    if (!normalized) return { error: `segments.${key} 路径非法` };
    if (!extensionMatches(normalized, type)) {
      return { error: `segments.${key} 扩展名与 type "${type}" 不匹配` };
    }
    return normalized;
  };

  const start = normalize('start');
  if (start && typeof start === 'object') return start;
  const loop = normalize('loop');
  if (loop && typeof loop === 'object') return loop;
  const end = normalize('end');
  if (end && typeof end === 'object') return end;

  if (!start && !loop && !end) {
    return { error: 'segments 至少要指定 start / loop / end 之一' };
  }

  const loopCount =
    typeof raw.loopCount === 'number' && Number.isFinite(raw.loopCount) && raw.loopCount > 0
      ? Math.floor(raw.loopCount)
      : undefined;

  if (loop && !end && loopCount !== undefined) {
    issues.push({
      id,
      level: 'warn',
      message: `持续动画配置了 loopCount=${loopCount} 但没有 end 段，循环结束后将直接结束（没有收尾动作）`,
    });
  }

  return {
    segments: {
      ...(start ? { start } : {}),
      ...(loop ? { loop } : {}),
      ...(end ? { end } : {}),
      ...(loopCount !== undefined ? { loopCount } : {}),
    },
  };
}

/**
 * 归一化单条定义。
 *
 * @param issues 用于收集"不致命但值得提醒"的问题（例如持续动画没配 end 段）。
 * @returns 归一化后的定义，或 error 原因。
 */
export function normalizeAnimation(
  id: string,
  entry: AnimationManifestEntry,
  issues: ManifestValidationIssue[] = [],
): { animation: ResolvedAnimation } | { error: string } {
  if (typeof id !== 'string' || id.trim() === '') return { error: '缺少 id' };
  if (!isPlainObject(entry)) return { error: '定义必须是对象' };

  const type = entry.type;
  if (typeof type !== 'string') return { error: '缺少 type' };
  if (!SUPPORTED_TYPES.includes(type as AnimationType)) {
    return { error: `不支持的动画类型 "${type}"（当前支持 video / image）` };
  }

  const source = typeof entry.source === 'string' ? normalizeRelativeSource(entry.source) : null;
  if (!source) return { error: 'source 非法或为空（必须是 assets/ 下的相对路径）' };

  const priority =
    typeof entry.priority === 'number' && Number.isFinite(entry.priority)
      ? entry.priority
      : ANIMATION_DEFAULTS.priority;

  const cooldown =
    typeof entry.cooldown === 'number' && Number.isFinite(entry.cooldown) && entry.cooldown >= 0
      ? entry.cooldown
      : ANIMATION_DEFAULTS.cooldown;

  const interruptible =
    typeof entry.interruptible === 'boolean' ? entry.interruptible : ANIMATION_DEFAULTS.interruptible;

  const loop = typeof entry.loop === 'boolean'
    ? entry.loop
    : type === 'video'
      ? ANIMATION_DEFAULTS.videoLoop
      : ANIMATION_DEFAULTS.imageLoop;

  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((tag): tag is string => typeof tag === 'string')
    : undefined;

  const extension = source.slice(source.lastIndexOf('.')).toLowerCase();
  const extensionOk = type === 'video'
    ? (VIDEO_EXTENSIONS as readonly string[]).includes(extension)
    : (IMAGE_EXTENSIONS as readonly string[]).includes(extension);

  if (!extensionOk) {
    return { error: `source 扩展名 ${extension || '(无)'} 与 type "${type}" 不匹配` };
  }

  /*
   * 形态判定（一次性 / 持续）：
   * - 写了 `segments` 就是持续动画；
   * - 显式 `"kind": "one-shot"` 可以强制一次性（覆盖上面的推导）；
   * - 其余一律一次性。
   */
  let segments: PersistentSegments | undefined;
  if (entry.segments !== undefined) {
    const result = normalizeSegments(entry.segments, type as AnimationType, id, issues);
    if ('error' in result) return { error: result.error };
    segments = result.segments;
  }

  const explicitKind: AnimationKind | null =
    entry.kind === 'persistent' ? 'persistent' : entry.kind === 'one-shot' ? 'one-shot' : null;
  const kind: AnimationKind = explicitKind ?? (segments !== undefined ? 'persistent' : 'one-shot');

  if (kind === 'persistent' && segments === undefined) {
    issues.push({
      id,
      level: 'warn',
      message: '声明为 persistent 但没有 segments，将按一次性动画播放',
    });
  }

  const animation: ResolvedAnimation = {
    id,
    type: type as AnimationType,
    source,
    loop,
    priority,
    interruptible,
    cooldown,
    kind,
    ...(segments ? { segments } : {}),
    ...(tags ? { tags } : {}),
    ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
    ...(isPlainObject(entry.render) ? { render: entry.render } : {}),
    ...(entry.fallback === true ? { fallback: true } : {}),
  };

  return { animation };
}

/**
 * 校验整个 Manifest。
 * 单条记录失败不会让整体失败（返回 issues），但顶层结构错误会抛 ConfigError。
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  if (!isPlainObject(raw)) {
    throw new ConfigError('animations.json 顶层必须是对象：{ "id": { ...definition } }', {
      code: 'CONFIG_INVALID',
      module: 'AnimationConfig',
    });
  }

  const animations = new Map<string, ResolvedAnimation>();
  const issues: ManifestValidationIssue[] = [];

  for (const [rawId, rawEntry] of Object.entries(raw)) {
    const id = rawId.trim();
    if (id === '') {
      issues.push({ id: rawId, level: 'error', message: '空 id，已跳过' });
      continue;
    }
    if (animations.has(id)) {
      issues.push({ id, level: 'error', message: '重复的 animation id，已跳过后者' });
      continue;
    }
    if (!isPlainObject(rawEntry)) {
      issues.push({ id, level: 'error', message: '定义必须是对象，已跳过' });
      continue;
    }

    const entryId = typeof rawEntry.id === 'string' && rawEntry.id.trim() !== '' ? rawEntry.id.trim() : id;
    if (entryId !== id) {
      issues.push({ id, level: 'warn', message: `定义里的 id "${entryId}" 与 key 不一致，以 key 为准` });
    }
    if (animations.has(entryId)) {
      issues.push({ id: entryId, level: 'error', message: '重复的 animation id，已跳过' });
      continue;
    }

    const result = normalizeAnimation(entryId, rawEntry as AnimationManifestEntry, issues);
    if ('error' in result) {
      issues.push({ id: entryId, level: 'error', message: `${result.error}，已跳过` });
      continue;
    }
    animations.set(entryId, result.animation);
  }

  const explicitFallback = [...animations.values()].find((animation) => animation.fallback === true);
  const fallbackId = explicitFallback?.id ?? (animations.has('idle') ? 'idle' : (animations.keys().next().value ?? null));

  if (animations.size === 0) {
    issues.push({ id: '(manifest)', level: 'error', message: '没有任何有效动画定义' });
  }

  return { animations, issues, fallbackId };
}

/** 把已验证的 Map 转回普通对象，便于通过 IPC 传输。 */
export function manifestToRecord(
  animations: ReadonlyMap<string, AnimationDefinition>,
): Record<string, AnimationDefinition> {
  const record: Record<string, AnimationDefinition> = {};
  for (const [id, definition] of animations) record[id] = definition;
  return record;
}

/** 从任意输入解析出 Map（供 renderer 校验 IPC 下发或插件注册使用）。 */
export function manifestFromUnknown(raw: unknown): ManifestValidationResult {
  return validateManifest(raw);
}

export type { AnimationManifest };
