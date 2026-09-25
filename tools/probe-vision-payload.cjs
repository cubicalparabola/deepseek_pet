// @ts-check
/**
 * 探针：**把"她真正发给模型的东西"抓下来看**（起一个本地假模型服务）。
 *
 * 为什么必须这么做：感知这一路隐私承诺是"图像只在内存里活一次、永不落盘"，
 * 所以线上代码里**看不到**任何帧。可"窗口特写到底有没有附上""桌面自己有没有被涂掉"
 * "读不清时 activity 是不是真的被清空"这些恰恰只能看请求体才知道 ——
 * 这个探针用**可运行的假模型**换到那份证据（只写进 `build/`，那是探针自己的产物，
 * 与产品行为无关；产品本身依旧一个字节都不落盘）。
 *
 * 检查四件事：
 *   1. 一次采样真的发了 **3 张图**（整屏 / 地址栏横条 / 窗口特写）；
 *   2. 提示词里有 `contentReadable` 与"最上层窗口的特写"这两条契约；
 *   3. **桌宠自己那块像素被涂平了**（与"直接截屏"的同一块比方差）；
 *   4. 假模型回 `contentReadable:false` 时，落盘的观察里 `activity` / `suggestion` 真的是空的、
 *      且 `readable === false`（这是"读不清就不许猜"的端到端证据）。
 *
 * 用法：npx electron tools/probe-vision-payload.cjs
 * 输出：build/vision-payload.json + build/vision-payload-*.jpg
 */
const { app, BrowserWindow, desktopCapturer, nativeImage, screen } = require('electron');
const { createServer } = require('node:http');
const { mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'vision-payload.json');
const { guardSingleInstance } = require('./lib/instance-guard.cjs');
const dataDir = join(tmpdir(), 'desktop-pet-probe-vision-payload');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(dataDir, { recursive: true });

app.disableHardwareAcceleration();
guardSingleInstance(app, {
  onBlocked: (message) => {
    try { writeFileSync(outFile, JSON.stringify({ fatal: message }, null, 1), 'utf8'); } catch (error) { /* 忽略 */ }
  },
});
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假模型的回答：故意 `contentReadable:false` + 编了一句具体内容，用来验证代码侧闸门。 */
const FAKE_ANSWER = JSON.stringify({
  scene: 'terminal',
  app: 'Windows Terminal',
  contentReadable: false,
  // 模型"一边说看不清一边又编"是最常见的情形 —— 线上必须在落盘前把它清掉
  activity: '在跑 npm run acceptance',
  url: '',
  browserChrome: false,
  editorChrome: false,
  sensitive: false,
  focus: 'unknown',
  suggestion: '试试 npm ci',
});

/** 收到的请求体（只留最后一次）。 */
let lastRequest = null;

