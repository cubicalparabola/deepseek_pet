/**
 * 「每天在做什么」的**纯聚合逻辑**（3.1 观察 → 区间 → 每日汇总 → 给模型的叙述请求）。
 *
 * 为什么单独一层纯函数：这一段全是"时间怎么合并、怎么切、怎么算时长"的规则，
 * 一旦写进主进程的定时器里就没法逐条断言了。而它恰恰最容易出细节错：
 * 跨零点、漏采一次、idle 要不要计入、同场景但换了程序算不算同一段……
 * 所以：**规则在这里，副作用（读盘/写盘/调模型）在 `main/perception/timeline-service.ts`**。
 */

import type { ScreenObservation } from './perception-types';
import type { ActivitySegment, DayTimeline, TimelineTotals } from './timeline-types';
import { sceneLabel } from './perception';

/** 两条观察最多间隔多久还算"同一段"（默认 90s = 3 倍采样间隔，容忍漏采一两次）。 */
export const SEGMENT_GAP_MS = 90000;

/** 本地日期（`YYYY-MM-DD`）——跨天按用户时区切，不用 UTC。 */
export function localDayOf(at: string | number | Date = Date.now()): string {
  const date = at instanceof Date ? at : new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 分钟数（保留 1 位小数）。 */
function minutesBetween(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round((ms / 60000) * 10) / 10;
}

/** 这一段是不是"人不在/没动"。 */
export function isIdleSegment(segment: ActivitySegment): boolean {
  return segment.scene === 'idle';
}

/**
 * 把一条新观察并进今天的区间列表（**纯函数**：返回新数组，不改入参）。
 *
 * 合并规则（顺序很重要）：
 * 1. 与上一段 **scene 相同、app 相同、间隔 ≤ gapMs** → 延长上一段（samples+1）；
 * 2. 否则**另起一段**。
 *
 * ⚠️ 不要给 `idle` 加"永远另起一段"的特例：`scene` 相同这一条**已经**保证
 * "离开"不会和"工作"混在一段里，而特例会让"离开 20 分钟"攒出几十个碎片段
 * （每 30 秒一条观察）—— 第一版就是这么写的，验收当场抓到。
 */
export function appendObservation(
  segments: readonly ActivitySegment[],
  observation: Pick<ScreenObservation, 'at' | 'scene' | 'app'>,
  options?: { readonly gapMs?: number },
): ActivitySegment[] {
  const gapMs = Math.max(1000, options?.gapMs ?? SEGMENT_GAP_MS);
  const at = observation.at;
  const scene = observation.scene;
  const app = (observation.app ?? '').slice(0, 60);
  const last = segments[segments.length - 1];

  if (last) {
    const sameThing = last.scene === scene && last.app === app;
    const gap = new Date(at).getTime() - new Date(last.end).getTime();
    const continuous = Number.isFinite(gap) && gap >= 0 && gap <= gapMs;
    if (sameThing && continuous) {
      const extended: ActivitySegment = {
        ...last,
        end: at,
        samples: last.samples + 1,
        minutes: minutesBetween(last.start, at),
      };
      return [...segments.slice(0, -1), extended];
    }
  }

  const created: ActivitySegment = { start: at, end: at, scene, app, samples: 1, minutes: 0 };
  return [...segments, created];
}

/** 一天的汇总（纯统计）。 */
export function summarizeDay(segments: readonly ActivitySegment[]): TimelineTotals {
  const bySceneMap = new Map<string, number>();
  const byAppMap = new Map<string, number>();
  let activeMillis = 0;
  let idleMillis = 0;
  let firstAt = '';
  let lastAt = '';

  for (const segment of segments) {
    const ms = Math.max(0, new Date(segment.end).getTime() - new Date(segment.start).getTime());
    if (segment.scene === 'idle') idleMillis += ms;
    else activeMillis += ms;
    if (segment.scene !== 'idle') {
      bySceneMap.set(segment.scene, (bySceneMap.get(segment.scene) ?? 0) + ms);
      const app = segment.app.trim() === '' ? '（未知）' : segment.app.trim();
      byAppMap.set(app, (byAppMap.get(app) ?? 0) + ms);
    }
    if (firstAt === '' || segment.start < firstAt) firstAt = segment.start;
    if (lastAt === '' || segment.end > lastAt) lastAt = segment.end;
  }

  const toMinutes = (ms: number): number => Math.round((ms / 60000) * 10) / 10;
  const activeMinutes = toMinutes(activeMillis);
  const byScene = [...bySceneMap.entries()]
    .map(([scene, ms]) => ({
      scene: scene as TimelineTotals['byScene'][number]['scene'],
      minutes: toMinutes(ms),
      share: activeMillis > 0 ? Math.round((ms / activeMillis) * 100) / 100 : 0,
    }))
    .sort((a, b) => b.minutes - a.minutes);
  const byApp = [...byAppMap.entries()]
    .map(([app, ms]) => ({ app, minutes: toMinutes(ms) }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 5);

  return { activeMinutes, idleMinutes: toMinutes(idleMillis), byScene, byApp, firstAt, lastAt };
}

/** 把分钟数写成中文（`2 小时 22 分` / `45 分钟` / `不到 1 分钟`）。 */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  // 采样间隔是 30 秒，刚起步的一两段往往不足 1 分钟 —— 写成"0 分钟"会让人以为没记录到
  if (total < 1) return '不到 1 分钟';
  if (total < 60) return `${total} 分钟`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

/** `HH:MM`（本地时间）。 */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 一段区间的一行文字：`09:10–11:32 写代码（VS Code）· 2 小时 22 分`。 */
export function formatSegmentLine(segment: ActivitySegment): string {
  const label = sceneLabel(segment.scene);
  const app = segment.app.trim() === '' ? '' : `（${segment.app.trim()}）`;
  const minutes = Math.max(0, new Date(segment.end).getTime() - new Date(segment.start).getTime()) / 60000;
  const tail = minutes < 1 && segment.samples <= 2 ? '刚刚' : formatDuration(minutes);
  return `${formatClock(segment.start)}–${formatClock(segment.end)} ${label}${app} · ${tail}`;
}

/**
 * 给聊天/日记/面板看的紧凑文本。
 *
 * 形如：
 * ```
 * 今天（截至 15:20）：写代码 3 小时 20 分（42%）、浏览网页 55 分钟（12%）…
 * 主要程序：code 3 小时、msedge 1 小时 20 分
 * 最近：14:05–15:20 写代码（code）· 1 小时 15 分
 * ```
 */
export function formatTimelineText(timeline: DayTimeline, options?: { readonly maxSegments?: number }): string {
  const { totals } = timeline;
  if (totals.activeMinutes <= 0 && totals.idleMinutes <= 0) return '';
  const maxSegments = Math.max(1, options?.maxSegments ?? 3);
  const until = totals.lastAt === '' ? '' : `（截至 ${formatClock(totals.lastAt)}）`;
  const scenePart = totals.byScene
    .slice(0, 4)
    .map((item) => `${sceneLabel(item.scene)} ${formatDuration(item.minutes)}（${Math.round(item.share * 100)}%）`)
    .join('、');
  const appPart = totals.byApp
    .slice(0, 3)
    .map((item) => `${item.app} ${formatDuration(item.minutes)}`)
    .join('、');
  const recent = timeline.segments.slice(-maxSegments).map(formatSegmentLine);

  return [
    `今天${until}：${scenePart === '' ? '没有记录到明确的活动' : scenePart}`,
    appPart === '' ? '' : `主要程序：${appPart}`,
    recent.length > 0 ? `最近：${recent.join('；')}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * 给"让模型写一段叙述"用的提示词（**纯函数**，验收可以断言它包含关键事实）。
 *
 * 与日记的区别：日记是"她的内心独白"，这段是"她记得主人今天干了什么"——
 * 所以要求**只根据给定时间线说，不要编**，并且**不要复述具体命令/内容**。
 */
export function buildNarrativeMessages(input: {
  readonly timeline: DayTimeline;
  readonly petName: string;
  readonly userName: string;
}): { readonly system: string; readonly user: string } {
  const { timeline } = input;
  const owner = input.userName.trim() === '' ? '主人' : input.userName.trim();
  const lines = timeline.segments.map(formatSegmentLine).join('\n');
  return {
    system: [
      `你是「${input.petName}」，一只住在 Windows 桌面上的鲸鱼娘桌宠。`,
      `现在请你用 2~3 句中文，写下你**记得的**${owner}今天在电脑上做了什么。`,
      '要求：',
      '- **只根据下面给出的时间线说**，时间线里没有的不要编（宁可不提）；',
      '- 口语化、自然，像在跟主人聊天时顺口提起；',
      '- 可以点出"做得最久的一件事"和"大约从几点到几点"；',
      '- 不要罗列全部区间、不要说"数据显示/根据记录"、不要复述任何具体命令或文件内容；',
      '- 不要写标题、不要用 Markdown、不要提 AI。',
    ].join('\n'),
    user: [
      `日期：${timeline.date}`,
      `今天在电脑前共 ${formatDuration(timeline.totals.activeMinutes)}（判为离开/没动另有 ${formatDuration(timeline.totals.idleMinutes)}）。`,
      '时间线：',
      lines === '' ? '（今天没有任何有效观察）' : lines,
    ].join('\n'),
  };
}
