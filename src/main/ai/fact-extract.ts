/**
 * 记忆抽取（2.2）—— 从一句话里挑出"值得长期记住的东西"。
 *
 * 两条路径，互为兜底：
 * 1. **规则**（本文件的 `extractFactsHeuristic`）：不联网、零成本、永远可用。
 *    覆盖"我叫X / 我喜欢X / 我一般X点睡 / 我在写X"这类高价值句式。
 * 2. **模型**（`extractFactsFromModelOutput`）：把一段对话交给大模型，
 *    让它输出 JSON 数组。能理解"我最近在鼓捣一个桌宠"这种没有固定句式的表达。
 *
 * 明确不做的事：**不猜**。置信度低于阈值的规则命中直接丢掉 ——
 * 记错了比没记住更伤陪伴感（她会一本正经地说错你的事）。
 */

import type { MemoryFactKey } from '../../shared/ai-types';

/** 抽取结果的中间形态（还没进 profile，没有时间戳/hits）。 */
export interface ExtractedFact {
  readonly key: MemoryFactKey;
  readonly value: string;
  readonly confidence: number;
  readonly source: 'heuristic' | 'llm';
}

const VALID_KEYS: readonly MemoryFactKey[] = [
  'name',
  'interest',
  'routine',
  'activity',
  'project',
  'preference',
  'relation',
  'note',
];

/** 规则式抽取：命中即返回，同一条文本最多贡献一条同类事实。 */
export function extractFactsHeuristic(text: string): ExtractedFact[] {
  const source = typeof text === 'string' ? text.trim() : '';
  if (source === '') return [];
  const facts: ExtractedFact[] = [];

  const push = (key: MemoryFactKey, value: string, confidence = 0.6): void => {
    const cleaned = cleanValue(value);
    if (cleaned === '' || cleaned.length > 40) return;
    if (facts.some((fact) => fact.key === key && fact.value === cleaned)) return;
    facts.push({ key, value: cleaned, confidence, source: 'heuristic' });
  };

  /*
   * ⚠️ 顺序有意义：先"名字"，再"项目/兴趣"等。
   * "我是学生"这种句子不该被当成名字，所以名字规则只认
   * "我叫/我的名字是/叫我" 这几种明确说法。
   */
  push('name', match(source, /(?:我叫|我的名字是|我的名字叫|叫我)\s*([^\s，。！？,.!?]{1,12})/) ?? '', 0.8);

  const interest = match(source, /我(?:很)?(?:喜欢|爱好|最爱|迷上|最近迷上了?)\s*([^\s，。！？,.!?]{1,20})/);
  if (interest) push('interest', interest);

  const dislike = match(source, /我(?:很)?(?:不喜欢|讨厌|受不了)\s*([^\s，。！？,.!?]{1,20})/);
  if (dislike) push('preference', `不喜欢${dislike}`);

  const routine = match(source, /我(?:一般|通常|每天|平时)?\s*([0-9一二三四五六七八九十]{1,2}\s*点(?:半)?\s*(?:睡|睡觉|起床|起|下班|上班))/);
  if (routine) push('routine', routine, 0.7);

  /*
   * 项目/任务："我在写论文"、"最近在做桌宠"、"打算训练一个模型"。
   *
   * ⚠️ 早期版本要求"我"紧贴动词，于是 "我叫小明，最近在写毕业论文"
   * 里那个项目就漏掉了（中间隔着逗号和"最近在"，实测验收抓到）。
   * 现在允许"我 + 时间/打算类词 + 在"或"直接以时间词开头"两种入口。
   */
  const project = match(
    source,
    /(?:我(?:最近|正在|这两天|近期|打算|准备)?(?:在)?|(?:最近|这两天|近期)(?:我)?(?:在)?)\s*(?:写|做|搞|弄|训练|跑|改|开发)\s*([^\s，。！？,.!?]{1,24})/,
  );
  if (project) push('project', project, 0.65);

  const activity = match(source, /我(?:今天|昨天|刚刚|刚才|这两天)\s*(?:在)?\s*(写代码|debug|调 bug|改 bug|开会|上课|考试|健身|跑步|打游戏|看论文|写论文|做实验|加班)/);
  if (activity) push('activity', activity, 0.6);

  const relation = match(source, /我(?:的)?\s*(导师|老板|老师|同事|妈妈|爸爸|女朋友|男朋友|室友|同学)\s*(?:叫|是)?\s*([^\s，。！？,.!?]{0,12})/);
  if (relation) {
    const who = match(source, /(导师|老板|老师|同事|妈妈|爸爸|女朋友|男朋友|室友|同学)/) ?? '';
    const name = match(source, /(?:叫|是)\s*([^\s，。！？,.!?]{1,12})$/) ?? '';
    push('relation', name ? `${who}：${name}` : `提到过${who}`, 0.55);
  }

  return facts;
}

/**
 * 解析模型给出的 JSON 事实列表。
 *
 * 模型很爱加 ```json 围栏或前后闲聊，因此先"捞"出第一个 `[` 到最后一个 `]`；
 * 仍失败就当成"没有新事实"，绝不让解析错误打断对话。
 */
export function extractFactsFromModelOutput(raw: string): ExtractedFact[] {
  const text = typeof raw === 'string' ? raw : '';
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const facts: ExtractedFact[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const key = typeof record.key === 'string' ? (record.key as MemoryFactKey) : null;
    const value = typeof record.value === 'string' ? cleanValue(record.value) : '';
    if (key === null || !VALID_KEYS.includes(key) || value === '' || value.length > 60) continue;
    const confidence = typeof record.confidence === 'number' ? Math.min(1, Math.max(0.3, record.confidence)) : 0.9;
    // 模型自己给 0.9：它理解了语义，但仍要求它给出"明确说过"的内容
    facts.push({ key, value, confidence, source: 'llm' });
  }
  return facts.slice(0, 20);
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

function match(text: string, pattern: RegExp): string | null {
  const result = pattern.exec(text);
  if (!result) return null;
  const value = result[1] ?? '';
  return value.trim() === '' ? null : value.trim();
}

/** 去掉包裹的引号/标点与首尾空白（模型经常带出来）。 */
function cleanValue(value: string): string {
  return value
    .replace(/^[\s"'“”‘’【\[（(]+/, '')
    .replace(/[\s"'“”‘’】\]）)]+$/, '')
    .replace(/[，。！？,.!?;；:：]+$/, '')
    .trim();
}

/**
 * 从一句话里抽出用于检索的 token。
 *
 * 中文没有空格，因此用**二元组**（bigram）近似分词：
 * "论文进度" -> ["论文","文进","进度"]。够用且零依赖，
 * 检索评分只看命中数量，不要求精确分词。
 */
export function queryTokens(text: string): string[] {
  const source = typeof text === 'string' ? text : '';
  const tokens = new Set<string>();
  for (const word of source.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) tokens.add(word);
  const cjk = source.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
    // 整段短词也作为一个 token（"论文"命中"写论文"）
    if (run.length <= 4) tokens.add(run);
  }
  return [...tokens];
}

/** 命中数量（用于给记忆条目打分）。 */
export function matchScore(text: string, tokens: readonly string[]): number {
  if (!text || tokens.length === 0) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (token.length >= 2 && haystack.includes(token)) score += 1;
  }
  return score;
}
