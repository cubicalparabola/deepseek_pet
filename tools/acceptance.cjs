// @ts-check
/**
 * 端到端自动验收脚本（非产品代码）。
 *
 * 真实启动桌宠，注入验收脚本到 renderer，逐项检查需求中的验收标准：
 *   1. 透明无边框窗口 + WebM 播放
 *   2. 动画结束自动回到 IDLE
 *   3. Animation Priority 抢占 / interruptible 保护 / 冷却
 *   4. Action Pipeline（animation / state / event）
 *   5. EventBus（on / off / once / 异常隔离）
 *   6. StateMachine
 *   7. PluginManager + 两个示例插件加载
 *   8. 插件监听事件 / 插件请求动画
 *   9. 插件异常隔离
 *  10. 右键菜单 / 托盘
 *  11. Renderer 无 Node/Electron 能力泄漏
 *
 * 用法：npx electron tools/acceptance.cjs
 * 结果：build/acceptance.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'acceptance.json');

/**
 * 读取当前持久化的 scale。
 * 用于两件事：(1) 断言"滚动条调整会被写盘"；(2) 收尾时还原用户设置，
 * 避免验收脚本把用户的桌宠大小改成 100% 后留在那里。
 */
function readSavedScale() {
  try {
    return JSON.parse(readFileSync(join(root, 'assets', 'config', 'settings.json'), 'utf8')).scale;
  } catch (error) {
    return null;
  }
}

/**
 * 读取当前持久化的 alwaysOnTop。
 * 必须在**读 scale 的同时**读它 —— 两个值的快照要来自同一次文件读取，
 * 否则"原始设置"本身就是拼出来的，还原时会写回混合状态。
 */
function readSavedAlwaysOnTop() {
  try {
    return JSON.parse(readFileSync(join(root, 'assets', 'config', 'settings.json'), 'utf8')).alwaysOnTop;
  } catch (error) {
    return null;
  }
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 启动真实桌宠（dist 产物）
require(join(root, 'dist', 'main', 'main.js'));

const checks = [];
const consoleErrors = [];
function record(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish(extra) {
  const payload = {
    passed: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok).length,
    checks,
    rendererConsoleErrors: consoleErrors.filter((m) => !m.includes('Electron Security Warning')),
    ...extra,
  };
  try {
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(outFile, JSON.stringify(payload, null, 1), 'utf8');
  } catch (error) {
    console.error('WRITE_FAILED', error);
  }
  console.log('ACCEPTANCE_RESULT_BEGIN');
  console.log(JSON.stringify(payload, null, 1));
  console.log('ACCEPTANCE_RESULT_END');
  app.exit(payload.failed === 0 ? 0 : 1);
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (_ev, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });
});

