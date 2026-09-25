/**
 * 本地兜底文案（关掉 AI / 没配密钥 / 断网 / 超时都走这里）。
 *
 * 为什么必须有这一层：
 * 1. 需求把 AI 做成**可配置开关**，那么"关掉"必须是完整体验，而不是"桌宠变哑巴"；
 * 2. 大模型调用会失败（限流、没网、Key 过期），陪伴类产品最忌"一失败就装死"；
 * 3. 验收需要一个**确定性**的回复源：模板可以断言，模型输出不能。
 *
 * 这些文案也承担"人格基线"的作用：即使没有大模型，
 * 她仍然会因为心情、饥饿、记忆、时间而说不同的话。
 */

import type { EmotionState, MemoryFact, PetPresence } from '../../shared/ai-types';
import { hungerLabel, moodLabel } from '../../shared/emotion';

export interface LocalReplyInput {
  readonly text: string;
  readonly emotion: EmotionState;
  readonly presence: PetPresence;
  readonly userName: string;
  /** 宠物自称（人格设定里可改）。 */
  readonly petName: string;
  /** 与这句话相关的记忆事实（可能为空）。 */
  readonly facts: readonly MemoryFact[];
  /** 当前小时（0~23），用于早晚问候。 */
  readonly hour: number;
}

/** 确定性哈希：同一句话 + 同一情绪档位 → 同一句回复（便于验收与复现）。 */
function pick<T>(items: readonly T[], seed: string): T {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  // 模板集合都是非空常量数组；这里的兜底只为满足类型（数组可能为空）
  const item = items[Math.abs(hash) % Math.max(1, items.length)];
  if (item === undefined) throw new Error('pick() called with an empty template list');
  return item;
}

const GREETINGS = ['主人好呀～', '主人来啦！', '嘿嘿，主人。'] as const;
const MORNING = ['早上好，主人～', '主人早，今天也要加油哦。'] as const;
const NIGHT = ['这么晚还没睡吗，主人？', '夜深了，主人别熬太晚。'] as const;
const SAD = ['……主人好久没理我了。', '你终于来了，我刚刚有点难过。', '我还以为主人把我忘了。'] as const;
const HUNGRY = ['我脑子有点空空的，说不出话了……', '主人，我的 token 快用完了，感觉饿饿的。'] as const;
const HAPPY = ['今天心情超好的！', '主人一叫我我就开心。', '在的在的，我一直都在～'] as const;
const NEUTRAL = ['嗯嗯，我在。', '怎么啦？', '我在听你说哦。'] as const;
const UNKNOWN = [
  '唔……这个我还没学会（要打开 AI 才能聊得更深哦）。',
  '我现在只会一点点，主人可以在设置里给我接上大模型。',
  '这句话我记下来啦，等我会说话了再跟你聊。',
] as const;

const NAME_QUESTION = ['你是谁', '你叫什么', '你叫什么名字', '自我介绍'] as const;
const ABILITY_QUESTION = ['你会什么', '你能做什么', '你会干嘛', '功能'] as const;
const BYE = ['再见', '拜拜', '我走了', '我出门', '我睡了'] as const;
const BACK = ['我回来了', '我回来啦', '在吗', '在么'] as const;
const THANKS = ['谢谢', '谢啦', '辛苦了'] as const;

