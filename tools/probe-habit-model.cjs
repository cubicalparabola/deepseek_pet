// @ts-check
/**
 * 探针：习惯画像 **v1 → v2 迁移** + **习惯建模的完整链路**（真机）。
 *
 * 为什么必须单独跑一次真机（验收覆盖不到的部分）：
 *   1. **迁移**发生在主进程读盘时（`sanitizeHabits`），渲染层里没有这个函数 ——
 *      而它恰恰是"老用户升级后会不会丢数据"的唯一入口；
 *   2. **习惯条目**（几点、在做什么、几天）需要**多天数据**才会出现，
 *      验收的隔离数据目录里没有这么多历史，只能预先写一份 `habits.json`；
 *   3. 「立刻建模」按钮走的是 IPC -> 服务 -> 落盘，中间任何一环断了验收都看不出来。
 *
 * 做法：
 *   1. 先写一份 **v1 格式**的 `habits.json`（只有小时数字 key、值是观察次数）；
 *   2. 真启动桌宠 -> 读状态：应当已经变成 v2（`version: 2`、`*|10` 桶、
 *      次数被按活跃天数截断成"天"），并且 `typicalNow` 能用；
 *   3. 用本地假网关当大模型，调 `modelHabits()`：断言请求里带的是**统计文本**、
 *      返回的 `summary/line` 被解析出来、条目是本地算的、token 记进了预算；
 *   4. 断言 `habit-model.json` 真的落在 `perception/` 下。
 *
 * 用法：npx electron tools/probe-habit-model.cjs
 * 输出：build/habit-model.json
 *
 * ⚠️ 用独立的 userData / 数据目录，不会和正在运行的桌宠抢单实例锁。
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'habit-model.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-habitmodel');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(join(dataDir, 'perception'), { recursive: true });
mkdirSync(join(dataDir, 'mood'), { recursive: true });

/*
 * ① 一份**真实的 v1 画像**：key 只有小时数字、值是"观察次数"。
 * 27 次观察分布在 3 个活跃日里 —— 迁移后应当变成 3 天（min(count, activeDays)）。
 */
const legacyProfile = {
  hours: {
    10: { coding: 27, reading: 5 },
    15: { browsing: 9 },
  },
  observedHours: 2,
  samples: 41,
  activeDays: 3,
  latestActiveHour: 23,
  earliestActiveHour: 9,
  lastActiveDate: '2026-09-20',
  updatedAt: '2026-09-20T23:00:00.000Z',
};
writeFileSync(join(dataDir, 'perception', 'habits.json'), `${JSON.stringify(legacyProfile, null, 2)}\n`, 'utf8');

/* ② 设置：感知 + 习惯打开；AI 只开"对话"这一条门（`evaluateAIUsability` 要求它） */
writeFileSync(join(dataDir, 'ai-settings.json'), JSON.stringify({
  version: 1,
  enabled: true,
  chat: false,          // 先关着：下面用本地网关再打开，确保"这一轮才接上模型"
  memory: false,
  emotion: false,
  diary: false,
}, null, 2), 'utf8');

/* ③ 本地假网关：把模型该回的两行固定下来，并记录请求体 */
const requests = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch (error) { parsed = {}; }
    requests.push(parsed);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'probe-stub',
      model: 'stub-model',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '摘要：你工作日早上一般在写代码，下午会看点东西。说：这个点你一般在写代码吧？' },
      }],
      usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 },
    }));
  });
});

