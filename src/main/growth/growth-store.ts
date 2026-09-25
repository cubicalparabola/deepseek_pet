/**
 * 成长与反思的落盘（4.1 记忆宫殿 / 4.2 反思与策略）。
 *
 * `<userData>/` 下：
 *   growth-settings.json               开关（默认全开）
 *   memory/nodes.json                  记忆节点（记忆宫殿的数据）
 *   memory/palace.md                   **可读镜像**：用户可以直接看/直接改
 *   reflection/YYYY-MM-DD.json         每天的反思（结构化）
 *   reflection/feedback-YYYY-MM-DD.jsonl 主动开口的反馈流水（有没有被回应）
 *   reflection/policy.json             策略叠加层（反思的"结论"落在这里）
 *   reflection/policy-log.md           策略调整历史（可审计、可回退）
 *
 * 为什么反思与策略要留"历史文件"：
 * 4.2 是**会改变她行为**的功能。用户必须能回答"她为什么最近变安静了"，
 * 所以每次调整都要留痕，并且能一键重置（见 GrowthService.resetPolicy）。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  GrowthSettings,
  InterventionFeedback,
  MemoryNode,
  MemoryNodeKind,
  PolicyOverlay,
  ReflectionEntry,
} from '../../shared/growth-types';
import { DEFAULT_GROWTH_SETTINGS, NODE_KINDS } from '../../shared/growth-types';
import { clampOverlay, defaultPolicyOverlay } from '../../shared/growth';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export interface GrowthStoreOptions {
  readonly dataDir: string;
  readonly logger: Logger;
}

const VALID_KINDS = Object.keys(NODE_KINDS) as MemoryNodeKind[];

export class GrowthStore {
  private readonly logger: Logger;
  private readonly dir: string;
  private readonly settingsFile: string;
  private readonly nodesFile: string;
  private readonly palaceFile: string;
  private readonly reflectionDir: string;
  private readonly policyFile: string;
  private readonly policyLogFile: string;

  private settings: GrowthSettings = { ...DEFAULT_GROWTH_SETTINGS };
  private nodes: MemoryNode[] = [];
  private policy: PolicyOverlay = defaultPolicyOverlay();

  public constructor(options: GrowthStoreOptions) {
    this.logger = options.logger;
    this.dir = join(options.dataDir, 'memory');
    this.settingsFile = join(options.dataDir, 'growth-settings.json');
    this.nodesFile = join(this.dir, 'nodes.json');
    this.palaceFile = join(this.dir, 'palace.md');
    this.reflectionDir = join(options.dataDir, 'reflection');
    this.policyFile = join(this.reflectionDir, 'policy.json');
    this.policyLogFile = join(this.reflectionDir, 'policy-log.md');
  }

  /* ------------------------------------------------------------------ */
  /* 路径                                                                */
  /* ------------------------------------------------------------------ */

  public get memoryDir(): string {
    return this.dir;
  }

  public get reflectDir(): string {
    return this.reflectionDir;
  }

  public get palacePath(): string {
    return this.palaceFile;
  }

  public get policyLogPath(): string {
    return this.policyLogFile;
  }

  /* ------------------------------------------------------------------ */
  /* 读                                                                  */
  /* ------------------------------------------------------------------ */

  public load(): { settings: GrowthSettings; nodes: MemoryNode[]; policy: PolicyOverlay } {
    this.settings = this.readSettings();
    this.nodes = this.readNodes();
    this.policy = this.readPolicy();
    this.logger.info('growth store loaded', {
      data: { palace: this.settings.palace, reflection: this.settings.reflection, nodes: this.nodes.length },
    });
    return { settings: this.settings, nodes: this.nodes, policy: this.policy };
  }

  public getSettings(): GrowthSettings {
    return this.settings;
  }

  public getNodes(): readonly MemoryNode[] {
    return this.nodes;
  }

  public getPolicy(): PolicyOverlay {
    return this.policy;
  }

  /** 策略是否从未调整过（"重置"按钮据此决定是否可用）。 */
  public get policyPristine(): boolean {
    return (
      this.policy.adjustments === 0 &&
      this.policy.minIntervalFactor === 1 &&
      this.policy.maxPerHourFactor === 1 &&
      Object.keys(this.policy.sceneFactors).length === 0
    );
  }

  /** 每条反思的保留天数（默认 180）—— 让 `keepReflectionDays` 真的起作用。 */
  public readonly keepReflectionDays: number = 180;

  /**
   * 删掉超期的反思与反馈流水。
   *
   * 为什么敢删：反思是"当天感想"，长期价值已经在记忆宫殿的节点里沉淀过了；
   * 留一堆 JSON 只会让目录越来越乱。归档动作会写进策略日志（可追溯到"哪几天被清了"）。
   */
  public pruneReflections(keepDays: number, now: number = Date.now()): number {
    // 目录还不存在（从未反思过）就直接返回：这不是错误，不该在日志里刷一条
    if (!existsSync(this.reflectionDir)) return 0;
    const cutoff = new Date(now - Math.max(7, keepDays) * 86400000);
    let removed = 0;
    try {
      for (const file of readdirSync(this.reflectionDir)) {
        const matched = /^(\d{4}-\d{2}-\d{2})\.(json|md)$/.exec(file);
        const day = matched?.[1];
        if (!day) continue;
        if (new Date(`${day}T00:00:00`).getTime() >= cutoff.getTime()) continue;
        rmSync(join(this.reflectionDir, file), { force: true });
        removed += 1;
      }
      for (const file of readdirSync(this.reflectionDir)) {
        const matched = /^feedback-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
        const day = matched?.[1];
        if (!day) continue;
        if (new Date(`${day}T00:00:00`).getTime() >= cutoff.getTime()) continue;
        rmSync(join(this.reflectionDir, file), { force: true });
        removed += 1;
      }
    } catch (error) {
      this.logger.debug('pruning reflections failed', { error: describeError(error) });
    }
    if (removed > 0) this.logger.info('old reflections pruned', { data: { removed, keepDays } });
    return removed;
  }

  /* ------------------------------------------------------------------ */
  /* 写：设置                                                            */
  /* ------------------------------------------------------------------ */

  public saveSettings(settings: GrowthSettings): GrowthSettings {
    this.settings = settings;
    this.writeJson(this.settingsFile, settings);
    return settings;
  }

  /* ------------------------------------------------------------------ */
  /* 写：节点                                                            */
  /* ------------------------------------------------------------------ */

  public saveNodes(nodes: readonly MemoryNode[]): void {
    this.nodes = [...nodes];
    this.writeJson(this.nodesFile, this.nodes);
  }

  /** 写可读镜像（`memory/palace.md`）。 */
  public savePalaceMarkdown(markdown: string): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.palaceFile, markdown, 'utf8');
    } catch (error) {
      this.logger.warn('writing palace.md failed', { error: describeError(error) });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 写：反思与策略                                                       */
  /* ------------------------------------------------------------------ */

  public saveReflection(entry: ReflectionEntry): void {
    try {
      mkdirSync(this.reflectionDir, { recursive: true });
      const file = join(this.reflectionDir, `${entry.date}.json`);
      const temp = `${file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
      renameSync(temp, file);
      // 同时写一份人可读的 markdown（用户真正会打开的是这个）
      const md = join(this.reflectionDir, `${entry.date}.md`);
      writeFileSync(
        md,
        `# ${entry.date} 的反思\n\n${entry.body}\n\n---\n\n- 来源：${entry.source === 'llm' ? '大模型' : '本地模板'}\n- 当天主动开口 ${entry.stats.interventions} 次，被回应 ${entry.stats.responded} 次\n- 对话 ${entry.stats.turnCount} 轮 · 心情 ${entry.stats.moodStart} → ${entry.stats.moodEnd}\n` +
          (entry.insights.length > 0
            ? `- 结论：${entry.insights.map((item) => `${item.scene || '全局'} ${item.action}（${item.reason}）`).join('；')}\n`
            : '- 结论：保持现状\n'),
        'utf8',
      );
    } catch (error) {
      this.logger.warn('saving reflection failed', { error: describeError(error), data: { date: entry.date } });
    }
  }

  public readReflection(date: string): ReflectionEntry | null {
    const file = join(this.reflectionDir, `${date}.json`);
    if (!existsSync(file)) return null;
    try {
      return sanitizeReflection(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      this.logger.warn('reading reflection failed', { error: describeError(error), data: { date } });
      return null;
    }
  }

  /** 最近的反思（倒序，最多 limit 条）。 */
  public recentReflections(limit = 7): ReflectionEntry[] {
    try {
      const dates = readdirSync(this.reflectionDir)
        .map((file) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(file)?.[1])
        .filter((date): date is string => typeof date === 'string')
        .sort()
        .reverse()
        .slice(0, limit);
      return dates.map((date) => this.readReflection(date)).filter((entry): entry is ReflectionEntry => entry !== null);
    } catch {
      return [];
    }
  }

  public hasReflection(date: string): boolean {
    return existsSync(join(this.reflectionDir, `${date}.json`));
  }

  public savePolicy(policy: PolicyOverlay): void {
    this.policy = clampOverlay(policy);
    this.writeJson(this.policyFile, this.policy);
  }

  /** 追加策略调整历史（人可读）。 */
  public logPolicyAdjustment(applied: readonly string[], overlay: PolicyOverlay): void {
    if (applied.length === 0) return;
    try {
      mkdirSync(this.reflectionDir, { recursive: true });
      if (!existsSync(this.policyLogFile)) {
        writeFileSync(
          this.policyLogFile,
          '# 行为策略调整历史\n\n> 每次自我反思改变了她的打扰策略都会记在这里。\n> 想让她回到你的原始设置，在设置窗口点「重置策略」即可。\n\n',
          'utf8',
        );
      }
      const time = new Date().toISOString().slice(0, 16).replace('T', ' ');
      appendFileSync(
        this.policyLogFile,
        `- ${time} · 间隔×${overlay.minIntervalFactor.toFixed(2)} 上限×${overlay.maxPerHourFactor.toFixed(2)} —— ${applied.join('；')}\n`,
        'utf8',
      );
    } catch (error) {
      this.logger.warn('logging policy adjustment failed', { error: describeError(error) });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 写：干预反馈流水                                                     */
  /* ------------------------------------------------------------------ */

  public appendFeedback(item: InterventionFeedback): void {
    try {
      mkdirSync(this.reflectionDir, { recursive: true });
      const day = item.at.slice(0, 10);
      appendFileSync(join(this.reflectionDir, `feedback-${day}.jsonl`), `${JSON.stringify(item)}\n`, 'utf8');
    } catch (error) {
      this.logger.warn('appending intervention feedback failed', { error: describeError(error) });
    }
  }

  /**
   * 读某天的反馈流水。
   *
   * ⚠️ 反馈是**先写"未回应"，回应后追加一条覆盖记录**（append-only 的简化做法）：
   * 读取时按 `at` 去重，后者覆盖前者。
   */
  public readFeedback(date: string): InterventionFeedback[] {
    const file = join(this.reflectionDir, `feedback-${date}.jsonl`);
    if (!existsSync(file)) return [];
    try {
      const byKey = new Map<string, InterventionFeedback>();
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const parsed = JSON.parse(trimmed) as InterventionFeedback;
          if (typeof parsed.at !== 'string') continue;
          byKey.set(`${parsed.at}|${parsed.text}`, {
            at: parsed.at,
            kind: typeof parsed.kind === 'string' ? parsed.kind : 'unknown',
            text: typeof parsed.text === 'string' ? parsed.text : '',
            scene: typeof parsed.scene === 'string' ? parsed.scene : '',
            responded: parsed.responded === true,
            responseSeconds: typeof parsed.responseSeconds === 'number' ? parsed.responseSeconds : null,
          });
        } catch {
          /* 单行坏了就跳过 */
        }
      }
      return [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
    } catch (error) {
      this.logger.warn('reading intervention feedback failed', { error: describeError(error), data: { date } });
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /* 内部                                                                */
  /* ------------------------------------------------------------------ */

  private readSettings(): GrowthSettings {
    if (!existsSync(this.settingsFile)) return { ...DEFAULT_GROWTH_SETTINGS };
    try {
      return sanitizeGrowthSettings(JSON.parse(readFileSync(this.settingsFile, 'utf8')));
    } catch (error) {
      this.logger.error('growth-settings.json parse failed; using defaults', { error: describeError(error) });
      return { ...DEFAULT_GROWTH_SETTINGS };
    }
  }

  private readNodes(): MemoryNode[] {
    if (!existsSync(this.nodesFile)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.nodesFile, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => sanitizeNode(item))
        .filter((node): node is MemoryNode => node !== null)
        .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.at.localeCompare(a.at)));
    } catch (error) {
      this.logger.error('nodes.json parse failed; starting empty', { error: describeError(error) });
      return [];
    }
  }

  private readPolicy(): PolicyOverlay {
    if (!existsSync(this.policyFile)) return defaultPolicyOverlay();
    try {
      const parsed = JSON.parse(readFileSync(this.policyFile, 'utf8')) as Partial<PolicyOverlay>;
      return clampOverlay({
        minIntervalFactor: typeof parsed.minIntervalFactor === 'number' ? parsed.minIntervalFactor : 1,
        maxPerHourFactor: typeof parsed.maxPerHourFactor === 'number' ? parsed.maxPerHourFactor : 1,
        sceneFactors: typeof parsed.sceneFactors === 'object' && parsed.sceneFactors !== null ? parsed.sceneFactors : {},
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
        adjustments: typeof parsed.adjustments === 'number' ? Math.max(0, Math.round(parsed.adjustments)) : 0,
      });
    } catch (error) {
      this.logger.error('policy.json parse failed; using neutral policy', { error: describeError(error) });
      return defaultPolicyOverlay();
    }
  }

  private writeJson(file: string, value: unknown): void {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      renameSync(temp, file);
    } catch (error) {
      this.logger.error('growth write failed', { error: describeError(error), data: { file } });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 清洗                                                                        */
/* -------------------------------------------------------------------------- */

export function sanitizeGrowthSettings(raw: unknown, fallback: GrowthSettings = DEFAULT_GROWTH_SETTINGS): GrowthSettings {
  if (typeof raw !== 'object' || raw === null) return { ...fallback };
  const record = raw as Record<string, unknown>;
  const bool = (value: unknown, preset: boolean): boolean => (typeof value === 'boolean' ? value : preset);
  const hour = typeof record.reflectionHour === 'number' && Number.isFinite(record.reflectionHour)
    ? Math.min(23, Math.max(0, Math.round(record.reflectionHour)))
    : fallback.reflectionHour;
  const keep = typeof record.keepReflectionDays === 'number' && Number.isFinite(record.keepReflectionDays)
    ? Math.min(3650, Math.max(7, Math.round(record.keepReflectionDays)))
    : fallback.keepReflectionDays;
  return {
    palace: bool(record.palace, fallback.palace),
    reflection: bool(record.reflection, fallback.reflection),
    policyAdapt: bool(record.policyAdapt, fallback.policyAdapt),
    reflectionHour: hour,
    firstMeetAt: typeof record.firstMeetAt === 'string' ? record.firstMeetAt.slice(0, 40) : fallback.firstMeetAt,
    keepReflectionDays: keep,
  };
}

function sanitizeNode(raw: unknown): MemoryNode | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const kind = typeof record.kind === 'string' && (VALID_KINDS as string[]).includes(record.kind)
    ? (record.kind as MemoryNodeKind)
    : 'manual';
  const title = typeof record.title === 'string' ? record.title.trim().slice(0, 120) : '';
  if (title === '') return null;
  const at = typeof record.at === 'string' && Number.isFinite(Date.parse(record.at)) ? record.at : new Date().toISOString();
  return {
    id: typeof record.id === 'string' && record.id !== '' ? record.id : `n${Math.abs(hashString(`${kind}|${title}`)).toString(36)}`,
    kind,
    title,
    detail: typeof record.detail === 'string' ? record.detail.slice(0, 400) : '',
    at,
    source: record.source === 'llm' || record.source === 'manual' ? record.source : 'auto',
    evidence: Array.isArray(record.evidence)
      ? (record.evidence as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [],
    hits: typeof record.hits === 'number' && record.hits > 0 ? Math.round(record.hits) : 1,
    pinned: record.pinned === true,
  };
}

function sanitizeReflection(raw: unknown): ReflectionEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const date = typeof record.date === 'string' ? record.date : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const insights = Array.isArray(record.insights)
    ? (record.insights as unknown[])
        .map((item) => {
          if (typeof item !== 'object' || item === null) return null;
          const entry = item as Record<string, unknown>;
          if (entry.action !== 'quiet-down' && entry.action !== 'keep' && entry.action !== 'speak-up') return null;
          return {
            scene: typeof entry.scene === 'string' ? entry.scene.slice(0, 24) : '',
            action: entry.action,
            reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 120) : '',
          };
        })
        .filter((item): item is ReflectionEntry['insights'][number] => item !== null)
    : [];
  const stats = (typeof record.stats === 'object' && record.stats !== null ? record.stats : {}) as Record<string, unknown>;
  const number = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  return {
    date,
    body: typeof record.body === 'string' ? record.body : '',
    insights,
    source: record.source === 'llm' ? 'llm' : 'template',
    tokens: number(record.tokens),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    stats: {
      interventions: number(stats.interventions),
      responded: number(stats.responded),
      turnCount: number(stats.turnCount),
      moodStart: number(stats.moodStart),
      moodEnd: number(stats.moodEnd),
    },
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash;
}