function startFakeModel() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try { lastRequest = JSON.parse(body); } catch (error) { lastRequest = { raw: body.slice(0, 2000) }; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: FAKE_ANSWER } }],
          usage: { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * 一块区域的"平整度"：逐通道 max-min 的最大值。涂过色的补丁接近 0。
 *
 * ⚠️ 两种缩进都试过，各有各的坑，最后用"内部 25%"：
 * - 缩 25% 太少的信息？不 —— 缩 25% 时第一次量到"没涂"的对照组也很平整（2），
 *   因为鲸鱼娘画在窗口偏下，中心那块本来就是透明背景，等于没量到东西；
 * - 不缩则会把补丁边界与 JPEG 振铃算进来（实测 41），把"涂成功了"误判成"没涂干净"。
 * 所以：**判断"涂没涂平"用内部 25%**（`interiorFlatness`），
 * 判断"这里本来有没有内容"用接近整块（`fullFlatness`）+ 与隐藏对照比较（见 self-capture 探针）。
 */
function flatness(bitmap, size, rect, insetRatio) {
  const insetX = Math.max(2, Math.round(rect.width * insetRatio));
  const insetY = Math.max(2, Math.round(rect.height * insetRatio));
  const x0 = rect.x + insetX;
  const y0 = rect.y + insetY;
  const x1 = Math.min(size.width, rect.x + rect.width - insetX);
  const y1 = Math.min(size.height, rect.y + rect.height - insetY);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  let worst = 0;
  for (let channel = 0; channel < 3; channel++) {
    let min = 255;
    let max = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const value = bitmap[(y * size.width + x) * 4 + channel] ?? 0;
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
    worst = Math.max(worst, max - min);
  }
  return worst;
}

app.whenReady().then(async () => {
  const { server, port } = await startFakeModel();
  await wait(6000);
  const petWin = BrowserWindow.getAllWindows()[0];
  if (!petWin) throw new Error('桌宠窗口不存在');
  const run = (js) => petWin.webContents.executeJavaScript(js, true);

  // 先把桌宠**显式显示**出来：这条断言要有意义，前提是她真的在画面上（她可能被上一次运行藏起来了）
  await run(`(() => { window.petAPI.window.show(); return true; })()`);
  await wait(1200);

  await run(`(async () => {
    await window.petAPI.ai.setSettings({
      enabled: true, chat: true,
      provider: { baseUrl: 'http://127.0.0.1:${port}/v1', model: 'probe-vision', apiKey: 'sk-probe-0001', timeoutMs: 5000 },
    });
    await window.petAPI.perception.setSettings({ screen: true, windowContext: true, captureUrl: true, windowCloseUp: true, privacyMode: false });
    return true;
  })()`);
  await wait(600);

  const status = await run(`window.petAPI.perception.sampleNow()`);
  await wait(800);

  // 请求体里把图抠出来（探针自己的产物，写进 build/ 供肉眼看）
  // 注意：OpenAI 兼容格式把图片放在 `{type:'image_url', image_url:{url:'data:image/jpeg;base64,...'}}`
  const messages = (lastRequest && lastRequest.messages) || [];
  const images = [];
  let promptText = '';
  for (const message of messages) {
    const content = message.content;
    if (typeof content === 'string') { promptText += content + '\n'; continue; }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string') promptText += part.text + '\n';
      const dataUrl = part.type === 'image_url' && part.image_url ? part.image_url.url : '';
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        images.push({ dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) });
      }
    }
  }
  images.forEach((part, index) => {
    writeFileSync(join(root, 'build', `vision-payload-${index + 1}.jpg`), Buffer.from(part.dataBase64, 'base64'));
  });

  // 桌宠那块在自己截的帧里平不平？（与"直接截屏"的同区域对比）
  const bounds = petWin.getBounds();
  const primary = screen.getPrimaryDisplay();
  const petRegion = bounds;
  let inPayloadFlatness = null;
  let inPayloadInterior = null;
  let rawFlatness = null;
  if (images.length > 0) {
    const image = nativeImage.createFromBuffer(Buffer.from(images[0].dataBase64, 'base64'));
    const size = image.getSize();
    const k = size.width / primary.size.width;
    const region = {
      x: Math.max(0, Math.round(petRegion.x * k)),
      y: Math.max(0, Math.round(petRegion.y * k)),
      width: Math.max(2, Math.round(petRegion.width * k)),
      height: Math.max(2, Math.round(petRegion.height * k)),
    };
    const bitmap = image.toBitmap();
    inPayloadFlatness = flatness(bitmap, size, region, 0.04);
    inPayloadInterior = flatness(bitmap, size, region, 0.25);
    // 存下来肉眼看（探针产物，产品本身不落任何图）
    writeFileSync(join(root, 'build', 'vision-payload-pet-region.jpg'), image.crop(region).toJPEG(85));
  }
  {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    });
    const source = sources.find((item) => String(item.display_id) === String(primary.id)) ?? sources[0];
    const raw = source.thumbnail;
    const size = raw.getSize();
    const k = size.width / primary.size.width;
    const region = {
      x: Math.max(0, Math.round(petRegion.x * k)),
      y: Math.max(0, Math.round(petRegion.y * k)),
      width: Math.max(2, Math.round(petRegion.width * k)),
      height: Math.max(2, Math.round(petRegion.height * k)),
    };
    rawFlatness = flatness(raw.toBitmap(), size, region, 0.04);
    // 同一块"没涂过"的对照图
    writeFileSync(join(root, 'build', 'vision-payload-pet-region-raw.jpg'), raw.crop(region).toJPEG(85));
  }

  await run(`window.petAPI.ai.setSettings({ clearApiKey: true })`);

  const observation = status.lastObservation;
  const result = {
    requestSeen: lastRequest !== null,
    imageCount: images.length,
    petBounds: petRegion,
    petVisible: petWin.isVisible(),
    imageSizes: images.map((part) => {
      const image = nativeImage.createFromBuffer(Buffer.from(part.dataBase64, 'base64'));
      const size = image.getSize();
      return `${size.width}x${size.height}`;
    }),
    promptHasReadableField: promptText.includes('contentReadable'),
    promptHasCloseUpNotice: promptText.includes('最上层窗口的特写'),
    // 涂过 ⇒ 补丁**内部**应当几乎是纯色（JPEG 下通常个位数）；接近整块会带上边界与振铃
    petRegionInPayloadFlatness: inPayloadFlatness,
    petRegionInPayloadInteriorFlatness: inPayloadInterior,
    petRegionInRawCaptureFlatness: rawFlatness,
    petMaskedInPayload: inPayloadInterior !== null && inPayloadInterior <= 12,
    observation: observation === null ? null : {
      scene: observation.scene,
      activity: observation.activity,
      suggestion: observation.suggestion,
      readable: observation.readable,
      mode: observation.mode,
    },
    lastCloseUp: status.lastCloseUp,
    verdict: {
      threeImages: images.length === 3,
      promptContract: promptText.includes('contentReadable') && promptText.includes('最上层窗口的特写'),
      petMasked: inPayloadInterior !== null && inPayloadInterior <= 12,
      unreadableGated: observation !== null && observation.readable === false && observation.activity === '' && observation.suggestion === '',
    },
  };
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('[result]', JSON.stringify(result, null, 1));
  server.close();
  app.exit(0);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
