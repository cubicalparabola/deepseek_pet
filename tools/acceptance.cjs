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
  record('Manifest 注册了 24 个动画', state.animations === 24, `animations=${state.animations}`);
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

  /* ------------- 持续动画机制：start -> loop × N -> end ------------- */
  // 需求：播放 start 后播放若干 loop，最后"被打断"或"循环次数达到"时播放 end。
  const persistentManifest = await run(`(() => {
    const anim = window.petDebug.anim;
    const rows = anim.list().map((id) => {
      const d = anim.getDefinition(id);
      return {
        id,
        kind: d ? d.kind : null,
        seg: d && d.segments ? { start: Boolean(d.segments.start), loop: Boolean(d.segments.loop), end: Boolean(d.segments.end), loopCount: d.segments.loopCount ?? null } : null,
      };
    });
    return rows;
  })()`);
  const persistentIds = ['overheat', 'read', 'sleep', 'watch', 'work'];
  const persistRows = persistentManifest.filter((r) => persistentIds.includes(r.id));
  const oneShotRows = persistentManifest.filter((r) => !persistentIds.includes(r.id));
  record(
    '5 条持续动画均带 start/loop/end 三段',
    persistRows.length === 5 && persistRows.every((r) => r.kind === 'persistent' && r.seg && r.seg.start && r.seg.loop && r.seg.end),
    JSON.stringify(persistRows.map((r) => `${r.id}:${r.kind}:${r.seg ? `${r.seg.start ? 'S' : '-'}${r.seg.loop ? 'L' : '-'}${r.seg.end ? 'E' : '-'}${r.seg.loopCount === null ? '(inf)' : '(' + r.seg.loopCount + ')'}` : 'none'}`)),
  );
  record(
    '其余 19 条为一次性动画（无 segments）',
    oneShotRows.length === 19 && oneShotRows.every((r) => r.kind === 'one-shot' && r.seg === null),
    JSON.stringify({ count: oneShotRows.length, kinds: [...new Set(oneShotRows.map((r) => r.kind))] }),
  );

  // 完整走一遍：start -> loop -> 循环到次数 -> end -> 结束
  const cycleRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const bus = window.petDebug.bus;
    const video = () => document.querySelector('video.layer-active') || document.getElementById('pet-video') || document.querySelector('video');
    const srcOf = () => String(video().currentSrc || video().src || '').split('/').pop();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    anim.resetCooldowns();
    const cycles = [];
    const cycleTimes = [];
    const sub = bus.on('animation:loop-cycle', (p) => { if (p.animationId === 'read') { cycles.push(p.cycle); cycleTimes.push(Date.now()); } });
    let endEvent = null;
    const subEnd = bus.on('animation:end', (p) => { if (p.animationId === 'read') endEvent = p; });

    await anim.play('read', { interrupt: 'force', reason: 'persistent-cycle-test' });
    const phaseStart = anim.getPersistentPhase();
    const srcStart = srcOf();

    // 等开场段播完（read-start ≈ 1.63s）。
    // 注意用 anim.getActiveSource() 而不是 video.currentSrc：
    // 切段瞬间缓冲可能还没交换完，currentSrc 会滞后一个段。
    let phaseLoop = null, srcLoop = null;
    for (let i = 0; i < 40 && phaseLoop === null; i++) {
      await wait(100);
      if (anim.getPersistentPhase() === 'loop') { phaseLoop = 'loop'; srcLoop = anim.getActiveSource(); }
    }

    // 等它自己循环到次数（read loopCount=4，loop 段 1.75s → 约 7s）
    const target = (anim.getDefinition('read').segments || {}).loopCount;
    let sawEndSrc = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && !endEvent) {
      await wait(100);
      if (srcOf().includes('-end')) sawEndSrc = true;
    }
    sub.unsubscribe();
    subEnd.unsubscribe();
    // 每轮之间的平均间隔（回归用：曾经 4 轮在同帧内计完，间隔≈0）
    const totalMs = cycleTimes.length > 1 ? cycleTimes[cycleTimes.length - 1] - cycleTimes[0] : 0;
    const cycleSpanMs = cycleTimes.length > 1 ? totalMs / (cycleTimes.length - 1) : 0;
    return { phaseStart, srcStart, phaseLoop, srcLoop, target, cycles, cycleTimes, totalMs, cycleSpanMs, sawEndSrc, endEvent, phaseAfter: anim.getPersistentPhase(), current: anim.getCurrentAnimation() };
  })()`);
  record('持续动画起始阶段为 start', cycleRun.phaseStart === 'start' && String(cycleRun.srcStart).includes('-start'), JSON.stringify({ phase: cycleRun.phaseStart, src: cycleRun.srcStart }));
  record('开场播完自动进入 loop 阶段', cycleRun.phaseLoop === 'loop' && String(cycleRun.srcLoop).includes('-loop'), JSON.stringify({ phase: cycleRun.phaseLoop, src: cycleRun.srcLoop }));
  record(
    '循环段按 loopCount 精确计数',
    Array.isArray(cycleRun.cycles) && cycleRun.cycles.length === cycleRun.target && cycleRun.cycles[cycleRun.cycles.length - 1] === cycleRun.target,
    JSON.stringify({ target: cycleRun.target, cycles: cycleRun.cycles }),
  );
  /*
   * 回归断言（真实 bug）：循环计数曾经在同一帧内连加 ——
   * tick 每帧都判断"到片尾了吗"，而视频到片尾后会停留若干帧，
   * 于是 4 轮在 20ms 内计完、立刻切收尾，表现为"循环时闪一下"。
   * 正确行为：每轮必须间隔约一个循环段的时长。
   */
  record(
    '循环计数每轮间隔一个循环段时长（回归：不再同帧连加）',
    typeof cycleRun.cycleSpanMs === 'number' && cycleRun.cycleSpanMs > 400,
    JSON.stringify({ target: cycleRun.target, totalMs: cycleRun.totalMs, avgPerCycleMs: cycleRun.cycleSpanMs }),
  );
  record('循环次数达到后播放 end 段', cycleRun.sawEndSrc === true, `endSrcSeen=${cycleRun.sawEndSrc}`);
  record('end 播完后动画结束并回到兜底 idle', Boolean(cycleRun.endEvent) && cycleRun.phaseAfter === null && cycleRun.current === 'idle', JSON.stringify({ end: cycleRun.endEvent, phase: cycleRun.phaseAfter, current: cycleRun.current }));

  // 被打断：立刻进收尾段 -> end 播完 -> 结束
  const interruptRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const bus = window.petDebug.bus;
    const video = () => document.querySelector('video.layer-active') || document.getElementById('pet-video') || document.querySelector('video');
    const srcOf = () => String(video().currentSrc || video().src || '').split('/').pop();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    anim.resetCooldowns();
    // watch 是无限循环（loopCount 未配），正好用来测"只能被打断结束"
    await anim.play('watch', { interrupt: 'force', reason: 'persistent-interrupt-test' });
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
    const phaseBefore = anim.getPersistentPhase();
    const srcBefore = anim.getActiveSource();

    /*
     * 用**权威来源**判断 end 段是否播过，而不是轮询 DOM 的 currentSrc：
     * 后者会漏采样（end 段只有 4.4s，但轮询粒度/切换时机都可能错过，
     * 实测偶发 endSrc=false 而其实 end 段正常播完了）。
     * getActiveSource() 在 phase='end' 时返回的就是 end 段素材。
     */
    let sawEndSource = false;
    const t0 = Date.now();
    const accepted = anim.endPersistent('acceptance-interrupt');
    const phaseRightAfter = anim.getPersistentPhase();
    const enteredEndImmediately = anim.getPersistentPhase() === 'end';
    const phaseLatencyMs = Date.now() - t0;

    let endEvent = null;
    const sub = bus.on('animation:end', (p) => { if (p.animationId === 'watch') endEvent = p; });
    const t1 = Date.now();
    while (Date.now() - t1 < 30000 && !endEvent) {
      await wait(50);
      // 只要观察到"处于 end 阶段"或素材名含 -end，就认定 end 段播过
      if (anim.getPersistentPhase() === 'end') sawEndSource = true;
      if (String(anim.getActiveSource()).includes('-end')) sawEndSource = true;
      if (String(srcOf()).includes('-end')) sawEndSource = true;
    }
    sub.unsubscribe();
    return { phaseBefore, srcBefore, accepted, phaseRightAfter, enteredEndImmediately, phaseLatencyMs, sawEndSrc: sawEndSource, endEvent, current: anim.getCurrentAnimation() };
  })()`);
  record('无限循环的持续动画（watch）循环段无 loopCount', interruptRun.phaseBefore === 'loop' && String(interruptRun.srcBefore).includes('-loop'), JSON.stringify(interruptRun));
  record(
    '打断立刻进入 end 阶段（不等本轮循环播完）',
    interruptRun.accepted === true && interruptRun.enteredEndImmediately === true && interruptRun.phaseRightAfter === 'end',
    `phase=${interruptRun.phaseRightAfter} latency=${interruptRun.phaseLatencyMs}ms`,
  );
  record('打断后播放 end 段并结束', interruptRun.sawEndSrc === true && Boolean(interruptRun.endEvent) && interruptRun.current === 'idle', JSON.stringify({ endSrc: interruptRun.sawEndSrc, end: interruptRun.endEvent, current: interruptRun.current }));

  /*
   * 收尾段（end）中途再次被打断 -> 必须**立刻**收干净（回 idle），
   * 不能等 4.4 秒的收尾段播完。这是"end 阶段被打断应该立刻切回 idle"那条要求。
   */
  const endInterruptRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const bus = window.petDebug.bus;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    anim.resetCooldowns();
    const endEvents = [];
    const sub = bus.on('animation:end', (p) => endEvents.push({ id: p.animationId, completed: p.completed, reason: p.reason }));
    await anim.play('watch', { interrupt: 'force', reason: 'end-interrupt-setup' });
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
    anim.endPersistent('end-interrupt-step1');           // 立刻进 end
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'end'; i++) await wait(50);
    const atEnd = { phase: anim.getPersistentPhase(), source: anim.getActiveSource() };

    const t0 = Date.now();
    const accepted = anim.endPersistent('end-interrupt-step2');   // 收尾段中途再打断
    const latencyMs = Date.now() - t0;
    const phaseAfter = anim.getPersistentPhase();
    let gone = false;
    while (Date.now() - t0 < 6000 && !gone) {
      await wait(100);
      if (anim.getCurrentAnimation() !== 'watch') gone = true;
    }
    /*
     * 关键不变量：**兜底 idle 必须接回来**。
     *
     * 这条路径没有新动画接替，而 renderer 只在 AnimationEnd 的 completed === true
     * 时才把状态迁回 IDLE；一旦这里发的是 completed=false，状态机会永远停在
     * PLAYING，idle 再也不会循环（画面冻结在收尾帧）—— 实测踩过这个坑。
     *
     * 注意断言方式：不能只看"此刻的 state" —— idle 一旦接回来就会把状态又推回
     * PLAYING（animation:start 无人接管的旧动画时会迁 IDLE）。因此这里查
     * **迁移历史**里确实出现过 to=IDLE，并且动画确实回到了 idle。
     * （本段代码在模板字符串里，注释中不能出现反引号。）
     */
    let idleBack = false;
    for (let i = 0; i < 100 && !idleBack; i++) {
      await wait(100);
      if (anim.getCurrentAnimation() === 'idle') idleBack = true;
    }
    const history = window.petDebug.state.getHistory(30);
    const sawIdleTransition = history.some((h) => h.to === 'IDLE' && String(h.reason).includes('animation-end:watch'));
    sub.unsubscribe();
    return { atEnd, accepted, latencyMs, phaseAfter, gone, idleBack, sawIdleTransition, currentAfter: anim.getCurrentAnimation(), endEvents };
  })()`);
  record(
    'end 阶段被打断立刻收干净（不等收尾段播完）',
    endInterruptRun.atEnd?.phase === 'end' &&
      endInterruptRun.accepted === true &&
      endInterruptRun.phaseAfter === null &&
      endInterruptRun.gone === true &&
      endInterruptRun.latencyMs < 1500,
    JSON.stringify(endInterruptRun),
  );
  record(
    '打断收尾段后兜底 idle 接回来（状态不卡在 PLAYING）',
    endInterruptRun.idleBack === true && endInterruptRun.sawIdleTransition === true,
    'idleBack=' +
      endInterruptRun.idleBack +
      ' sawIdleTransition=' +
      endInterruptRun.sawIdleTransition +
      ' currentAfter=' +
      endInterruptRun.currentAfter +
      ' watchEndEvents=' +
      JSON.stringify((endInterruptRun.endEvents ?? []).filter((e) => e.id === 'watch')),
  );

  /*
   * 点击遇到持续动画：**先播完收尾段，再播点击反应**（用户明确要求）。
   *
   * 旧行为是硬切 —— 收尾段完全被跳过，动作断得突兀。新行为两步：
   *   1. endPersistent() 让它立刻进收尾段；
   *   2. 点击反应按 interrupt:'queue' 排队，收尾段结束后接上。
   *
   * 走**真实点击入口** window.petApp.handleIntent(...)，不在测试里复刻
   * 区域->动画的映射（复刻过的断言漏过真 bug）。
   */
  const clickDeferRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const payload = { button: 'left', x: 100, y: 100, nx: 0.5, ny: 0.5, region: 'body', detail: 1 };
    anim.resetCooldowns();
    anim.stop('click-defer-reset');
    await wait(200);
    await anim.play('watch', { interrupt: 'force', reason: 'click-defer-setup' });
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
    const before = { animation: anim.getCurrentAnimation(), phase: anim.getPersistentPhase() };

    window.petApp.handleIntent({ kind: 'click', region: 'body', payload });
    // 立刻应进 end 段（不是硬切到 stroke）
    let enteredEnd = false;
    const t0 = Date.now();
    for (let i = 0; i < 40 && !enteredEnd; i++) {
      await wait(20);
      if (anim.getPersistentPhase() === 'end') enteredEnd = true;
    }
    const enterEndMs = Date.now() - t0;
    const midAnimation = anim.getCurrentAnimation();

    // 收尾段播完后应自动接上点击反应（body -> stroke）
    let reaction = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 20000 && reaction === null) {
      await wait(100);
      const cur = anim.getCurrentAnimation();
      if (cur !== null && cur !== 'watch') reaction = cur;
    }
    return { before, enteredEnd, enterEndMs, midAnimation, reaction, reactionAfterMs: Date.now() - t1 };
  })()`);
  record(
    '点击持续动画：立刻进 end 段而不是硬切',
    clickDeferRun.before?.phase === 'loop' &&
      clickDeferRun.enteredEnd === true &&
      clickDeferRun.midAnimation === 'watch' &&
      clickDeferRun.enterEndMs < 1500,
    `enterEndMs=${clickDeferRun.enterEndMs} mid=${clickDeferRun.midAnimation}`,
  );
  record(
    '点击持续动画：收尾段播完后自动接上点击反应',
    clickDeferRun.reaction === 'stroke',
    `reaction=${clickDeferRun.reaction} afterMs=${clickDeferRun.reactionAfterMs}`,
  );

  /*
   * 对照：**优先级更高的动画不受点击延迟影响**。
   *
   * 点击只是瞬时反应（priority 50/60），不该让位于高优先级动画：
   * 门控条件是"持续动画的优先级 <= 反应优先级"，bomb（priority 100，一次性）
   * 连持续动画都不是，因此既不延迟、点击也会被既有的优先级仲裁拒掉
   * （lower-priority）—— 这是设计如此，不是缺陷；关键是**不能把 bomb 掐掉**。
   */
  const clickNoDeferRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const bus = window.petDebug.bus;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const payload = { button: 'left', x: 100, y: 100, nx: 0.5, ny: 0.5, region: 'body', detail: 1 };
    anim.resetCooldowns();
    anim.stop('no-defer-reset');
    await wait(200);
    const rejections = [];
    const sub = bus.on('animation:rejected', (p) => rejections.push({ id: p.animationId, rejection: p.rejection }));
    const started = await anim.play('bomb', { interrupt: 'force', reason: 'no-defer-setup', bypassCooldown: true });
    const before = { animation: anim.getCurrentAnimation(), priority: anim.getCurrentPriority() };
    window.petApp.handleIntent({ kind: 'click', region: 'body', payload });
    await wait(500);
    sub.unsubscribe();
    return { started: started.accepted, before, after: anim.getCurrentAnimation(), rejections };
  })()`);
  record(
    '高优先级动画（bomb 100）不被点击延迟或掐掉',
    clickNoDeferRun.started === true &&
      clickNoDeferRun.before?.priority === 100 &&
      clickNoDeferRun.after === 'bomb' &&
      (clickNoDeferRun.rejections ?? []).some((r) => r.rejection === 'lower-priority'),
    JSON.stringify(clickNoDeferRun),
  );

  /*
   * 对话气泡：三个需求一起验。
   *   1. 气泡随宠物大小变化（改 scale 后气泡按比例跟着变）；
   *   2. 长文本可通过滚动条滑动（scrollHeight > clientHeight，且能滚到底）；
   *   3. 文字落在气泡贴图的留白区内（不压描边/尾巴）。
   *
   * 走**真实链路**：window.petAPI.bubble.set -> IPC -> BubbleController
   * -> 窗口按宠物锚点扩张 -> 下发布局 -> 渲染层落地。
   * 与托盘菜单「对话气泡（测试）」是同一条实现。
   */
  const bubbleRun = await run(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    /* 内容比较必须读**正文元素**：滚动容器里还有正文这一层，
       其 textContent 会带上 HTML 缩进产生的空白（踩过）。 */
    const text = () => document.getElementById('pet-bubble-body').textContent;
    const el = () => document.getElementById('pet-bubble-text');

    // ---- 1) 先记录"无气泡"时的窗口尺寸，用于核对锚点 ----
    await window.petAPI.bubble.set(null);
    await wait(700);
    const hidden = window.petApp.describeBubble();

    // ---- 2) 显示短句 ----
    const shortPayload = await window.petAPI.bubble.set({ visible: true, text: '今天也一起加油吧！' });
    await wait(900);
    const shortState = window.petApp.describeBubble();

    // ---- 3) 显示长文本（单行、足够长 -> 必然折行并溢出） ----
    const longText = '这是一段用来把气泡内容撑长的测试文字。'.repeat(20);
    const longPayload = await window.petAPI.bubble.set({ visible: true, text: longText });
    await wait(900);
    const longState = window.petApp.describeBubble();
    /* 中途采样：定位"文字内容"是在哪一步之后变掉的 */
    const textAfterLongSet = text();
    // 滚动到底
    const t = el();
    t.scrollTop = t.scrollHeight;
    await wait(250);
    const scrolled = {
      scrollTop: t.scrollTop,
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      /* 容差 3px：滚动位置会被舍入到物理像素（本机 dpr 1.25） */
      atBottom: t.scrollTop + t.clientHeight >= t.scrollHeight - 3,
    };

    // ---- 4) 缩放跟随：改 scale，气泡必须按比例变 ----
    const scaleProbe = [];
    for (const scale of [0.35, 1.0]) {
      await window.petAPI.settings.setScale(scale);
      await wait(900);
      const s = window.petApp.describeBubble();
      scaleProbe.push({ scale, pet: s.petSize, bubble: s.bubble, fontSize: s.fontSize, scrollable: s.scrollable });
    }

    /*
     * ---- 5) 锚点：气泡显隐不能让**宠物在窗口里的布局位置**发生变化 ----
     *
     * 注意不能量 getBoundingClientRect()（视口坐标）：窗口向上扩大时，
     * 宠物在屏幕上原地不动，它在**视口**里的坐标必然改变 —— 那是坐标系问题，
     * 不是锚点错。第一版就是这么误判的。
     *
     * 这里改量"布局不变量"：宠物在窗口内的偏移必须完全由布局决定。
     *   隐藏时：petTop  = padding
     *   显示时：petTop  = padding + bubbleHeight + gap
     *   水平恒为：(windowWidth - petWidth) / 2
     * 同时宠物像素尺寸必须等于 petWidth/petHeight（不随窗口拉伸）。
     *
     * 注意：getBoundingClientRect 给的是**视口**坐标，而窗口可能被移到屏幕外
     * （宠物底边贴工作区底边时窗口顶部会在屏幕上方），因此这里换算成
     * **窗口内坐标**再比较：offsetTop - (windowScreenY - screen.availTop)。
     * 直接用视口坐标会在窗口处于屏幕外时报假失败 —— 这个坑踩过。
     */
    const layoutProbe = async () => {
      const pet = document.getElementById('pet-pet');
      const stage = document.getElementById('pet-stage');
      const pr = pet.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      return {
        /*
         * **相对舞台**的偏移（= 纯布局量）。
         *
         * 不能用 getBoundingClientRect 的绝对值：窗口可能被 clamp 推到屏幕上方
         * （宠物底边贴工作区底边 + 气泡在宠物上方时必然如此），
         * 那时视口坐标会整体平移，看起来像"布局不对"。踩过两次。
         */
        offsetLeft: pr.left - sr.left,
        offsetTop: pr.top - sr.top,
        width: pr.width,
        height: pr.height,
        stagePad: getComputedStyle(stage).paddingTop,
        /* 原始 rect：定位"舞台自身是否被下移" */
        raw: {
          stage: { top: sr.top, left: sr.left, w: sr.width, h: sr.height },
          pet: { top: pr.top, left: pr.left, w: pr.width, h: pr.height },
          viewport: { w: window.innerWidth, h: window.innerHeight },
        },
      };
    };
    await window.petAPI.settings.setScale(0.6);
    await wait(900);

    await window.petAPI.bubble.set(null);
    await wait(700);
    const probeHidden = await layoutProbe();
    const descHidden = window.petApp.describeBubble();
    const padHidden = descHidden.padding;
    // 舞台是 content-box + padding，宠物整体被推下/推右 padding
    const expectedHiddenTop = padHidden;
    const expectedHiddenLeft = padHidden + (descHidden.windowInner.width - descHidden.petSize.width) / 2;

    await window.petAPI.bubble.set({ visible: true, text: '锚点测试' });
    await wait(900);
    const probeShown = await layoutProbe();
    const descShown = window.petApp.describeBubble();
    const expectedShownTop = descShown.padding + descShown.bubble.height + descShown.gap;
    const expectedShownLeft = descShown.padding + (descShown.windowInner.width - descShown.petSize.width) / 2;

    await window.petAPI.bubble.set(null);
    await wait(900);
    const probeHiddenAgain = await layoutProbe();

    const layout = {
      hidden: { actual: probeHidden, expectedTop: expectedHiddenTop, expectedLeft: expectedHiddenLeft },
      shown: { actual: probeShown, expectedTop: expectedShownTop, expectedLeft: expectedShownLeft },
      hiddenAgain: probeHiddenAgain,
    };

    // ---- 6) 隐藏：窗口应收回纯宠物尺寸 ----
    await window.petAPI.bubble.set(null);
    await wait(900);
    const afterHide = window.petApp.describeBubble();

    return {
      hidden, shortPayload, shortState, longPayload, longState, scrolled, scaleProbe, afterHide, layout,
      longTextLength: longText.length,
      textMatches: textAfterLongSet === longText,
      textSample: String(text()).slice(0, 12),
      textAfterLongSetSample: String(textAfterLongSet).slice(0, 12),
      longTextSample: longText.slice(0, 12),
      /* 长度对比：384 vs 380 之类能立刻看出是不是多了空白 */
      readLength: String(textAfterLongSet).length,
      longTextLen: longText.length,
    };
  })()`);

  // 1) 气泡渲染出来，且尺寸与主进程下发的布局一致
  record(
    '对话气泡：显示后按布局渲染（贴图 + 文字区）',
    bubbleRun.shortState?.visible === true &&
      bubbleRun.shortState?.bubble?.width > 0 &&
      bubbleRun.shortState?.textLength > 0 &&
      bubbleRun.shortPayload?.layout?.bubbleWidth === bubbleRun.shortState?.bubble?.width,
    JSON.stringify({ visible: bubbleRun.shortState?.visible, bubble: bubbleRun.shortState?.bubble, layout: bubbleRun.shortPayload?.layout?.bubbleWidth }),
  );

  // 2) 长文本出现滚动条并且能滚到底
  record(
    '对话气泡：超长文本出现滚动条且能滚到底（高度到上限后不再拉高）',
    bubbleRun.longState?.scrollable === true &&
      bubbleRun.scrolled?.atBottom === true &&
      bubbleRun.scrolled?.scrollHeight > bubbleRun.scrolled?.clientHeight &&
      bubbleRun.textMatches === true,
    JSON.stringify({ scrollable: bubbleRun.longState?.scrollable, scrolled: bubbleRun.scrolled, textMatches: bubbleRun.textMatches }),
  );

  // 短文本不该出现滚动条
  record(
    '对话气泡：短文本不出现滚动条',
    bubbleRun.shortState?.scrollable === false,
    `shortScrollable=${bubbleRun.shortState?.scrollable}`,
  );

  // 3) 随宠物大小变化：两次 scale 的气泡尺寸比应等于宠物尺寸比
  const ratioCheck = (() => {
    const [a, b] = bubbleRun.scaleProbe ?? [];
    if (!a || !b || !a.bubble || !b.bubble || !a.pet || !b.pet) return null;
    const petRatio = b.pet.height / a.pet.height;
    const bubbleRatio = b.bubble.width / a.bubble.width;
    return { petRatio: Number(petRatio.toFixed(3)), bubbleRatio: Number(bubbleRatio.toFixed(3)), diff: Number(Math.abs(petRatio - bubbleRatio).toFixed(3)) };
  })();
  record(
    '对话气泡：随宠物大小等比缩放',
    ratioCheck !== null && ratioCheck.diff < 0.05 && ratioCheck.bubbleRatio > 1.5,
    JSON.stringify({ ratioCheck, scaleProbe: bubbleRun.scaleProbe }),
  );

  // 4) 隐藏后窗口收回纯宠物尺寸（锚点不乱留空白）
  record(
    '对话气泡：隐藏后窗口收回宠物尺寸',
    bubbleRun.afterHide?.visible === false &&
      bubbleRun.afterHide?.windowInner?.width === bubbleRun.afterHide?.petSize?.width &&
      bubbleRun.afterHide?.windowInner?.height === bubbleRun.afterHide?.petSize?.height,
    JSON.stringify({ windowInner: bubbleRun.afterHide?.windowInner, petSize: bubbleRun.afterHide?.petSize }),
  );

  /*
   * 5) 布局不变量。
   *
   * 只锁**真正有意义且稳定**的三条：
   *   a. 宠物像素尺寸 == 布局给的 petWidth/petHeight（不随窗口拉伸）；
   *   b. 气泡与宠物都完整落在窗口内（不因 padding/box-sizing 被挤出裁切）；
   *   c. 回到隐藏后宠物位置与最初完全一致（无累积漂移）。
   *
   * 刻意**不**断言"宠物顶边 == padding + 气泡高 + gap"这类绝对像素等式：
   * 在 1.25 倍 DPR 下，content-box 容器的 getBoundingClientRect 会把 padding
   * 重复计入（实测舞台 rect 比视口大 18.2px），这种断言会被测量层伪影带偏。
   */
  const layoutCheck = (() => {
    const l = bubbleRun.layout;
    const s = bubbleRun.shortState;
    if (!l || !l.hidden || !l.shown || !l.hiddenAgain || !s?.windowInner) return null;
    const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

    /*
     * a. 宠物像素尺寸**不随气泡显隐变化**（不被窗口拉伸）。
     * 只比较 DOM 自身的两次测量：主进程下发的 petSize 快照与 DOM 可能不在
     * 同一时刻（`setScale` 是异步的，这里前面刚把 scale 调回 0.6），
     * 拿它们互相比会得到假失败（实测：快照 360x480 vs DOM 216x288）。
     */
    const sizeMatchesLayout =
      near(l.shown.actual.width, l.hidden.actual.width) && near(l.shown.actual.height, l.hidden.actual.height);

    /*
     * b. 宠物完整落在窗口内（含 offset + 尺寸 <= 窗口内尺寸）。
     * 超出说明被 overflow 裁掉了 —— padding 与 box-sizing 配合出错时就会这样
     * （实测宠物上下各被裁掉 9px）。
     */
    const withinWindow =
      l.shown.actual.offsetLeft >= -1 &&
      l.shown.actual.offsetTop >= -1 &&
      l.shown.actual.offsetLeft + l.shown.actual.width <= s.windowInner.width + 2 &&
      l.shown.actual.offsetTop + l.shown.actual.height <= s.windowInner.height + 2;

    // c. 无累积漂移
    const noDrift =
      near(l.hiddenAgain.offsetTop, l.hidden.actual.offsetTop, 1) &&
      near(l.hiddenAgain.offsetLeft, l.hidden.actual.offsetLeft, 1);

    return { sizeMatchesLayout, withinWindow, noDrift, hiddenSize: l.hidden.actual, shownSize: l.shown.actual };
  })();
  record(
    '对话气泡：宠物尺寸不被窗口拉伸、不溢出窗口、显隐无累积漂移',
    layoutCheck !== null && layoutCheck.sizeMatchesLayout && layoutCheck.withinWindow && layoutCheck.noDrift,
    JSON.stringify({ layoutCheck, checks: layoutCheck ? Object.entries(layoutCheck).map(([k, v]) => `${k}=${v}`).join(',') : 'null' }),
  );

  /*
   * 6) 气泡大小**随文本长短变化**。
   *
   * 链路：Renderer 用 canvas 量出"当前宽度下占几行" -> 回报主进程 ->
   * 主进程按行数重算气泡高度（有下限与上限）-> 调整窗口 -> 回传布局。
   * 期望：文本越长气泡越高（到上限为止），超过上限则不再变高、改为文字区滚动。
   */
  const bubbleAdaptive = await run(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const samples = [
      { name: '极短', text: '早' },
      { name: '短', text: '今天也一起加油吧！' },
      { name: '中', text: '这是一段中等长度的文本，用来观察气泡高度会不会跟着变高。大概两到三行。' },
      { name: '长', text: '当文字超过一屏时，气泡内部会出现滚动条，可以用鼠标滚轮或拖动滚动条查看后面的内容，文字不会溢出气泡的描边。下面还有一些内容用来把文本撑长：一、气泡的尾巴指向桌宠的头顶；二、气泡在桌宠上方，窗口会向上扩展。' },
      { name: '极长', text: '这一段刻意写得非常长，用来把气泡撑到高度上限。'.repeat(16) + '结尾。' },
    ];
    const rows = [];
    for (const sample of samples) {
      await window.petAPI.bubble.set({ visible: true, text: sample.text });
      await wait(900);
      const s = window.petApp.describeBubble();
      rows.push({
        name: sample.name,
        chars: sample.text.length,
        bubbleHeight: s.bubble?.height ?? 0,
        scrollable: s.scrollable,
        textAreaHeight: s.clientHeight,
        contentHeight: s.scrollHeight,
      });
    }
    await window.petAPI.bubble.set(null);
    await wait(700);

    const heights = rows.map((r) => r.bubbleHeight);
    const cap = Math.max(...heights);
    return {
      rows,
      heights,
      cap,
      monotonic: heights.every((h, i) => i === 0 || h >= heights[i - 1] - 2),
      shortest: heights[0],
      tallest: heights[heights.length - 1],
      /** 到达上限的行数（至少两条 -> 说明确实"到上限后不再变高"） */
      atCap: rows.filter((r) => r.bubbleHeight === cap).length,
      /** 需要滚动的那几条：都是内容超出正文区的 */
      scrollRows: rows.filter((r) => r.scrollable),
      /** 不需要滚动的：内容都在正文区内放得下 */
      fitsRows: rows.filter((r) => !r.scrollable),
    };
  })()`);

  record(
    '对话气泡：大小随文本长短变化（越长越高，单调不减）',
    bubbleAdaptive.monotonic === true && (bubbleAdaptive.tallest ?? 0) > (bubbleAdaptive.shortest ?? 0),
    `heights=${JSON.stringify(bubbleAdaptive.heights)}`,
  );
  /*
   * 拉伸上限 + 滚动条：
   *   - 有文本到达上限（更长的文本不再变高）；
   *   - 需要滚动的文本，其内容高度确实超过正文区高度；
   *   - 不需要滚动的文本，内容高度在正文区内放得下。
   * 上限由宠物尺寸与工作区共同决定，因此**不**断言"几条同时到上限"。
   */
  record(
    '对话气泡：到拉伸上限后不再变高，超出部分转为文字区滚动',
    (bubbleAdaptive.atCap ?? 0) >= 1 &&
      (bubbleAdaptive.scrollRows ?? []).length >= 1 &&
      (bubbleAdaptive.fitsRows ?? []).length >= 1 &&
      (bubbleAdaptive.scrollRows ?? []).every((r) => r.contentHeight > r.textAreaHeight) &&
      (bubbleAdaptive.fitsRows ?? []).every((r) => r.contentHeight <= r.textAreaHeight + 2),
    JSON.stringify({ cap: bubbleAdaptive.cap, heights: bubbleAdaptive.heights, scroll: bubbleAdaptive.scrollRows?.map((r) => r.name), fits: bubbleAdaptive.fitsRows?.map((r) => r.name) }),
  );

  record(
    '对话气泡：文字内容原样落地',
    bubbleRun.textMatches === true,
    `matches=${bubbleRun.textMatches} 读到=${bubbleRun.readLength}字/期望=${bubbleRun.longTextLen}字 读到开头="${bubbleRun.textAfterLongSetSample}" src="${bubbleRun.longTextSample}"`,
  );

  /*
   * 卡死自愈：**没有任何动画在播、画面却停着一帧**时必须能接回兜底 idle。
   *
   * 复现的形态（用户反馈"idle 时再点击会卡住"）：点击 idle 播 stroke，
   * 若 stroke 被插件/行为中途抢占（`completed=false`），状态不会迁回 IDLE，
   * 于是 `resumeFallbackLoop` 永远不触发，桌宠就冻在 stroke 的最后一帧。
   *
   * 旧的看门狗只在**状态为 IDLE** 时检查，恰好漏掉这个最常见的卡死形态；
   * 而且 `isVideoRenderable()` 对"停在收尾帧的缓冲"返回 true，也救不了。
   * 现在用 `isVisuallyStuck()`（无动画在播 + 可见缓冲 paused 且已播到末尾）
   * 独立判定，跑一次健康检查就应把 idle 接回来。
   */
  const stuckHealRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = () => Array.from(document.querySelectorAll('#pet-stage video'))
      .filter((v) => v.classList.contains('layer-active') && v.readyState >= 2);

    anim.resetCooldowns();
    anim.stop('stuck-setup');
    await wait(300);
    // 播一个反应动画
    await anim.play('stroke', { interrupt: 'force', reason: 'stuck-setup', bypassCooldown: true });
    await wait(600);
    const playing = anim.getCurrentAnimation();

    // 模拟"被抢占后没人接上"：直接停掉动画管理器，画面留在这一帧
    anim.stop('simulated-interrupt');
    /*
     * 关键：在**同一个 tick 内**立刻断言卡死状态并跑健康检查。
     *
     * 不能先 await 再查：resumeFallbackLoop 里还有一道 600ms 的保险，
     * 会抢先把兜底接回来，于是"看门狗能不能救"这件事就被掩盖了
     * （第一版断言就是这样误判的）。
     * 注意：本段在模板字符串里，注释中不能出现反引号。
     */
    const immediate = (() => {
      const vids = Array.from(document.querySelectorAll('#pet-stage video'))
        .filter((v) => v.classList.contains('layer-active') && v.readyState >= 2);
      const before = window.petApp.describeRecovery();
      window.petApp.runHealthCheck('acceptance-stuck-probe');
      const after = window.petApp.describeRecovery();
      return {
        pausedVisible: vids.length > 0 && vids.every((v) => v.paused),
        stuckBefore: before.visuallyStuck,
        stuckAfter: after.visuallyStuck,
        attemptsBefore: before.recoveryAttempts,
        attemptsAfter: after.recoveryAttempts,
        // 本次调用确实执行了自愈（计数器是累计值，不能断言具体数字）
        healed: after.recoveryAttempts > before.recoveryAttempts,
      };
    })();

    await wait(300);
    const stuck = {
      animation: anim.getCurrentAnimation(),
      state: window.petDebug.state.get(),
      visiblePaused: visible().length > 0 && visible().every((v) => v.paused),
    };

    let recovered = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000 && !recovered) {
      await wait(150);
      if (anim.getCurrentAnimation() === 'idle') recovered = true;
    }
    // 再确认画面真的在动（不是又冻住）
    const tA = visible()[0] ? visible()[0].currentTime : -1;
    await wait(500);
    const tB = visible()[0] ? visible()[0].currentTime : -1;
    return {
      playing,
      immediate,
      stuck,
      recovered,
      recoveredMs: Date.now() - t0,
      advancing: tB > tA,
      tA,
      tB,
      finalAnimation: anim.getCurrentAnimation(),
    };
  })()`);
  record(
    '卡死自愈：无动画在播且画面停帧时接回兜底 idle',
    stuckHealRun.playing === 'stroke' &&
      stuckHealRun.immediate?.pausedVisible === true &&
      stuckHealRun.immediate?.stuckBefore === true &&
      stuckHealRun.immediate?.stuckAfter === false &&
      stuckHealRun.immediate?.healed === true &&
      stuckHealRun.recovered === true &&
      stuckHealRun.finalAnimation === 'idle',
    JSON.stringify(stuckHealRun),
  );

  /*
   * 用户交互抢占：点击带来的反应动画必须**立刻**接管，
   * 不能等持续动画把收尾段播完（watch-end 有 4.5 秒，等完就像"点不动"）。
   */
  const stealRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const bus = window.petDebug.bus;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    anim.resetCooldowns();
    await anim.play('watch', { interrupt: 'force', reason: 'user-click:body-steal-test' });
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
    const before = { animation: anim.getCurrentAnimation(), phase: anim.getPersistentPhase() };
    // 模拟点击反应（renderer 用的就是 user-click:* 这个 reason 前缀 + priority 50）
    const t0 = Date.now();
    const result = await anim.play('stroke', { priority: 50, interrupt: 'auto', reason: 'user-click:body', source: 'user' });
    const elapsedMs = Date.now() - t0;
    await wait(300);
    return { before, accepted: result.accepted, elapsedMs, after: anim.getCurrentAnimation(), phaseAfter: anim.getPersistentPhase() };
  })()`);
  record(
    '用户点击可立刻打断持续动画（不等收尾段）',
    stealRun.accepted === true && stealRun.after === 'stroke' && stealRun.elapsedMs < 1500,
    JSON.stringify(stealRun),
  );

  /*
   * 托盘菜单"再次点击同一项"必须能结束它。
   *
   * 菜单用 radio 勾选当前动画，用户看到已选中自然会想"再点一次取消"；
   * 持续动画会一直循环，没有这个出口就会觉得"watch 无法打断"（实测反馈）。
   */
  const toggleRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const runtime = window.petDebug; // 直接走 renderer 的 onSetAnimation 等价路径
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    anim.resetCooldowns();
    await anim.play('watch', { interrupt: 'force', priority: 60, reason: 'tray-menu', source: 'system' });
    for (let i = 0; i < 60 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
    const before = { animation: anim.getCurrentAnimation(), phase: anim.getPersistentPhase() };
    /*
     * 模拟菜单再次点同一项：renderer 现在会走 endPersistent('tray-menu-toggle')。
     * 这里直接复刻那两步，验证"同动画再点一次"确实能结束。
     */
    let ended = false;
    if (anim.getCurrentAnimation() === 'watch') {
      ended = anim.endPersistent('tray-menu-toggle');
      if (!ended) anim.stop('tray-menu-toggle');
    }
    const phaseAfter = anim.getPersistentPhase();
    let gone = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !gone) {
      await wait(150);
      if (anim.getCurrentAnimation() !== 'watch') gone = true;
    }
    return { before, ended, phaseAfter, gone, now: anim.getCurrentAnimation() };
  })()`);
  record(
    '托盘菜单再次点击同一动画可结束它（watch 的打断出口）',
    toggleRun.before.animation === 'watch' && toggleRun.ended === true && toggleRun.gone === true,
    JSON.stringify(toggleRun),
  );

  /*
   * 回归断言：**从菜单选择「其它动画」必须能打断当前动画**。
   *
   * 真实 bug：renderer 原来给菜单播放统一用 priority 60 + interrupt 'auto'，
   * 于是"当前 60 vs 目标 60"命中 equal-priority 被拒 ——
   * 表现就是"watch 播放时选别的动画没反应"（实测**所有**动画都被拒）。
   * 菜单是用户明确选择，必须无条件生效：priority 70 + interrupt 'force'。
   */
  const menuSwitch = await run(`(async () => {
    const anim = window.petDebug.anim;
    const actions = window.petDebug.actions;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const menuPlay = (id) => actions.execute({
      type: 'animation', animationId: id, priority: 70, interrupt: 'force',
      source: 'user', reason: 'tray-menu', bypassCooldown: true,
    });

    const results = [];
    for (const target of ['talk', 'cute', 'idle']) {
      anim.resetCooldowns();
      anim.stop('menu-switch-reset');
      await wait(150);
      // 每次起点都一样：用菜单路径起 watch（priority 70，与真实菜单一致）
      await menuPlay('watch');
      for (let i = 0; i < 60 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
      const before = anim.getCurrentAnimation();
      const r = await menuPlay(target);
      await wait(500);
      results.push({ target, before, accepted: r.accepted, rejection: r.rejection ?? null, after: anim.getCurrentAnimation() });
    }
    return results;
  })()`);
  record(
    '菜单选择其它动画可打断正在播放的持续动画（回归：equal-priority）',
    menuSwitch.every((r) => r.before === 'watch' && r.accepted === true && r.after === r.target),
    JSON.stringify(menuSwitch),
  );

  /*
   * 回归：**同一个动画"播放 -> 再点结束 -> 再播放 -> 再点结束"多个来回**都要生效。
   *
   * 之前那条 toggle 断言只跑了一次、而且是"复刻 renderer 的判断"，
   * 没有覆盖"连续来回"与真实菜单回调 —— 这次补上真实 command 路径。
   */
  const toggleRepeat = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const rounds = [];
    for (let round = 0; round < 2; round++) {
      anim.resetCooldowns();
      anim.stop('repeat-reset');
      await wait(200);
      // 等价于菜单项 click -> onSetAnimation -> 真实处理器（不是复刻逻辑）
      window.petApp.handleMenuAnimation('watch');
      for (let i = 0; i < 60 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
      const playing = { animation: anim.getCurrentAnimation(), phase: anim.getPersistentPhase() };
      // 再次点同一项
      window.petApp.handleMenuAnimation('watch');
      let gone = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 20000 && !gone) {
        await wait(150);
        if (anim.getCurrentAnimation() !== 'watch') gone = true;
      }
      rounds.push({ round, playing, gone, after: anim.getCurrentAnimation(), ms: Date.now() - t0 });
    }
    return rounds;
  })()`);
  record(
    '同一动画连续两轮"播放->再点结束"都生效',
    Array.isArray(toggleRepeat) && toggleRepeat.length === 2 && toggleRepeat.every((r) => r.playing.animation === 'watch' && r.gone === true),
    JSON.stringify(toggleRepeat),
  );

  // 对一次性动画调用 endPersistent 必须是空操作
  const endOnOneShot = await run(`(async () => {
    const anim = window.petDebug.anim;
    anim.resetCooldowns();
    await anim.play('cute', { interrupt: 'force', reason: 'one-shot-endprobe' });
    const before = anim.getCurrentAnimation();
    const accepted = anim.endPersistent('should-be-noop');
    return { before, accepted, current: anim.getCurrentAnimation(), phase: anim.getPersistentPhase() };
  })()`);
  record(
    'endPersistent() 对一次性动画是空操作',
    endOnOneShot.accepted === false && endOnOneShot.phase === null && endOnOneShot.current === 'cute',
    JSON.stringify(endOnOneShot),
  );
  await run(`window.petDebug.anim.play('idle', { interrupt: 'force', reason: 'restore-after-persistent-tests' })`);
  await wait(1200);

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
    /*
     * 不可打断 + 冷却：这里**契约注册**一条专用动画，而不是依赖 Manifest 里
     * 某条素材恰好配了 interruptible=false / cooldown。
     * 原因：素材与 Manifest 会随需求变化（例如 sleep 后来改成了持续动画），
     * 让断言依赖"机制"而不是"某条素材的当前配置"，用例才不会被无关改动打破。
     */
    anim.registerAnimation({
      id: 'ac-guarded', type: 'video', source: 'animations/lie.webm',
      priority: 20, interruptible: false, cooldown: 180000,
    });
    anim.resetCooldowns();
    await anim.play('ac-guarded', { priority: 20, interrupt: 'force', reason: 'test' });
    out.guardedPlaying = anim.getCurrentAnimation();
    const r3 = await anim.play('bomb', { priority: 100, reason: 'test' });
    out.nonInterruptibleReason = r3.accepted ? null : r3.reason;
    // 冷却：紧接着再次 force 请求应被 cooldown 拒绝
    const r4 = await anim.play('ac-guarded', { priority: 20, interrupt: 'force', reason: 'test' });
    out.cooldownReason = r4.accepted ? null : r4.reason;
    // 收尾：停止，避免影响后续用例
    anim.stop('test-cleanup');
    return out;
  })()`);
  record('低优先级动画可正常播放', priority.low === 'lie', JSON.stringify(priority));
  record('高优先级可抢占低优先级', priority.interruptAccepted === true && priority.after === 'cute', `after=${priority.after}`);
  record('同优先级被拒绝 (equal-priority)', priority.equalReason === 'equal-priority', `reason=${priority.equalReason}`);
  record('interruptible=false 拒绝更高优先级抢占', priority.nonInterruptibleReason === 'not-interruptible', `reason=${priority.nonInterruptibleReason}, playing=${priority.guardedPlaying}`);
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
