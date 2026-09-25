// @ts-check
/**
 * 探针：**「每天在做什么」端到端**——周期观察 → 区间 → 落盘 → 模型写"她记得的今天"。
 *
 * 为什么需要它：验收只能断言纯函数规则（合并/切分/汇总）与"字段存在"，
 * 而这条链路真正的风险在**接线**上：观察有没有真的进时间线？跨 30 秒的两条观察
 * 会不会合成一段？文件到底写了没有？模型写的那段有没有落进 `daily-<日期>.md`？
 *
 * 做法：起一个**本地假模型**（按请求内容区分"场景分析"与"写叙述"两种回答），
 * 把采样间隔压短，连着采三次（每次都从假模型拿到同一个场景），然后：
 *   1. 断言 `status.timeline` 里有区间、时长 ≥ 1 分钟；
 *   2. 断言 `perception/timeline-<日期>.json` 与 `daily-<日期>.md` 真的写出来了；
 *   3. 调 `narrateTimeline()`，断言它写回了叙述并落进 md。
 *
 * 用法：npx electron tools/probe-timeline.cjs
 * 输出：build/timeline-probe.json（+ 它在临时数据目录里留下的 timeline/daily 文件）
 */
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'timeline-probe.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-timeline');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCENE_ANSWER = JSON.stringify({
  scene: 'coding', app: 'code', activity: '在写一个探针', url: '', browserChrome: false,
  editorChrome: true, sensitive: false, focus: 'deep', suggestion: '',
});
const NARRATIVE = '我记得你今天一直在写代码，中间还停下来看了会儿网页，感觉挺专注的。';

