/**
 * 习惯建模（3.6 的"第二层"）—— 把统计出来的习惯**归纳成她自己的话**。
 *
 * 分工刻意划得很清，这是整个模块最重要的设计决定：
 *
 * | 部分 | 谁来做 | 为什么 |
 * |---|---|---|
 * | `routines`（几点、在做什么、用什么、几天） | **本地纯函数**（`buildHabitRoutines`） | 这些是"事实"，必须能从 `habits.json` 逐条复算出来；让模型生成数字就等于允许它编 |
 * | `summary`（一段她眼里的你） | **大模型**（可用时） | 模型擅长的是把"工作日 09:00 写代码 ×6 天"这种表写成自然语言 |
 * | `line`（一句能直接说出口的话） | **大模型**（可用时） | 闲聊要的是人话，不是统计读数 |
 *
 * 因此：**模型只写措辞，不写事实**。模型不可用 / 调用失败 / 输出不可解析时，
 * 退回 `localHabitModel()` 的模板 —— 面板永远有东西看，功能不会静默消失。
 *
 * 另外两条约束：
 * - 输入是**统计文本**（`habitStatsLines()` 的输出），不是原始 JSON、更不是截图；
 * - 模型输出**不会**改变任何行为（不改频率、不改触发）—— 它只被展示与"说出口"。
 */

import type { HabitProfile } from './perception-types';
import { sceneLabel } from './perception';
import {
  HABIT_KIND_ANY,
  HABIT_MIN_DAYS,
  describeHour,
  habitStatsLines,
  type HabitDayKind,
} from './perception';

/** 一条"习惯条目"（**由本地统计算出**，不是模型生成的）。 */
export interface HabitRoutine {
  /** 时段描述，例如 `工作日 09:00–11:00` / `周末 14:00 前后`。 */
  readonly when: string;
  /** 场景名（中文，直接可读）。 */
  readonly what: string;
  /** 主要应用（没学到 = 空串）。 */
  readonly app: string;
  /** 这条结论背后有几天数据（真实统计）。 */
  readonly days: number;
}

/** 模型输出的上限（防呆：它偶尔会写小作文）。 */
export const HABIT_SUMMARY_MAX_CHARS = 400;
export const HABIT_LINE_MAX_CHARS = 60;

export interface HabitModel {
  /** 她眼里的你（2~4 句，第一人称）。 */
  readonly summary: string;
  /** 一句可以直接说出口的话（闲聊用；空串 = 没有）。 */
  readonly line: string;
  /** 本地算出的习惯条目。 */
  readonly routines: readonly HabitRoutine[];
  readonly source: 'llm' | 'template';
  readonly tokens: number;
  readonly updatedAt: string;
  readonly samples: number;
  readonly activeDays: number;
  /** 走模板的原因（`source === 'llm'` 时为空）。 */
  readonly error: string;
}

/* -------------------------------------------------------------------------- */
/* 一、本地：从统计里抽出"习惯条目"                                              */
/* -------------------------------------------------------------------------- */

/**
 * 把画像归纳成几条**连续时段**的习惯。
 *
 * 做法（纯扫描，没有任何推测）：
 *   1. 分别看 `工作日` / `周末` 两档；
 *   2. 逐小时取"这个点在做什么"（`describeHour`，门槛放到 1 天，因为这里只是**发现**，
 *      要不要说出口由调用方按 `HABIT_MIN_DAYS` 判断）；
 *   3. 相邻小时是同一场景（且应用一致）就合并成一个时段；
 *   4. 整个时段的"天"数取其中最大值，且必须 ≥ `HABIT_MIN_DAYS` 才留下 ——
 *      只出现过一天的时段不是习惯，不进模型。
 *
 * @returns 按"天"数从多到少排序的条目（最多 8 条）
 */
