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
import { isRecognizedScene } from './perception-types';
import { appDisplayName, normalizeProcessName, sceneLabel } from './perception';

/**
 * 两条观察最多间隔多久还算"同一段"（默认 150s = 5 倍采样间隔）。
 *
 * 为什么从 90s 放到 150s（用户实测后定的口径）：一次"没认出来"就占掉一个 30 秒槽位，
 * 90s 阈值下"上一段结束 → 一次 other → 下一次认出来"合计 119 秒就断段，
 * 于是同一个应用里的连续使用被切成一串"2 分钟"的碎片。
 * 150s 能容下一次 other（119s）与两次漏采（120s），而 4 分钟以上的真实空档仍然断段。
 */
export const SEGMENT_GAP_MS = 150000;

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

/* -------------------------------------------------------------------------- */
/* 保留期与归档（"不让数据无限增长"）                                             */
/* -------------------------------------------------------------------------- */

/**
 * 从一堆 `YYYY-MM-DD` 里挑出**超过保留期**的日子（纯函数，可被验收断言）。
 *
 * @param days 候选日期（别的形状一律忽略，坏文件名不该被删）
 * @param nowMs 现在
 * @param retentionDays 保留天数；**<= 0 表示永久保留**（返回空数组 = 什么都不删）
 */
export function selectExpiredDays(days: readonly string[], nowMs: number, retentionDays: number): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  const cutoff = new Date(nowMs);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - Math.round(retentionDays));
  return days
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .filter((day) => {
      const date = new Date(`${day}T00:00:00`);
      return !Number.isNaN(date.getTime()) && date.getTime() < cutoff.getTime();
    })
    .sort();
}

/** 归档一行的输入（一天的全部统计都在这儿，别的字段不再落盘）。 */
export interface ArchiveLineInput {
  readonly day: string;
  readonly activeMinutes: number;
  readonly idleMinutes: number;
  readonly byScene: readonly { readonly scene: string; readonly minutes: number }[];
  readonly apps: readonly string[];
}

/**
 * 把一天压成**一行**归档文本（纯函数）。
 *
 * 为什么要有归档这一步：明细（每 30 秒一条观察、当天的区间 json、当天的 md）
 * 过了保留期就该删，但"那天在电脑前多久、主要在做什么"值得留一句话 ——
 * 删掉明细之前先把它写成一行，用户翻 `archive/<月>.md` 仍能看到这一天。
 */
export function formatArchiveLine(input: ArchiveLineInput): string {
  const scenes = input.byScene
    .slice(0, 3)
    .map((item) => `${sceneLabel(item.scene as Parameters<typeof sceneLabel>[0])} ${formatDuration(item.minutes)}`)
    .join('、');
  const apps = input.apps.slice(0, 3).join('、');
  const parts = [
    `- ${input.day}`,
    `在电脑前 ${formatDuration(input.activeMinutes)}`,
    input.idleMinutes > 0 ? `离开 ${formatDuration(input.idleMinutes)}` : '',
    scenes === '' ? '（没有明确活动）' : scenes,
    apps === '' ? '' : `主要程序 ${apps}`,
  ].filter((part) => part !== '');
  return parts.join(' · ');
}

/** 这一段是不是"人不在/没动"。 */
export function isIdleSegment(segment: ActivitySegment): boolean {
  return segment.scene === 'idle';
}

/**
 * 把一条新观察并进今天的区间列表（**纯函数**：返回新数组，不改入参）。
 *
 * 合并规则（顺序很重要）：
 * 1. 与上一段 **scene 相同、间隔 ≤ gapMs** → 延长上一段（samples+1、appCounts 累加）；
 * 2. 否则**另起一段**，但先把上一段的 `end` 补到这一刻（见下面的"补时"）。
 *
 * ## 为什么合并键只有 scene，没有 app
 *
 * 实测（用户真实数据）：同一个游戏在不同时刻被读成
 * `PVZ Universe` / `Plants Vs. Zombies Universe` / `植物大战僵尸 Universe`——
 * 因为模型读的是**窗口标题**，而标题会随界面语言/场景变。
 * 拿 app 当合并键的后果：
 *   - "一直在打同一个游戏"被切成十几段，**每段时长都接近 0**（实测 93 处 / 67.5 分钟）；
 *   - `byApp` 把同一个程序列成好几行；
 *   - 面板的"最近"列表被几百个不到 1 分钟的碎片刷屏。
 * 现在 app 只在段内记 `appCounts`：段的代表性 app 取采样最多的那个，
 * `byApp` 按占比分摊时长 —— **总时长不受标签抖动影响**。
 *
 * ## 补时（换段时不丢时间）
 *
 * 采样是每 30 秒一次，所以"上一次看到 A、这一次看到 B"的真实切换点
 * 落在两者之间的某个时刻。旧实现直接把新段从此刻起算，那 30 秒
 * **两边都不算**（实测 136 处 / 111.9 分钟的过渡时间凭空消失）。
 * 现在把上一段的 `end` 顺延到这一刻（last-observation-carried-forward）：
 * 时间归给"上一个已知状态"，账户自洽。
 *
 * ⚠️ 不要给 `idle` 加"永远另起一段"的特例：`scene` 相同这一条**已经**保证
 * "离开"不会和"工作"混在一段里，而特例会让"离开 20 分钟"攒出几十个碎片段
 * （每 30 秒一条观察）—— 第一版就是这么写的，验收当场抓到。
 */
