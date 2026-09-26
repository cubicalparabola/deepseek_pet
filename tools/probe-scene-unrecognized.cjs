// @ts-check
/**
 * 探针：**用你本机真实的习惯数据**验证"没认出来 = 当作没看见"。
 *
 * 用户反馈的原话：『如果是没认出来，就当作没看见，不应该在宠物对话的时候说出
 * "这个时候经常在说不清"这种话』。
 *
 * 这句话的来源就是 `habitPredictionText()`：它照着 `topSceneAtHour()` 挑出的场景
 * 念一句"按你平时的习惯，这个点一般在 X，今天也是吗？"。而 `%APPDATA%\DesktopPet\perception\habits.json`
 * 里**真的存着 `other` 的计数**（本机实测：15 点那一格 other=8，比 browsing=6 还多）——
 * 于是那句台词就变成了"……一般在其他（没认出来）……"。
 *
 * 这个探针不用造数据：
 *   1. 把**你真实的** habits.json 读进来，对 24 个整点各算一遍台词；
 *   2. 把**今天真实的** timeline 读进来，算一遍"今天在做什么"的文本；
 *   3. 判定：任何一句里都不许出现"没认出来"，且当前这一小时要么没有台词、要么是
 *      一个**看得懂**的场景；
 *   4. 顺带把"旧算法会挑哪一个"也算出来写进结果（同一份数据下旧算法确实会挑到 other），
 *      这样"这句话是怎么冒出来的"在结果文件里一目了然。
 *
 * 用法：npx electron tools/probe-scene-unrecognized.cjs
 * 输出：build/scene-unrecognized.json
 */
const { app, BrowserWindow } = require('electron');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'scene-unrecognized.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-scene');
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.setPath('userData', dataDir);
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ai-settings.json'), JSON.stringify({ enabled: false }, null, 2), 'utf8');
writeFileSync(join(dataDir, 'perception-settings.json'), JSON.stringify({ screen: false, behavior: false, camera: false, habits: false }, null, 2), 'utf8');

app.disableHardwareAcceleration();
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 用户真实的感知数据目录（探针只读它，不写）。 */
const realDir = join(app.getPath('appData'), 'DesktopPet', 'perception');
const habitsFile = join(realDir, 'habits.json');
const todayKey = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();
const timelineFile = join(realDir, `timeline-${todayKey}.json`);

app.whenReady().then(async () => {
  await wait(7000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('桌宠窗口不存在');
  const run = (js) => win.webContents.executeJavaScript(js, true);

  const result = { habitsFile, timelineFile, habitsExists: existsSync(habitsFile), timelineExists: existsSync(timelineFile) };
  if (!result.habitsExists) throw new Error(`没有找到真实的习惯文件：${habitsFile}`);

  const habits = JSON.parse(readFileSync(habitsFile, 'utf8'));
  const timeline = existsSync(timelineFile) ? JSON.parse(readFileSync(timelineFile, 'utf8')) : null;
  result.habitHours = Object.keys(habits.hours ?? {}).length;

  /* 旧算法（把 other 也算进去）会挑哪个场景 —— 只为把"这句话怎么来的"写进结果 */
  const legacyTop = {};
  for (const [hour, bucket] of Object.entries(habits.hours ?? {})) {
    let best = null;
    for (const [scene, count] of Object.entries(bucket)) {
      if (!best || count > best.count) best = { scene, count };
    }
    legacyTop[hour] = best ? best.scene : null;
  }
  result.legacyTopByHour = legacyTop;
  result.legacyTopIsOther = Object.entries(legacyTop).filter(([, scene]) => scene === 'other').map(([hour]) => hour);

  /* 新算法 + 真实台词：交给渲染层的纯函数算（与产品代码同一份实现） */
  const evaluated = await run(`(() => {
    const model = window.petDebug.perception;
    const profile = ${JSON.stringify(habits)};
    const settings = window.petDebug.perception.DEFAULT_PERCEPTION_SETTINGS;
    const behavior = { idleSeconds: 5, sessionMinutes: 10, switchesLastHour: 2, hour: 12, lateNight: false, userState: 'deep' };
    const now = new Date();
    const lines = [];
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 30, 0).getTime();
      const top = model.topSceneAtHour(profile, hour);
      const text = model.habitPredictionText({ profile, now: at, settings, behavior });
      if (top !== null || text !== null) lines.push({ hour, top, text });
    }
    const timeline = ${timeline === null ? 'null' : JSON.stringify(timeline)};
    return {
      currentHour: now.getHours(),
      lines,
      timelineText: timeline === null ? null : model.formatTimelineText(timeline, { maxSegments: 3 }),
      normalizeOther: model.normalizeScene('other'),
      labelOther: model.sceneLabel('other'),
    };
  })()`);
  result.evaluated = evaluated;

  const badLines = evaluated.lines.filter((line) => line.top === 'other' || (line.text ?? '').includes('没认出来'));
  const currentLine = evaluated.lines.find((line) => line.hour === evaluated.currentHour) ?? null;

  result.verdict = {
    // 真实画像里确实有 other 的格子，而且旧算法真的会挑到它（这就是用户听到那句话的来源）
    legacyPickedOther: result.legacyTopIsOther.length > 0,
    // 新算法：24 个小时里没有任何一句把"没认出来"当场景说出来
    noUnrecognizedSpeech: badLines.length === 0,
    // 当前这一小时要么没有台词，要么是看得懂的场景
    currentHourSpeakable:
      currentLine === null ||
      (currentLine.top !== null && currentLine.top !== 'other' && !String(currentLine.text ?? '').includes('没认出来')),
    // 时间线文本（"今天在做什么"）里也不出现"没认出来"
    timelineTextClean:
      evaluated.timelineText === null || !String(evaluated.timelineText).includes('没认出来'),
  };

  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log(`\n[verdict] ${JSON.stringify(result.verdict, null, 1)}`);
  console.log(`[真实画像] ${result.habitHours} 个整点有样本；旧算法会在这些小时挑到 other：${result.legacyTopIsOther.join(',') || '（无）'}`);
  console.log(`[当前小时 ${evaluated.currentHour}] ${JSON.stringify(currentLine)}`);
  console.log(`[今天在做什么] ${JSON.stringify(evaluated.timelineText)}`);
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