const profileDir = join(tmpdir(), 'desktop-pet-probe-habitmodel-profile');
try { rmSync(profileDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
app.setPath('userData', profileDir);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish(payload) {
  try {
    writeFileSync(outFile, JSON.stringify(payload, null, 1), 'utf8');
  } catch (error) {
    console.error('写入探针结果失败', error);
  }
  console.log(JSON.stringify(payload, null, 1));
  app.exit(payload.ok === true ? 0 : 1);
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  require(join(root, 'dist', 'main', 'main.js'));

  app.whenReady().then(async () => {
    try {
      await wait(6000);
      const petWin = BrowserWindow.getAllWindows()[0];
      if (!petWin) throw new Error('桌宠窗口不存在');
      const pet = (js) => petWin.webContents.executeJavaScript(js, true);

      /*
       * ① 先建模（真调用本地网关）。
       *
       * 顺序很重要：**先建模再采样**。迁移是"读盘时在内存里做"的，
       * 而磁盘上的文件要等下一次 `learnHabit` 才被重写成 v2 ——
       * 所以此刻内存里正是"迁移后的画像"（旧计数已被截断成天数），
       * 用它能验证"迁移结果真的可用"（条目里出现"平时 10:00"）。
       */
      const modeled = await pet(`(async () => {
        const ai = window.petAPI.ai;
        const before = await ai.status();
        await ai.setSettings({
          enabled: true,
          chat: true,
          provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:${port}/v1', model: 'stub-model', apiKey: 'sk-probe-habit-0001', timeoutMs: 8000 },
        });
        const usable = (await ai.status()).usable;
        const status = await window.petAPI.perception.modelHabits();
        const after = await ai.status();
        // 立刻断开模型：下面的采样就走**本地判断**那条路（不截屏、不再调模型），
        // 这样"网关只被调用一次"是可以断言的
        await ai.setSettings({ clearApiKey: true });
        return {
          usable,
          model: status.habits.model,
          habits: status.habits,
          tokensUsed: after.tokensUsed - before.tokensUsed,
        };
      })()`);

      /*
       * ② 顺便采一次样（本地路径，不调模型），看迁移后的画像会不会被正常落盘。
       *
       * ⚠️ 这一步**不参与判定**：采样能不能认出场景取决于前台窗口，
       * 无头环境里可能什么都认不出来（那就不会写盘）。
       * 迁移本身已由验收用纯函数逐条钉死（喂 v1 JSON 直接断言），
       * 这里只是把"真机上文件长什么样"记下来方便肉眼核对。
       */
      const afterSample = await pet(`(async () => {
        const status = await window.petAPI.perception.sampleNow();
        return { samples: status.habits.samples, scene: status.lastObservation ? status.lastObservation.scene : '' };
      })()`);
      await wait(400);

      const saved = existsSync(join(dataDir, 'perception', 'habits.json'))
        ? JSON.parse(readFileSync(join(dataDir, 'perception', 'habits.json'), 'utf8'))
        : null;

      const onDisk = existsSync(join(dataDir, 'perception', 'habit-model.json'))
        ? JSON.parse(readFileSync(join(dataDir, 'perception', 'habit-model.json'), 'utf8'))
        : null;

      const prompt = JSON.stringify(requests[0]?.messages ?? []);
      const model = modeled.model;
      /* 逐条记下来：探针失败时要能一眼看出是哪一条（否则只能靠猜） */
      const checks = {
        usable: modeled.usable === true,
        oneCall: requests.length === 1,
        promptHasStats: prompt.includes('样本：观察'),
        promptHasRoutines: prompt.includes('归纳出的时段'),
        promptHasAnyKind: prompt.includes('不分平日周末'),
        // 迁移在**真实读盘路径**上生效：旧画像（v1）被换成了"平时 10:00 写代码 3 天"
        migratedInMemory: modeled.habits.recentDays >= 1 && modeled.habits.windowDays === 21,
        modelIsLlm: model !== null && model.source === 'llm',
        summaryOk: model !== null && model.summary.includes('写代码'),
        lineOk: model !== null && model.line.includes('写代码'),
        noError: model !== null && model.error === '',
        onDiskIsLlm: onDisk !== null && onDisk.source === 'llm',
        onDiskMatches: onDisk !== null && model !== null && onDisk.summary === model.summary,
        routinesCount: model !== null && Array.isArray(model.routines) && model.routines.length >= 2,
        routinesAllAny: model !== null && Array.isArray(model.routines) && model.routines.every((item) => item.when.startsWith('平时')),
        routinesDays: model !== null && Array.isArray(model.routines) && model.routines.length > 0 && model.routines[0].days === 3,
        tokensCounted: modeled.tokensUsed >= 55,
      };
      const ok = Object.values(checks).every(Boolean);

      finish({
        ok,
        checks,
        failed: Object.entries(checks).filter(([, value]) => !value).map(([key]) => key),
        model,
        routines: model ? model.routines : [],
        // 只是记录：真实落盘长什么样（判定不依赖它）
        savedProfile: saved,
        samplesAfter: afterSample.samples,
        tokensUsed: modeled.tokensUsed,
        sourceOnDisk: onDisk ? onDisk.source : null,
        prompt,
      });
    } catch (error) {
      finish({ ok: false, error: String((error && error.stack) || error) });
    }
  });
});

setTimeout(() => {
  finish({ ok: false, error: 'PROBE_TIMEOUT' });
}, 90000);