function startFakeModel() {
  return new Promise((resolve) => {
    const requests = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        // 时间线叙述的提示词里有"时间线"这个词；场景分析没有
        const isNarrative = body.includes('时间线');
        requests.push({ at: new Date().toISOString(), kind: isNarrative ? 'narrative' : 'scene' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: isNarrative ? NARRATIVE : SCENE_ANSWER } }],
          usage: { prompt_tokens: 800, completion_tokens: 60, total_tokens: 860 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

app.whenReady().then(async () => {
  const { server, port, requests } = await startFakeModel();
  await wait(6000);
  const petWin = BrowserWindow.getAllWindows()[0];
  if (!petWin) throw new Error('桌宠窗口不存在');
  const run = (js) => petWin.webContents.executeJavaScript(js, true);

  const configure = await run(`(async () => {
    await window.petAPI.ai.setSettings({
      enabled: true, chat: true,
      provider: { baseUrl: 'http://127.0.0.1:${port}/v1', model: 'probe-timeline', apiKey: 'sk-probe-timeline-0001', timeoutMs: 5000 },
    });
    // 采样间隔压到最小（5s），保证三次采样能落在同一段里、且能攒出真实时长
    await window.petAPI.perception.setSettings({ screen: true, windowContext: true, privacyMode: false, captureIntervalMs: 5000 });
    return true;
  })()`);

  // 三次采样，间隔 6 秒（> 5s 节流，但远小于 90s 的"同一段"上限 → 应当合并成一段）
  for (let i = 0; i < 3; i += 1) {
    await run(`window.petAPI.perception.sampleNow()`);
    if (i < 2) await wait(6000);
  }
  await wait(500);

  const afterSamples = await run(`(async () => {
    const status = await window.petAPI.perception.status();
    return { timeline: status.timeline, lastObservation: status.lastObservation };
  })()`);

  const perceptionDir = join(dataDir, 'perception');
  const filesAfterSamples = existsSync(perceptionDir) ? readdirSync(perceptionDir).sort() : [];
  const timelineFile = filesAfterSamples.find((name) => name.startsWith('timeline-'));
  const timelineJson = timelineFile ? JSON.parse(readFileSync(join(perceptionDir, timelineFile), 'utf8')) : null;

  const narrated = await run(`window.petAPI.perception.narrateTimeline()`);
  await wait(300);
  const dailyFile = filesAfterSamples.find((name) => name.startsWith('daily-'));
  const dailyMarkdown = dailyFile ? readFileSync(join(perceptionDir, dailyFile), 'utf8') : '';

  const recent = afterSamples.timeline.recent ?? [];
  const first = recent[0] ?? null;

  /*
   * 顺手核一遍**感知日志文件**（用户报过"时间不对、不够详细"）：
   * 真机上跑出来的那份 `perception-log.md`，最后一条 [observation] 行必须是
   * `- YYYY-MM-DD HH:MM:SS · [observation] …`（**本地**时间 + 秒），且字段齐全（用 `｜` 分隔）。
   */
  const logPath = join(perceptionDir, 'perception-log.md');
  const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const observationLines = logText.split('\n').filter((line) => line.includes('· [observation] '));
  const lastObservationLine = observationLines[observationLines.length - 1] ?? '';
  const parsedLine = /^- (\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2}) · \[observation\] (.+)$/.exec(lastObservationLine);
  const localNow = new Date();
  const logCheck = {
    line: lastObservationLine.slice(0, 200),
    matched: parsedLine !== null,
    dateIsLocalToday: parsedLine !== null && parsedLine[1] === `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`,
    // 允许跨小时边界：差不超过 1 小时就算"本地时间对上了"（UTC 写法会差 8 小时，照样会被抓住）
    hourIsLocal: parsedLine !== null && Math.abs(Number(parsedLine[2]) - localNow.getHours()) <= 1,
    detailed: parsedLine !== null && parsedLine[5].includes('｜'),
  };

  /*
   * 顺手截一张**有真实数据**的面板图（截图验收抓过好几次真 bug，比如复选框没回填）。
   * 滚到"今天在做什么（时间线）"那一段再截，肉眼看区间行、合计与叙述排版是否正常。
   */
  let shotPath = '';
  try {
    await run(`window.petAPI.window.showSettingsWindow()`);
    await wait(2500);
    const settingsWin = BrowserWindow.getAllWindows().find((window) => {
      try { return window.webContents.getURL().includes('/settings/'); } catch (error) { return false; }
    });
    if (settingsWin) {
      await settingsWin.webContents.executeJavaScript(`(() => {
        const sections = Array.from(document.querySelectorAll('#perception-panel-root .perception-section'));
        const target = sections.find((s) => (s.querySelector('h2')?.textContent ?? '').includes('今天在做什么'));
        if (target) target.scrollIntoView({ block: 'start' });
        return true;
      })()`, true);
      await wait(1200);
      const image = await settingsWin.capturePage();
      shotPath = join(root, 'build', 'shot-timeline.png');
      writeFileSync(shotPath, image.toPNG());
      console.log(`[shot] timeline -> ${shotPath}`);
    }
  } catch (error) {
    console.log('[shot] 截图失败（不影响结论）', String(error));
  }

  const result = {
    configureOk: configure === true,
    fakeModelRequests: requests,
    timeline: {
      date: afterSamples.timeline.date,
      activeMinutes: afterSamples.timeline.activeMinutes,
      recentCount: recent.length,
      firstSegment: first,
      firstSegmentMinutes: first ? Math.round(((new Date(first.end).getTime() - new Date(first.start).getTime()) / 60000) * 10) / 10 : null,
      topScene: afterSamples.timeline.byScene[0] ?? null,
      topApp: afterSamples.timeline.byApp[0] ?? null,
    },
    files: filesAfterSamples,
    timelineJsonSegments: timelineJson ? timelineJson.segments.length : 0,
    timelineJsonFirstSamples: timelineJson && timelineJson.segments[0] ? timelineJson.segments[0].samples : 0,
    narrativeReturned: narrated.narrative,
    dailyMarkdownHasNarrative: dailyMarkdown.includes('她记得的今天') && dailyMarkdown.includes(narrated.narrative.slice(0, 12)),
    shot: shotPath,
    log: logCheck,
    verdict: {
      threeSamplesMergedIntoOneSegment: recent.length === 1 && timelineJson !== null && timelineJson.segments[0].samples === 3,
      intervalHasDuration: first !== null && (new Date(first.end).getTime() - new Date(first.start).getTime()) >= 10000,
      filesWritten: timelineFile !== undefined && dailyFile !== undefined,
      narrativeWritten: narrated.narrative.length > 0 && dailyMarkdown.includes(narrated.narrative.slice(0, 12)),
      sceneFromModel: afterSamples.lastObservation !== null && afterSamples.lastObservation.scene === 'coding',
      logLineLocalAndDetailed:
        logCheck.matched && logCheck.dateIsLocalToday && logCheck.hourIsLocal && logCheck.detailed,
    },
  };
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('[result]', JSON.stringify(result, null, 1));
  server.close();
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