export function buildHabitRoutines(profile: HabitProfile, limit = 8): HabitRoutine[] {
  const routines: HabitRoutine[] = [];

  for (const kind of ['weekday', 'weekend'] as const) {
    let run: { start: number; end: number; scene: string; app: string; days: number } | null = null;

    const flush = (): void => {
      if (!run) return;
      const days = run.days;
      const span = run.start === run.end ? `${pad(run.start)}:00 前后` : `${pad(run.start)}:00–${pad(run.end + 1)}:00`;
      if (days >= HABIT_MIN_DAYS) {
        routines.push({
          when: `${kindLabel(kind)} ${span}`,
          what: sceneLabel(run.scene as Parameters<typeof sceneLabel>[0]),
          app: run.app,
          days: Math.round(days),
        });
      }
      run = null;
    };

    for (let hour = 0; hour < 24; hour += 1) {
      /*
       * `allowAnyFallback: false`：这一轮只认"确实是工作日/周末"的数据。
       * 否则旧数据（`*` 档）会被算成两遍，面板上就会出现
       * "工作日 10:00 写代码"和"周末 10:00 写代码"两条其实同一份证据的条目。
       */
      const reading = describeHour(profile, hour, { kind, minDays: 1, minSceneDays: 1, allowAnyFallback: false });
      if (!reading) {
        flush();
        continue;
      }
      if (run && run.scene === reading.scene && run.app === reading.app) {
        run.end = hour;
        run.days = Math.max(run.days, reading.days);
        continue;
      }
      flush();
      run = { start: hour, end: hour, scene: reading.scene, app: reading.app, days: reading.days };
    }
    flush();
  }

  /*
   * 旧数据（`*` 档）：只在这两档都没抽出东西时才用上。
   * 措辞里写"平时"而不是"工作日/周末" —— 我们确实不知道那天是星期几，
   * 这一点必须让用户看得出来（否则他会以为她分得清）。
   */
  if (routines.length === 0) {
    for (let hour = 0; hour < 24; hour += 1) {
      const reading = describeHour(profile, hour, { kind: HABIT_KIND_ANY, minDays: HABIT_MIN_DAYS, minSceneDays: 2 });
      if (!reading) continue;
      routines.push({
        when: `${kindLabel(HABIT_KIND_ANY)} ${pad(hour)}:00 前后`,
        what: sceneLabel(reading.scene),
        app: reading.app,
        days: Math.round(reading.days),
      });
    }
  }

  return routines.sort((a, b) => b.days - a.days).slice(0, limit);
}

function pad(hour: number): string {
  return String(hour).padStart(2, '0');
}

function kindLabel(kind: HabitDayKind): string {
  return kind === 'weekend' ? '周末' : kind === 'weekday' ? '工作日' : '平时';
}

/* -------------------------------------------------------------------------- */
/* 二、给模型看的输入 / 提示词                                                   */
/* -------------------------------------------------------------------------- */

/** 统计摘要（提示词与面板共用的同一段文本，避免两处口径不一致）。 */
export function habitModelDigest(profile: HabitProfile, routines: readonly HabitRoutine[]): string {
  const lines = habitStatsLines(profile);
  if (routines.length > 0) {
    lines.push(
      '归纳出的时段（由统计直接算出，天数是真的）：',
      ...routines.map((item) => `- ${item.when}：${item.what}${item.app === '' ? '' : `（${item.app}）`}，共 ${item.days} 天`),
    );
  } else {
    lines.push('归纳出的时段：（还没有稳定到可以下结论的时段）');
  }
  return lines.join('\n');
}

export function buildHabitModelMessages(input: {
  readonly digest: string;
  readonly petName: string;
  readonly userName: string;
}): { system: string; user: string } {
  const name = input.userName.trim() === '' ? '主人' : input.userName.trim();
  const system = [
    `你是住在 ${name} 的 Windows 桌面上的鲸鱼娘桌宠「${input.petName}」。`,
    `现在你要根据**统计出来的作息数据**，把你对 ${name} 的了解写成一段话。`,
    '',
    '要求：',
    '- 第一人称，口语化，像你心里对他的了解，2~4 句，不要标题、不要列表、不要 Markdown；',
    '- 只能使用下面数据里出现过的事实（场景、应用、时段、天数）；**不要编造**没有的时段或爱好；',
    '- 数据不足时就直接说"还没摸清"，不要硬凑；',
    '- 另外单独写一句**可以直接对他说出口**的话（不超过 30 字，不要引号）。',
    '',
    '输出格式（严格遵守，两行）：',
    '第一行以「摘要：」开头，写那段 2~4 句的话；',
    '第二行以「说：」开头，写那句可以直接说出口的话。',
  ].join('\n');
  const user = ['这是我观察统计到的数据：', input.digest, '', '现在写你的摘要与那句话。'].join('\n');
  return { system, user };
}

