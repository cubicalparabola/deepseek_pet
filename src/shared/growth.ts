/**
 * 成长与反思的**纯函数模型**（4.1 节点沉淀 / 4.2 策略调整）。
 *
 * 这些规则决定了"她记什么"和"她以后少说话还是多说话"，必须可被直接断言 ——
 * 否则只能靠"用几天看看她烦不烦我"来验证。
 *
 * 关键约束（写在类型里也写在函数里）：
 * - 节点要**去重**：同一种经历反复触发只累加 hits，不在时间轴上刷屏；
 * - 策略**只能收紧**：`clampOverlay` 把所有乘数夹在 [POLICY_MIN_FACTOR, 1]，
 *   因此她永远不会变得比用户设定的更聒噪。
 */

import type {
  GrowthSettings,
  InterventionFeedback,
  MemoryNode,
  MemoryNodeDraft,
  MemoryNodeKind,
  PolicyOverlay,
  ReflectionInsight,
} from './growth-types';
import { NODE_KINDS, POLICY_MIN_FACTOR } from './growth-types';
import type { PerceptionSettings } from './perception-types';

/* -------------------------------------------------------------------------- */
/* 一、4.1 记忆节点                                                            */
/* -------------------------------------------------------------------------- */

/** 节点种类的中文标签（含 emoji）。 */
export function nodeLabel(kind: MemoryNodeKind): string {
  const entry = NODE_KINDS[kind] ?? NODE_KINDS.manual;
  return `${entry.emoji} ${entry.label}`;
}

/** 稳定的节点 id（同类 + 同标题 + 同月 -> 同一个节点，天然去重）。 */
export function nodeId(draft: Pick<MemoryNodeDraft, 'kind' | 'title' | 'at'>): string {
  const month = draft.at.slice(0, 7);
  const slug = `${draft.kind}:${draft.title.trim().toLowerCase()}:${month}`;
  let hash = 2166136261;
  for (let index = 0; index < slug.length; index += 1) {
    hash ^= slug.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `n${(hash >>> 0).toString(36)}`;
}

/**
 * 合并新节点到已有时间轴。
 *
 * 去重规则（对"记忆宫殿"尤其重要）：
 * - 同 id（同种类 + 同标题 + **同月**）→ 只累加 hits、补充证据、刷新时间；
 * - 标题相同但换月（例如"熬夜赶论文"在 3 月和 5 月各一次）→ 视为两段经历，各留一条。
 */
export function mergeNodes(
  existing: readonly MemoryNode[],
  drafts: readonly MemoryNodeDraft[],
): { nodes: MemoryNode[]; added: MemoryNode[]; updated: MemoryNode[] } {
  const nodes = [...existing];
  const added: MemoryNode[] = [];
  const updated: MemoryNode[] = [];

  for (const draft of drafts) {
    const title = draft.title.trim();
    if (title === '') continue;
    const id = nodeId({ ...draft, title });
    const index = nodes.findIndex((node) => node.id === id);
    if (index >= 0) {
      const current = nodes[index];
      if (!current) continue;
      const evidence = dedupeStrings([...current.evidence, ...draft.evidence]).slice(0, 8);
      const next: MemoryNode = {
        ...current,
        detail: draft.detail.trim() !== '' ? draft.detail : current.detail,
        at: draft.at < current.at ? draft.at : current.at,
        evidence,
        hits: current.hits + 1,
        // 用户手动写的内容与"钉住"状态不被自动更新覆盖
        source: current.source === 'manual' ? 'manual' : draft.source,
      };
      nodes[index] = next;
      updated.push(next);
      continue;
    }
    const node: MemoryNode = {
      id,
      kind: draft.kind,
      title,
      detail: draft.detail.slice(0, 400),
      at: draft.at,
      source: draft.source,
      evidence: dedupeStrings(draft.evidence).slice(0, 8),
      hits: 1,
      pinned: false,
    };
    nodes.push(node);
    added.push(node);
  }

  // 时间轴倒序（新的在前）；钉住的排最前
  nodes.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.at.localeCompare(a.at);
  });
  return { nodes, added, updated };
}

/** 按年月分组统计（UI 时间轴的分组头）。 */
export function groupByMonth(nodes: readonly MemoryNode[]): { month: string; count: number }[] {
  const buckets = new Map<string, number>();
  for (const node of nodes) {
    const month = node.at.slice(0, 7);
    buckets.set(month, (buckets.get(month) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, count]) => ({ month, count }));
}

