// @ts-check
/**
 * 从**观察记录**重建某一天的时间线。
 *
 * 为什么需要它：时间线是"增量聚合"出来的（每 30 秒把一条观察并进当天的区间表），
 * 所以**聚合规则一改，历史文件不会自动跟着变** —— 旧文件里留着按旧规则切出来的碎片。
 * 这个脚本用**产品里的同一份纯函数**（`shared/timeline.ts`，esbuild 现打包）
 * 把 `observations-<日期>.jsonl` 重放一遍，重写 `timeline-<日期>.json`。
 *
 * 它修的是什么（实测的真实缺陷）：
 *   1. 合并键曾经包含应用名 —— 同一个程序换了窗口标题就把一段切成好几段；
 *   2. 换段时上一段的 `end` 不补到当前时刻 —— 采样间隔（≈30 秒）两边都不算；
 *   3. 于是"在电脑前"的时长被严重低报（实测某天 23.5 分钟 → 113.5 分钟）。
 *
 * ⚠️ 只动 `timeline-*.json`：**观察记录是原始数据，绝不被修改**。
 * 叙述（`narrative`）与 `daily-<日期>.md` 保持原样（那是她写过的话，不重写）。
 *
 * 用法：
 *   node tools/rebuild-timeline.mjs                 # 所有能重建的日期
 *   node tools/rebuild-timeline.mjs 2026-09-27      # 只重建某一天
 *   node tools/rebuild-timeline.mjs --dry           # 只看差异，不写盘
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const onlyDay = args.find((item) => /^\d{4}-\d{2}-\d{2}$/.test(item)) ?? '';

/** 数据目录：与运行时同一条规则（环境变量 > 项目 data/）。 */
const dataDir = process.env.DESKTOP_PET_AI_DATA_DIR || join(root, 'data');
const perceptionDir = join(dataDir, 'perception');

if (!existsSync(perceptionDir)) {
  console.error(`找不到感知数据目录：${perceptionDir}`);
  process.exit(1);
}

/* 把 shared/timeline.ts 现打包成 CJS：工具脚本要用**产品里的同一份规则**，不是复刻一份 */
const entry = join(mkdtempSync(join(tmpdir(), 'ds-rebuild-timeline-')), 'entry.mjs');
writeFileSync(
  entry,
  `export { appendObservation, summarizeDay, localDayOf } from ${JSON.stringify(join(root, 'src', 'shared', 'timeline.ts').replace(/\\/g, '/'))};\n`,
  'utf8',
);
const bundleSource = execFileSync(
  process.execPath,
  [join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), entry, '--bundle', '--platform=node', '--format=cjs'],
  { encoding: 'utf8' },
);
const bundlePath = join(tmpdir(), `ds-timeline-bundle-${Date.now()}.cjs`);
writeFileSync(bundlePath, bundleSource, 'utf8');
const { appendObservation, summarizeDay, localDayOf } = await import(`file://${bundlePath}`);

const days = readdirSync(perceptionDir)
  .map((name) => /^observations-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1] ?? '')
  .filter((day) => day !== '' && (onlyDay === '' || day === onlyDay))
  .sort();

if (days.length === 0) {
  console.log(onlyDay === '' ? '没有任何 observations-*.jsonl 可用来重建' : `${onlyDay} 没有观察记录，跳过`);
  process.exit(0);
}

let rebuilt = 0;
for (const day of days) {
  const timelineFile = join(perceptionDir, `timeline-${day}.json`);
  const previous = existsSync(timelineFile) ? JSON.parse(readFileSync(timelineFile, 'utf8')) : null;

  const observations = readFileSync(join(perceptionDir, `observations-${day}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((item) => item !== null)
    // 只保留**本地日等于这一天**的观察：文件名按本地日切，而 `at` 是 ISO(UTC)
    .filter((item) => localDayOf(new Date(item.at)) === day)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  let segments = [];
  for (const observation of observations) segments = appendObservation(segments, observation);
  const totals = summarizeDay(segments);

  const next = {
    date: day,
    segments,
    totals,
    // 叙述是她写过的话，不重写（那需要再调一次模型）
    narrative: previous?.narrative ?? '',
    updatedAt: previous?.updatedAt ?? new Date(observations[observations.length - 1]?.at ?? Date.now()).toISOString(),
  };

  const before = previous?.totals ?? null;
  const line =
    `  ${day}：观察 ${observations.length} 条 → 段 ${segments.length}` +
    ` · 在电脑前 ${before?.activeMinutes ?? '—'} → ${totals.activeMinutes} 分钟` +
    ` · 离开 ${before?.idleMinutes ?? '—'} → ${totals.idleMinutes} 分钟` +
    ` · 没认出来/没采样 ${totals.unaccountedMinutes} 分钟`;
  console.log(line);

  if (!dryRun) {
    writeFileSync(timelineFile, `${JSON.stringify(next, null, 1)}\n`, 'utf8');
    rebuilt += 1;
  }
}

console.log(dryRun ? `（--dry：没有写盘）` : `已重建 ${rebuilt} 天的时间线（观察记录未改动）`);