/* -------------------------------------------------------------------------- */
/* 三、解析（宽容：模型很爱加围栏与前后缀）                                       */
/* -------------------------------------------------------------------------- */

function clean(text: unknown, max: number): string {
  return (typeof text === 'string' ? text : '')
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```\s*$/, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/^[\s"'“”「」【】]+/, '')
    .replace(/[\s"'“”「」【】]+$/, '')
    .trim()
    .slice(0, max);
}

/**
 * 解析模型输出（提示词要求"摘要：… / 说：…"两行）。
 *
 * ⚠️ 实测：模型（以及我们的假网关）经常把两段**挤在同一行**里
 * （`摘要：……。说：……`），所以这里**不要求换行** ——
 * 先找 `说：` 这个分隔标记，找不到才退回"整段都当摘要"。
 *
 * 其它宽容处理：`**摘要**：`、代码围栏、多余引号。
 * 解析不出摘要时返回 `null`，调用方退回模板（**不会**把半成品写进模型文件）。
 */
export function parseHabitModel(raw: string): { summary: string; line: string } | null {
  const text = typeof raw === 'string' ? raw : '';
  if (text.trim() === '') return null;

  const body = text
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```\s*$/, '')
    .trim();

  const summaryMarker = /(?:\*\*)?摘要(?:\*\*)?\s*[:：]/;
  const lineMarker = /(?:\*\*)?说(?:\*\*)?\s*[:：]/;
  const lineMatch = lineMarker.exec(body);

  let summaryRaw = '';
  let lineRaw = '';
  if (lineMatch && lineMatch.index > 0) {
    // `说：` 之前是摘要（去掉"摘要："标签），之后是那句可以直接说出口的话
    summaryRaw = body.slice(0, lineMatch.index);
    lineRaw = body.slice(lineMatch.index + lineMatch[0].length);
  } else if (lineMatch && lineMatch.index === 0) {
    lineRaw = body.slice(lineMatch[0].length);
  } else {
    summaryRaw = body;
  }

  let summary = clean(summaryRaw.replace(summaryMarker, ''), HABIT_SUMMARY_MAX_CHARS);
  const line = clean(lineRaw.split('\n')[0], HABIT_LINE_MAX_CHARS);

  // 没按格式来：整段当摘要，尽量从最后一行捞出一句短的当"说"
  if (summary === '') {
    const whole = clean(body.replace(summaryMarker, ''), HABIT_SUMMARY_MAX_CHARS);
    if (whole === '') return null;
    summary = whole;
  }
  // 摘要里换行压成空格：面板里显示成一段更自然
  summary = summary.replace(/\n+/g, ' ').trim();
  if (summary === '') return null;
  return { summary, line };
}

/* -------------------------------------------------------------------------- */
/* 四、模板兜底（没有模型时也要"建模"）                                           */
/* -------------------------------------------------------------------------- */

/** 用条目拼一段话（确定性，无模型）。 */
export function localHabitModel(input: {
  readonly profile: HabitProfile;
  readonly routines: readonly HabitRoutine[];
  readonly petName: string;
  readonly userName: string;
  readonly now: Date;
}): { summary: string; line: string } {
  const name = input.userName.trim() === '' ? '主人' : input.userName.trim();
  const { profile, routines } = input;

  if (routines.length === 0) {
    return {
      summary: profile.samples === 0
        ? `我还没怎么看懂${name}的习惯——等我看得多了，就能说清"这个点你一般在做什么"了。`
        : `我还在慢慢记${name}的习惯（已经看了 ${profile.samples} 次、${profile.activeDays} 天），还没到能下结论的时候。`,
      line: '',
    };
  }

  const top = routines.slice(0, 3).map((item) => `${item.when}在${item.what}`);
  const parts = [`我大概摸清${name}的作息了：${top.join('，')}。`];
  if (profile.earliestActiveHour !== null && profile.latestActiveHour !== null) {
    parts.push(`平时 ${profile.earliestActiveHour}:00 左右开始，${profile.latestActiveHour}:00 前后还在。`);
  }
  const first = routines[0];
  return {
    summary: parts.join(''),
    line: first ? `这个点你一般在${first.what}吧？` : '',
  };
}

/** 模型文件里的一句话是否"能说出口"（闲聊前过一道闸）。 */
export function sanitizeHabitLine(text: unknown): string {
  return clean(text, HABIT_LINE_MAX_CHARS);
}
