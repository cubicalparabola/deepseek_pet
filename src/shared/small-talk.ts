/**
 * 日常闲聊（小话头）—— 她主动开口时**说什么**。
 *
 * 背景（需求原文）："多样化一些宠物的对话，不仅仅基于用户习惯询问，
 * 有时候也可能换成一些问候、最近发生的有趣的事等等，**频率不变**"。
 *
 * 因此这里只做一件事：在**同一次开口机会**里，把"说什么"从
 * "只有一句习惯询问"换成一组轮换的候选 —— 问候 / 今天的活动 / 最近的事 /
 * 习惯询问。频率完全由既有的 `gateIntervention`（免打扰、最小间隔、每小时上限）
 * 决定，本模块**不新增任何开口机会**。
 *
 * 两条硬约束（与项目其它"她说话"的地方一致）：
 * 1. **不编事实**：问候与陪伴类台词不含任何关于主人的断言；
 *    "最近的事"只用真实记忆（记忆宫殿里的节点标题），"今天的活动"只用时间线统计。
 * 2. **纯函数 + 可注入随机源**：验收能逐条钉死"轮到哪一类""不会连着说同一类"。
 */

import type { MemoryNodeKind } from './growth-types';
import type { SceneKind } from './perception-types';
import { formatDuration } from './timeline';
import { sceneLabel } from './perception';

/** 小话头的类别。 */
export type SmallTalkKind =
  /** 问候（按时段）。 */
  | 'greeting'
  /** 习惯询问（她学到的作息规律）。 */
  | 'habit'
  /** 今天的活动（时间线统计出来的真实数字）。 */
  | 'activity'
  /** 最近发生的事（来自记忆宫殿的真实节点）。 */
  | 'recent'
  /** 陪伴/自言自语（不含任何关于主人的断言）。 */
  | 'company';

export interface SmallTalkCandidate {
  readonly kind: SmallTalkKind;
  readonly text: string;
}

export interface SmallTalkInput {
  /** 当前小时（0~23）。 */
  readonly hour: number;
  /** 主人称呼（空串 = 没设，就不点名）。 */
  readonly userName: string;
  /** 习惯询问的台词；null = 还没学到习惯，或习惯开关关着。 */
  readonly habitText?: string | null;
  /** 今天最主要的一项活动（时间线聚合；null = 今天还没记到明确的活动）。 */
  readonly topActivity?: { readonly scene: SceneKind; readonly minutes: number } | null;
  /** 最近值得提一句的真实记忆（记忆宫殿节点标题 + 距今几天 + 类型）。 */
  readonly recentMoment?: {
    readonly title: string;
    readonly daysAgo: number;
    readonly kind?: MemoryNodeKind;
  } | null;
}

/** 按时段取问候语（这几条都是"不含事实断言"的安全台词）。 */
function greetings(hour: number): readonly string[] {
  if (hour >= 5 && hour < 9) {
    return ['早上好呀～新的一天也要开心哦。', '早呀，昨晚睡得好吗？', '醒啦？我在的。'];
  }
  if (hour >= 9 && hour < 12) {
    return ['上午好～今天想先做点什么呀？', '上午好，要不要先列个今天要做的事？'];
  }
  if (hour >= 12 && hour < 14) {
    return ['到饭点啦，记得吃点东西。', '中午了，别饿着肚子忙哦。'];
  }
  if (hour >= 14 && hour < 18) {
    return ['下午好呀，泡杯水喝吧。', '下午了，要不要伸个懒腰？'];
  }
  if (hour >= 18 && hour < 23) {
    return ['晚上好～今天过得怎么样？', '天黑啦，我在这儿陪着你。'];
  }
  return ['这么晚还没睡呀，我也有点困了……', '夜深了，早点休息好不好？'];
}

/** 陪她/自言自语（不含事实断言，任何时候都能说）。 */
const COMPANY_LINES: readonly string[] = [
  '我刚才在屏幕角落发了会儿呆，忽然想看看你在不在。',
  '你忙你的，我就在这儿待着，不吵你。',
  '刚刚想起你，就出来打个招呼～',
];

/**
 * 组装这一次开口的候选小话头（顺序即"同等条件下的偏好顺序"）。
 *
 * 顺序刻意让**信息量大的先说**：最近的事 > 今天的活动 > 习惯询问 > 问候 > 陪伴。
 * 但真正的选择在 `pickSmallTalk` 里做（会避开上一次说过的类别）。
 */
export function buildSmallTalk(input: SmallTalkInput): SmallTalkCandidate[] {
  const candidates: SmallTalkCandidate[] = [];
  const name = input.userName.trim();
  const suffix = name === '' ? '' : `，${name}`;

  const recent = input.recentMoment;
  if (recent && recent.title.trim() !== '') {
    /*
     * 措辞对**任何**节点标题都成立：不问"顺利吗"（那是任务口径），
     * 而是"现在怎么样了" —— 熬夜赶工、情绪时刻、出门旅行都读得通。
     */
    const title = recent.title.trim();
    const text = recent.daysAgo <= 0
      ? `今天的事我都记着呢：「${title}」——现在怎么样了？`
      : recent.daysAgo === 1
        ? `昨天那件事我还记着：「${title}」，现在怎么样了？`
        : `前几天的事我还记着：「${title}」，后来怎么样了？`;
    candidates.push({ kind: 'recent', text });
  }

  const activity = input.topActivity;
  if (activity && activity.minutes > 0) {
    const label = sceneLabel(activity.scene);
    const spent = formatDuration(activity.minutes);
    candidates.push({
      kind: 'activity',
      text: `今天你${label}花了 ${spent}啦，记得起来活动一下。`,
    });
    candidates.push({
      kind: 'activity',
      text: `我看你今天大部分时间都在${label}，投入得很嘛。`,
    });
  }

  const habit = (input.habitText ?? '').trim();
  if (habit !== '') candidates.push({ kind: 'habit', text: habit });

  for (const text of greetings(input.hour)) {
    candidates.push({ kind: 'greeting', text: suffix === '' ? text : `${text.replace(/[。～]$/, '')}${suffix}。` });
  }
  for (const text of COMPANY_LINES) candidates.push({ kind: 'company', text });

  return candidates;
}

/**
 * 挑一条小话头。
 *
 * 规则：**尽量不连着说同一类**（`lastKind` = 上一次实际说出去的类别）。
 * 候选里只剩同一类时才允许重复（例如只有习惯询问可用）。
 *
 * @param random 注入随机源，便于验收断言
 */
export function pickSmallTalk(
  candidates: readonly SmallTalkCandidate[],
  random: () => number = Math.random,
  lastKind: SmallTalkKind | null = null,
): SmallTalkCandidate | null {
  if (candidates.length === 0) return null;
  const fresh = lastKind === null ? candidates : candidates.filter((item) => item.kind !== lastKind);
  const pool = fresh.length > 0 ? fresh : candidates;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index] ?? null;
}