export interface NodeSuggestionInput {
  readonly now: number;
  /** 第一次见面时间（用户可改；空串表示还没定）。 */
  readonly firstMeetAt: string;
  /** 当天（或指定区间）的对话片段。 */
  readonly messages: readonly string[];
  /** 当晚是否有深夜活动（本地信号，不依赖模型）。 */
  readonly lateNight: boolean;
  /** 已经存在的节点（用于"第一次"类判断与去重）。 */
  readonly existing: readonly MemoryNode[];
  /** 当天情绪曲线的低点（用于情绪时刻）。 */
  readonly moodLow: number;
  /** 场景直方图（用于"养成的习惯"）。 */
  readonly sceneCounts: Readonly<Record<string, number>>;
  /** 稳定采样总量（习惯节点的门槛）。 */
  readonly habitSamples: number;
}

/**
 * 从当天素材里"猜"出值得沉淀的节点（**规则**路径，不联网）。
 *
 * 只在语义足够明确时才产出节点：
 * - `first-meet`：还没有这个节点时补一条（用 `firstMeetAt`，缺省用当前时间）；
 * - `birthday` / `milestone` / `project` / `trip`：关键词命中；
 * - `late-night`：当天确有深夜活动；
 * - `habit`：某个场景的采样数达到门槛（说明是稳定习惯，不是偶尔一次）；
 * - `emotion`：当天心情低点很低（她记得"那天主人不太好"）。
 */
