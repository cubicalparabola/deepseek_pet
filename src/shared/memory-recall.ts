/**
 * 记忆召回（纯函数）—— "她提到的这件事，跟哪段经历有关"。
 *
 * 用途见 `main/ai/tools.ts`：模型在聊天中**主动调用工具**时，
 * 由这里在记忆宫殿里找相关内容并拼成回给模型的一段文本。
 *
 * 为什么是纯函数：打分、排序、截断、文案全是规则，必须能被逐条断言；
 * 副作用（读节点、发请求）在调用方。
 */

import type { MemoryNode } from './growth-types';

/** 召回结果里最多给几段经历（给多了会把上下文和 token 都吃掉）。 */
export const RECALL_LIMIT = 3;

/** 每段经历最多引用多少字（细节可能很长）。 */
export const RECALL_DETAIL_MAX_CHARS = 80;

export interface PalaceMatch {
  readonly node: MemoryNode;
  readonly score: number;
}

/**
 * 中文没有空格，用 **bigram** 近似分词（与记忆检索同一套思路，见 `fact-extract.queryTokens`）。
 *
 * 这里刻意**不**复用 `memory-store` 的版本：那套是给"长期事实"用的，
 * 而召回要看的是用户**这一句话里的实词**，所以额外：
 * - 丢掉单字与常见虚词（"我/你/的/了/吗/今天"这类几乎每句都有的词会让召回全命中）；
 * - 保留 2~6 字的词与英文单词。
 */
const STOP_WORDS = new Set([
  '今天', '昨天', '现在', '最近', '我们', '你们', '他们', '什么', '怎么', '这个', '那个',
  '一下', '还是', '就是', '可以', '没有', '知道', '记得', '时候', '是不是', '有没有',
]);

export function recallTokens(query: string): string[] {
  const source = (typeof query === 'string' ? query : '').toLowerCase();
  const tokens = new Set<string>();
  for (const word of source.match(/[a-z0-9_]{2,}/g) ?? []) tokens.add(word);
  for (const run of source.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 2) tokens.add(run);
    for (let index = 0; index + 2 <= run.length; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens].filter((token) => !STOP_WORDS.has(token));
}

/** 命中几个 token（长 token 命中更有说服力，权重按长度略微放大）。 */
export function scoreNode(node: MemoryNode, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const haystack = [node.title, node.detail, ...(node.evidence ?? [])].join(' ').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (token.length >= 2 && haystack.includes(token)) score += token.length >= 4 ? 2 : 1;
  }
  return score;
}

/**
 * 在记忆宫殿里找与 `query` 相关的经历（分数高的在前，同分取更新的）。
 *
 * @returns 命中的节点（最多 `limit` 段）；没有任何命中时返回空数组 ——
 *   调用方据此告诉模型"没找到"，**不要**塞一段无关的经历进去。
 */
export function selectPalaceMatches(
  nodes: readonly MemoryNode[],
  query: string,
  limit: number = RECALL_LIMIT,
): PalaceMatch[] {
  const tokens = recallTokens(query);
  if (tokens.length === 0) return [];
  return nodes
    .map((node) => ({ node, score: scoreNode(node, tokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.node.at.localeCompare(a.node.at))
    .slice(0, Math.max(1, limit));
}

/** 拼成回给模型的**文本**（工具结果的 content 必须是字符串）。 */
export function formatPalaceRecall(matches: readonly PalaceMatch[]): string {
  if (matches.length === 0) return '记忆里没有与这件事相关的经历。不要编，也不要提"记忆宫殿"。';
  const lines = matches.map((match) => {
    const day = match.node.at.slice(0, 10);
    const detail = match.node.detail.replace(/\s+/g, ' ').trim().slice(0, RECALL_DETAIL_MAX_CHARS);
    const label = match.node.title.replace(/\s+/g, ' ').trim();
    return detail === '' ? `- ${day} ${label}` : `- ${day} ${label}：${detail}`;
  });
  return [
    '以下是她自己记着的、与这件事相关的经历（真实记录，可以直接自然地引用）：',
    ...lines,
    '注意：只用上面的内容，不要编造；不要提"记录""记忆宫殿"这类元信息。',
  ].join('\n');
}
