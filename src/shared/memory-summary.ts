/**
 * 对话的**滚动摘要**（2.2 的"压缩机制"）—— 纯函数，可被验收逐条断言。
 *
 * 为什么需要：聊天上下文原来只带"最近 6 轮"，更早说过的话全靠关键词检索捞片段
 * （`searchPast`，最多 4 条）。于是长会话里她会**忘掉早先明确说过的事**。
 * 这里把"更早的那些轮"压成一段 ≤ `maxChars` 的前情，滚动更新（旧摘要 + 新轮 → 新摘要），
 * 它进 prompt 的【你记得的事】那一块。
 *
 * 两条设计约束：
 * 1. **没模型也要能用**：`fallbackRollingSummary()` 是纯抽取式（每条取主人那句话的开头），
 *    保证"没配密钥"时同样会滚动，而不是这条机制静默失效；
 * 2. **宁可短**：摘要只用来"记得住话题与人"，不追求还原细节 —— 细节该由检索片段负责。
 */

import type { ChatTurn } from './ai-types';

/** 摘要长度上限（字符）。 */
export const SUMMARY_MAX_CHARS = 600;

/** 把一句话压到 `limit` 字（超出加省略号）。 */
function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/**
 * **没有模型时**的滚动摘要（抽取式，确定性）。
 *
 * 做法：保留上一版摘要（它已经是压缩过的记忆），再接上这一批新轮里
 * 主人说过的内容开头（她的回复不复述，只留主人的，避免摘要被客套话占满）。
 * 超出上限时**从旧的部分开始截**（最近的事更重要）。
 */
export function fallbackRollingSummary(
  previous: string,
  turns: readonly ChatTurn[],
  maxChars: number = SUMMARY_MAX_CHARS,
): string {
  const additions = turns
    .filter((turn) => turn.role === 'user')
    .map((turn) => clip(turn.text, 40))
    .filter((text) => text !== '');
  const kept = previous.replace(/\s+/g, ' ').trim();
  const merged = [kept, ...additions].filter((part) => part !== '').join('；');
  if (merged.length <= maxChars) return merged;
  // 从尾部留：最近说的更该被记住
  return `…${merged.slice(merged.length - Math.max(0, maxChars - 1))}`;
}

/**
 * 给模型用的滚动摘要请求（纯函数：验收可以断言它把"上一版摘要"和"新对话"都带上了）。
 */
export function buildRollingSummaryMessages(input: {
  readonly previous: string;
  readonly turns: readonly ChatTurn[];
  readonly petName: string;
  readonly maxChars?: number;
}): { readonly system: string; readonly user: string } {
  const maxChars = Math.max(80, input.maxChars ?? SUMMARY_MAX_CHARS);
  const transcript = input.turns
    .map((turn) => `${turn.role === 'user' ? '主人' : '我'}：${clip(turn.text, 120)}`)
    .join('\n');
  return {
    system: [
      `你是「${input.petName}」的记忆整理器：把主人与桌宠的对话压成一段**长期记得住的前情**。`,
      `要求：`,
      `- 只写主人相关的**事实与话题**（在做什么、在意什么、约定过什么、称呼与偏好），不要写寒暄；`,
      `- 用第三人称陈述，不要复述原话、不要加评论、不要写"对话中"这类元信息；`,
      '- 不要编造：原文里没有的不要写；',
      `- 中文，不超过 ${maxChars} 字，直接输出那一段文字（不要 JSON、不要标题）。`,
    ].join('\n'),
    user: [
      input.previous.trim() === '' ? '（还没有前情摘要）' : `上一版前情摘要：\n${input.previous.trim()}`,
      '',
      '需要并入的新对话：',
      transcript === '' ? '（无）' : transcript,
      '',
      '请输出合并后的前情摘要。',
    ].join('\n'),
  };
}

/**
 * 规范化模型输出的摘要（去掉它偶尔加的标题/引号/围栏，并限长）。
 */
export function sanitizeSummary(raw: string, maxChars: number = SUMMARY_MAX_CHARS): string {
  return raw
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^\s*前情摘要\s*[:：]\s*/i, '')
    .replace(/^["'“”「『]+/, '')
    .replace(/["'“”」』]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}