export function appendObservation(
  segments: readonly ActivitySegment[],
  observation: Pick<ScreenObservation, 'at' | 'scene' | 'app'> & { readonly appLabel?: string },
  options?: { readonly gapMs?: number },
): ActivitySegment[] {
  const gapMs = Math.max(1000, options?.gapMs ?? SEGMENT_GAP_MS);
  const at = observation.at;
  const scene = observation.scene;
  const app = (observation.app ?? '').slice(0, 60);
  const label = (observation.appLabel ?? '').slice(0, 60);
  const last = segments[segments.length - 1];
  const atMs = new Date(at).getTime();

  /*
   * 「没认出来」（scene = other）的处理：**不进时间线**，但可以"桥接"。
   *
   * 需求原文是"没认出来就当作没看见" —— 所以它既不能写成一段，也不能当依据。
   * 但它的副作用很实在（用户实测）：一次"没认出来"占掉一个 30 秒槽位，
   * 于是**同一个应用里两次认出来之间的间隔被推到 119 秒**，超过合并阈值就断成两段，
   * 面板上看起来像"聊了 2 分钟、歇 2 分钟、又聊 2 分钟"。
   *
   * 桥接规则（只在**同一个应用**时成立，用户选定的口径）：
   *   · 场景没认出来，但 `app`（进程名，本地确定性证据）与上一段一致；
   *   · 且距上一段的结束 ≤ gapMs（说明我们一直在采样，不是"程序没开"）；
   *   → 把上一段的 `end` 推到这一刻，并记一条 `unrecognizedSamples`。
   * 这段时间仍算进上一段的时长（应用确实一直开着），但**次数是留痕的**：
   * 面板那一行会写"其中 N 次没认出来"，所以不是悄悄把不知道的事说成知道。
   */
  if (!isRecognizedScene(scene)) {
    const key = app === '' ? '' : normalizeProcessName(app);
    const lastKey = last ? normalizeProcessName(last.app) : '';
    const gap = last ? atMs - new Date(last.end).getTime() : Number.NaN;
    const sameApp = key !== '' && lastKey !== '' && key === lastKey;
    const continuous = Number.isFinite(gap) && gap >= 0 && gap <= gapMs;
    if (!last || !sameApp || !continuous) return [...segments];
    const bridged: ActivitySegment = {
      ...last,
      end: at,
      samples: last.samples + 1,
      minutes: minutesBetween(last.start, at),
      unrecognizedSamples: (last.unrecognizedSamples ?? 0) + 1,
    };
    return [...segments.slice(0, -1), bridged];
  }

  if (last) {
    const gap = atMs - new Date(last.end).getTime();
    const continuous = Number.isFinite(gap) && gap >= 0 && gap <= gapMs;

    if (last.scene === scene && continuous) {
      const counts = { ...(last.appCounts ?? {}) };
      const key = app === '' ? '（未知）' : app;
      counts[key] = (counts[key] ?? 0) + 1;
      const extended: ActivitySegment = {
        ...last,
        end: at,
        samples: last.samples + 1,
        minutes: minutesBetween(last.start, at),
        appCounts: counts,
        // 友好名字取"最后看到的那个非空值"：它只是显示用的
        ...(label !== '' ? { appLabel: label } : {}),
      };
      return [...segments.slice(0, -1), extended];
    }

    /*
     * 换段：先把上一段补到这一刻（仅当"我们一直在采样"时）。
     * 超过 gapMs 说明中间真的没看/没认出来，那段时间留给 `unaccountedMinutes`。
     */
    if (continuous) {
      const closed: ActivitySegment = { ...last, end: at, minutes: minutesBetween(last.start, at) };
      const created: ActivitySegment = {
        start: at,
        end: at,
        scene,
        app,
        ...(label !== '' ? { appLabel: label } : {}),
        appCounts: { [app === '' ? '（未知）' : app]: 1 },
        samples: 1,
        minutes: 0,
      };
      return [...segments.slice(0, -1), closed, created];
    }
  }

  const created: ActivitySegment = {
    start: at,
    end: at,
    scene,
    app,
    ...(label !== '' ? { appLabel: label } : {}),
    appCounts: { [app === '' ? '（未知）' : app]: 1 },
    samples: 1,
    minutes: 0,
  };
  return [...segments, created];
}