export function suggestNodes(input: NodeSuggestionInput): MemoryNodeDraft[] {
  const drafts: MemoryNodeDraft[] = [];
  const nowIso = new Date(input.now).toISOString();
  const has = (kind: MemoryNodeKind): boolean => input.existing.some((node) => node.kind === kind);

  if (!has('first-meet')) {
    drafts.push({
      kind: 'first-meet',
      title: '我们第一次见面',
      detail: '从这天起，我住进了你的桌面。',
      at: input.firstMeetAt !== '' ? input.firstMeetAt : nowIso,
      source: 'auto',
      evidence: [],
    });
  }

  const birthday = matchLine(input.messages, /(生日|生日快乐|birthday)/i);
  if (birthday) {
    drafts.push({
      kind: 'birthday',
      title: '一起过生日',
      detail: '那天我们聊到了生日。',
      at: nowIso,
      source: 'auto',
      evidence: [birthday],
    });
  }

  const milestone = matchLine(input.messages, /(终于|搞定|完成|上线|跑通|通过了|拿到|毕业|发表)/);
  /*
   * ⚠️ 里程碑的主题要取**名词本身**，不能取"名词后面那段话"。
   *
   * 早期版本复用动词式抽取（取匹配后的文字），于是
   * "今天终于把论文投出去了" 抽出的主题是"投出去了"，标题成了
   * "投出去了有了进展" —— 读起来像乱码（截图验收抓到）。
   */
  const milestoneTopic = pickNoun(input.messages, /(论文|项目|考试|答辩|面试|比赛|模型|系统|产品|课程|作业|报告|设计)/);
  if (milestone && milestoneTopic) {
    drafts.push({
      kind: 'milestone',
      title: `${milestoneTopic}有了进展`,
      detail: `主人那天说「${milestoneTopic}」有进展了。`,
      at: nowIso,
      source: 'auto',
      evidence: [milestone],
    });
  }

  const project = pickTopic(input.messages, /(正在做|在做|在写|开发|训练|研究)/);
  if (project) {
    drafts.push({
      kind: 'project',
      title: `一起折腾「${project}」`,
      detail: '这段时间主人一直在忙它。',
      at: nowIso,
      source: 'auto',
      evidence: input.messages.filter((line) => line.includes(project)).slice(0, 2),
    });
  }

  const studyingAi = matchLine(input.messages, /(研究|学习|入门|开始学)\s*(AI|人工智能|机器学习|深度学习|大模型)/i);
  if (studyingAi) {
    drafts.push({
      kind: 'milestone',
      title: '开始研究 AI',
      detail: '主人开始认真研究 AI 了。',
      at: nowIso,
      source: 'auto',
      evidence: [studyingAi],
    });
  }

  const trip = matchLine(input.messages, /(出差|回家|旅行|放假|离开|不在几天)/);
  if (trip) {
    drafts.push({
      kind: 'trip',
      title: '要离开一段时间',
      detail: '主人说会有一阵子不在。',
      at: nowIso,
      source: 'auto',
      evidence: [trip],
    });
  }

  if (input.lateNight) {
    drafts.push({
      kind: 'late-night',
      title: '一起熬夜',
      detail: '那天到很晚，屏幕还亮着，我陪着。',
      at: nowIso,
      source: 'auto',
      evidence: [],
    });
  }

  if (input.moodLow < 25) {
    drafts.push({
      kind: 'emotion',
      title: '主人今天不太开心',
      detail: `那天我的心情也掉到了 ${input.moodLow}。`,
      at: nowIso,
      source: 'auto',
      evidence: [],
    });
  }

  if (input.habitSamples >= 20) {
    const top = Object.entries(input.sceneCounts).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 10) {
      drafts.push({
        kind: 'habit',
        title: `常常在${sceneName(top[0])}`,
        detail: `到这个阶段我已经看过 ${top[1]} 次了。`,
        at: nowIso,
        source: 'auto',
        evidence: [],
      });
    }
  }

  // 同一批里去重（避免"生日"与"里程碑"同时命中同一句话产生重复节点）
  const seen = new Set<string>();
  return drafts.filter((draft) => {
    const key = `${draft.kind}|${draft.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 节点 -> 一句话（她在聊天/气泡里提到这段经历时的说法）。 */
export function nodeSentence(node: MemoryNode): string {
  const label = NODE_KINDS[node.kind]?.label ?? '那段日子';
  return `${NODE_KINDS[node.kind]?.emoji ?? '📌'} ${label}：${node.title}`;
}

/** 记忆宫殿可读镜像（`memory/palace.md`）。 */
export function renderPalaceMarkdown(nodes: readonly MemoryNode[], daysTogether: number): string {
  const lines = [
    '# 🧠 鲸鱼娘的记忆宫殿',
    '',
    `> 我们已经一起经历了 ${daysTogether} 天，这里有 ${nodes.length} 段被记下的经历。`,
    '>',
    '> ⚠️ 这份文件是**只读镜像**（由 nodes.json 生成）：直接编辑它**不会**改变她记住的内容。',
    '> 想删掉某段经历，请在设置窗口的「记忆宫殿」里点删除，或编辑 `memory/nodes.json`。',
    '',
  ];
  let currentMonth = '';
  for (const node of nodes) {
    const month = node.at.slice(0, 7);
    if (month !== currentMonth) {
      currentMonth = month;
      lines.push(`## ${month}`, '');
    }
    const pinned = node.pinned ? ' 📌' : '';
    lines.push(`- ${node.at.slice(0, 10)} ${NODE_KINDS[node.kind]?.emoji ?? '📌'} **${node.title}**${pinned}`);
    if (node.detail) lines.push(`  - ${node.detail}`);
    if (node.evidence.length > 0) lines.push(`  - 依据：${node.evidence.slice(0, 2).join(' / ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* 二、4.2 反思与策略                                                          */
/* -------------------------------------------------------------------------- */

export function defaultPolicyOverlay(now: string = new Date().toISOString()): PolicyOverlay {
  return { minIntervalFactor: 1, maxPerHourFactor: 1, sceneFactors: {}, updatedAt: now, reason: '', adjustments: 0 };
}

/** 把所有乘数夹进 [POLICY_MIN_FACTOR, 1]：**只能收紧，不能放松**。 */
export function clampOverlay(overlay: PolicyOverlay): PolicyOverlay {
  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return 1;
    return Math.min(1, Math.max(POLICY_MIN_FACTOR, value));
  };
  const sceneFactors: Record<string, number> = {};
  for (const [scene, factor] of Object.entries(overlay.sceneFactors)) {
    if (typeof factor === 'number' && Number.isFinite(factor)) sceneFactors[scene] = clamp(factor);
  }
  return {
    ...overlay,
    minIntervalFactor: clamp(overlay.minIntervalFactor),
    maxPerHourFactor: clamp(overlay.maxPerHourFactor),
    sceneFactors,
  };
}

/**
 * 把反思洞见落成策略调整。
 *
 * 动作语义（**乘数的方向很关键**：factor 越小 = 打扰间隔越长 = 越克制）：
 * - `quiet-down`：倍率**减半**（×0.5，最低 0.25）—— 间隔随之翻倍；
 * - `speak-up`：倍率**翻倍**，但被 `clampOverlay` 夹在 ≤1，
 *   也就是"最多回到用户设定"，绝不会比用户设的更频繁；
 * - `keep`：不动。
 *
 * 选 0.5 而不是 0.7 是为了**可解释**：界面上显示的就是"间隔 ×2 / ×4"，
 * 没有 14.29 分钟这种读不懂的数字。
 */
export function applyInsights(
  current: PolicyOverlay,
  insights: readonly ReflectionInsight[],
  now: string = new Date().toISOString(),
): { overlay: PolicyOverlay; applied: string[] } {
  let minFactor = current.minIntervalFactor;
  let maxFactor = current.maxPerHourFactor;
  const sceneFactors: Record<string, number> = { ...current.sceneFactors };
  const applied: string[] = [];
  const step = (action: ReflectionInsight['action']): number => (action === 'quiet-down' ? 0.5 : 2);

  for (const insight of insights) {
    if (insight.action === 'keep') continue;
    const factorStep = step(insight.action);
    const verb = insight.action === 'quiet-down' ? '少打扰' : '可以多说话';
    const target = insight.scene !== '' ? insight.scene : '*';
    if (target === '*') {
      minFactor *= factorStep;
      maxFactor *= factorStep;
      applied.push(`全局：${verb}（${insight.reason}）`);
      continue;
    }
    sceneFactors[target] = (sceneFactors[target] ?? 1) * factorStep;
    applied.push(`${sceneName(target)}：${verb}（${insight.reason}）`);
  }

  const overlay = clampOverlay({
    minIntervalFactor: minFactor,
    maxPerHourFactor: maxFactor,
    sceneFactors,
    updatedAt: now,
    reason: applied[applied.length - 1] ?? current.reason,
    adjustments: current.adjustments + applied.length,
  });
  return { overlay, applied };
}

/**
 * 把"用户设置 + 策略叠加层 + 当前场景"算成**实际生效的感知设置**。
 *
 * 这是 4.2 与 3.4 的交界：反思不改用户的配置，只在用户配置之内收紧。
 * 例如用户设"最小间隔 10 分钟"，反思学出"写代码时少打扰"（0.5），
 * 那么写代码时实际间隔 = 10 / 0.5 = 20 分钟。
 */
export function effectivePerception(
  settings: PerceptionSettings,
  overlay: PolicyOverlay,
  currentScene: string,
): PerceptionSettings {
  const sceneFactor = overlay.sceneFactors[currentScene] ?? 1;
  const intervalFactor = clampFactor(overlay.minIntervalFactor * sceneFactor);
  const perHourFactor = clampFactor(overlay.maxPerHourFactor * (sceneFactor < 1 ? sceneFactor : 1));
  return {
    ...settings,
    proactiveMinIntervalMs: Math.min(
      86400000,
      Math.round(settings.proactiveMinIntervalMs / intervalFactor),
    ),
    proactiveMaxPerHour: Math.max(0, Math.min(60, Math.floor(settings.proactiveMaxPerHour * perHourFactor))),
  };
}

function clampFactor(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(1, Math.max(POLICY_MIN_FACTOR, value));
}

/** 策略叠加层 -> 人话（UI 与日志共用）。 */
export function describePolicy(settings: PerceptionSettings, overlay: PolicyOverlay): string {
  const parts: string[] = [];
  if (overlay.minIntervalFactor < 1) {
    const effective = Math.round(settings.proactiveMinIntervalMs / overlay.minIntervalFactor / 60000);
    parts.push(`主动开口间隔 ${Math.round(settings.proactiveMinIntervalMs / 60000)} → ${effective} 分钟`);
  }
  if (overlay.maxPerHourFactor < 1) {
    parts.push(`每小时上限 ${settings.proactiveMaxPerHour} → ${Math.floor(settings.proactiveMaxPerHour * overlay.maxPerHourFactor)} 次`);
  }
  const scenes = Object.entries(overlay.sceneFactors).filter(([, factor]) => factor < 1);
  if (scenes.length > 0) {
    parts.push(...scenes.map(([scene, factor]) => `${sceneName(scene)}时打扰间隔 ×${(1 / factor).toFixed(1)}`));
  }
  if (parts.length === 0) return '还没调整过（保持你的设置）';
  return parts.join(' · ');
}

/** 按场景汇总"回应率"（她据此决定要不要少说话）。 */
export function responseStats(
  feedback: readonly InterventionFeedback[],
): { scene: string; total: number; responded: number; rate: number }[] {
  const buckets = new Map<string, { total: number; responded: number }>();
  for (const item of feedback) {
    const key = item.scene === '' ? 'unknown' : item.scene;
    const entry = buckets.get(key) ?? { total: 0, responded: 0 };
    entry.total += 1;
    if (item.responded) entry.responded += 1;
    buckets.set(key, entry);
  }
  return [...buckets.entries()]
    .map(([scene, entry]) => ({ scene, ...entry, rate: entry.total === 0 ? 0 : entry.responded / entry.total }))
    .sort((a, b) => b.total - a.total);
}

/**
 * 由反馈统计直接得出"该不该少说话"的洞见（**不依赖模型**的保守版本）。
 *
 * 规则刻意简单且保守：只有"至少打扰过 3 次、回应率 ≤ 1/3"才建议安静；
 * 回应率很高（≥ 0.8 且样本 ≥ 5）才建议"可以多说一点"（也只会回到用户设定）。
 */
export function heuristicInsights(
  feedback: readonly InterventionFeedback[],
  stats: readonly { scene: string; total: number; responded: number; rate: number }[],
): ReflectionInsight[] {
  const insights: ReflectionInsight[] = [];
  for (const item of stats) {
    if (item.scene === 'unknown') continue;
    if (item.total >= 3 && item.rate <= 1 / 3) {
      insights.push({
        scene: item.scene,
        action: 'quiet-down',
        reason: `${sceneName(item.scene)}时打扰了 ${item.total} 次，只有 ${item.responded} 次被回应`,
      });
    } else if (item.total >= 5 && item.rate >= 0.8) {
      insights.push({
        scene: item.scene,
        action: 'speak-up',
        reason: `${sceneName(item.scene)}时 ${item.total} 次里被回应了 ${item.responded} 次`,
      });
    }
  }
  if (feedback.length >= 6) {
    const responded = feedback.filter((item) => item.responded).length;
    const rate = responded / feedback.length;
    if (rate <= 0.25) {
      insights.push({ scene: '', action: 'quiet-down', reason: `最近 ${feedback.length} 次主动开口只被回应 ${responded} 次` });
    }
  }
  return insights;
}

/** 本地模板反思（没接模型时也要有"反思"这件事）。 */
export function localReflection(input: {
  readonly date: string;
  readonly stats: ReflectionEntryStats;
  readonly insights: readonly ReflectionInsight[];
  readonly scenes: readonly { scene: string; count: number }[];
  readonly mood: { start: number; end: number };
  readonly interventions: readonly InterventionFeedback[];
}): string {
  const lines: string[] = [];
  const { stats } = input;
  if (stats.interventions === 0) {
    lines.push('今天我一句话也没主动说。主人也没怎么来理我。');
  } else {
    lines.push(`今天我一共主动开口 ${stats.interventions} 次，其中 ${stats.responded} 次主人理我了。`);
  }
  const unresponded = input.interventions.filter((item) => !item.responded);
  if (unresponded.length > 0) {
    const sample = unresponded[unresponded.length - 1];
    if (sample) lines.push(`有一次是在${sceneName(sample.scene)}的时候说的（"${sample.text.slice(0, 18)}"），主人没有回应。`);
  }
  if (input.scenes.length > 0) {
    const top = input.scenes.slice(0, 3).map((item) => `${sceneName(item.scene)} ${item.count} 次`).join('、');
    lines.push(`主人今天主要在：${top}。`);
  }
  if (stats.moodEnd < stats.moodStart - 5) {
    lines.push(`我自己的心情从 ${stats.moodStart} 掉到了 ${stats.moodEnd} —— 大概是太久没被理了。`);
  }
  for (const insight of input.insights) {
    if (insight.action === 'quiet-down') lines.push(`以后${insight.scene === '' ? '' : `在${sceneName(insight.scene)}时`}我应该少说两句：${insight.reason}。`);
    else if (insight.action === 'speak-up') lines.push(`在${sceneName(insight.scene)}时我可以稍微主动一点，主人是有回应的。`);
  }
  if (lines.length <= 1) lines.push('今天没什么特别的，就这样安静地陪着也挺好。');
  return lines.join('\n');
}

export interface ReflectionEntryStats {
  readonly interventions: number;
  readonly responded: number;
  readonly turnCount: number;
  readonly moodStart: number;
  readonly moodEnd: number;
}

/** 反思的 system prompt（要求：第一人称 + 明确的行为结论 + 严格 JSON 结论段）。 */
export function reflectionSystemPrompt(petName: string): string {
  return [
    `你是桌面宠物「${petName}」，现在要写**今天的自我反思**（第一人称，中文）。`,
    '反思要围绕"我今天的行为是否打扰到主人"，而不是复述事件。',
    '',
    '输出格式（严格遵守）：先写 3~6 句反思正文（不要标题、不要列表、不要 Markdown），',
    '然后另起一行输出一行 JSON 作为结论，形如：',
    '{"insights":[{"scene":"coding","action":"quiet-down","reason":"写代码时打扰了 3 次都没被回应"}]}',
    'action 只能是 quiet-down / keep / speak-up；scene 用英文场景名（coding/reading/video/gaming/meeting/browsing/chatting/writing/terminal/other），全局结论用空字符串。',
    'insights 最多 2 条；**没有把握就给 []**（宁可不动策略，也不要瞎调）。',
  ].join('\n');
}

/** 解析模型输出：正文 + 结论段（宽容解析，失败则只取正文）。 */
export function parseReflection(raw: string): { body: string; insights: ReflectionInsight[] } {
  const text = typeof raw === 'string' ? raw : '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let insights: ReflectionInsight[] = [];
  let body = text.trim();
  if (start >= 0 && end > start) {
    const jsonPart = text.slice(start, end + 1);
    body = `${text.slice(0, start)}${text.slice(end + 1)}`.trim();
    try {
      const parsed: unknown = JSON.parse(jsonPart);
      const list = (parsed as { insights?: unknown }).insights;
      if (Array.isArray(list)) {
        insights = list
          .map((item) => {
            if (typeof item !== 'object' || item === null) return null;
            const record = item as Record<string, unknown>;
            const action = record.action;
            if (action !== 'quiet-down' && action !== 'keep' && action !== 'speak-up') return null;
            const scene = typeof record.scene === 'string' ? record.scene.slice(0, 24) : '';
            const reason = typeof record.reason === 'string' ? record.reason.slice(0, 120) : '';
            return { scene, action, reason } satisfies ReflectionInsight;
          })
          .filter((item): item is ReflectionInsight => item !== null)
          .slice(0, 2);
      }
    } catch {
      /* 结论段坏了就只用正文 */
    }
  }
  return { body: body.replace(/```[a-z]*/gi, '').trim().slice(0, 2000), insights };
}