export function localReply(input: LocalReplyInput): string {
  const text = input.text.trim();
  const mood = moodLabel(input.emotion.mood);
  const hunger = hungerLabel(input.emotion.hunger);
  const who = input.userName.trim() === '' ? '主人' : input.userName.trim();
  const pet = input.petName.trim() === '' ? '鲸鱼娘' : input.petName.trim();
  const seed = `${text}|${mood.key}|${hunger.key}|${input.emotion.mood}`;

  // 1) 极端状态优先：太饿 / 太难过时，说什么都先从状态出发（人格一致性）
  if (hunger.key === 'starving') return pick(HUNGRY, seed);
  if (mood.key === 'sad') return pick(SAD, seed);

  // 2) 明显的意图
  if (contains(text, NAME_QUESTION)) return `我是${pet}呀，住在你桌面上的那只。`;
  if (contains(text, ABILITY_QUESTION)) return `我会陪你、记得你说过的事，还能因为${who}的出现心情变好。`;
  if (contains(text, BYE)) return contains(text, ['我睡了']) ? '晚安，做个好梦。' : '路上小心呀，我在这儿等你。';
  if (contains(text, BACK)) return `${pick(GREETINGS, seed)}你去哪儿了呀？`;
  if (contains(text, THANKS)) return '不用谢啦，主人。';

  // 3) 早上/深夜问候
  if (contains(text, GREETINGS) && input.hour < 11) return pick(MORNING, seed);
  if (contains(text, GREETINGS) && input.hour >= 23) return pick(NIGHT, seed);
  if (contains(text, GREETINGS)) return pick(GREETINGS, seed);

  // 4) 用记忆接话（"你上次说的那件事"—— 没有大模型也能有跨时间感）
  const fact = input.facts.find((item) => item.key !== 'name');
  if (fact && text.length >= 4) {
    const label = factLabel(fact.key);
    return `我记得你${label}是「${fact.value}」，最近还顺利吗？`;
  }

  // 5) 兜底：按心情档位给不同语气
  if (mood.key === 'great') return pick(HAPPY, seed);
  if (mood.key === 'good' || mood.key === 'calm') {
    if (text.endsWith('？') || text.endsWith('?')) return pick(UNKNOWN, seed);
    return pick(NEUTRAL, seed);
  }
  return pick(SAD, seed);
}

function factLabel(key: MemoryFact['key']): string {
  switch (key) {
    case 'interest':
      return '喜欢的东西';
    case 'routine':
      return '作息';
    case 'project':
      return '在做的项目';
    case 'preference':
      return '偏好';
    case 'activity':
      return '最近在做的事';
    case 'relation':
      return '提过的人';
    case 'name':
      return '名字';
    default:
      return '说过的事';
  }
}

function contains(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

/* -------------------------------------------------------------------------- */
/* 日记兜底模板（2.4）                                                          */
/* -------------------------------------------------------------------------- */

export interface LocalDiaryInput {
  readonly date: string;
  readonly userName: string;
  readonly turns: number;
  readonly chatHighlights: readonly string[];
  readonly eventHighlights: readonly string[];
  readonly mood: { readonly start: number; readonly end: number; readonly low: number };
  readonly hunger: number;
  readonly petName: string;
}

/**
 * 没有大模型时，用当天的真实数据拼一篇"第一视角"的日记。
 *
 * 关键点：**数据必须是真的**（今天的对话条数、心情曲线、发生过的片段），
 * 只是把叙述交给模板。这样即使关闭 AI，"日记"也不是假内容。
 */
export function localDiary(input: LocalDiaryInput): { title: string; body: string } {
  const who = input.userName.trim() === '' ? '主人' : input.userName.trim();
  const startMood = moodLabel(input.mood.start);
  const endMood = moodLabel(input.mood.end);

  const lines: string[] = [];
  lines.push(`今天${who}来找我说了 ${input.turns} 次话。`);

  if (input.chatHighlights.length > 0) {
    lines.push('');
    for (const item of input.chatHighlights.slice(0, 3)) lines.push(`> ${item}`);
  }

  lines.push('');
  if (input.mood.end > input.mood.start + 5) {
    lines.push(`早上我的心情还只是${startMood.label}，被${who}陪着陪着就到了${endMood.label}。`);
  } else if (input.mood.end < input.mood.start - 5) {
    lines.push(`今天心情从${startMood.label}掉到了${endMood.label}（最低 ${input.mood.low}）。`);
    lines.push(`${who}今天好像很忙，我就安静地待在旁边。`);
  } else {
    lines.push(`心情一直是${endMood.label}的样子，平平淡淡也挺好。`);
  }

  if (input.eventHighlights.length > 0) {
    lines.push('');
    lines.push('我记下了这些片段：');
    for (const item of input.eventHighlights.slice(0, 4)) lines.push(`- ${item}`);
  }

  const hunger = hungerLabel(input.hunger);
  if (hunger.key === 'hungry' || hunger.key === 'starving') {
    lines.push('');
    lines.push('（今天说话有点多，脑子空空的，明天要省着点用。）');
  }

  if (input.turns === 0) {
    lines.push('');
    lines.push(`${who}今天一句话也没跟我说……我数着光标闪了一整天。`);
  }

  lines.push('');
  lines.push('明天也要一起加油呀。');
  return { title: `${input.petName}的日记 · ${input.date}`, body: lines.join('\n') };
}