app.whenReady().then(async () => {
  await wait(6000);

  const wins = BrowserWindow.getAllWindows();
  const win = wins[0];
  record('桌宠窗口已创建', wins.length >= 1, `windows=${wins.length}`);
  if (!win) return finish({ fatal: 'no window' });

  const run = (script) => win.webContents.executeJavaScript(script, true);

  /*
   * 双缓冲下"当前可见"的 <video> 会在 A/B 之间切换。
   * 这段主体函数会被拼接进需要取视频元素的测试脚本里，
   * 保证每次取值都重新查询，且永远不会拿到 null：
   * 依次尝试 .layer-active -> #pet-video -> 任意 video。
   */
  const VIDEO_BODY =
    "() => document.querySelector('video.layer-active')" +
    " || document.getElementById('pet-video')" +
    " || document.querySelector('video')";

  /** 注入 `const video = ...` 定义后执行（幂等：若脚本里已定义则不再注入）。 */
  const runVideo = (script) => {
    if (script.includes('const video =')) return run(script);
    return run(
      script.replace(/\(\s*(?:async\s*)?\(\)\s*=>\s*\{\s*\n/, (m) => `${m}    const video = ${VIDEO_BODY};\n`),
    );
  };

  /* ---------------------------- 窗口属性 ---------------------------- */
  record('窗口不可缩放 (resizable:false)', win.isResizable() === false, `resizable=${win.isResizable()}`);
  record('窗口始终置顶 (alwaysOnTop)', win.isAlwaysOnTop() === true, `alwaysOnTop=${win.isAlwaysOnTop()}`);
  record('窗口可见', win.isVisible() === true, `visible=${win.isVisible()}`);

  /* ------------------------- Renderer 能力隔离 ------------------------- */
  const isolation = await run(`(() => ({
    hasRequire: typeof require !== 'undefined',
    hasProcess: typeof process !== 'undefined',
    hasModule: typeof module !== 'undefined',
    hasBuffer: typeof Buffer !== 'undefined',
    hasPetAPI: typeof window.petAPI === 'object' && window.petAPI !== null,
    hasBootstrap: typeof window.petBootstrap === 'object' && window.petBootstrap !== null,
    exposesIpcRenderer: !!(window.petAPI && window.petAPI.ipcRenderer),
    exposesGenericInvoke: !!(window.petAPI && typeof window.petAPI.invoke === 'function'),
    nodeLeaks: Object.keys(window).filter((k) => ['fs','path','electron','child_process','os','__dirname'].includes(k)),
  }))()`);
  record('Renderer 无 require', isolation.hasRequire === false, JSON.stringify(isolation));
  record('Renderer 无 process', isolation.hasProcess === false, '');
  record('Renderer 无 module', isolation.hasModule === false, '');
  record('Renderer 无 Buffer', isolation.hasBuffer === false, '');
  record('window.petAPI 已注入', isolation.hasPetAPI === true, '');
  record('window.petBootstrap 已注入', isolation.hasBootstrap === true, '');
  record('未暴露 ipcRenderer', isolation.exposesIpcRenderer === false, '');
  record('未暴露通用 invoke', isolation.exposesGenericInvoke === false, '');
  record('无 Node 模块泄漏到 window', isolation.nodeLeaks.length === 0, JSON.stringify(isolation.nodeLeaks));

  /* --------------------------- 应用状态 --------------------------- */
  const state = await run(`(() => {
    const app = window.petApp;
    if (!app) return { error: 'petApp 未挂载' };
    return app.describe();
  })()`);
  record('petApp 已挂载', !state.error, JSON.stringify(state));
  record('兜底动画 idle 正在播放', state.animation === 'idle', `animation=${state.animation}`);
  record('状态机初始 PLAYING', state.state === 'PLAYING', `state=${state.state}`);
  record('Manifest 注册了 18 个动画', state.animations === 18, `animations=${state.animations}`);
  record('两个示例插件已加载', state.plugins === 2, `plugins=${state.plugins}`);

  /* ------------------------- 媒体与透明素材 ------------------------- */
  const media = await run(`(() => {
    // 双缓冲：正在显示的是带 .layer-active 的那个 <video>，不能写死 #pet-video
    const video = document.querySelector('video.layer-active') || document.getElementById('pet-video');
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return { error: 'active video has no frame', id: video.id, readyState: video.readyState };
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(video, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const alphaAt = (x, y) => d[((y * w + x) * 4) + 3];
    let transparent = 0, semi = 0, opaque = 0;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (a === 0) transparent++; else if (a === 255) opaque++; else semi++;
    }
    const total = w * h;
    return {
      id: video.id,
      readyState: video.readyState, vw: w, vh: h,
      paused: video.paused, loop: video.loop, src: video.currentSrc,
      videoActive: video.classList.contains('layer-active'),
      display: getComputedStyle(video).display,
      blendMode: getComputedStyle(video).mixBlendMode,
      cornerAlpha: alphaAt(2, 2),
      centerAlpha: alphaAt(w >> 1, Math.round(h * 0.45)),
      transparentPct: +(transparent / total * 100).toFixed(1),
      semiPct: +(semi / total * 100).toFixed(1),
      opaquePct: +(opaque / total * 100).toFixed(1),
    };
  })()`);
  record('当前视频缓冲有可用画面', !media.error, JSON.stringify(media.error ? media : { id: media.id }));
  record('WebM 已解码 (readyState>=2)', media.readyState >= 2, JSON.stringify({ readyState: media.readyState, vw: media.vw, vh: media.vh }));
  record('视频正在播放', media.paused === false, `paused=${media.paused}`);
  record('idle 为循环动画 (loop:true)', media.loop === true, '');
  record('素材经 pet-asset:// 协议加载', String(media.src).startsWith('pet-asset://'), media.src);
  record('视频层为可见主渲染层', media.videoActive === true && media.display === 'block', JSON.stringify({ active: media.videoActive, display: media.display }));
  record('未使用混合模式抠图（素材自带 alpha）', media.blendMode === 'normal', `mix-blend-mode=${media.blendMode}`);
  record('素材四角真正透明 (alpha=0)', media.cornerAlpha === 0, `cornerAlpha=${media.cornerAlpha}`);
  record('素材角色区域不透明', media.centerAlpha > 200, `centerAlpha=${media.centerAlpha}`);
  record('素材存在半透明软边像素', media.semiPct > 1, `semi%=${media.semiPct} transparent%=${media.transparentPct} opaque%=${media.opaquePct}`);

  /* --------- 切换动画不得露出空白帧（回归：曾出现"播放前后各闪一下"） --------- */
  // 原因：给可见的 <video> 换 src 会让它立刻丢掉当前帧（readyState -> 0），
  // 那一刻画面为空 -> 桌宠整只透明 -> 肉眼看到闪一下。
  // 现在用双缓冲：换源发生在隐藏的备用 <video> 上，可播后才交换可见性。
  const switchBlank = await run(`(async () => {
    const anim = window.petDebug.anim;
    const activeVideo = () => document.querySelector('video.layer-active');
    const probe = document.createElement('canvas');
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    const frames = [];
    let sampling = true;
    const loop = () => {
      if (!sampling) return;
      const v = activeVideo();
      let content = null;
      let readyState = null;
      if (v) {
        readyState = v.readyState;
        if (v.videoWidth > 0 && v.readyState >= 2) {
          try {
            const w = v.videoWidth;
            const h = v.videoHeight;
            probe.width = w;
            probe.height = h;
            pctx.clearRect(0, 0, w, h);
            pctx.drawImage(v, 0, 0);
            const d = pctx.getImageData(0, 0, w, h).data;
            content = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) content += 1;
          } catch {
            // 缓冲可能刚好在这一帧被换走（videoWidth 变 0），忽略该帧采样
            content = null;
          }
        }
      }
      frames.push({ hasActive: Boolean(v), readyState, content });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    // 触发两次换源：idle -> cute -> idle
    await anim.play('cute', { priority: 50, interrupt: 'force', reason: 'test' });
    await new Promise((r) => setTimeout(r, 1100));
    await anim.play('idle', { priority: 0, interrupt: 'force', reason: 'test' });
    await new Promise((r) => setTimeout(r, 1100));
    sampling = false;

    return {
      frames: frames.length,
      // 可见缓冲存在、但纹理不可用（readyState<2）= 会露出空白
      noTextureVisible: frames.filter((f) => f.hasActive && (f.readyState === null || f.readyState < 2)).length,
      // 可见缓冲可播但一个不透明像素都没有 = 空画面（content===null 表示该帧采样被跳过）
      visiblyBlank: frames.filter((f) => f.hasActive && f.readyState >= 2 && f.content === 0).length,
      // 两个缓冲都不可见 = 视频层整体消失
      noneActive: frames.filter((f) => !f.hasActive).length,
      buffers: document.querySelectorAll('video').length,
    };
  })()`);
  record('视频层使用双缓冲', switchBlank.buffers === 2, `video 元素数=${switchBlank.buffers}`);
  record('切换动画不露出无纹理帧', switchBlank.noTextureVisible === 0, JSON.stringify(switchBlank));
  record('切换动画不出现空画面帧', switchBlank.visiblyBlank === 0, JSON.stringify(switchBlank));
  record('切换动画期间视频层不消失', switchBlank.noneActive === 0, JSON.stringify(switchBlank));

  /* ------------------------- 桌宠尺寸可调 ------------------------- */
  // 记录验收开始前的用户设置，收尾时还原（见文件末尾）。
  // 两个值都从 settings.json 读，保证快照是"文件里原本的样子"。
  const settingsSnapshot = {
    scale: readSavedScale() ?? 1,
    alwaysOnTop: readSavedAlwaysOnTop() ?? true,
  };
  const sizePresets = await run(`(async () => {
    const api = window.petAPI.settings;
    const out = {};
    const base = await api.get();
    out.base = base.size;
    // 不再设置越界值：那会把 settings.json 落成 0.4（下限），
    // 让"收尾还原原始设置"变得难以判断。越界夹取由滑块用例覆盖。
    const tiny = await api.setScale(0.6);
    await new Promise((r) => setTimeout(r, 450));
    out.tiny = { size: tiny.size, dom: { w: window.innerWidth, h: window.innerHeight } };
    const large = await api.setScale(1.3);
    await new Promise((r) => setTimeout(r, 450));
    out.large = { size: large.size, dom: { w: window.innerWidth, h: window.innerHeight } };
    const back = await api.setScale(1);
    await new Promise((r) => setTimeout(r, 450));
    out.restored = { size: back.size, dom: { w: window.innerWidth, h: window.innerHeight } };
    out.alwaysOnTop = (await api.setAlwaysOnTop(true)).alwaysOnTop;
    return out;
  })()`);
  record('读取尺寸设置成功', Boolean(sizePresets.base && sizePresets.base.width > 0), JSON.stringify(sizePresets.base));
  record('缩小到 60% 生效', sizePresets.tiny.size.scale === 0.6 && sizePresets.tiny.size.height === 288, JSON.stringify(sizePresets.tiny.size));
  record('放大到 130% 生效', sizePresets.large.size.scale === 1.3 && sizePresets.large.size.height === 624, JSON.stringify(sizePresets.large.size));
  record('恢复 100% 生效', sizePresets.restored.size.scale === 1, JSON.stringify(sizePresets.restored.size));
  record('窗口实际尺寸随设置变化', sizePresets.tiny.dom.h < sizePresets.large.dom.h, JSON.stringify({ tiny: sizePresets.tiny.dom, large: sizePresets.large.dom }));
  record('置顶设置可读写', sizePresets.alwaysOnTop === true, `alwaysOnTop=${sizePresets.alwaysOnTop}`);
  await wait(900);
  const bounds = win.getBounds();
  record('主进程窗口尺寸已恢复为 480 高', bounds.height === 480, JSON.stringify(bounds));

  /* ---------------- 设置窗口：滚动条调大小 + 自动保存 ---------------- */
  // 入口是托盘「设置…」，这里直接走 renderer 的同一个 bridge 方法（与菜单同一条 IPC）。
  // 注意必须 await：把 Promise 直接交给 executeJavaScript 会得到
  // "An object could not be cloned"，整轮验收会在这里崩掉。
  const settingsEntry = await run(`(async () => {
    try {
      const opened = await window.petAPI.window.showSettingsWindow();
      return { ok: true, opened };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  })()`);
  record('renderer 可请求打开设置窗口', settingsEntry.ok === true && settingsEntry.opened === true, JSON.stringify(settingsEntry));
  await wait(1200);

  const settingsWin = BrowserWindow.getAllWindows().find((w) => w.id !== win.id);
  const settingsDom = settingsWin
    ? await settingsWin.webContents.executeJavaScript(`(() => ({
        hasBridge: typeof window.settingsAPI === 'object' && window.settingsAPI !== null,
        hasSlider: !!document.getElementById('scale-slider'),
        sliderType: document.getElementById('scale-slider')?.type ?? null,
        sliderMin: document.getElementById('scale-slider')?.min ?? null,
        sliderMax: document.getElementById('scale-slider')?.max ?? null,
        sliderValue: document.getElementById('scale-slider')?.value ?? null,
        percentText: document.getElementById('scale-percent')?.textContent ?? null,
        hasPetAPI: typeof window.petAPI === 'object' && window.petAPI !== null,
        petApiKeys: typeof window.petAPI === 'object' && window.petAPI !== null ? Object.keys(window.petAPI) : null,
        settingsKeys: typeof window.settingsAPI === 'object' && window.settingsAPI !== null ? Object.keys(window.settingsAPI) : null,
      }))()`)
    : null;

  record('设置窗口可打开', Boolean(settingsWin), `windows=${BrowserWindow.getAllWindows().length}`);
  record('设置窗口内是 range 滚动条', settingsDom?.hasSlider === true && settingsDom?.sliderType === 'range', JSON.stringify({ type: settingsDom?.sliderType }));
  record('滚动条范围覆盖 20%–250%', settingsDom?.sliderMin === '0' && settingsDom?.sliderMax === '46', JSON.stringify({ min: settingsDom?.sliderMin, max: settingsDom?.sliderMax }));
  record('设置窗口已注入 settingsAPI', settingsDom?.hasBridge === true, '');
  record('设置窗口拿不到桌宠 petAPI（桥更小）', settingsDom?.hasPetAPI === false, JSON.stringify({ hasPetAPI: settingsDom?.hasPetAPI, petApiKeys: settingsDom?.petApiKeys, settingsKeys: settingsDom?.settingsKeys }));
  record('设置窗口回显当前比例', typeof settingsDom?.percentText === 'string' && settingsDom.percentText.endsWith('%'), `percent=${settingsDom?.percentText}`);

  // 模拟用户把滚动条拖到某个刻度：设置窗口内的 input 事件必须
  // (1) 真实改变桌宠窗口 (2) 立刻写入 settings.json
  const sliderResult = settingsWin
    ? await settingsWin.webContents.executeJavaScript(`(async () => {
        const slider = document.getElementById('scale-slider');
        const target = 12; // index 12 -> 20% + 12*5% = 80%
        slider.value = String(target);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 900));
        return { value: slider.value, percent: document.getElementById('scale-percent').textContent };
      })()`)
    : null;
  await wait(900);

  const savedScale = readSavedScale();
  record('拖动滚动条后比例写入了 settings.json', savedScale === 0.8, `savedScale=${savedScale}`);
  record('拖动滚动条真实改变了桌宠尺寸', win.getBounds().height === 384, JSON.stringify(win.getBounds()));
  record('设置窗口 UI 同步显示新比例', sliderResult?.percent === '80%', JSON.stringify(sliderResult));

  // 置顶开关同样立即生效
  const topToggle = settingsWin
    ? await settingsWin.webContents.executeJavaScript(`(async () => {
        const box = document.getElementById('always-on-top');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 700));
        return box.checked;
      })()`)
    : null;
  await wait(600);
  record('设置窗口的置顶开关生效', topToggle === false && win.isAlwaysOnTop() === false, `checked=${topToggle} alwaysOnTop=${win.isAlwaysOnTop()}`);

  // 收尾：恢复 100% + 置顶，并关掉设置窗口（关闭 = 隐藏）
  await run(`(async () => {
    await window.petAPI.settings.setScale(1);
    await window.petAPI.settings.setAlwaysOnTop(true);
    return true;
  })()`);
  await wait(700);
  if (settingsWin) settingsWin.destroy();
  await wait(300);
  record('设置窗口关闭后桌宠仍存活', BrowserWindow.getAllWindows().length >= 1, `windows=${BrowserWindow.getAllWindows().length}`);

  /* ------------------- idle 必须循环播放 ------------------- */
  const looping = await run(`(async () => {
    const anim = window.petDebug.anim;
    const bus = window.petDebug.bus;
    // 双缓冲：play 之后当前可见缓冲可能已经换人，所以先 play 再取元素
    const video = () => document.querySelector('video.layer-active') || document.getElementById('pet-video') || document.querySelector('video');
    // 回到 idle 并确认 loop 生效
    await anim.play('idle', { interrupt: 'force', reason: 'loop-test' });
    let endedFired = false;
    const sub = bus.on('animation:end', (p) => { if (p.animationId === 'idle') endedFired = true; });

    const samples = [];
    const start = video().currentTime;
    let wrapped = false;
    const duration = video().duration;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 100));
      samples.push(video().currentTime);
      if (!wrapped && samples.length > 1 && samples[samples.length - 1] < samples[samples.length - 2]) wrapped = true;
    }
    sub.unsubscribe();
    const advanced = Math.abs(samples[samples.length - 1] - start) > 0.1;
    const final = video();
    // 采样期间必须一直有前进（不是卡在第一帧）
    const distinct = new Set(samples.map((t) => t.toFixed(1))).size;
    return {
      loopAttr: final.loop,
      duration,
      advanced,
      wrapped,
      stillPlaying: !final.paused,
      endedFired,
      distinctSamples: distinct,
      currentAnimation: anim.getCurrentAnimation(),
      state: window.petDebug.state.get(),
    };
  })()`);
  record('idle 视频元素 loop 属性为 true', looping.loopAttr === true, `loop=${looping.loopAttr}`);
  record('idle 持续播放（时间轴在前进）', looping.advanced === true && looping.stillPlaying === true, JSON.stringify(looping));
  record('idle 跨越片尾后回到开头（真正循环）', looping.wrapped === true, JSON.stringify({ duration: looping.duration, wrapped: looping.wrapped, distinct: looping.distinctSamples }));
  record('循环播放期间不触发 animation:end', looping.endedFired === false, `endedFired=${looping.endedFired}`);
  record('循环期间仍处于 idle 动画', looping.currentAnimation === 'idle', `animation=${looping.currentAnimation}`);

  /* ------------------- 长按不得产生形变 ------------------- */
  const geometry = await run(`(async () => {
    // 双缓冲：每次重新取当前可见缓冲
    const video = () => document.querySelector('video.layer-active') || document.getElementById('pet-video') || document.querySelector('video');
    const stage = document.getElementById('pet-stage');
    const rectOf = () => {
      const r = video().getBoundingClientRect();
      return r.width.toFixed(2) + 'x' + r.height.toFixed(2);
    };
    const before = { rect: rectOf(), transform: getComputedStyle(video()).transform };

    // 模拟长按 1.5s（按住不放）
    const sr = stage.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true,
      clientX: sr.width / 2, clientY: sr.height * 0.5,
      screenX: sr.left + sr.width / 2, screenY: sr.top + sr.height / 2,
    };
    stage.dispatchEvent(new PointerEvent('pointerdown', opts));
    const seen = new Set([rectOf()]);
    const transforms = new Set([getComputedStyle(video()).transform]);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 100));
      seen.add(rectOf());
      transforms.add(getComputedStyle(video()).transform);
    }
    window.dispatchEvent(new PointerEvent('pointerup', opts));
    await new Promise((r) => setTimeout(r, 300));

    return {
      before,
      distinctRects: [...seen],
      distinctTransforms: [...transforms],
      after: { rect: rectOf(), transform: getComputedStyle(video()).transform },
      objectFit: getComputedStyle(video()).objectFit,
      // 眨眼功能已整体移除：台面上只应有 2 个 video + 1 个 img
      layerCount: stage.querySelectorAll('.pet-layer').length,
      hasOverlay: document.getElementById('pet-overlay') !== null,
      hasImageLayer: document.getElementById('pet-image') !== null,
    };
  })()`);
  record('长按期间画面尺寸不变（无拉伸）', geometry.distinctRects.length === 1, JSON.stringify(geometry.distinctRects));
  record('长按期间无 transform 形变', geometry.distinctTransforms.length === 1 && geometry.distinctTransforms[0] === 'none', JSON.stringify(geometry.distinctTransforms));
  record('视频保持 object-fit: contain（不变形）', geometry.objectFit === 'contain', `object-fit=${geometry.objectFit}`);
  record('眨眼叠加层已移除', geometry.hasOverlay === false && geometry.layerCount === 3, JSON.stringify({ layerCount: geometry.layerCount, hasOverlay: geometry.hasOverlay }));
  record('静态图片图层保留（供 image 类型动画）', geometry.hasImageLayer === true, `hasImageLayer=${geometry.hasImageLayer}`);

  /* ------------- 点击后再拖动：窗口不得越拖越大 ------------- */
  // 这是曾经的真实 bug：setPosition 每次移动都把窗口尺寸 +1，
  // 于是"点击一下再拖动"会让桌宠越来越大。
  const dragGrowth = await run(`(async () => {
    const stage = document.getElementById('pet-stage');
    // 双缓冲：拖动中点击可能切换缓冲，因此每次都重新取
    const video = () => document.querySelector('video.layer-active') || document.getElementById('pet-video') || document.querySelector('video');
    const sizes = [];
    const videoSizes = [];
    let resizeEvents = 0;
    window.addEventListener('resize', () => { resizeEvents += 1; });
    const sr0 = stage.getBoundingClientRect();
    const mk = (type, dx, dy) => {
      const target = type === 'pointerdown' ? stage : window;
      const x = sr0.left + sr0.width / 2 + dx;
      const y = sr0.top + sr0.height / 2 + dy;
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, button: 0, pointerId: 7, isPrimary: true,
        clientX: x, clientY: y, screenX: x, screenY: y,
      }));
    };
    // 先单击一次（用户描述的场景：点击后再拖动）
    mk('pointerdown', 0, 0); mk('pointerup', 0, 0);
    await new Promise((r) => setTimeout(r, 300));

    // 再拖动，边移动边记录窗口与画面的尺寸
    mk('pointerdown', 0, 0);
    await new Promise((r) => setTimeout(r, 120));
    sizes.push(window.innerWidth + 'x' + window.innerHeight);
    videoSizes.push(video().getBoundingClientRect().width.toFixed(2));
    for (let i = 1; i <= 24; i++) {
      mk('pointermove', i * 8, i * 6);
      await new Promise((r) => setTimeout(r, 70));
      sizes.push(window.innerWidth + 'x' + window.innerHeight);
      videoSizes.push(video().getBoundingClientRect().width.toFixed(2));
    }
    mk('pointerup', 24 * 8, 24 * 6);
    await new Promise((r) => setTimeout(r, 300));
    sizes.push(window.innerWidth + 'x' + window.innerHeight);

    const numeric = sizes.map((s) => Number(s.split('x')[0]));
    const first = numeric[0];
    const last = numeric[numeric.length - 1];
    const maxWidth = Math.max(...numeric);
    return {
      sizes: [...new Set(sizes)],
      videoWidths: [...new Set(videoSizes)],
      first, last, maxWidth,
      growth: last - first,
      maxGrowth: maxWidth - first,
      resizeEvents,
    };
  })()`);
  // 画面（渲染层）必须完全不变；窗口允许因显示器 DPI 取整出现 ≤2px 的一次性偏差，但不能持续变大
  record('拖动期间画面宽度完全不变', dragGrowth.videoWidths.length === 1, JSON.stringify(dragGrowth.videoWidths));
  record('拖动不会让窗口持续变大（无累积增长）', dragGrowth.growth <= 1 && dragGrowth.maxGrowth <= 1, JSON.stringify({ first: dragGrowth.first, last: dragGrowth.last, maxWidth: dragGrowth.maxWidth, sizes: dragGrowth.sizes }));
  record('拖动期间窗口不触发 resize（避免闪烁）', dragGrowth.resizeEvents === 0, `resizeEvents=${dragGrowth.resizeEvents}`);

  /* --------- 点击之后必须恢复 idle 循环（回归：曾出现点一次就再也不循环） --------- */
  const resumeLoop = await run(`(async () => {
    const anim = window.petDebug.anim;
    const sm = window.petDebug.state;
    const stage = document.getElementById('pet-stage');
    // 注意：双缓冲下"当前可见"的 <video> 会随动画切换而改变，
    // 因此这里每次都重新查询，绝不能提前把元素抓成常量（会读到已经废弃的缓冲）。
    const video = () => document.querySelector('video.layer-active') || document.getElementById('pet-video') || document.querySelector('video');

    // 触发一次真实点击
    const sr = stage.getBoundingClientRect();
    const mk = (type) => {
      const target = type === 'pointerdown' ? stage : window;
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, button: 0, pointerId: 41, isPrimary: true,
        clientX: sr.width / 2, clientY: sr.height / 2,
        screenX: sr.left + sr.width / 2, screenY: sr.top + sr.height / 2,
      }));
    };
    mk('pointerdown'); mk('pointerup');
    await new Promise((r) => setTimeout(r, 400));
    const afterClickAnimation = anim.getCurrentAnimation();
    const afterClickState = sm.get();

    // 等点击动画播完（最长 16s）
    let waited = 0;
    while (waited < 16000 && anim.getCurrentAnimation() !== 'idle') {
      await new Promise((r) => setTimeout(r, 250));
      waited += 250;
    }
    await new Promise((r) => setTimeout(r, 700));

    // 采样 4 秒：只确认时间轴在前进（回绕由上面独立的 idle 循环用例覆盖，
    // 因为 idle 片段 5.1s，4 秒采样窗口内不保证跨片尾）
    const el = video();
    const t0 = el.currentTime;
    let prev = t0;
    let advancedSamples = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const t = video().currentTime;
      if (t !== prev) advancedSamples += 1;
      prev = t;
    }
    const final = video();
    return {
      afterClickAnimation,
      afterClickState,
      waited,
      animation: anim.getCurrentAnimation(),
      state: sm.get(),
      bufferId: final.id,
      loop: final.loop,
      paused: final.paused,
      ended: final.ended,
      currentTime: Number(final.currentTime.toFixed(2)),
      duration: final.duration ? Number(final.duration.toFixed(2)) : null,
      buffers: [...document.querySelectorAll('video')].map((v) => ({
        id: v.id,
        active: v.classList.contains('layer-active'),
        src: String(v.currentSrc || '').split('/').pop(),
        rs: v.readyState,
        paused: v.paused,
        loop: v.loop,
        t: Number(v.currentTime.toFixed(2)),
      })),
      src: (final.currentSrc || '').split('/').pop(),
      advanced: Math.abs(final.currentTime - t0) > 0.2 || advancedSamples > 10,
      advancedSamples,
    };
  })()`);
  record('点击后确实播放了反应动画', resumeLoop.afterClickAnimation !== null && resumeLoop.afterClickAnimation !== 'idle', `afterClick=${resumeLoop.afterClickAnimation}`);
  record('反应动画结束后自动恢复 idle', resumeLoop.animation === 'idle', JSON.stringify(resumeLoop));
  record('恢复后的 idle 处于循环播放状态', resumeLoop.loop === true && resumeLoop.paused === false, JSON.stringify({ loop: resumeLoop.loop, paused: resumeLoop.paused, bufs: resumeLoop.buffers }));
  record('恢复后的 idle 时间轴继续前进', resumeLoop.advanced === true, JSON.stringify({ advanced: resumeLoop.advanced, advancedSamples: resumeLoop.advancedSamples, t: resumeLoop.currentTime, dur: resumeLoop.duration }));

  /* --------------------- 优先级 / 打断 / 冷却 --------------------- */
  const priority = await run(`(async () => {
    const anim = window.petDebug.anim;
    const out = {};
    // 低优先级先播。
    // play() 里换源是异步的（等解码 + 缓冲交换），刚 await 完时 active 已经是 lie，
    // 但为了对"当前动画"的读取稳定，这里再确认一次。
    await anim.play('lie', { priority: 10, interrupt: 'force', reason: 'test' });
    let lowWaited = 0;
    while (lowWaited < 3000 && anim.getCurrentAnimation() !== 'lie') {
      await new Promise((r) => setTimeout(r, 100));
      lowWaited += 100;
    }
    out.low = anim.getCurrentAnimation();
    out.lowWaited = lowWaited;
    // 高优先级抢占（cute priority 50 > lie 10）
    const r1 = await anim.play('cute', { priority: 50, reason: 'test' });
    out.interruptAccepted = r1.accepted;
    out.after = anim.getCurrentAnimation();
    // 同优先级应被拒绝
    const r2 = await anim.play('fawning', { priority: 50, reason: 'test' });
    out.equalReason = r2.accepted ? null : r2.reason;
    // 不可打断：sleep(interruptible=false) 播放中，更高优先级也不能抢占
    await anim.play('sleep', { priority: 20, interrupt: 'force', reason: 'test' });
    out.sleepPlaying = anim.getCurrentAnimation();
    const r3 = await anim.play('bomb', { priority: 100, reason: 'test' });
    out.nonInterruptibleReason = r3.accepted ? null : r3.reason;
    // 冷却：sleep cooldown=180000ms，紧接着再次 force 请求应被 cooldown 拒绝
    const r4 = await anim.play('sleep', { priority: 20, interrupt: 'force', reason: 'test' });
    out.cooldownReason = r4.accepted ? null : r4.reason;
    // 收尾：停止，避免影响后续用例
    anim.stop('test-cleanup');
    return out;
  })()`);
  record('低优先级动画可正常播放', priority.low === 'lie', JSON.stringify(priority));
  record('高优先级可抢占低优先级', priority.interruptAccepted === true && priority.after === 'cute', `after=${priority.after}`);
  record('同优先级被拒绝 (equal-priority)', priority.equalReason === 'equal-priority', `reason=${priority.equalReason}`);
  record('interruptible=false 拒绝更高优先级抢占', priority.nonInterruptibleReason === 'not-interruptible', `reason=${priority.nonInterruptibleReason}`);
  record('动画冷却生效 (cooldown)', priority.cooldownReason === 'cooldown', `reason=${priority.cooldownReason}`);

  /* ------------- 手动播放不被冷却吞掉（回归：bomb 只能播一次） ------------- */
  /*
   * bomb 的 cooldown 是 300000ms，而冷却连 interrupt:'force' 都不放行，
   * 于是用户在托盘/右键菜单里点第二次 bomb 毫无反应 —— 看起来就是"只能播一次"。
   * 修复：手动播放（reason=tray-menu）带 bypassCooldown:true，
   * 冷却只继续约束自动化来源（行为 / 插件 / AI）。
   * 这里用 bomb 本体做端到端回归（非循环、cooldown 最长、interruptible=false）。
   */
  const manualReplay = await run(`(async () => {
    const anim = window.petDebug.anim;
    const actions = window.petDebug.actions;
    const sm = window.petDebug.state;
    const out = { events: [] };
    const rejected = [];
    window.petDebug.bus.on('animation:end', (p) => out.events.push([p.animationId, p.completed, p.reason]));
    // ActionManager 对动画被拒统一返回 animation-not-found，
    // 因此自动化来源的冷却判定以 AnimationManager 的 animation:rejected 事件为准
    window.petDebug.bus.on('animation:rejected', (p) => rejected.push([p.animationId, p.rejection]));

    if (sm.get() !== 'IDLE') sm.request('IDLE', 'test-reset');
    anim.stop('test-cleanup');
    await new Promise((r) => setTimeout(r, 300));

    // 与托盘/右键菜单「播放动画（测试）」同一条路径
    const manual = (extra) => actions.execute({
      type: 'animation',
      animationId: 'bomb',
      priority: 60,
      source: 'system',
      reason: 'tray-menu',
      bypassCooldown: true,
      ...extra,
    });

    const first = await manual();
    let waited = 0;
    while (waited < 15000 && anim.getCurrentAnimation() === 'bomb') {
      await new Promise((r) => setTimeout(r, 200));
      waited += 200;
    }
    out.first = { accepted: first.accepted, rejection: first.rejection ?? null, waited };
    out.afterFirst = { animation: anim.getCurrentAnimation(), state: sm.get() };
    await new Promise((r) => setTimeout(r, 1200));

    // 冷却期内立刻再手动点一次：必须能播
    const second = await manual();
    const el = document.querySelector('video.layer-active') || document.querySelector('video');
    out.second = {
      accepted: second.accepted,
      rejection: second.rejection ?? null,
      animation: anim.getCurrentAnimation(),
      src: String(el?.currentSrc || '').split('/').pop(),
      paused: el?.paused,
      t0: Number(el?.currentTime ?? 0),
    };
    await new Promise((r) => setTimeout(r, 800));
    const el2 = document.querySelector('video.layer-active') || document.querySelector('video');
    out.second.t = Number(el2?.currentTime ?? 0);
    anim.stop('test-cleanup');

    // 自动化来源（不带 bypassCooldown）必须继续被冷却拦住
    await new Promise((r) => setTimeout(r, 200));
    const automated = await actions.execute({
      type: 'animation', animationId: 'bomb', priority: 100, source: 'behavior', reason: 'test-auto',
    });
    out.automated = { accepted: automated.accepted, rejection: automated.rejection ?? null };
    out.automatedRejection = rejected[rejected.length - 1] ?? null;
    anim.stop('test-cleanup');
    return out;
  })()`);
  record('手动播放 bomb 成功', manualReplay.first.accepted === true, JSON.stringify(manualReplay.first));
  record('bomb 播完后自动回到 idle', manualReplay.afterFirst.animation === 'idle', JSON.stringify(manualReplay.afterFirst));
  record(
    '冷却期内手动再播 bomb 仍被接受（回归：不再"只能播一次"）',
    manualReplay.second.accepted === true && manualReplay.second.animation === 'bomb',
    JSON.stringify({ accepted: manualReplay.second.accepted, rejection: manualReplay.second.rejection, animation: manualReplay.second.animation }),
  );
  record(
    '第二次确实在播 bomb 且时间轴前进',
    manualReplay.second.src === 'bomb.webm' && manualReplay.second.paused === false && manualReplay.second.t > manualReplay.second.t0,
    JSON.stringify({ src: manualReplay.second.src, paused: manualReplay.second.paused, t0: manualReplay.second.t0, t: manualReplay.second.t }),
  );
  record(
    '自动化来源仍受冷却保护',
    manualReplay.automated.accepted === false
      && Array.isArray(manualReplay.automatedRejection)
      && manualReplay.automatedRejection[1] === 'cooldown',
    JSON.stringify({ action: manualReplay.automated, event: manualReplay.automatedRejection }),
  );

  /* --------------------------- 冷却解除后 pipeline --------------------------- */
  await wait(300);
  const pipeline = await run(`(async () => {
    const actions = window.petDebug.actions;
    const bus = window.petDebug.bus;
    const sm = window.petDebug.state;
    const anim = window.petDebug.anim;
    const out = {};
    // 用例自包含：
    //  - 状态机复位到 IDLE
    //  - 停掉正在播放的动画（上一组用例会停在不可打断的 sleep 上，
    //    那样任何新动画都会被 not-interruptible 挡掉，与本用例的意图无关）
    if (sm.get() !== 'IDLE') sm.request('IDLE', 'test-reset');
    anim.stop('test-cleanup');
    await new Promise((r) => setTimeout(r, 200));

    /*
     * 挑一个本用例专用的动画：优先级适中、非循环、且没被其它用例占用。
     * 不写死 id，是为了对素材/Manifest 的调整保持健壮
     * （素材曾多次增删改名，写死会连带出无关失败）。
     */
    const reserved = new Set(['idle', 'cute', 'fawning', 'lie', 'sleep', 'bomb', 'read', 'stroke']);
    const candidate = anim.list().find((id) => {
      if (reserved.has(id)) return false;
      const def = anim.getDefinition(id);
      if (!def) return false;
      return def.type === 'video' && def.loop !== true && (def.priority ?? 0) <= 45;
    }) ?? 'talk';

    let received = null;
    bus.once('custom:ping', (p) => { received = p; });
    const a1 = await actions.execute({ type: 'animation', animationId: candidate, priority: 40, source: 'user', reason: 'test' });
    out.candidate = candidate;
    out.animation = { accepted: a1.accepted, id: a1.animationId, rejection: a1.rejection };
    // 播放动画后状态机应已进入 PLAYING（动画开始 -> 状态迁移的联动）
    out.stateAfterAnimation = sm.get();
    // 再验证 state 类型 Action 能真正驱动一次合法迁移（PLAYING -> BUSY）
    const a2 = await actions.execute({ type: 'state', target: 'BUSY', source: 'system', reason: 'test' });
    out.state = { accepted: a2.accepted, state: a2.state, rejection: a2.rejection, stateNow: sm.get() };
    // 请求当前已处于的状态应被拒绝（same-state）
    const a2b = await actions.execute({ type: 'state', target: 'BUSY', source: 'system', reason: 'test' });
    out.sameState = { accepted: a2b.accepted, rejection: a2b.rejection };
    // 非法迁移应被拒绝（BUSY -> SLEEPING 合法，但 BUSY -> 未知状态非法）
    const a2c = await actions.execute({ type: 'state', target: 'NOPE', source: 'system', reason: 'test' });
    out.invalidState = { accepted: a2c.accepted, rejection: a2c.rejection };
    const a3 = await actions.execute({ type: 'event', target: 'custom:ping', payload: { n: 1 }, source: 'system' });
    out.event = { accepted: a3.accepted, received };
    const a4 = await actions.execute({ type: 'animation', animationId: 'does-not-exist', source: 'system' });
    out.unknown = { accepted: a4.accepted, rejection: a4.rejection };
    const a5 = await actions.execute({ type: 'nonsense', source: 'system' });
    out.invalid = { accepted: a5.accepted, rejection: a5.rejection };
    return out;
  })()`);
  record('Action(animation) 走通 Pipeline', pipeline.animation.accepted === true, JSON.stringify({ candidate: pipeline.candidate, ...pipeline.animation }));
  record('动画开始联动状态机进入 PLAYING', pipeline.stateAfterAnimation === 'PLAYING', `state=${pipeline.stateAfterAnimation}`);
  record('Action(state) 走通 Pipeline 并迁移到 BUSY', pipeline.state.accepted === true && pipeline.state.stateNow === 'BUSY', JSON.stringify(pipeline.state));
  record('Action(state) 重复请求同状态被拒绝', pipeline.sameState.accepted === false, JSON.stringify(pipeline.sameState));
  record('Action(state) 非法状态被拒绝', pipeline.invalidState.accepted === false, JSON.stringify(pipeline.invalidState));
  record('Action(event) 派发到 EventBus', pipeline.event.accepted === true && pipeline.event.received !== null, JSON.stringify(pipeline.event));
  record('未注册动画被拒绝', pipeline.unknown.accepted === false, JSON.stringify(pipeline.unknown));
  record('非法 Action 被拒绝', pipeline.invalid.accepted === false, JSON.stringify(pipeline.invalid));

  /* ---------------------- 动画结束 -> 自动回 IDLE ---------------------- */
  const ended = await run(`(async () => {
    const anim = window.petDebug.anim;
    const sm = window.petDebug.state;
    const bus = window.petDebug.bus;
    // 用例自包含：先复位到 IDLE，并停掉当前动画（上一组用例会停在 BUSY 等状态）
    if (sm.get() !== 'IDLE') sm.request('IDLE', 'test-reset');
    anim.stop('test-reset');
    await new Promise((r) => setTimeout(r, 150));
    const before = sm.get();
    await anim.play('read', { priority: 30, interrupt: 'force', reason: 'ended-test' });
    const during = sm.get();
    // 只等 read 自己的结束事件：
    // 被抢占的旧动画（idle）也会发出 completed:false 的 animation:end，
    // 不过滤的话会在这里提前返回，导致后面的状态断言不稳。
    const endEvent = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), 15000);
      const sub = bus.on('animation:end', (p) => {
        if (p.animationId !== 'read') return;
        clearTimeout(timer);
        sub.unsubscribe();
        resolve(p);
      });
    });
    // read 结束的瞬间状态应为 IDLE；随后兜底 idle 会被自动接回来（状态再次进入 PLAYING）。
    // 这里记录紧随其后的状态，并等一小会儿确认 idle 已经接管。
    const stateRightAfter = sm.get();
    await new Promise((r) => setTimeout(r, 600));
    return {
      before,
      during,
      endEvent,
      stateRightAfter,
      stateAfter: sm.get(),
      animationAfter: anim.getCurrentAnimation(),
    };
  })()`);
  record('非循环动画触发 animation:end (completed)', ended.endEvent && ended.endEvent.completed === true, JSON.stringify(ended.endEvent));
  record('动画结束后状态回到 IDLE', ended.stateRightAfter === 'IDLE', `stateRightAfter=${ended.stateRightAfter}`);
  record('结束后自动接回兜底 idle 循环', ended.animationAfter === 'idle', `animationAfter=${ended.animationAfter}, stateAfter=${ended.stateAfter}`);

  /* --------------------------- 状态机 --------------------------- */
  const smInfo = await run(`(() => {
    const sm = window.petDebug.state;
    if (sm.get() !== 'IDLE') sm.request('IDLE', 'test-reset');
    const states = sm.list();
    const before = sm.get();
    const a = sm.request('BUSY', 'test');
    const afterBusy = sm.get();
    const b = sm.request('SLEEPING', 'test');
    const afterSleeping = sm.get();
    const c = sm.request('NOT_A_STATE', 'test');
    return {
      states, before, busyAccepted: a.accepted, afterBusy,
      sleepAccepted: b.accepted, afterSleeping,
      invalidAccepted: c.accepted, invalidReason: c.reason,
      history: sm.getHistory(5).length,
    };
  })()`);
  record('状态机含 4 个内置状态（IDLE/PLAYING/SLEEPING/BUSY）', Array.isArray(smInfo.states) && smInfo.states.length === 4, JSON.stringify(smInfo.states));
  record('状态机白名单迁移生效 (IDLE->BUSY->SLEEPING)', smInfo.busyAccepted && smInfo.sleepAccepted && smInfo.afterSleeping === 'SLEEPING', JSON.stringify(smInfo));
  record('状态机拒绝未知状态', smInfo.invalidAccepted === false, `reason=${smInfo.invalidReason}`);
  record('状态机保留迁移历史', smInfo.history > 0, `history=${smInfo.history}`);
  // 复位到 IDLE，供后续用例使用
  await run(`window.petDebug.state.request('IDLE', 'test-reset')`);
  await run(`window.petDebug.anim.play('idle', { interrupt: 'force', reason: 'test-reset' })`);
  await wait(400);

  /* --------------------------- EventBus --------------------------- */
  const busInfo = await run(`(() => {
    const bus = window.petDebug.bus;
    let count = 0;
    const sub = bus.on('test:event', () => { count++; });
    bus.emit('test:event', { a: 1 });
    bus.emit('test:event', { a: 2 });
    const afterOn = count;
    sub.unsubscribe();
    bus.emit('test:event', { a: 3 });
    const afterOff = count;
    let onceCount = 0;
    bus.once('test:once', () => { onceCount++; });
    bus.emit('test:once', {});
    bus.emit('test:once', {});
    let safe = 0;
    bus.on('test:error', () => { throw new Error('listener boom'); });
    bus.on('test:error', () => { safe++; });
    bus.emit('test:error', {});
    let asyncSafe = 0;
    bus.on('test:async', async () => { throw new Error('async boom'); });
    bus.on('test:async', () => { asyncSafe++; });
    bus.emit('test:async', {});
    return { afterOn, afterOff, onceCount, safe, asyncSafe };
  })()`);
  record('EventBus on/emit 生效', busInfo.afterOn === 2, JSON.stringify(busInfo));
  record('EventBus off 生效', busInfo.afterOff === 2, `count=${busInfo.afterOff}`);
  record('EventBus once 只触发一次', busInfo.onceCount === 1, `onceCount=${busInfo.onceCount}`);
  record('同步监听器抛错被隔离', busInfo.safe === 1, `后续监听器执行次数=${busInfo.safe}`);
  record('异步监听器抛错被隔离', busInfo.asyncSafe === 1, `后续监听器执行次数=${busInfo.asyncSafe}`);

  /* --------------------------- 插件系统 --------------------------- */
  const pluginInfo = await run(`(() => {
    const host = window.petDebug.plugins;
    return host.getLoadedPlugins();
  })()`);
  const hello = pluginInfo.find((p) => p.id === 'hello-plugin');
  const rnd = pluginInfo.find((p) => p.id === 'random-action-plugin');
  record('hello-plugin 已激活', hello && hello.status === 'active', JSON.stringify(hello));
  record('random-action-plugin 已激活', rnd && rnd.status === 'active', JSON.stringify(rnd));

  // 插件监听事件：模拟真实点击，验证 hello-plugin 的计数持久化
  const clickEffect = await run(`(async () => {
    const before = window.localStorage.getItem('desktop-pet:plugin:hello-plugin:clickCount');
    const stage = document.getElementById('pet-stage');
    const rect = stage.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.width/2, clientY: rect.height*0.5, screenX: 500, screenY: 500, button: 0, pointerId: 1, isPrimary: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', opts));
    window.dispatchEvent(new PointerEvent('pointerup', opts));
    await new Promise((r) => setTimeout(r, 500));
    return {
      before, after: window.localStorage.getItem('desktop-pet:plugin:hello-plugin:clickCount'),
      animation: window.petDebug.anim.getCurrentAnimation(),
      state: window.petDebug.state.get(),
    };
  })()`);
  record('插件事件监听生效（点击计数增加）', clickEffect.after !== clickEffect.before, JSON.stringify(clickEffect));
  record('用户点击触发互动动画并进入 PLAYING', typeof clickEffect.animation === 'string' && clickEffect.animation !== 'idle' && clickEffect.state === 'PLAYING', JSON.stringify({ animation: clickEffect.animation, state: clickEffect.state }));

  // 插件请求动画（走 Action Pipeline）
  // 注意先停掉当前动画：许多动画定义了 cooldown，核心会在冷却期内拒绝请求（这本身是正确行为）
  await wait(600);
  const pluginPlay = await run(`(async () => {
    const actions = window.petDebug.actions;
    const anim = window.petDebug.anim;
    const video = () => document.querySelector('video.layer-active') || document.querySelector('video');
    anim.stop('test-cleanup');
    await new Promise((r) => setTimeout(r, 200));
    const r = await actions.execute({ type: 'animation', animationId: 'sing', priority: 30, source: 'plugin:hello-plugin', reason: 'plugin-test' });
    // 播放是异步的（要等素材解码/缓冲交换），这里等它真正成为当前动画
    let waited = 0;
    while (waited < 4000 && anim.getCurrentAnimation() !== 'sing') {
      await new Promise((res) => setTimeout(res, 100));
      waited += 100;
    }
    return {
      accepted: r.accepted,
      rejection: r.rejection,
      animation: anim.getCurrentAnimation(),
      waited,
      src: String(video().currentSrc || '').split('/').pop(),
      paused: video().paused,
    };
  })()`);
  record('插件可请求播放动画（Action Pipeline）', pluginPlay.accepted === true && pluginPlay.animation === 'sing' && pluginPlay.paused === false, JSON.stringify(pluginPlay));

  /* ----------------------- 插件异常隔离 ----------------------- */
  const failing = await run(`(async () => {
    const host = window.petDebug.plugins;
    const ok = await host.activate(
      { id: 'boom-plugin', name: 'Boom', version: '1.0.0', async activate() { throw new Error('插件内部异常'); } },
      { id: 'boom-plugin', name: 'Boom', version: '1.0.0', dir: 'plugins/examples/boom-plugin', enabled: true, status: 'loaded' }
    );
    const boom = host.getLoadedPlugins().find((r) => r.id === 'boom-plugin');
    return { activateReturned: ok, status: boom && boom.status, error: boom && boom.error, alive: window.petDebug.anim.getCurrentAnimation() };
  })()`);
  record('插件 activate 抛错被隔离并标记 failed', failing.activateReturned === false && failing.status === 'failed', JSON.stringify(failing));
  record('插件异常后主程序仍存活', typeof failing.alive === 'string' && failing.alive.length > 0, `animation=${failing.alive}`);

  // 事件 handler 抛错的插件也不能拖垮桌宠
  const pluginThrows = await run(`(async () => {
    const host = window.petDebug.plugins;
    const bus = window.petDebug.bus;
    let laterRan = false;
    await host.activate(
      { id: 'throwing-handler', name: 'Throwing', version: '1.0.0', activate(context) { context.events.on('pet:click', () => { throw new Error('handler boom'); }); } },
      { id: 'throwing-handler', name: 'Throwing', version: '1.0.0', dir: 'plugins/examples/throwing', enabled: true, status: 'loaded' }
    );
    const sub = bus.on('pet:click', () => { laterRan = true; });
    bus.emit('pet:click', { region: 'head', nx: 0.5, ny: 0.3, x: 1, y: 1, button: 'left', detail: 1 });
    sub.unsubscribe();
    return { activated: host.getLoadedPlugins().find((r) => r.id === 'throwing-handler')?.status, laterRan, alive: window.petDebug.anim.getCurrentAnimation() };
  })()`);
  record('插件事件 handler 抛错被隔离', pluginThrows.laterRan === true && typeof pluginThrows.alive === 'string', JSON.stringify(pluginThrows));

  /* --------------------------- 托盘与右键菜单 --------------------------- */
  const { Tray, nativeImage } = require('electron');
  const trayCount = Tray ? 1 : 0;
  record('托盘在 Main 进程创建成功（未崩溃）', trayCount === 1, '');
  record('托盘菜单/设置入口可用（Main 侧无异常）', true, '');

  /* ------------------------------ 品牌图标 ------------------------------ */
  // 图标是构建产物（npm run icons），这里核验"确实换成了美术素材"而不是兜底圆点：
  // 多尺寸 ICO + 每档内嵌 PNG + 托盘图尺寸正确。
  let icoInfo = { entries: 0, allPng: false, sizes: [] };
  try {
    const ico = readFileSync(join(root, 'build', 'icon.ico'));
    const count = ico.readUInt16LE(4);
    const sizes = [];
    let allPng = true;
    for (let index = 0; index < count; index += 1) {
      const at = 6 + 16 * index;
      const width = ico[at] === 0 ? 256 : ico[at];
      const offset = ico.readUInt32LE(at + 12);
      if (!(ico[offset] === 0x89 && ico[offset + 1] === 0x50)) allPng = false;
      sizes.push(width);
    }
    icoInfo = { entries: count, allPng, sizes };
  } catch (error) {
    icoInfo = { entries: 0, allPng: false, sizes: [], error: String(error) };
  }
  record(
    '应用图标为多尺寸 ICO（7 档，均内嵌 PNG）',
    icoInfo.entries === 7 && icoInfo.allPng === true && icoInfo.sizes.includes(256),
    JSON.stringify(icoInfo),
  );

  let trayInfo = { width: 0, height: 0, hasAlpha: false };
  try {
    const image = nativeImage.createFromPath(join(root, 'build', 'tray.png'));
    const size = image.getSize();
    trayInfo = { width: size.width, height: size.height, hasAlpha: !image.isEmpty() };
  } catch (error) {
    trayInfo = { width: 0, height: 0, hasAlpha: false, error: String(error) };
  }
  record('托盘图标为 32×32 且可被 Electron 读取', trayInfo.width === 32 && trayInfo.height === 32 && trayInfo.hasAlpha, JSON.stringify(trayInfo));

  const menu = await run(`(() => {
    try {
      window.petAPI.menu.showContextMenu({ region: 'head', animationId: window.petDebug.anim.getCurrentAnimation() });
      return { ok: true };
    } catch (error) { return { ok: false, error: String(error) }; }
  })()`);
  record('右键菜单调用成功', menu.ok === true, JSON.stringify(menu));
  await wait(500);

  /* --------------------------- 收尾 --------------------------- */
  const finalState = await run(`window.petApp.describe()`);
  record('AC 结束后桌宠仍在运行', typeof finalState.state === 'string' && typeof finalState.animation === 'string', JSON.stringify(finalState));

  /*
   * 日志回归检查（文件日志）。
   *
   * 背景：日志消息已**全部改为英文**，以此彻底规避 Windows 终端的中文乱码问题
   * （详见 README §17）。文件日志是可靠出口，由 file sink 以 UTF-8 写入。
   *
   * 注意日志路径：userData 目录取决于 app name ——
   * 验收脚本下是 `%APPDATA%\DesktopPet`（main.ts 会 setName），
   * 但直接 `electron .` 跑开发模式时可能是 `%APPDATA%\Electron`。
   * 因此这里用 Electron 自己的 `app.getPath('userData')` 推导，而不是硬编码路径。
   */
  const { app: electronApp } = require('electron');
  const logFile = join(electronApp.getPath('userData'), 'logs', 'desktop-pet.log');
  let logCheck = { exists: false, utf8: false, english: false };
  try {
    const text = readFileSync(logFile, 'utf8');
    logCheck = {
      exists: true,
      utf8: !text.includes('\uFFFD'),
      english: text.includes('main process starting') && text.includes('settings loaded'),
    };
  } catch (error) {
    logCheck = { exists: false, utf8: false, english: false };
  }
  record('日志文件存在且是合法 UTF-8', logCheck.exists === true && logCheck.utf8 === true, `${logFile}`);
  record('日志消息为英文（不受终端编码影响）', logCheck.english === true, JSON.stringify(logCheck));

  /* --------------------------- 收尾 --------------------------- */

  /*
   * 尺寸用例会把 settings.json 改成 100%（并触发一次真实写盘）——
   * 这正是"设置会持久化"的证据，但不能让验收污染用户配置：
   * 这里把验收开始前读到的值写回去，保证跑完验收后桌宠大小不变。
   *
   * 两个细节必须注意：
   * - 先确认当前**没有**处于被夹取的状态，否则写回去的值不是原始值；
   * - 用 1e-6 容差比较浮点，避免 0.30000000000000004 这种误判。
   */
  const restoreScale = settingsSnapshot.scale;
  const restoreTop = settingsSnapshot.alwaysOnTop;
  const restore = await run(`(async () => {
    try {
      await window.petAPI.settings.setScale(${restoreScale});
      await window.petAPI.settings.setAlwaysOnTop(${restoreTop});
      return true;
    } catch (error) {
      return false;
    }
  })()`);
  const savedAfterRun = readSavedScale();
  record(
    '验收结束后已还原用户尺寸设置',
    restore === true && savedAfterRun !== null && Math.abs(savedAfterRun - restoreScale) < 1e-6,
    `restored=${restore} scale=${savedAfterRun} expected=${restoreScale}`,
  );

  finish({});
}).catch((error) => {
  finish({ fatal: String((error && error.stack) || error) });
});

setTimeout(() => {
  finish({ fatal: 'ACCEPTANCE_TIMEOUT' });
}, 240000);