/* -------------------------------------------------------------------------- */
/* 三、小工具                                                                  */
/* -------------------------------------------------------------------------- */

const SCENE_NAMES: Readonly<Record<string, string>> = {
  coding: '写代码',
  reading: '读论文/文档',
  video: '看视频',
  gaming: '打游戏',
  meeting: '开会',
  browsing: '浏览网页',
  chatting: '聊天',
  writing: '写东西',
  terminal: '命令行',
  idle: '没在动',
  sensitive: '私人内容',
  other: '说不清',
  unknown: '不清楚',
};

export function sceneName(scene: string): string {
  return SCENE_NAMES[scene] ?? (scene === '' ? '平时' : scene);
}

function matchLine(lines: readonly string[], pattern: RegExp): string | null {
  for (const line of lines) {
    if (pattern.test(line)) return line.slice(0, 80);
  }
  return null;
}

function pickTopic(lines: readonly string[], pattern: RegExp): string | null {
  for (const line of lines) {
    const matched = pattern.exec(line);
    if (!matched) continue;
    // 取动词后面的一小段作为主题（"在写毕业论文" -> "毕业论文"）
    const after = line.slice(matched.index + matched[0].length).replace(/^[的地了着\s]+/, '').trim();
    const topic = after.replace(/[，。！？,.!?\s].*$/, '').slice(0, 12);
    if (topic !== '') return topic;
  }
  return null;
}

/** 取匹配到的**名词本身**作为主题（"把论文投出去了" -> "论文"）。 */
function pickNoun(lines: readonly string[], pattern: RegExp): string | null {
  for (const line of lines) {
    const matched = pattern.exec(line);
    if (matched && matched[0]) return matched[0];
  }
  return null;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed.slice(0, 120));
  }
  return out;
}

/** 天数统计（第一次见面到现在）。 */
export function daysBetween(fromIso: string, now: number): number {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, Math.floor((now - from) / 86400000));
}

/** 开关默认全开（与 2.x/3.x 一致）。 */
export function isGrowthEnabled(settings: GrowthSettings): boolean {
  return settings.palace || settings.reflection;
}