/**
 * 一天的汇总（纯统计）。
 *
 * `byApp` 按**段内占比**分摊时长，而不是"段属于哪一个 app"：
 * 段是按场景合并的（见 `appendObservation`），一段里可能有多个 app 标签
 * （Edge / Chrome 都算 browsing），按占比分摊才能保证
 * `sum(byApp) == activeMinutes` —— 面板上两处数字对不上是最招人怀疑的。
 */
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
      const counts = segment.appCounts ?? {};
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      if (total > 0) {
        for (const [name, count] of Object.entries(counts)) {
          byAppMap.set(name, (byAppMap.get(name) ?? 0) + (ms * count) / total);
        }
      } else {
        const app = segment.app.trim() === '' ? '（未知）' : segment.app.trim();
        byAppMap.set(app, (byAppMap.get(app) ?? 0) + ms);
      }
    }
    if (firstAt === '' || segment.start < firstAt) firstAt = segment.start;
    if (lastAt === '' || segment.end > lastAt) lastAt = segment.end;
  }

  const toMinutes = (ms: number): number => Math.round((ms / 60000) * 10) / 10;
  const activeMinutes = toMinutes(activeMillis);
  const idleMinutes = toMinutes(idleMillis);
  /*
   * 账目自洽：跨度 = 活动 + 空闲 + 没认出来/没采样。
   * 这个数字以前根本不存在，于是"在电脑前 8 小时，活动只有 22 分钟"
   * 看起来就像统计错了 —— 其实差额是"她没认出来"的时间（按需求不记），
   * 现在明确写出来。
   */
  const spanMs = firstAt !== '' && lastAt !== ''
    ? Math.max(0, new Date(lastAt).getTime() - new Date(firstAt).getTime())
    : 0;
  const unaccountedMinutes = toMinutes(Math.max(0, spanMs - activeMillis - idleMillis));
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
    .filter((item) => item.minutes > 0)
    .slice(0, 5);

  return { activeMinutes, idleMinutes, unaccountedMinutes, byScene, byApp, firstAt, lastAt };
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

/**
 * 一段区间的一行文字：`09:10–11:32 写代码（VS Code）· 2 小时 22 分`。
 *
 * 名字走 `appDisplayName()`：**已知程序用固定名字**，其余才用模型读出来的友好名，
 * 最后回退到稳定身份（进程名）—— 于是同一段既能说人话，
 * 又不会让同一个 Edge 在三行里变成 `msedge` / `Microsoft Edge` / `Edge`。
 */
export function formatSegmentLine(segment: ActivitySegment): string {
  const scene = sceneLabel(segment.scene);
  const name = appDisplayName(segment.app, segment.appLabel);
  const app = name === '' ? '' : `（${name}）`;
  const minutes = Math.max(0, new Date(segment.end).getTime() - new Date(segment.start).getTime()) / 60000;
  const tail = minutes < 1 && segment.samples <= 2 ? '刚刚' : formatDuration(minutes);
  return `${formatClock(segment.start)}–${formatClock(segment.end)} ${scene}${app} · ${tail}`;
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
  /*
   * 这段文本会被塞进聊天提示词与日记里，所以**"没认出来"一律不提**
   * （用户要求："如果是没认出来，就当作没看见"）。老的时间线文件里可能已经存了
   * `other` 段，这里再过一道，保证她嘴里不会出现"上午在其他（没认出来）"。
   */
  const scenePart = totals.byScene
    .filter((item) => isRecognizedScene(item.scene))
    .slice(0, 4)
    .map((item) => `${sceneLabel(item.scene)} ${formatDuration(item.minutes)}（${Math.round(item.share * 100)}%）`)
    .join('、');
  const appPart = totals.byApp
    .slice(0, 3)
    // `byApp` 的 key 是**稳定身份**（进程名）：显示时过一遍固定名字表，
    // 否则聊天/日记里会出现 "msedge 1 小时" 这种没人话味的行
    .map((item) => `${appDisplayName(item.app)} ${formatDuration(item.minutes)}`)
    .join('、');
  const recent = recognizedSegments(timeline.segments).slice(-maxSegments).map(formatSegmentLine);

  /*
   * 账目自洽那一行：跨度 = 活动 + 空闲 + 没认出来/没采样。
   *
   * 只在差额明显（≥10 分钟）时才提 —— 否则每句话尾巴都挂一个"还有 3 分钟没认出来"，
   * 既啰嗦又没意义。它不是"今天在做什么"的一部分（所以不放进 scenePart），
   * 而是回答"为什么总时长看起来比在线时间短"。
   */
  const spanLine = totals.unaccountedMinutes >= 10
    ? `（另外约 ${formatDuration(totals.unaccountedMinutes)}没认出在做什么或没采到样，没有算进上面的时长）`
    : '';

  return [
    `今天${until}：${scenePart === '' ? '没有记录到明确的活动' : scenePart}${spanLine}`,
    appPart === '' ? '' : `主要程序：${appPart}`,
    recent.length > 0 ? `最近：${recent.join('；')}` : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** 只留"看懂了"的段（老时间线文件里可能存着 `other`）。 */
export function recognizedSegments(segments: readonly ActivitySegment[]): ActivitySegment[] {
  return segments.filter((segment) => isRecognizedScene(segment.scene));
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
  // 同上：让模型写叙述时也不给"没认出来"的段，免得她照着说出来
  const lines = recognizedSegments(timeline.segments).map(formatSegmentLine).join('\n');
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
