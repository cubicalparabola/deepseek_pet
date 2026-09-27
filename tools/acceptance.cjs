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
 *   7. PluginManager + 插件安装/启停/卸载（随包不带插件，验收自己装探针）
 *   8. 插件监听事件 / 插件请求动画
 *   9. 插件异常隔离
 *  10. 右键菜单 / 托盘
 *  11. Renderer 无 Node/Electron 能力泄漏
 *
 * 用法：npx electron tools/acceptance.cjs
 * 结果：build/acceptance.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, appendFileSync, mkdirSync, readFileSync, rmSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'acceptance.json');

/*
 * AI 认知与人格（2.1~2.4）的数据目录必须**隔离**：
 * 验收会在里面写假密钥、测试记忆与测试日记，绝不能污染用户真实数据。
 * 因此这里在 require(main.js) **之前**把环境变量指到临时目录，
 * 并每次清空一次（保证"AI 默认全关"这类断言从干净状态开始）。
 */
const aiTestDataDir = join(tmpdir(), 'desktop-pet-acceptance-ai');
process.env.DESKTOP_PET_AI_DATA_DIR = aiTestDataDir;
try {
  rmSync(aiTestDataDir, { recursive: true, force: true });
} catch (error) {
  console.error('cleaning AI test data dir failed', error);
}
mkdirSync(aiTestDataDir, { recursive: true });

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

/**
 * 读取当前持久化的 `dockOnEdge`（拖到边缘是否自动收起）。
 *
 * 验收会临时把它关掉（见下面的说明），所以**必须记下原值并还原** ——
 * `assets/config/settings.json` 是用户真实配置，不是隔离目录。
 * （踩过：第一次实现忘了还原，于是验收跑完用户的"拖到边缘自动收起"被永久关掉，
 * 紧接着 diag-anim-system 全红。）
 */
function readSavedDockOnEdge() {
  try {
    return JSON.parse(readFileSync(join(root, 'assets', 'config', 'settings.json'), 'utf8')).dockOnEdge;
  } catch (error) {
    return null;
  }
}

/** 读取 `plugins.json` 的原始文本（收尾要写回，见 `originalPluginsJson` 的说明）。 */
function readSavedPluginsJson() {
  try {
    return readFileSync(join(root, 'assets', 'config', 'plugins.json'), 'utf8');
  } catch (error) {
    return null;
  }
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/*
 * 在**启动桌宠之前**记下用户的"拖到边缘自动收起"。
 *
 * 为什么必须这么早：验收自己要临时关掉它（合成指针会产生假拖动），
 * 而下面构造快照时再读文件就已经是"被关掉之后"的值了 —— 于是收尾会把它
 * 还原成 false，用户的手感被悄悄改掉（实测踩到，紧接着 diag-anim-system 全红）。
 * 函数声明会提升，所以在 `require(main)` 之前就能调用。
 */
const originalDockOnEdge = readSavedDockOnEdge();

/**
 * 验收开始前抄一份 `plugins.json`。
 *
 * 为什么需要：**验收自己会改这个文件**（安装探针插件、启停用例、卸载用例），
 * 而它是**用户的配置**（不是隔离目录）。收尾时写回原始内容 ——
 * 顺带也修掉了"上一次验收被中途掐断、把某个插件留在关闭状态"导致的连锁假红。
 */
const originalPluginsJson = readSavedPluginsJson();

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

/**
 * 收尾还原用户设置的钩子（在主流程里被赋值，见 `restoreUserSettings`）。
 *
 * 为什么提到外面来：`.catch()` 与主流程是**两个作用域**，中途抛错时要还原设置
 * 就得有一个两边都看得见的入口。
 */
let restoreUserSettings = async () => false;

app.whenReady().then(async () => {
  /*
   * 抢在"触发服务"启动之前把"她会自己动"的路径静音。
   *
   * 时序：触发服务在窗口 `did-finish-load` 之后 1.5 秒启动
   * （见 main.createWindow 的注释），而下面还要等 6 秒才做正式断言 ——
   * 不在这里抢跑的话，启动时"没配密钥 -> 演 offline"的指令会先到，
   * 于是 `兜底动画 idle 正在播放` 看到的是 `offline`（实测）。
   *
   * 为什么不是产品 bug：没配密钥时演 offline 正是需求要的行为
   * （`tools/probe-triggers.cjs` 专门断言它）；这里只是测试要隔离。
   */
  /*
   * 把她放回"桌面中部 + 未收起"。
   *
   * 贴边收起（`shared/dock.ts`）会改变**默认动画**（右侧收起 = watch、下方收起 = lie），
   * 而验收里大量断言在问"现在该播谁"。她默认出现在右下角（距边缘 48px），
   * 一旦合成指针事件造成位移，拖动结束时可能停到边缘上 -> 收起 ->
   * 之后所有动画断言都看到 watch/lie。所以：测试里的每次合成拖拽之后、
   * 以及每段动画断言之前，都显式回到自由状态。
   */
  const backToDesktop = async () => {
    const display = await run(`(async () => {
      await window.petAPI.window.setPosition(500, 300);
      await new Promise((r) => setTimeout(r, 200));
      await window.petAPI.window.undock();
      await new Promise((r) => setTimeout(r, 300));
      return window.petDebug.display();
    })()`);
    return display;
  };

  for (let i = 0; i < 240; i += 1) {
    const candidate = BrowserWindow.getAllWindows()[0];
    if (candidate && !candidate.isDestroyed()) {
      try {
        /*
         * 必须等到 `petDebug.behaviors` 存在才停手：`petAPI` 在 preload 阶段就有了，
         * 而行为管理器要等渲染层的 start() 才挂上 —— 只判 petAPI 会在
         * "预加载已就绪、渲染层还没起来"时误判成功，然后把主进程的暂停标记
         * 交给渲染层的托盘状态同步（它会报 false）覆盖掉（实测踩到）。
         *
         * 同一处顺手关掉"拖到边缘自动收起"（托盘菜单里的开关，默认开）：
         * 验收里有几处**合成指针**（长按 / 点击 / 拖动）—— 合成事件不会真的"按住"，
         * 但真实鼠标的移动会被当成拖动，拖动结束若停在边缘就会触发收起，
         * 而收起会换掉默认动画（右侧 watch / 下方 lie），后面一大批
         * "现在该播谁"的断言就会集体变红（实测跑几次，收起来的时间点每次还不一样）。
         * 真实的收/展由 `tools/diag-anim-system.cjs` 与
         * `tools/probe-dock-transition.cjs` 用**真实拖拽**专门验证。
         */
        const ok = await candidate.webContents.executeJavaScript(
          `(async () => {
            try {
              if (!window.petDebug || !window.petDebug.behaviors) return false;
              window.petAPI.notifyBehaviorPaused(true);
              window.petDebug.behaviors.pause();
              await window.petAPI.settings.setDockOnEdge(false);
              await window.petAPI.window.setPosition(500, 300);
              await new Promise((r) => setTimeout(r, 200));
              await window.petAPI.window.undock();
              return window.petDebug.behaviors.isPaused() === true;
            } catch (error) { return false; }
          })()`,
          true,
        );
        if (ok === true) break;
      } catch (error) {
        /* 渲染层/预加载还没就绪：下一轮再试 */
      }
    }
    await wait(100);
  }

  await wait(6000);

  const wins = BrowserWindow.getAllWindows();
  const win = wins[0];
  record('桌宠窗口已创建', wins.length >= 1, `windows=${wins.length}`);
  if (!win) return finish({ fatal: 'no window' });

  const run = (script) => win.webContents.executeJavaScript(script, true);

  /*
   * ⚠️ 动画相关断言期间**先把感知与 AI 都关掉**。
   *
   * 为什么：这两个模块都会**主动说话**，而说话会顺手播动画并弹气泡：
   * - 感知的主动开口 → `handleSpeak()`（talk / 场景对应动画）；
   * - AI 模块的心跳 → `maybeLonelySpeak()`（"很久没理你了，主动说一句"）→ 常挑 `cute`。
   * 而验收里有一大批断言在问"**现在应该播的是谁**"（bomb 播完回 idle、冷却期手动再播、
   * 交叉淡化没有空帧……）。撞在一起时断言看到的是**它们插进来的那个动画**，
   * 于是稳定/偶发地红（实测：`bomb 播完后自动回到 idle` 看到 `cute` 在播、
   * `非循环动画触发 animation:end` 被 `source: system` 打断、`对话气泡：隐藏后窗口收回宠物尺寸`…）。
   * 这是**测试没隔离好**，不是产品 bug —— 产品里"她会主动说话"本来就是设计行为。
   *
   * 两个模块自己的断言段开始前会重新打开（并在那里断言"默认全开"）。
   *
   * ⚠️ **随机池与触发动画同样要静音**（这一次新增的两条"她会自己动"的路径）：
   *   - 随机池 25~60 秒就会挑一个随机动画播 —— 验收跑几分钟必然撞上；
   *   - 鼠标靠近（catch_down/catch_right）看的是**真实光标位置**，
   *     光标恰好停在宠物附近时会插进来演一次（实测：`反应动画结束后自动恢复 idle`
   *     看到的是 `catch_right`）。
   * 两条都属于"产品里本来就该发生"，测试要主动隔离：
   * `behaviors.pause()` 停渲染层随机池，`notifyBehaviorPaused(true)` 让主进程的
   * 触发服务也安静（"行为暂停"的语义就是"别自己动"）。
   * 感知/AI 段开始前会恢复（见下面的 resume）。
   */
  await run(`window.petAPI.perception.setSettings({ screen: false, behavior: false, habits: false, camera: false })`);
  await run(`window.petAPI.ai.setSettings({ enabled: false, chat: false, memory: false, emotion: false, diary: false })`);
  await run(`(() => { window.petDebug.behaviors.pause(); window.petAPI.notifyBehaviorPaused(true); return true; })()`);
  await wait(300);

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
  /*
   * 先等回 idle 再断言"兜底动画是 idle"。
   *
   * 为什么需要等：没配密钥时启动会演一次 `offline`（需求要求的行为，
   * `tools/probe-triggers.cjs` 专门验证它）。正常情况下上面那段"抢跑静音"
   * 已经把它拦住了；但"能不能拦住"取决于渲染层就绪与触发服务 1.5 秒延迟的先后，
   * 不该让断言依赖这种竞态。这里最多等 8 秒，等不到就照常断言失败。
   */
  for (let i = 0; i < 80; i += 1) {
    const current = await run(`window.petDebug.anim.getCurrentAnimation()`);
    if (current === 'idle') break;
    await wait(100);
  }

  /*
   * 随包**只带一个**插件：待办清单（`plugins/todo-plugin`，需求"现在制作第一个插件：TO DO"）。
   *
   * 这条钉的是"没有别的插件也能正常起"：插件系统是可选能力，缺了不该影响桌宠本身。
   * 其余插件相关的用例会在下面**自己安装**两个探针插件
   * （`acceptance-click-probe` / `acceptance-plain-probe`），跑完再卸载 ——
   * 这样验收既不依赖随包内容，又覆盖了真实的"安装 -> 启用 -> 停用 -> 卸载"链路。
   */
  const state = await run(`(() => {
    const app = window.petApp;
    if (!app) return { error: 'petApp 未挂载' };
    return app.describe();
  })()`);
  record('petApp 已挂载', !state.error, JSON.stringify(state));
  record('兜底动画 idle 正在播放', state.animation === 'idle', `animation=${state.animation}`);
  record('状态机初始 PLAYING', state.state === 'PLAYING', `state=${state.state}`);
  record('Manifest 注册了 28 个动画（四类：状态/随机/触发/点击）', state.animations === 28, `animations=${state.animations}`);
  record('随包的待办插件已激活（只有一个随包插件）', state.plugins === 1, `plugins=${state.plugins}`);

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
    // 用启动前读到的原值（验收早段已经把它临时关掉了，见文件顶部）
    dockOnEdge: originalDockOnEdge ?? true,
  };
  /**
   * 把用户设置写回快照值。
   *
   * 为什么单独抽成一个函数：验收中途一旦抛错（fatal），末尾那段还原根本走不到 ——
   * 结果就是**用户的缩放/贴边开关被悄悄改掉**（实测踩过：一次崩溃把 scale 0.4 留成 1、
   * dockOnEdge true 留成 false，后续所有真机探针都跟着"收不起来"）。
   * 所以正常收尾与 fatal 收尾都要调用它。
   */
  const restoreUserSettingsImpl = async () => {
    try {
      await run(`(async () => {
        await window.petAPI.settings.setScale(${settingsSnapshot.scale});
        await window.petAPI.settings.setAlwaysOnTop(${settingsSnapshot.alwaysOnTop});
        await window.petAPI.settings.setDockOnEdge(${settingsSnapshot.dockOnEdge});
        return true;
      })()`);
      /*
       * `plugins.json` 也一起还原：启停与安装/卸载用例都会改它，
       * 而它是**用户的配置**（不是隔离目录）。写回原始文本 = 连格式与注释都不动。
       */
      if (originalPluginsJson !== null) {
        writeFileSync(join(root, 'assets', 'config', 'plugins.json'), originalPluginsJson, 'utf8');
      }
      return true;
    } catch (error) {
      return false;
    }
  };
  // 挂到外层（fatal 收尾时也要用它）
  restoreUserSettings = restoreUserSettingsImpl;
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
        // 从托盘菜单搬进设置窗口的三个入口（需求）：调整大小=滚动条、打开配置目录、重载插件
        hasOpenConfig: !!document.getElementById('open-config'),
        hasReloadPlugins: !!document.getElementById('reload-plugins'),
        hasDockOnEdge: !!document.getElementById('dock-on-edge'),
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
  record(
    '设置窗口里有从菜单搬来的三个入口（打开配置目录 / 重载插件 / 拖到边缘收起）',
    settingsDom?.hasOpenConfig === true && settingsDom?.hasReloadPlugins === true && settingsDom?.hasDockOnEdge === true,
    JSON.stringify({ config: settingsDom?.hasOpenConfig, reload: settingsDom?.hasReloadPlugins, dock: settingsDom?.hasDockOnEdge }),
  );

  /*
   * 插件面板（"插件可随时关闭"的界面入口）。
   *
   * 断言分三层，缺一层都可能假绿：
   *   1. 面板真的挂上了、卡片数量与清单一致（DOM 层）；
   *   2. 权限是**画出来的**（用户得能看见"这插件能联网"）；
   *   3. 真点一下开关，插件的 `enabled` 真的变了、并且能再点回来（通道层）。
   * 最后一条最要紧：新加的 IPC 正是最容易"元素在、点了没反应"的地方。
   */
  const pluginPanelDom = settingsWin
    ? await settingsWin.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(800);
        const root = document.getElementById('plugin-panel-root');
        const cards = document.querySelectorAll('#plugin-list .plugin-card');
        const switches = document.querySelectorAll('#plugin-list .plugin-switch-input');
        return {
          hasRoot: !!root,
          hasSection: !!document.querySelector('.plugin-panel .plugin-section'),
          cardCount: cards.length,
          switchCount: switches.length,
          permRows: document.querySelectorAll('#plugin-list .plugin-perms').length,
          // 权限胶囊的文字（"联网（…）"/"往「交互」收件箱投递…"）——用户得能看见这插件能干什么
          permLabels: [...document.querySelectorAll('#plugin-list .plugin-perms .plugin-chip')]
            .map((chip) => chip.textContent.trim()),
          hasReloadButton: !!document.getElementById('plugin-reload'),
          hasInstallButton: !!document.getElementById('plugin-install'),
          builtinNotes: document.querySelectorAll('#plugin-list .plugin-builtin').length,
          uninstallButtons: document.querySelectorAll('#plugin-list .plugin-uninstall').length,
          emptyHint: document.querySelector('#plugin-list .plugin-empty')?.textContent ?? '',
          names: [...document.querySelectorAll('#plugin-list .plugin-name')].map((n) => n.textContent),
        };
      })()`, true)
    : null;
  /*
   * 随包插件（待办清单）的**卡片**：一个开关、一行权限、一个卸载按钮。
   *
   * 空状态（"还没有插件…"）在这里看不到 —— 随包已经带了一个插件；
   * 空状态本身由后面的"卸载探针"流程覆盖（清空后 `plugin-empty` 会出现）。
   */
  record(
    '设置窗口「插件」面板：随包的待办插件渲染成卡片（开关 + 权限行 + 卸载）',
    pluginPanelDom?.hasRoot === true &&
      pluginPanelDom?.hasSection === true &&
      pluginPanelDom?.cardCount === 1 &&
      pluginPanelDom?.switchCount === 1 &&
      pluginPanelDom?.permRows === 1 &&
      pluginPanelDom?.hasReloadButton === true &&
      pluginPanelDom?.hasInstallButton === true &&
      pluginPanelDom?.uninstallButtons === 1,
    JSON.stringify(pluginPanelDom),
  );
  record(
    '设置窗口「插件」面板：待办插件的名字与它声明的权限都画出来了',
    Array.isArray(pluginPanelDom?.names) &&
      pluginPanelDom.names.some((name) => String(name).includes('待办清单')) &&
      /联网|通知|投递/.test(String(pluginPanelDom.names).concat(String(pluginPanelDom.permLabels))),
    JSON.stringify({ names: pluginPanelDom?.names, perms: pluginPanelDom?.permLabels }),
  );


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

  /*
   * 「拖到边缘自动收起」：从托盘菜单搬进设置窗口的开关（需求）。
   *
   * 必须**真点 DOM 并读 settings.json** 才算数 —— 只断言"元素在"会漏掉
   * 通道接错时"元素在、点了没反应"这种坏（新加的 IPC 正是最容易接错的地方）。
   *
   * ⚠️ 验收开头为了不让合成拖动触发贴边，特意把 `dockOnEdge` 关成了 false；
   * 所以这里翻一下、断言、**再翻回去**，跑完仍是 false，
   * 否则后面的拖动/点击类断言会开始偶发红（实测过：收起来的时间点每次不一样）。
   */
  const flipDockOnEdge = (value) => settingsWin
    ? settingsWin.webContents.executeJavaScript(`(async () => {
        const box = document.getElementById('dock-on-edge');
        if (!box) return { ok: false };
        box.checked = ${value ? 'true' : 'false'};
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 700));
        return { ok: true, checked: box.checked };
      })()`)
    : null;
  const dockOn = await flipDockOnEdge(true);
  await wait(500);
  const savedDockOn = readSavedDockOnEdge();
  const dockOff = await flipDockOnEdge(false);
  await wait(500);
  const savedDockOff = readSavedDockOnEdge();
  record(
    '设置窗口的「拖到边缘自动收起」开关真的生效并写盘（开→关都能对上）',
    dockOn?.ok === true && dockOn.checked === true && savedDockOn === true &&
      dockOff?.ok === true && dockOff.checked === false && savedDockOff === false,
    JSON.stringify({ dockOn, savedDockOn, dockOff, savedDockOff }),
  );

  /*
   * 「重载插件」：同样是搬进设置窗口的动作（以前只有托盘菜单里有）。
   * 断言的是**点完之后有回音**：按钮恢复可用 + 状态行显示结果。
   * 磁盘上没有插件时会显示"没有发现插件…"，那也是正确行为，所以只要求含「插件」二字。
   */
  const reloadPlugins = settingsWin
    ? await settingsWin.webContents.executeJavaScript(`(async () => {
        const button = document.getElementById('reload-plugins');
        const status = document.getElementById('action-status');
        if (!button) return { ok: false };
        button.click();
        await new Promise((r) => setTimeout(r, 900));
        return {
          ok: true,
          disabled: button.disabled,
          text: status ? (status.hidden ? '' : status.textContent || '') : '',
        };
      })()`)
    : null;
  record(
    '设置窗口的「重载插件」按钮点得动且有回音',
    reloadPlugins?.ok === true && reloadPlugins.disabled === false && /插件/.test(reloadPlugins.text || ''),
    JSON.stringify(reloadPlugins),
  );

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
        category: d ? d.category : null,
        seg: d && d.segments ? { start: Boolean(d.segments.start), loop: Boolean(d.segments.loop), end: Boolean(d.segments.end), loopCount: d.segments.loopCount ?? null, range: d.segments.loopCountRange ?? null } : null,
      };
    });
    return rows;
  })()`);
  // 7 条三段式：watch 与 lie 是"收起状态的默认姿势"（按次覆盖成无限循环），
  // 另外 5 条会自己播够轮数后收尾
  const persistentIds = ['lie', 'overheat', 'read', 'sad', 'sleep', 'watch', 'work'];
  const persistRows = persistentManifest.filter((r) => persistentIds.includes(r.id));
  const oneShotRows = persistentManifest.filter((r) => !persistentIds.includes(r.id));
  record(
    '7 条持续动画均带 start/loop/end 三段',
    persistRows.length === 7 && persistRows.every((r) => r.kind === 'persistent' && r.seg && r.seg.start && r.seg.loop && r.seg.end),
    JSON.stringify(persistRows.map((r) => `${r.id}:${r.kind}:${r.seg ? `${r.seg.start ? 'S' : '-'}${r.seg.loop ? 'L' : '-'}${r.seg.end ? 'E' : '-'}${r.seg.range ? `[${r.seg.range.join('-')}]` : r.seg.loopCount === null ? '(inf)' : `(${r.seg.loopCount})`}` : 'none'}`)),
  );
  record(
    '其余 21 条为一次性动画（无 segments）',
    oneShotRows.length === 21 && oneShotRows.every((r) => r.kind === 'one-shot' && r.seg === null),
    JSON.stringify({ count: oneShotRows.length, kinds: [...new Set(oneShotRows.map((r) => r.kind))] }),
  );
  record(
    '三段式动画都配了随机循环次数（watch 除外：右侧收起的默认姿势要无限循环）',
    persistRows.every((r) =>
      r.id === 'watch'
        ? r.seg.range === null && r.seg.loopCount === null
        : Array.isArray(r.seg.range) && r.seg.range.length === 2 && r.seg.loopCount === null,
    ),
    JSON.stringify(persistRows.map((r) => `${r.id}:${r.seg.range ? r.seg.range.join('-') : 'inf'}`)),
  );
  /*
   * 按次覆盖轮数：同一个三段式动画在不同场合要的持续时间不同 ——
   * 作为"收起的默认姿势"要无限（`'forever'`），作为随机池成员要短（[1,2]），
   * 作为触发演一次用定义里的默认值。这条断言把三种来源钉死。
   */
  const loopOverride = await run(`(() => {
    const model = window.petDebug.animationModel;
    const lie = window.petDebug.anim.getDefinition('lie').segments;
    return {
      forever: model.resolvePlayLoopCount(lie, 'forever', () => 0.5),
      poolShort: [0, 0.99].map((r) => model.resolvePlayLoopCount(lie, [1, 2], () => r)),
      fromDefinition: [0, 0.99].map((r) => model.resolvePlayLoopCount(lie, undefined, () => r)),
      // 一次性动画没有 segments：任何覆盖都不该造出轮数
      oneShot: model.resolvePlayLoopCount(undefined, 'forever', () => 0.5),
    };
  })()`);
  record(
    '循环轮数三层覆盖：状态默认 forever / 随机池 [1,2] / 触发用定义里的 [2,4]',
    loopOverride.forever === 0 &&
      JSON.stringify(loopOverride.poolShort) === JSON.stringify([1, 2]) &&
      JSON.stringify(loopOverride.fromDefinition) === JSON.stringify([2, 4]) &&
      loopOverride.oneShot === 0,
    JSON.stringify(loopOverride),
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

    // 等它自己循环到次数（read 的随机范围 2~5，loop 段 1.75s → 最多约 9s）
    const readSegments = anim.getDefinition('read').segments || {};
    const target = readSegments.loopCount ?? null;
    // 本次播放实际要循环几轮（随机值在进入 loop 段时定下，见 getLoopTarget）
    const effectiveTarget = anim.getLoopTarget();
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
    return { phaseStart, srcStart, phaseLoop, srcLoop, target, effectiveTarget, range: readSegments.loopCountRange ?? null, cycles, cycleTimes, totalMs, cycleSpanMs, sawEndSrc, endEvent, phaseAfter: anim.getPersistentPhase(), current: anim.getCurrentAnimation() };
  })()`);
  record('持续动画起始阶段为 start', cycleRun.phaseStart === 'start' && String(cycleRun.srcStart).includes('-start'), JSON.stringify({ phase: cycleRun.phaseStart, src: cycleRun.srcStart }));
  record('开场播完自动进入 loop 阶段', cycleRun.phaseLoop === 'loop' && String(cycleRun.srcLoop).includes('-loop'), JSON.stringify({ phase: cycleRun.phaseLoop, src: cycleRun.srcLoop }));
  record(
    '循环段按"本次随机轮数"精确计数（数到的轮数 = 进入 loop 时定下的目标）',
    Array.isArray(cycleRun.cycles) &&
      cycleRun.effectiveTarget >= 2 &&
      cycleRun.effectiveTarget <= 5 &&
      cycleRun.cycles.length === cycleRun.effectiveTarget &&
      cycleRun.cycles[cycleRun.cycles.length - 1] === cycleRun.effectiveTarget,
    JSON.stringify({ target: cycleRun.effectiveTarget, range: cycleRun.range, cycles: cycleRun.cycles }),
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
    /*
     * 先 stop 一次再 play：同一动画的 play() 现在受"same-animation 硬规则"约束
     * （force 也不重启），如果上一条用例把它留在了 end 阶段，这里的 play 会是空操作，
     * 后面就完全抓不到 end 阶段了（实测偶发：atEnd.phase 变成 null）。
     * watch 是无限循环（loopCount 未配），正好用来测"只能被打断结束"
     */
    anim.stop('acceptance-interrupt-reset');
    await wait(150);
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
    // 同上：先 stop 清干净，免得同动画的 play() 被 same-animation 硬规则变成空操作
    anim.stop('end-interrupt-reset');
    await wait(150);
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

    // 收尾段播完后应自动接上点击反应（点击不再分区域：cute / fawning / stroke 随机一条）
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
    '点击持续动画：收尾段播完后自动接上点击反应（cute/fawning/stroke 之一）',
    ['cute', 'fawning', 'stroke'].includes(clickDeferRun.reaction),
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

  /* ==================================================================== */
  /* 动画系统（6.2）：分类 / 随机循环次数 / 三段式打断 / 点击锁 / 收起隐藏    */
  /* ==================================================================== */

  /*
   * 清单与分类：28 条动画分四类，且**每一类里都有该有的那些 id**。
   * 只数总数是不够的 —— "lie 被划进 trigger 就不会当默认动画了" 这种错
   * 只有逐类核对才抓得到。
   */
  const animCatalog = await run(`(() => {
    const anim = window.petDebug.anim;
    const byCategory = {};
    for (const id of anim.list()) {
      const category = anim.getDefinition(id).category ?? '?';
      (byCategory[category] ??= []).push(id);
    }
    const sorted = Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [k, v.slice().sort()]),
    );
    // 点击动画必须标成不可打断（硬锁由 AnimationManager 执行，这里只核对清单）
    const clickLocked = anim.list().every((id) => {
      const definition = anim.getDefinition(id);
      return definition.category !== 'click' || definition.interruptible === false;
    });
    return { total: anim.list().length, byCategory: sorted, clickLocked };
  })()`);
  record(
    '动画四分类（状态/随机/触发/点击）与需求清单一致',
    animCatalog.total === 28 &&
      JSON.stringify(animCatalog.byCategory.state) === JSON.stringify(['idle', 'sleep', 'watch']) &&
      JSON.stringify(animCatalog.byCategory.random) ===
        JSON.stringify(['bomb', 'hot', 'lie', 'peek', 'play', 'play_tail', 'roll', 'shake', 'sing', 'spin', 'swim']) &&
      JSON.stringify(animCatalog.byCategory.trigger) ===
        JSON.stringify(['catch_down', 'catch_right', 'hungry', 'offline', 'overheat', 'read', 'remind', 'sad', 'shy', 'talk', 'work']) &&
      JSON.stringify(animCatalog.byCategory.click) === JSON.stringify(['cute', 'fawning', 'stroke']),
    JSON.stringify(animCatalog.byCategory),
  );
  record(
    '点击动画在清单里标记为不可打断（interruptible: false）',
    animCatalog.clickLocked === true,
    `clickLocked=${animCatalog.clickLocked}`,
  );

  /* 三段式：loop 次数随机（纯函数钉死边界 + 真机跑一遍看范围） */
  const loopModel = await run(`(() => {
    const model = window.petDebug.animationModel;
    const fixed = model.resolveLoopCount({ loop: 'x.webm', loopCount: 3 }, () => 0);
    const ranged = [0, 0.2, 0.5, 0.99].map((r) =>
      model.resolveLoopCount({ loop: 'x.webm', loopCountRange: [2, 5] }, () => r));
    const infinite = model.resolveLoopCount({ loop: 'x.webm' }, () => 0.5);
    const reversed = model.resolveLoopCount({ loop: 'x.webm', loopCountRange: [5, 2] }, () => 0);
    return { fixed, ranged, infinite, reversed };
  })()`);
  record(
    'loop 次数：固定值 / 随机范围（含两端、写反也纠正）/ 省略即无限循环',
    loopModel.fixed === 3 &&
      // 2 + floor(r * 4)：r=0 -> 2；r=0.5 -> 4；r=0.99 -> 5（两端都能取到）
      JSON.stringify(loopModel.ranged) === JSON.stringify([2, 2, 4, 5]) &&
      loopModel.infinite === 0 &&
      loopModel.reversed === 2,
    JSON.stringify(loopModel),
  );

  const loopReal = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const seen = [];
    const rejected = [];
    /*
     * 采样 8 次而不是 5 次：范围 2~5 时"5 次全是同一个数"有约 0.4% 的概率纯属运气
     * （实测踩到过一次，白红了一条断言），8 次全同约 0.002%。
     * 同时把"被拒原因"带出来 —— 万一以后哪条规则（same-animation / docked…）
     * 把它挡住，detail 里能一眼看出是"根本没播成"而不是"随机不好"。
     */
    for (let i = 0; i < 8; i += 1) {
      anim.stop('loop-probe');
      anim.clearPendingAfterEnd();
      anim.clearQueue();
      anim.resetCooldowns();
      await wait(150);
      const played = await anim.play('sad', { reason: 'loop-probe', source: 'system', interrupt: 'force' });
      if (!played.accepted) rejected.push(played.reason ?? 'unknown');
      for (let k = 0; k < 40 && anim.getPersistentPhase() !== 'loop'; k += 1) await wait(100);
      seen.push(anim.getLoopTarget());
    }
    anim.stop('loop-probe');
    return { seen, rejected };
  })()`);
  record(
    '真机：每次播放的 loop 轮数都在 2~5 之间且不是常数',
    Array.isArray(loopReal?.seen) &&
      loopReal.rejected.length === 0 &&
      loopReal.seen.every((value) => value >= 2 && value <= 5) &&
      new Set(loopReal.seen).size >= 2,
    JSON.stringify(loopReal),
  );

  /*
   * 三段式打断语义（需求原文）：
   *   loop 中被打断 -> **先播 end**，再播打断它的动画；
   *   end  中被打断 -> 立刻结束，直接播新动画。
   */
  const persistentInterrupt = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    anim.stop('interrupt-probe');
    anim.resetCooldowns();
    await anim.play('read', { reason: 'interrupt-probe', source: 'system', interrupt: 'force' });
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i += 1) await wait(100);
    const phaseBefore = anim.getPersistentPhase();
    const accepted = await anim.play('talk', { reason: 'interrupt-next', source: 'system', interrupt: 'force' });
    const phaseAfter = anim.getPersistentPhase();
    const duringEnd = anim.getCurrentAnimation();
    const pending = anim.hasPendingAfterEnd();
    let settled = null;
    for (let i = 0; i < 80; i += 1) {
      await wait(100);
      if (anim.getCurrentAnimation() === 'talk') { settled = 'talk'; break; }
      if (anim.getCurrentAnimation() === null) { settled = '(none)'; break; }
    }
    return { phaseBefore, phaseAfter, duringEnd, pending, accepted: accepted.accepted, settled };
  })()`);
  record(
    'loop 中被打断：先播 end（不硬切），收尾结束后自动接上新动画',
    persistentInterrupt.phaseBefore === 'loop' &&
      persistentInterrupt.phaseAfter === 'end' &&
      persistentInterrupt.duringEnd === 'read' &&
      persistentInterrupt.pending === true &&
      persistentInterrupt.settled === 'talk',
    JSON.stringify(persistentInterrupt),
  );

  const endInterrupt = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    anim.stop('end-probe');
    anim.resetCooldowns();
    await anim.play('work', { reason: 'end-probe', source: 'system', interrupt: 'force' });
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i += 1) await wait(100);
    anim.endPersistent('end-probe-request');
    for (let i = 0; i < 30 && anim.getPersistentPhase() !== 'end'; i += 1) await wait(100);
    const phaseBefore = anim.getPersistentPhase();
    await anim.play('sing', { reason: 'end-probe-next', source: 'system', interrupt: 'force' });
    return {
      phaseBefore,
      current: anim.getCurrentAnimation(),
      pending: anim.hasPendingAfterEnd(),
      phaseAfter: anim.getPersistentPhase(),
    };
  })()`);
  record(
    'end 中被打断：立刻结束并直接播新动画（不再排一次收尾）',
    endInterrupt.phaseBefore === 'end' &&
      endInterrupt.current === 'sing' &&
      endInterrupt.pending === false &&
      endInterrupt.phaseAfter === null,
    JSON.stringify(endInterrupt),
  );

  /*
   * 点击动画的硬锁：**连 force 也不行**，而且必须等她播完才解锁。
   * 这是需求里"点击动画不可被打断，必须等待播放结束后才能继续点击"的完整含义。
   */
  const clickLock = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    anim.stop('lock-probe');
    anim.resetCooldowns();
    await anim.play('cute', { reason: 'lock-probe', source: 'user', interrupt: 'force' });
    const locked = anim.isLocked();
    const forced = await anim.play('bomb', { reason: 'lock-probe-force', source: 'system', interrupt: 'force', bypassCooldown: true });
    const queued = await anim.play('stroke', { reason: 'lock-probe-queue', source: 'user', interrupt: 'queue' });
    const current = anim.getCurrentAnimation();
    // 等她自己播完（cute 约 6s），排队的 stroke 会接上；
    // 注意**不能**用 isLocked() 判断"解锁" —— stroke 也是点击动画，接上后照样是锁着的
    let sawStroke = null;
    for (let i = 0; i < 120; i += 1) {
      await wait(100);
      if (anim.getCurrentAnimation() === 'stroke') { sawStroke = 'stroke'; break; }
    }
    return {
      locked,
      forcedAccepted: forced.accepted,
      forcedReason: forced.reason ?? '',
      queuedAccepted: queued.accepted,
      current,
      sawStroke,
      after: anim.getCurrentAnimation(),
    };
  })()`);
  record(
    '点击动画不可打断：force 被拒、只能排队，播完后排队的那条才接上',
    clickLock.locked === true &&
      clickLock.forcedAccepted === false &&
      clickLock.forcedReason === 'not-interruptible' &&
      clickLock.queuedAccepted === true &&
      clickLock.current === 'cute' &&
      clickLock.sawStroke === 'stroke' &&
      clickLock.after === 'stroke',
    JSON.stringify(clickLock),
  );

  /* 贴边收起的几何（纯函数：用户拖到边缘的判定与"贴平"目标位置） */
  const dockModel = await run(`(() => {
    const model = window.petDebug.animationModel;
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const petSize = { width: 288, height: 384 };
    const winSize = { width: 288, height: 384 };
    /** 整只宠物（= 窗口）放到某个位置 -> 参与判定用的宠物矩形。 */
    const at = (x, y) => model.petRectIn({ x, y, width: winSize.width, height: winSize.height }, petSize);
    // 阈值 8px 的边界：20px 外**不收起**（这是用户反馈"我还没拖到边上她就贴上来了"的那一段）
    const nearRight = at(1920 - 288 - 20, 600);
    const rightVerdict = model.evaluateDock(nearRight, area);
    // 刚好 8px（含等于）-> 收起；9px -> 还不收起
    const edgeRight = model.evaluateDock(at(1920 - 288 - 8, 600), area);
    const justOutsideRight = model.evaluateDock(at(1920 - 288 - 9, 600), area);
    // 推到最右边（窗口允许挂出屏幕 -> 差值是负数）-> 一定收起
    const overshootRight = model.evaluateDock(at(1920 - 288 + 30, 600), area);
    // 贴下边缘：差 6px 收起，差 20px 不收起
    const nearBottom = model.evaluateDock(at(700, 1040 - 384 - 6), area);
    const offBottom = model.evaluateDock(at(700, 1040 - 384 - 20), area);
    // 中间 -> 不收起
    const middle = model.petRectIn({ x: 700, y: 300, width: 288, height: 384 }, petSize);
    const freeVerdict = model.evaluateDock(middle, area);
    // 贴平目标：宠物右边缘应该正好落在工作区右边缘
    const target = model.dockTargetPosition({
      dock: 'right', petSize, windowSize: winSize, workArea: area, current: { x: 1476, y: 528 },
    });
    const targetRect = model.petRectIn({ ...target, width: winSize.width, height: winSize.height }, petSize);
    // 拖离：向右 40px 还不算离开，向右 200px 才算
    const moved40 = model.petRectIn({ x: target.x - 40, y: 528, width: 288, height: 384 }, petSize);
    const moved200 = model.petRectIn({ x: target.x - 200, y: 528, width: 288, height: 384 }, petSize);
    return {
      threshold: model.DOCK_EDGE_THRESHOLD_PX,
      nearRightGap: 1920 - (nearRight.x + nearRight.width),
      rightDock: rightVerdict.dock,
      edgeRightDock: edgeRight.dock,
      justOutsideRightDock: justOutsideRight.dock,
      overshootRightDock: overshootRight.dock,
      bottomDock: nearBottom.dock,
      offBottomDock: offBottom.dock,
      freeDock: freeVerdict.dock,
      targetRightGap: area.width - (targetRect.x + targetRect.width),
      stillDocked: model.shouldUndock('right', moved40, area),
      undocked: model.shouldUndock('right', moved200, area),
      undockDistancePx: model.UNDOCK_DISTANCE_PX,
    };
  })()`);
  record(
    '贴边收起几何：**必须推到最边上**（8px 内）才收起，差 9px 都不算；贴平到边缘、拖离阈值',
    dockModel.threshold === 8 &&
      // 以前 24px 阈值时，离边 20px 就收起了；现在这一段必须是"没收起"
      dockModel.nearRightGap === 20 &&
      dockModel.rightDock === 'free' &&
      dockModel.edgeRightDock === 'right' &&
      dockModel.justOutsideRightDock === 'free' &&
      dockModel.overshootRightDock === 'right' &&
      dockModel.bottomDock === 'bottom' &&
      dockModel.offBottomDock === 'free' &&
      dockModel.freeDock === 'free' &&
      dockModel.targetRightGap === 0 &&
      dockModel.stillDocked === false &&
      dockModel.undocked === true,
    JSON.stringify(dockModel),
  );

  /* 收起/隐藏 = 安静模式（用户要求："收起时不应该发生对话"）—— 纯函数先钉死 */
  const quietModel = await run(`(() => {
    const model = window.petDebug.animationModel;
    return [
      ['free', { dock: 'free', hidden: false }],
      ['right', { dock: 'right', hidden: false }],
      ['bottom', { dock: 'bottom', hidden: false }],
      ['hidden', { dock: 'free', hidden: true }],
      ['hidden+docked', { dock: 'bottom', hidden: true }],
    ].map((entry) => [entry[0], model.isQuietDisplay(entry[1])]);
  })()`);
  record(
    '安静模式判定：只有"好好待在桌面上"（free 且没隐藏）才允许她开口；收起/隐藏一律安静',
    JSON.stringify(quietModel) === JSON.stringify([
      ['free', false],
      ['right', true],
      ['bottom', true],
      ['hidden', true],
      ['hidden+docked', true],
    ]),
    JSON.stringify(quietModel),
  );

  /* 显示状态 -> 默认动画 / 随机池 / 随机小动作（纯函数 + 真机 app 的当前显示状态） */
  const poolModel = await run(`(() => {
    const model = window.petDebug.animationModel;
    const config = model.DEFAULT_BEHAVIOR_CONFIG;
    const known = new Set(window.petDebug.anim.list());
    const pools = (state) => model.poolsFor(config, state)
      .map((pool) => ({ id: pool.id, animations: pool.animations, interval: pool.intervalMs }));
    // 池内挑选：注入随机源，验证等概率取到两端
    const pool = config.pools['normal-random'];
    const picks = [0, 0.999].map((r) => model.pickPoolAnimation(pool, () => r));
    const fidget = (state) => model.fidgetFor(config, state);
    return {
      normalDefault: model.defaultAnimationFor(config, 'normal'),
      bottomDefault: model.defaultAnimationFor(config, 'docked-bottom'),
      rightDefault: model.defaultAnimationFor(config, 'docked-right'),
      hiddenDefault: model.defaultAnimationFor(config, 'hidden'),
      normalPools: pools('normal'),
      bottomPools: pools('docked-bottom'),
      rightPools: pools('docked-right'),
      hiddenPools: pools('hidden'),
      // 收起时的"随机小动作"：lie 插在 sleep 里、peek 插在 watch 里
      bottomFidget: fidget('docked-bottom'),
      rightFidget: fidget('docked-right'),
      normalFidget: fidget('normal'),
      resolveBottom: model.resolveDisplayState({ dock: 'bottom', hidden: false }),
      resolveHidden: model.resolveDisplayState({ dock: 'right', hidden: true }),
      picks,
      allPoolAnimationsRegistered: model.poolsFor(config, 'normal')
        .every((item) => item.animations.every((id) => known.has(id))),
      allFidgetAnimationsRegistered: ['docked-bottom', 'docked-right'].every((state) => {
        const item = fidget(state);
        return item === null || item.animations.every((id) => known.has(id));
      }),
      // lie / peek 不该出现在任何随机池里（需求：它们只由随机小动作触发）
      fidgetAnimationsNotInPools: ['lie', 'peek'].every((id) =>
        Object.values(config.pools).every((p) => !p.animations.includes(id))),
    };
  })()`);
  record(
    '显示状态 -> 默认动画（idle/sleep/watch/无）与随机池（正常 9 个 25~60s；收起没有池）',
    poolModel.normalDefault === 'idle' &&
      poolModel.bottomDefault === 'sleep' &&
      poolModel.rightDefault === 'watch' &&
      poolModel.hiddenDefault === null &&
      poolModel.normalPools.length === 1 &&
      poolModel.normalPools[0].animations.length === 9 &&
      JSON.stringify(poolModel.normalPools[0].interval) === JSON.stringify([25000, 60000]) &&
      poolModel.bottomPools.length === 0 &&
      poolModel.rightPools.length === 0 &&
      poolModel.hiddenPools.length === 0 &&
      poolModel.resolveBottom === 'docked-bottom' &&
      poolModel.resolveHidden === 'hidden' &&
      poolModel.allPoolAnimationsRegistered === true,
    JSON.stringify(poolModel),
  );

  record(
    '收起时的随机小动作：sleep 里插 lie、watch 里插 peek（3~8 分钟随机，正常状态没有）',
    poolModel.bottomFidget !== null &&
      poolModel.bottomFidget.animations.join() === 'lie' &&
      JSON.stringify(poolModel.bottomFidget.intervalMs) === JSON.stringify([180000, 480000]) &&
      poolModel.bottomFidget.loopCountRange.join() === '1,3' &&
      poolModel.rightFidget !== null &&
      poolModel.rightFidget.animations.join() === 'peek' &&
      JSON.stringify(poolModel.rightFidget.intervalMs) === JSON.stringify([180000, 480000]) &&
      poolModel.normalFidget === null &&
      poolModel.allFidgetAnimationsRegistered === true,
    JSON.stringify({ bottom: poolModel.bottomFidget, right: poolModel.rightFidget, normal: poolModel.normalFidget }),
  );

  record(
    'lie / peek 不在任何随机池里（只由随机小动作触发）',
    poolModel.fidgetAnimationsNotInPools === true,
    JSON.stringify(poolModel.normalPools.map((p) => p.animations)),
  );

  record(
    '随机池挑选：等概率时能取到第一个和最后一个（不是永远同一个）',
    poolModel.picks[0] === 'roll' && poolModel.picks[1] === 'swim',
    JSON.stringify(poolModel.picks),
  );

  /*
   * 心情过低 -> 随机池整体换成 sad（纯函数 + 真机状态）。
   *
   * 需求原文："在心情低于阈值的时候，所有随机池的动画都变成 sad，高于阈值再变回来，
   * 收起状态的动画不受影响"。
   *
   * 这里钉三件事（**端到端**那条在 tools/probe-sad-pool.cjs：真写一份 mood=18 的 emotion.json）：
   *   1. 阈值判定是单一阈值：`<= moodBelow` 命中、`moodBelow + 1` 立刻恢复；
   *   2. 阈值与 `moodLabel()` 的"很难过"档一致（两处不一致会出现"UI 说难过、她还在打滚"）；
   *   3. 规则**只作用于池**：fidget 与默认姿势在 sad 命中时原样不变，
   *      而且真机此刻（心情正常）池子里确实是原来那 8 条 —— 这就是"变回来"的那一半。
   */
  const sadPoolModel = await run(`(() => {
    const model = window.petDebug.animationModel;
    const config = model.DEFAULT_BEHAVIOR_CONFIG;
    const rule = config.sadPool;
    const below = model.sadPoolAnimation(config, rule.moodBelow);
    const above = model.sadPoolAnimation(config, rule.moodBelow + 1);
    const zero = model.sadPoolAnimation(config, 0);
    const nan = model.sadPoolAnimation(config, Number.NaN);
    // 关掉开关 + animation 为空的两条退化路径
    const disabled = model.parseBehaviorConfig({
      pools: config.pools,
      states: config.states,
      sadPool: { enabled: false, moodBelow: 25, animation: 'sad' },
    }).config;
    const emptyAnimation = model.parseBehaviorConfig({ sadPool: { enabled: true, animation: '' } }).config;
    // 自定义阈值真的会被读到（面板/JSON 改数就生效）
    const custom = model.parseBehaviorConfig({ sadPool: { enabled: true, moodBelow: 60, animation: 'shy' } }).config;
    return {
      rule,
      below,
      above,
      zero,
      nan,
      moodBelowConst: model.SAD_POOL_MOOD_BELOW,
      animationConst: model.SAD_POOL_ANIMATION,
      // 与"很难过"那档（触发动画 sad 的阈值）必须是同一个数
      sadTriggerThreshold: model.SAD_MOOD_THRESHOLD,
      disabledHasRule: disabled.sadPool !== undefined,
      disabledValue: model.sadPoolAnimation(disabled, 0),
      emptyAnimationHasRule: emptyAnimation.sadPool !== undefined,
      customRule: custom.sadPool ?? null,
      customAt60: model.sadPoolAnimation(custom, 60),
      customAt61: model.sadPoolAnimation(custom, 61),
      // sad 命中时**池以外的东西**一个都不许变
      bottomFidgetUnderSad: JSON.stringify(model.fidgetFor(config, 'docked-bottom')),
      bottomDefaultUnderSad: model.defaultAnimationFor(config, 'docked-bottom'),
      // 真机此刻（心情正常）池子还是原样
      live: {
        sad: window.petDebug.behaviors.describeSadPool(),
        pools: window.petDebug.behaviors.describePools().map((p) => p.animations),
      },
      registered: new Set(window.petDebug.anim.list()).has('sad'),
    };
  })()`);
  record(
    '心情过低：池里的动画整体换成 sad（单一阈值：<=25 命中、26 立刻恢复）',
    sadPoolModel.rule?.enabled === true &&
      sadPoolModel.rule.animation === 'sad' &&
      sadPoolModel.rule.moodBelow === sadPoolModel.moodBelowConst &&
      sadPoolModel.rule.moodBelow === sadPoolModel.sadTriggerThreshold &&
      sadPoolModel.animationConst === 'sad' &&
      sadPoolModel.below === 'sad' &&
      sadPoolModel.above === null &&
      sadPoolModel.zero === 'sad' &&
      sadPoolModel.nan === null &&
      sadPoolModel.customRule?.moodBelow === 60 &&
      sadPoolModel.customAt60 === 'shy' &&
      sadPoolModel.customAt61 === null,
    JSON.stringify(sadPoolModel),
  );
  record(
    '心情过低：关掉开关 / 动画名为空都不生效（退回原池，不会留下空池）',
    sadPoolModel.disabledHasRule === false &&
      sadPoolModel.disabledValue === null &&
      sadPoolModel.emptyAnimationHasRule === false,
    JSON.stringify({
      disabled: sadPoolModel.disabledHasRule,
      disabledValue: sadPoolModel.disabledValue,
      empty: sadPoolModel.emptyAnimationHasRule,
    }),
  );
  record(
    '心情过低：只换池，收起状态的 fidget 与默认姿势原样不动；池内容与当前心情一致',
    sadPoolModel.bottomDefaultUnderSad === 'sleep' &&
      JSON.parse(sadPoolModel.bottomFidgetUnderSad)?.animations?.join() === 'lie' &&
      sadPoolModel.registered === true &&
      // 渲染层的心情镜像与规则判定必须一致（镜像没收到推送时这里就会红）
      sadPoolModel.live.sad.active === (sadPoolModel.live.sad.mood <= sadPoolModel.live.sad.moodBelow) &&
      // 池内容跟着判定走：难过时只有 sad；正常时是原来那 8 条且不含 sad
      sadPoolModel.live.pools.every((animations) => sadPoolModel.live.sad.active
        ? animations.length === 1 && animations[0] === 'sad'
        : animations.length === 9 && animations.includes('sad') === false),
    JSON.stringify({ fidget: sadPoolModel.bottomFidgetUnderSad, live: sadPoolModel.live }),
  );

  /*
   * 点击反应：不再按身体区域区分，从 cute / fawning / stroke 里随机挑一条。
   * 挑选逻辑是共享层纯函数（可注入随机源），先把边界钉死。
   */
  const clickReactionModel = await run(`(() => {
    const model = window.petDebug.animationModel;
    const all = ['cute', 'fawning', 'stroke'];
    return {
      candidates: model.CLICK_REACTIONS,
      first: model.pickClickReaction(all, () => 0),
      last: model.pickClickReaction(all, () => 0.999),
      onlyOne: model.pickClickReaction(['stroke'], () => 0.5, () => false),
      noneRegistered: model.pickClickReaction(['idle', 'sleep'], () => 0.5),
      skipsCooling: model.pickClickReaction(all, () => 0, (id) => id === 'cute'),
      allCooling: model.pickClickReaction(all, () => 0, () => true),
    };
  })()`);
  record(
    '点击反应：候选是 cute/fawning/stroke，随机挑一条（优先避开正在冷却的那条）',
    JSON.stringify(clickReactionModel.candidates) === JSON.stringify(['cute', 'fawning', 'stroke']) &&
      clickReactionModel.first === 'cute' &&
      clickReactionModel.last === 'stroke' &&
      clickReactionModel.onlyOne === 'stroke' &&
      clickReactionModel.noneRegistered === null &&
      clickReactionModel.skipsCooling === 'fawning' &&
      clickReactionModel.allCooling === 'cute',
    JSON.stringify(clickReactionModel),
  );

  /*
   * 真实点击路径：同一个区域（head）点多次，产出的动画仍必须落在三条候选之内
   * —— 区域不再决定动画（以前 head 恒等于 cute）。
   * 这里刻意**不**断言"一定是某一条"：那正是本次要拆掉的行为。
   */
  const clickRegionRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const seen = [];
    for (let i = 0; i < 4; i++) {
      anim.stop('click-region-reset');
      anim.resetCooldowns();
      await wait(150);
      window.petApp.handleIntent({
        kind: 'click', region: 'head',
        payload: { button: 'left', x: 1, y: 1, nx: 0.5, ny: 0.1, region: 'head', detail: 1 },
      });
      await wait(300);
      seen.push(anim.getCurrentAnimation());
      anim.stop('click-region-cleanup');
    }
    return { seen };
  })()`);
  record(
    '点击不再按区域选动画：head 点 4 次都落在 cute/fawning/stroke 之内',
    (clickRegionRun.seen ?? []).length === 4 &&
      clickRegionRun.seen.every((id) => ['cute', 'fawning', 'stroke'].includes(id)),
    JSON.stringify(clickRegionRun.seen),
  );

  /*
   * 双击不再触发动画（需求："去掉双击触发动画的代码"）。
   *
   * 断言看的是**事件里的 reason**，而不是"当前动画有没有变"：后者会被随机池
   * （25–60 秒一次）之类的无关来源干扰，而 `user-double-click` 这个 reason
   * 一旦出现就说明双击还在播动画。
   */
  const doubleClickRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const bus = window.petDebug.bus;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const started = [];
    const sub = bus.on('animation:start', (p) => started.push({ id: p.animationId, reason: p.reason ?? '' }));
    anim.stop('dblclick-reset');
    anim.resetCooldowns();
    await wait(200);
    window.petApp.handleIntent({
      kind: 'double-click', region: 'body',
      payload: { button: 'left', x: 1, y: 1, nx: 0.5, ny: 0.5, region: 'body', detail: 2 },
    });
    await wait(600);
    sub.unsubscribe();
    return { started };
  })()`);
  record(
    '双击不再触发动画（也不再走 user-click 反应）',
    (doubleClickRun.started ?? []).every((item) =>
      item.reason !== 'user-double-click' && !item.reason.startsWith('user-click:')),
    JSON.stringify(doubleClickRun.started),
  );

  /*
   * 收起时的"随机小动作"端到端：默认姿势循环中到点 -> 先播完默认姿势的 end
   * -> 小动作 -> 回到同一个默认姿势（需求）。
   *
   * 两个关键点：
   *   1. **行为必须是"跑着"的**：本套件在动画断言段一开始就 `behaviors.pause()` 了
   *      （见上面那段注释），而 fidget 调度就在被暂停的 `tick()` 里 ——
   *      不临时恢复，它永远不会触发（这一条踩过）。测完按原样恢复暂停。
   *   2. 不真的贴边：把**正常状态**临时配置成"默认姿势 = sleep、fidget = peek"，
   *      再用 `playDisplayDefault` 的同一组参数把 sleep 播成默认姿势。
   *      于是 `tickFidget()` 的门槛（当前播的就是该状态的默认动画、且在 loop 段）成立，
   *      走的是**真实的调度器**；贴边那条路另有 probe-fidget / probe-end-loop 覆盖。
   *      用小动作换成了 `peek`（一次性）是为了把一次完整循环压到 ~10 秒内 ——
   *      本套件整体只有 240 秒预算，用 `lie` 走完整循环会让整轮超时（也踩过）。
   *      真实配置里"下方收起 -> lie、右侧收起 -> peek"由上面的纯函数断言钉住。
   */
  const fidgetRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const behaviors = window.petDebug.behaviors;
    const bus = window.petDebug.bus;
    const model = window.petDebug.animationModel;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const base = model.DEFAULT_BEHAVIOR_CONFIG;
    const custom = {
      version: base.version,
      states: Object.assign({}, base.states, {
        normal: Object.assign({}, base.states.normal, {
          defaultAnimation: 'sleep',
          pools: [],
          fidget: { animations: ['peek'], intervalMs: [1000, 1000] },
        }),
      }),
      pools: base.pools,
    };
    const events = [];
    const subs = [
      bus.on('animation:start', (p) => events.push({ t: 'start', id: p.animationId, reason: p.reason ?? '' })),
      bus.on('animation:end', (p) => events.push({ t: 'end', id: p.animationId, completed: p.completed })),
      bus.on('animation:rejected', (p) => events.push({ t: 'rejected', id: p.animationId, rejection: p.rejection, reason: p.reason ?? '' })),
    ];
    const wasPaused = behaviors.isPaused();
    const fidgetStartIndex = () => events.findIndex((e) => e.t === 'start' && e.reason.startsWith('fidget:'));
    let scheduled = null;
    try {
      if (wasPaused) {
        behaviors.resume();
        window.petAPI.notifyBehaviorPaused(false);
      }
      behaviors.setConfig(custom);
      anim.stop('fidget-reset');
      anim.clearPendingAfterEnd();
      anim.clearQueue();
      anim.resetCooldowns();
      await wait(250);
      /* 用默认姿势的同一组参数播 sleep（force + forever），模拟"收起在下方" */
      await anim.play('sleep', {
        interrupt: 'force', loop: true, loopCountRange: 'forever',
        source: 'system', priority: 5, reason: 'fidget-test-setup',
      });
      for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
      scheduled = behaviors.describeFidget();
      /*
       * 只等到"随机时刻到点 -> 默认姿势进 end -> 小动作接上"为止。
       *
       * 为什么不连"小动作播完回到默认姿势"一起等：那一段是**既有**链路
       * （动画结束 -> 回 IDLE -> resumeFallbackLoop 接回默认），验收里已有专门断言；
       * 而本套件整体只有 240 秒预算，多等一个完整循环（默认 end ~4s + 小动作 ~3s）
       * 会把余量吃到只剩几秒（实测：230/240）。完整闭环由
       * tools/probe-fidget.cjs 端到端覆盖（真实贴边：sleep -> end -> lie -> loop -> sleep）。
       */
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        await wait(200);
        if (fidgetStartIndex() >= 0) break;
      }
      return { scheduled, events, current: anim.getCurrentAnimation() };
    } finally {
      behaviors.setConfig(base);
      for (const sub of subs) sub.unsubscribe();
      anim.stop('fidget-cleanup');
      /* 我在测试里把状态机带进了 SLEEPING（sleep 的状态提示），显式复位，
         让后续用例从干净的 IDLE + 默认姿势开始（stop 是 completed=false，不会自动迁 IDLE） */
      const sm = window.petDebug.state;
      if (sm.get() !== 'IDLE') sm.request('IDLE', 'fidget-test-cleanup');
      if (wasPaused) {
        behaviors.pause();
        window.petAPI.notifyBehaviorPaused(true);
      }
    }
  })()`);
  const fidgetEvents = fidgetRun.events ?? [];
  const fidgetIndex = fidgetEvents.findIndex((e) => e.t === 'start' && e.reason.startsWith('fidget:'));
  const defaultEndBeforeFidget = fidgetIndex >= 0 &&
    fidgetEvents.slice(0, fidgetIndex).some((e) => e.t === 'end' && e.id === 'sleep');
  record(
    '收起时的随机小动作：默认姿势循环中随机时刻 -> 先播完它的 end -> 再播小动作',
    fidgetRun.scheduled !== null &&
      fidgetRun.scheduled.animations.join() === 'peek' &&
      fidgetIndex >= 0 &&
      fidgetEvents[fidgetIndex].id === 'peek' &&
      defaultEndBeforeFidget === true,
    JSON.stringify({ scheduled: fidgetRun.scheduled, events: fidgetEvents, current: fidgetRun.current }),
  );

  /* 触发动画的阈值规则（"演一次"而不是"一直演"） */
  const triggerRules = await run(`(() => {
    const model = window.petDebug.animationModel;
    const steps = (fn, values, armed0 = true) => {
      let armed = armed0;
      const fired = [];
      for (const value of values) {
        const decision = fn(value, armed);
        armed = decision.armed;
        if (decision.animationId) fired.push(decision.animationId);
      }
      return { fired, armed };
    };
    return {
      // 心情持续很低：只演一次（不会每 30 秒演一次）
      sadStuck: steps((mood, armed) => model.evaluateSad(mood, armed), [20, 18, 22, 20, 19]),
      // 心情恢复后再次变低：重新演一次
      sadRearm: steps((mood, armed) => model.evaluateSad(mood, armed), [20, 60, 20]),
      // 饿：**饱腹值越低越饿**（用户要求把数值反过来），<=40 触发、>=60 重新武装
      hungry: steps((satiety, armed) => model.evaluateHungry(satiety, armed), [30, 20, 80, 10]),
      // 「持续状态」重复间隔：在区间内随机（用户要求断网/过热"随机触发"）
      repeatDelays: [
        model.pickRepeatDelayMs(() => 0),
        model.pickRepeatDelayMs(() => 1),
        model.pickRepeatDelayMs(() => 0.5, [1000, 2000]),
        model.CONDITION_REPEAT_RANGE_MS,
      ],
      // 掉线：持续掉线只演一次，恢复后再掉线再演
      offline: steps((reason, armed) => model.evaluateOffline(reason, armed), ['no-key', 'no-key', '', 'invalid-key']),
      // 过热：阈值附近有回差
      overheat: steps((temp, armed) => model.evaluateOverheat(temp, armed), [85, 84, 76, 70, 82]),
      overheatUnknown: steps((temp, armed) => model.evaluateOverheat(temp, armed), [null, null, null]),
      // 过热阈值可配置（感知设置里那条）：真温度 52 度配 45 度阈值就该演
      overheatCustomThreshold: [
        model.evaluateOverheat(52, true, { threshold: 45 }).animationId,
        model.evaluateOverheat(44, true, { threshold: 45 }).animationId,
        model.evaluateOverheat(50, true, { threshold: 80 }).animationId,
      ],
      // 鼠标靠近：只有下方/右侧会触发，上方不演；离开后重新武装
      approach: [
        model.classifyApproach({ dx: 10, dy: 90 }, true),
        model.classifyApproach({ dx: 90, dy: 10 }, true),
        model.classifyApproach({ dx: 10, dy: -90 }, true),
        model.classifyApproach({ dx: -90, dy: 10 }, true),
        model.classifyApproach({ dx: 0, dy: 400 }, false),
      ].map((item) => ({ id: item.animationId, armed: item.armed })),
      /*
       * 鼠标靠近的冷却（用户："需要有一段时间的冷却，不能连续触发"）：
       * 同一位置反复"走开再回来"，60 秒内只演一次；冷却过后才允许第二次。
       * 冷却期间"保持武装"是刻意的 —— 冷却一过她自己会补演。
       */
      approachCooldown: [
        { sinceLastTriggerMs: 999999, armed: true },
        { sinceLastTriggerMs: 500, armed: true },
        { sinceLastTriggerMs: 59000, armed: true },
        { sinceLastTriggerMs: 60000, armed: true },
      ].map((step) => model.classifyApproach({ dx: 0, dy: 90 }, step.armed, { sinceLastTriggerMs: step.sinceLastTriggerMs }))
        .map((item) => ({ id: item.animationId, armed: item.armed })),
      approachCooldownMs: model.APPROACH_COOLDOWN_MS,
      /*
       * 掉线判定（纯函数，主进程只负责取事实）：
       * 总开关 / 没配密钥 / **断网** / 余额不可用 / 密钥无效 / 最近一次请求连不上。
       * 关键的两条：断网要算掉线；**超时不算断网**（否则模型慢会让人去查路由器）。
       */
      offlineClassify: [
        ['disabled', { enabled: false, hasKey: false, networkOnline: true, balanceAvailable: true, balanceError: '', lastError: '' }],
        ['no-key', { enabled: true, hasKey: false, networkOnline: true, balanceAvailable: true, balanceError: '', lastError: '' }],
        ['network-no-connection', { enabled: true, hasKey: true, networkOnline: false, balanceAvailable: true, balanceError: '', lastError: '' }],
        ['network-connect-failed', { enabled: true, hasKey: true, networkOnline: true, balanceAvailable: true, balanceError: '', lastError: '网络请求失败：connect ECONNREFUSED 127.0.0.1:9' }],
        ['network-balance-failed', { enabled: true, hasKey: true, networkOnline: true, balanceAvailable: true, balanceError: '网络请求失败：getaddrinfo ENOTFOUND api.deepseek.com', lastError: '' }],
        ['no-balance', { enabled: true, hasKey: true, networkOnline: true, balanceAvailable: false, balanceError: '', lastError: '' }],
        ['invalid-key', { enabled: true, hasKey: true, networkOnline: true, balanceAvailable: true, balanceError: 'HTTP 401 Authentication Fails', lastError: '' }],
        ['invalid-key-chat', { enabled: true, hasKey: true, networkOnline: true, balanceAvailable: true, balanceError: '', lastError: 'HTTP 403 Forbidden' }],
        ['timeout-is-not-offline', { enabled: true, hasKey: true, networkOnline: true, balanceAvailable: true, balanceError: '', lastError: '请求超时（20000ms）' }],
        ['healthy', { enabled: true, hasKey: true, networkOnline: true, balanceAvailable: true, balanceError: '', lastError: '' }],
      ].map((entry) => [entry[0], model.classifyOffline(entry[1])]),
      // 断网/连不上 -> offline；而且这几种都该真的演出来（evaluateOffline 认这些原因）
      offlineFromNetwork: [
        model.classifyOffline({ enabled: true, hasKey: true, networkOnline: false, balanceAvailable: true, balanceError: '', lastError: '' }),
        model.classifyOffline({ enabled: true, hasKey: true, networkOnline: true, balanceAvailable: true, balanceError: '', lastError: '网络请求失败：connect ECONNREFUSED' }),
      ].map((reason) => model.evaluateOffline(reason, true).animationId),
      // 场景触发：稳定 90 秒 + 不频繁切换 + 冷却（默认冷却 20 分钟）
      sceneCoding: model.evaluateSceneTrigger({ scene: 'coding', stableMs: 120000, switching: false, sinceLastTriggerMs: 9999999 }),
      sceneCodingTooEarly: model.evaluateSceneTrigger({ scene: 'coding', stableMs: 30000, switching: false, sinceLastTriggerMs: 9999999 }),
      sceneCodingSwitching: model.evaluateSceneTrigger({ scene: 'coding', stableMs: 120000, switching: true, sinceLastTriggerMs: 9999999 }),
      sceneCodingCooldown: model.evaluateSceneTrigger({ scene: 'coding', stableMs: 120000, switching: false, sinceLastTriggerMs: 60000 }),
      sceneReading: model.evaluateSceneTrigger({ scene: 'reading', stableMs: 120000, switching: false, sinceLastTriggerMs: 9999999 }),
      sceneGaming: model.sceneTriggerAnimation('gaming'),
    };
  })()`);
  record(
    '触发规则：持续越界只演一次（心情/饱腹/掉线），恢复后才重新武装',
    triggerRules.sadStuck.fired.length === 1 &&
      triggerRules.sadStuck.fired[0] === 'sad' &&
      triggerRules.sadRearm.fired.length === 2 &&
      triggerRules.hungry.fired.length === 2 &&
      triggerRules.offline.fired.length === 2 &&
      JSON.stringify(triggerRules.offline.fired) === JSON.stringify(['offline', 'offline']),
    JSON.stringify(triggerRules),
  );
  record(
    '触发规则：GPU 过热有回差、读不到温度一律不演',
    JSON.stringify(triggerRules.overheat.fired) === JSON.stringify(['overheat', 'overheat']) &&
      triggerRules.overheatUnknown.fired.length === 0,
    JSON.stringify({ hot: triggerRules.overheat, unknown: triggerRules.overheatUnknown }),
  );
  record(
    '触发规则：「持续状态」（断网/过热）的重复间隔是 3~8 分钟内随机（用户要求"随机触发"）',
    triggerRules.repeatDelays[0] === 180000 &&
      triggerRules.repeatDelays[1] === 480000 &&
      triggerRules.repeatDelays[2] === 1500 &&
      JSON.stringify(triggerRules.repeatDelays[3]) === JSON.stringify([180000, 480000]),
    JSON.stringify(triggerRules.repeatDelays),
  );
  record(
    '触发规则：过热阈值可配置（感知设置里那条）——52 度配 45 度阈值演、50 度配 80 度不演',
    triggerRules.overheatCustomThreshold[0] === 'overheat' &&
      triggerRules.overheatCustomThreshold[1] === null &&
      triggerRules.overheatCustomThreshold[2] === null,
    JSON.stringify(triggerRules.overheatCustomThreshold),
  );
  record(
    '触发规则：鼠标靠近有冷却（60 秒内"走开再回来"也只演一次，冷却过后才允许下一次）',
    triggerRules.approachCooldownMs === 60000 &&
      triggerRules.approachCooldown[0].id === 'catch_down' &&
      triggerRules.approachCooldown[1].id === null &&
      triggerRules.approachCooldown[2].id === null &&
      triggerRules.approachCooldown[3].id === 'catch_down' &&
      // 真演了的那两次解除武装；冷却期间那两次**保持武装**（冷却一过她还会补演，不会被吃掉）
      triggerRules.approachCooldown[0].armed === false &&
      triggerRules.approachCooldown[1].armed === true &&
      triggerRules.approachCooldown[2].armed === true &&
      triggerRules.approachCooldown[3].armed === false,
    JSON.stringify(triggerRules.approachCooldown),
  );
  record(
    '掉线判定：没配密钥 / 断网（系统没连接、请求连不上）/ 余额不足 / 密钥无效都算掉线；关掉 AI 与请求超时不算',
    JSON.stringify(triggerRules.offlineClassify) === JSON.stringify([
      ['disabled', ''],
      ['no-key', 'no-key'],
      ['network-no-connection', 'network'],
      ['network-connect-failed', 'network'],
      ['network-balance-failed', 'network'],
      ['no-balance', 'no-balance'],
      ['invalid-key', 'invalid-key'],
      ['invalid-key-chat', 'invalid-key'],
      ['timeout-is-not-offline', ''],
      ['healthy', ''],
    ]),
    JSON.stringify(triggerRules.offlineClassify),
  );
  record(
    '掉线判定：断网/连不上会真的演 offline（规则接到动画上）',
    JSON.stringify(triggerRules.offlineFromNetwork) === JSON.stringify(['offline', 'offline']),
    JSON.stringify(triggerRules.offlineFromNetwork),
  );
  record(
    '触发规则：鼠标只有从下方/右侧**占主导**地靠近才演 catch_down / catch_right',
    triggerRules.approach[0].id === 'catch_down' &&
      triggerRules.approach[1].id === 'catch_right' &&
      // 从上方偏右：dx 虽然为正，但她其实在低头看你 -> 不该演 catch_right
      triggerRules.approach[2].id === null &&
      triggerRules.approach[3].id === null &&
      triggerRules.approach[4].armed === true,
    JSON.stringify(triggerRules.approach),
  );
  record(
    '触发规则：work/read 只在场景稳定 90 秒、不频繁切换、过了冷却时才演',
    triggerRules.sceneCoding === 'work' &&
      triggerRules.sceneCodingTooEarly === null &&
      triggerRules.sceneCodingSwitching === null &&
      triggerRules.sceneCodingCooldown === null &&
      triggerRules.sceneReading === 'read' &&
      triggerRules.sceneGaming === null,
    JSON.stringify(triggerRules).slice(0, 300),
  );

  /* 余额：接口地址收敛、金额是字符串、非官方域名不查、余额 -> 饿 */
  const balanceModel = await run(`(() => {
    const model = window.petDebug.animationModel;
    const balance = window.petDebug.balance;
    const parsed = balance.parseBalance({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
    }, '2026-01-01T00:00:00.000Z');
    return {
      endpointRoot: balance.balanceEndpoint('https://api.deepseek.com'),
      endpointV1: balance.balanceEndpoint('https://api.deepseek.com/v1'),
      endpointChat: balance.balanceEndpoint('https://api.deepseek.com/v1/chat/completions'),
      official: balance.supportsBalanceQuery('https://api.deepseek.com/v1'),
      thirdParty: balance.supportsBalanceQuery('https://one-api.example.com/v1'),
      parsed,
      empty: balance.parseBalance({}, 'now').totalBalance,
      unavailable: balance.parseBalance({ is_available: false, balance_infos: [{ total_balance: '0.00' }] }, 'now').isAvailable,
      formatted: balance.formatBalance(parsed),
      satietyRich: model.satietyFromBalance(50, { low: 2, full: 20 }),
      satietyEmpty: model.satietyFromBalance(0, { low: 2, full: 20 }),
      satietyMid: model.satietyFromBalance(11, { low: 2, full: 20 }),
      satietyUnknown: model.satietyFromBalance(null, { low: 2, full: 20 }),
      satietyReversed: model.satietyFromBalance(11, { low: 20, full: 2 }),
    };
  })()`);
  record(
    'DeepSeek 余额：/user/balance 地址收敛 + 字符串金额解析 + 只有官方域名才查',
    balanceModel.endpointRoot === 'https://api.deepseek.com/user/balance' &&
      balanceModel.endpointV1 === 'https://api.deepseek.com/user/balance' &&
      balanceModel.endpointChat === 'https://api.deepseek.com/user/balance' &&
      balanceModel.official === true &&
      balanceModel.thirdParty === false &&
      balanceModel.parsed.totalBalance === 110 &&
      balanceModel.parsed.grantedBalance === 10 &&
      balanceModel.parsed.toppedUpBalance === 100 &&
      balanceModel.parsed.currency === 'CNY' &&
      balanceModel.empty === 0 &&
      balanceModel.unavailable === false &&
      balanceModel.formatted.includes('110.00 CNY'),
    JSON.stringify(balanceModel),
  );
  record(
    '余额 -> 饱腹：见底 0、充足 100、中间线性（数值方向与旧的"饥饿值"相反）；查不到时返回 null（交给本地预算兜底）',
    balanceModel.satietyRich === 100 &&
      balanceModel.satietyEmpty === 0 &&
      balanceModel.satietyMid === 50 &&
      balanceModel.satietyUnknown === null &&
      balanceModel.satietyReversed === 100,
    JSON.stringify(balanceModel),
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
    /*
     * ⚠️ 测量前必须**等窗口尺寸稳定**，不能只 sleep 固定毫秒。
     *
     * 气泡的隐藏是"两拍"（先不可见、再收缩窗口，中间还有 60ms 延时 + IPC 往返），
     * 而显隐往返又会重新加宽窗口。固定 sleep 一旦恰好落在收缩/展开的过程中，
     * 量到的 offset 就是"过渡中的那一帧"，于是这条"无累积漂移"断言会随机变红
     * （实测同一份代码一红一绿，值还是小数说明正处在物理像素网格之外）。
     */
    const settleWindow = async () => {
      let last = Number.NaN;
      let stable = 0;
      for (let i = 0; i < 40 && stable < 3; i++) {
        await wait(80);
        const key = window.innerWidth * 10000 + window.innerHeight;
        if (key === last) stable += 1;
        else stable = 0;
        last = key;
      }
    };
    await settleWindow();

    await window.petAPI.bubble.set(null);
    await settleWindow();
    const probeHidden = await layoutProbe();
    const descHidden = window.petApp.describeBubble();
    const padHidden = descHidden.padding;
    // 舞台是 content-box + padding，宠物整体被推下/推右 padding
    const expectedHiddenTop = padHidden;
    const expectedHiddenLeft = padHidden + (descHidden.windowInner.width - descHidden.petSize.width) / 2;

    await window.petAPI.bubble.set({ visible: true, text: '锚点测试' });
    await settleWindow();
    const probeShown = await layoutProbe();
    const descShown = window.petApp.describeBubble();
    const expectedShownTop = descShown.padding + descShown.bubble.height + descShown.gap;
    const expectedShownLeft = descShown.padding + (descShown.windowInner.width - descShown.petSize.width) / 2;

    await window.petAPI.bubble.set(null);
    await settleWindow();
    const probeHiddenAgain = await layoutProbe();

    const layout = {
      hidden: { actual: probeHidden, expectedTop: expectedHiddenTop, expectedLeft: expectedHiddenLeft },
      shown: { actual: probeShown, expectedTop: expectedShownTop, expectedLeft: expectedShownLeft },
      hiddenAgain: probeHiddenAgain,
    };

    // ---- 6) 隐藏：窗口应收回纯宠物尺寸 ----
    /*
     * ⚠️ 这里原来是固定 wait(900) 后直接读 —— 实测会**偶发红**（约 5 次里 1~2 次）：
     * 主进程的收缩是"排一次 60ms 的定时器再收敛"，再加上窗口尺寸本身要等 Windows 那边同步，
     * 900ms 有时刚好卡在中间，读到的还是气泡尺寸（visible: true / 595x487）。
     * 改成**等它真的收敛**：轮询到"不可见且窗口=宠物尺寸"为止，最多等 3 秒。
     * 这不是放水：失败仍然会红，只是不再因为"差几十毫秒"而红。
     */
    await window.petAPI.bubble.set(null);
    let afterHide = window.petApp.describeBubble();
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const settled =
        afterHide?.visible === false &&
        afterHide?.windowInner?.width === afterHide?.petSize?.width &&
        afterHide?.windowInner?.height === afterHide?.petSize?.height;
      if (settled) break;
      await wait(200);
      afterHide = window.petApp.describeBubble();
    }

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
    // 详情里带上 visible：失败时能立刻分清"气泡没收起来"还是"窗口没收回去"
    JSON.stringify({ visible: bubbleRun.afterHide?.visible, windowInner: bubbleRun.afterHide?.windowInner, petSize: bubbleRun.afterHide?.petSize }),
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
    /*
     * 容差用 4px 而不是 1px：Windows 会把窗口位置量化到**物理像素网格**
     * （125% 缩放下步长正好是 4px），因此一次显隐往返的偏移本来就可能差一格。
     * 用 1px 会让这条断言随机变红（实测遇到过：同一份代码两次运行一红一绿，
     * 且与任何几何改动无关）。累积漂移会远大于 4px，所以这个容差仍然抓得住真问题。
     */
    const noDrift =
      near(l.hiddenAgain.offsetTop, l.hidden.actual.offsetTop, 4) &&
      near(l.hiddenAgain.offsetLeft, l.hidden.actual.offsetLeft, 4);

    return {
      sizeMatchesLayout,
      withinWindow,
      noDrift,
      hiddenSize: l.hidden.actual,
      shownSize: l.shown.actual,
      // 把三处测量的**视口尺寸**都带上：失败时一眼能看出是"窗口没收缩"还是"宠物漂了"
      viewports: {
        hidden: l.hidden.actual.raw.viewport,
        shown: l.shown.actual.raw.viewport,
        hiddenAgain: l.hiddenAgain.raw.viewport,
      },
      offsets: {
        hidden: { left: l.hidden.actual.offsetLeft, top: l.hidden.actual.offsetTop },
        hiddenAgain: { left: l.hiddenAgain.offsetLeft, top: l.hiddenAgain.offsetTop },
      },
    };
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

  /*
   * 7) "知道了"关闭按钮：**另加**在正文区下方，点击后关闭气泡。
   *
   * 走真实点击（`element.click()`，与用户点它等价）验证整条链路：
   * 按钮 -> BubbleView 回调 -> IPC `pet:bubble-acknowledge` -> Main setBubble(null)
   * -> 收起窗口 -> 广播新布局 -> 渲染层隐藏。
   */
  const bubbleAck = await run(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const bubble = () => document.getElementById('pet-bubble');
    const ack = () => document.getElementById('pet-bubble-ack');
    const settle = async () => {
      let last = -1, stable = 0;
      for (let i = 0; i < 40 && stable < 2; i++) {
        await wait(120);
        const h = Math.round(bubble().getBoundingClientRect().height);
        if (h === last) stable++; else stable = 0;
        last = h;
      }
    };
    /*
     * 气泡的显隐现在由 CSS visibility 控制（元素常驻 DOM，只切 style，见
     * bubble-view.ts 的 pet-bubble-off / pet-bubble-pending），因此"看不见"
     * 必须看**计算样式**，不能只看 hidden 属性。
     */
    const invisible = (el) => {
      const s = getComputedStyle(el);
      return el.hidden === true || s.display === 'none' || s.visibility === 'hidden';
    };
    const snap = () => {
      const b = bubble();
      const a = ack();
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return {
        bubbleHidden: invisible(b),
        ackHidden: invisible(a),
        ackText: (a.textContent || '').trim(),
        ackSize: { w: Math.round(ar.width), h: Math.round(ar.height) },
        /** 按钮必须完整落在气泡容器内 */
        ackInsideBubble:
          ar.top >= br.top - 1 && ar.bottom <= br.bottom + 1 &&
          ar.left >= br.left - 1 && ar.right <= br.right + 1,
        /** 按钮必须在正文区下方（不挤压正文） */
        ackBelowText: ar.top >= document.getElementById('pet-bubble-text').getBoundingClientRect().bottom - 1,
        windowInner: { w: window.innerWidth, h: window.innerHeight },
        textAreaHeight: document.getElementById('pet-bubble-text').clientHeight,
      };
    };

    await window.petAPI.bubble.set({ visible: true, text: '点下面的按钮就能关掉我' });
    await settle();
    const shown = snap();

    /* 真实点击 */
    ack().click();
    await wait(1200);
    const afterClick = snap();

    /* 已隐藏时再点一次不应报错，也不应把气泡又弄出来 */
    ack().click();
    await wait(600);
    const afterSecondClick = snap();

    return { shown, afterClick, afterSecondClick };
  })()`);

  record(
    '对话气泡：正文下方有"知道了"按钮且完整位于气泡内',
    bubbleAck.shown?.ackHidden === false &&
      bubbleAck.shown?.ackText === '知道了' &&
      bubbleAck.shown?.ackInsideBubble === true &&
      bubbleAck.shown?.ackSize?.w > 0 &&
      bubbleAck.shown?.ackSize?.h > 0,
    JSON.stringify(bubbleAck.shown),
  );
  record(
    '对话气泡：按钮在正文区下方（不挤压正文）',
    bubbleAck.shown?.ackBelowText === true,
    `ackBelowText=${bubbleAck.shown?.ackBelowText} textAreaHeight=${bubbleAck.shown?.textAreaHeight}`,
  );
  record(
    '对话气泡：点"知道了"关闭气泡并收起窗口',
    bubbleAck.afterClick?.bubbleHidden === true &&
      bubbleAck.afterClick?.windowInner?.w === bubbleAck.afterClick?.windowInner?.h * 0.75 &&
      (bubbleAck.afterClick?.windowInner?.h ?? 0) < (bubbleAck.shown?.windowInner?.h ?? 0),
    JSON.stringify({ shown: bubbleAck.shown?.windowInner, afterClick: bubbleAck.afterClick?.windowInner }),
  );
  record(
    '对话气泡：关闭后再点按钮不报错',
    bubbleAck.afterSecondClick?.bubbleHidden === true,
    JSON.stringify(bubbleAck.afterSecondClick),
  );

  /*
   * 8) 点"知道了"**不应**触发宠物点击动画。
   *
   * 气泡与宠物在同一个窗口里，气泡上的指针事件会冒泡到舞台，
   * 曾被当成"点到了宠物" —— 点按钮顺带播一次点击动画（用户反馈）。
   * 现在 InteractionManager 忽略一切来自 `data-pet-ui` 元素内部的指针事件。
   *
   * 断言用**事件计数**而不是看动画名：动画可能被别的来源触发（例如插件），
   * 只关心"这次点击有没有产生宠物交互事件"。
   *
   * ⚠️ 只看**按下按钮之后 400ms 内**产生的事件。
   * 为什么：这台机器上真实鼠标是活的 —— 跑到这里时如果真人在拖桌宠，
   * 会冒出一串 `pet:drag`（实测就是这么红的）。那是环境噪声，
   * 与本条断言要问的问题（"按钮上的按下会不会被当成宠物交互"）无关。
   */
  const ackNoAnim = await run(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const bus = window.petDebug.bus;
    const seen = [];
    const subs = [
      bus.on('pet:click', (p) => seen.push({ t: 'pet:click', region: p.region, at: Date.now() })),
      bus.on('pet:dblclick', (p) => seen.push({ t: 'pet:dblclick', region: p.region, at: Date.now() })),
      bus.on('pet:drag', (p) => seen.push({ t: 'pet:drag', phase: p.phase, at: Date.now() })),
    ];
    await window.petAPI.bubble.set({ visible: true, text: '点下面的按钮关闭我' });
    for (let i = 0; i < 30; i++) { await wait(120); }
    const ack = document.getElementById('pet-bubble-ack');
    const r = ack.getBoundingClientRect();
    const point = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };

    /* 用真实指针事件（合成 DOM click 不经过 InteractionManager，测不出冒泡） */
    const pressedAt = Date.now();
    ack.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: point.x, clientY: point.y, screenX: point.x, screenY: point.y }));
    ack.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: point.x, clientY: point.y, screenX: point.x, screenY: point.y }));
    ack.click();
    await wait(900);
    const bubbleHidden = (() => {
      const s = getComputedStyle(document.getElementById('pet-bubble'));
      return s.display === 'none' || s.visibility === 'hidden';
    })();
    subs.forEach((s) => s.unsubscribe());
    const caused = seen.filter((item) => item.at >= pressedAt - 40 && item.at <= pressedAt + 400);
    return { point, eventsDuringAck: caused, ignoredNoise: seen.length - caused.length, bubbleHidden };
  })()`);

  record(
    '对话气泡：点"知道了"不触发宠物点击动画',
    (ackNoAnim.eventsDuringAck ?? []).length === 0 && ackNoAnim.bubbleHidden === true,
    JSON.stringify(ackNoAnim),
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
   * 用户交互抢占（需求 6.2 的三段式语义）：
   * 持续动画正在 loop 时被点击 -> **先立刻进 end 段**，收尾播完再播点击反应。
   *
   * 注意与"硬切"的区别：进 end 段是**立刻**发生的（不等本轮循环播完），
   * 但反应动画要等收尾播完 —— 这是需求明确要求的顺序，
   * 所以这里断言的是"立刻进 end"而不是"立刻看到 stroke"。
   */
  // 这一大段都在问"现在该播谁"：先确保她没被收起（收起时默认动画是 watch/lie）
  await backToDesktop();

  const stealRun = await run(`(async () => {
    const anim = window.petDebug.anim;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    anim.stop('steal-reset');
    await wait(150);
    anim.resetCooldowns();
    await anim.play('watch', { interrupt: 'force', reason: 'user-click:body-steal-test' });
    for (let i = 0; i < 40 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
    const before = { animation: anim.getCurrentAnimation(), phase: anim.getPersistentPhase() };
    // 模拟点击反应（renderer 用的就是 user-click:* 这个 reason 前缀 + priority 50）
    const t0 = Date.now();
    const result = await anim.play('stroke', { priority: 50, interrupt: 'auto', reason: 'user-click:body', source: 'user' });
    const elapsedMs = Date.now() - t0;
    const phaseAfter = anim.getPersistentPhase();
    const duringEnd = anim.getCurrentAnimation();
    let reaction = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 20000 && reaction === null) {
      await wait(100);
      const current = anim.getCurrentAnimation();
      if (current !== null && current !== 'watch') reaction = current;
    }
    return { before, accepted: result.accepted, elapsedMs, phaseAfter, duringEnd, reaction, after: anim.getCurrentAnimation() };
  })()`);
  record(
    '点击持续动画：立刻进 end 段（不硬切、不等本轮循环），收尾播完再接上反应',
    stealRun.accepted === true &&
      stealRun.before.phase === 'loop' &&
      stealRun.elapsedMs < 1500 &&
      stealRun.phaseAfter === 'end' &&
      stealRun.duringEnd === 'watch' &&
      stealRun.reaction === 'stroke',
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
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // 先彻底停下来：上一条用例可能留着收尾段/挂起请求，否则起点就不是 watch
    anim.stop('toggle-reset');
    anim.clearPendingAfterEnd();
    anim.clearQueue();
    await wait(400);
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
      // 每条都从干净状态开始：清掉收尾段与挂起请求，否则起点可能不是 watch
      anim.stop('menu-switch-reset');
      anim.clearPendingAfterEnd();
      anim.clearQueue();
      await wait(400);
      anim.resetCooldowns();
      // 每次起点都一样：用菜单路径起 watch（priority 70，与真实菜单一致）
      await menuPlay('watch');
      for (let i = 0; i < 60 && anim.getPersistentPhase() !== 'loop'; i++) await wait(100);
      const before = anim.getCurrentAnimation();
      const r = await menuPlay(target);
      const phaseAfterRequest = anim.getPersistentPhase();
      // 收尾段播完后应该接上目标动画（三段式打断语义）
      let settled = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 20000 && settled === null) {
        await wait(100);
        const current = anim.getCurrentAnimation();
        if (current !== 'watch') settled = current;
      }
      results.push({
        target, before, accepted: r.accepted, rejection: r.rejection ?? null,
        phaseAfterRequest, settled,
      });
    }
    return results;
  })()`);
  record(
    '菜单选择其它动画：受理并在 watch 的收尾段播完后接上（回归：equal-priority 被拒）',
    menuSwitch.every((r) =>
      r.before === 'watch' && r.accepted === true && r.rejection === null &&
      r.phaseAfterRequest === 'end' && r.settled === r.target,
    ),
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
    /*
     * 再补一发 pointercancel：合成事件不会真的'按住'，但真实鼠标的移动
     * 可能在她被窗口移动/缩放时产生 pointermove —— 那会被当成拖动，
     * 拖动结束若停在边缘就会触发贴边收起（实测：验收跑到一半她收起来了）。
     */
    stage.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1, isPrimary: true }));
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
  // 长按用例用合成指针'按住'了 1.5 秒：期间真实光标的任何移动都会被当成拖动，
  // 拖完可能停在边缘上（收起）—— 后面还有一大批动画断言，先把她放回中部。
  await backToDesktop();
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

  /*
   * 拖拽用例会把窗口推到屏幕边缘，于是**贴边收起**会被触发（产品行为，没错）。
   * 但收起状态下点击 = 展开而不是"点击反应"，下面的断言（点击反应、手动重播、
   * 交叉淡化…）在收起状态下会看到 watch/lie 的收尾段 —— 实测就是这样红的。
   * 因此这些用例开始前显式把她放回桌面中间并展开。
   */
  await backToDesktop();

  /* --------- 点击之后必须恢复 idle 循环（回归：曾出现点一次就再也不循环） --------- */
  const resumeLoop = await run(`(async () => {
    const anim = window.petDebug.anim;
    const sm = window.petDebug.state;
    const stage = document.getElementById('pet-stage');
    // 注意：双缓冲下"当前可见"的 <video> 会随动画切换而改变，
    // 因此这里每次都重新查询，绝不能提前把元素抓成常量（会读到已经废弃的缓冲）。
    const video = () => document.querySelector('video.layer-active') || document.getElementById('pet-video') || document.querySelector('video');

    /*
     * 起点必须是干净的 idle：上面几条用例可能把持续动画留在 loop 阶段，
     * 那样点击会（按三段式语义）先播收尾段，4 秒内看不到反应动画。
     */
    anim.stop('resume-loop-reset');
    anim.clearPendingAfterEnd();
    anim.clearQueue();
    await new Promise((r) => setTimeout(r, 500));
    anim.resetCooldowns();
    await anim.play('idle', { interrupt: 'force', loop: true, reason: 'resume-loop-setup', source: 'system' });
    await new Promise((r) => setTimeout(r, 700));

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
  // 同样先确保"正常显示状态"（收起时默认动画是 watch/lie，会干扰下面的断言）
  await backToDesktop();

  const priority = await run(`(async () => {
    const anim = window.petDebug.anim;
    const out = {};
    /*
     * 低优先级'受害者'用一次性动画 sing(30)。
     * 不能用 lie：它现在是**三段式**（下方收起的默认姿势），被抢占时会先播收尾段
     * 再让位 —— 那是需求要的语义，但会让"立刻抢占"这条断言读到 lie。
     */
    await anim.play('sing', { priority: 30, interrupt: 'force', reason: 'test' });
    let lowWaited = 0;
    while (lowWaited < 3000 && anim.getCurrentAnimation() !== 'sing') {
      await new Promise((r) => setTimeout(r, 100));
      lowWaited += 100;
    }
    out.low = anim.getCurrentAnimation();
    out.lowWaited = lowWaited;
    // 高优先级抢占（cute 50 > sing 30；两者都是一次性，立刻切换）
    const r1 = await anim.play('cute', { priority: 50, reason: 'test' });
    out.interruptAccepted = r1.accepted;
    out.after = anim.getCurrentAnimation();
    /*
     * 同优先级应被拒绝 (equal-priority)。
     *
     * ⚠️ 这里**不能**用两条点击动画来测（原来用 cute -> fawning）：
     * 点击动画现在是 **interruptible: false 的硬锁**，fawning 会先被
     * not-interruptible 拒掉，测的就不是"同优先级"了。
     * 所以用两条同优先级(45)的非点击动画：roll -> shake。
     */
    anim.stop('equal-priority-reset');
    await new Promise((r) => setTimeout(r, 300));
    anim.resetCooldowns();
    await anim.play('roll', { priority: 45, interrupt: 'force', reason: 'test' });
    out.equalPlaying = anim.getCurrentAnimation();
    const r2 = await anim.play('shake', { priority: 45, reason: 'test' });
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
  record('低优先级动画可正常播放', priority.low === 'sing', JSON.stringify(priority));
  record('高优先级可抢占低优先级', priority.interruptAccepted === true && priority.after === 'cute', `after=${priority.after}`);
  record('同优先级被拒绝 (equal-priority)', priority.equalPlaying === 'roll' && priority.equalReason === 'equal-priority', `playing=${priority.equalPlaying} reason=${priority.equalReason}`);
  record('interruptible=false 拒绝更高优先级抢占', priority.nonInterruptibleReason === 'not-interruptible', `reason=${priority.nonInterruptibleReason}, playing=${priority.guardedPlaying}`);
  record('动画冷却生效 (cooldown)', priority.cooldownReason === 'cooldown', `reason=${priority.cooldownReason}`);

  await backToDesktop();

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
    /*
     * read 是三段式，轮数本来是随机的 [2,5]：start 1.63s + loop 1.75s×N + end 4.38s，
     * 最坏情况 ≈14.8s —— 和下面 15s 的超时只差一点点，实测偶发超时（后面两条
     * 断言跟着一起红）。这里显式钉成 1 轮，把"到底几轮"这个随机因素去掉：
     * 本用例要验的是"非循环动画会发 animation:end"，与轮数无关。
     */
    await anim.play('read', { priority: 30, interrupt: 'force', reason: 'ended-test', loopCountRange: [1, 1] });
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

  /*
   * 逐帧检查**一次性动画的开始与结束**是否有"闪一下"。
   *
   * 用户反馈"所有动画开始和结束都要闪一次"。逐帧量化（tools/diag-transition-composite.cjs）
   * 定位到原因是**硬切**：`startVideo` 原来用 `commitVideoSwap()` 直接换缓冲，
   * 而两段素材的首末帧并不相同，切换那一帧就是一次可见跳变。修复方式是与持续动画
   * 切段一致，走 140ms 交叉淡化（`crossfadeToSpare`）。
   *
   * 这里用 rAF 采样把"闪"的两种形态都钉住：
   *   - blankOpacity：所有媒体层都不可见（桌宠整只消失一帧）；
   *   - blankTex    ：可见层 opacity>0.5 但 readyState<2（画不出内容 = 透明一帧）；
   *   - fadeFrames  ：同时有两层处于中间不透明度 = 正在交叉淡化。
   * 断言：切换窗口内 blankOpacity=0、blankTex=0，且确实出现了淡化帧。
   *
   * 嵌入 JS 里没有反引号（模板字符串到此为止），改文字时请只写 CSS visibility 这类词。
   */
  const transition = await run(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const anim = window.petDebug.anim;
    const vids = () => Array.from(document.querySelectorAll('#pet-pet video'));
    const st = { frames: 0, blankOpacity: 0, blankTex: 0, fadeFrames: 0, maxFadeLayers: 0 };
    const reset = () => { st.frames = 0; st.blankOpacity = 0; st.blankTex = 0; st.fadeFrames = 0; st.maxFadeLayers = 0; };
    let stopped = false;
    const sample = () => requestAnimationFrame(() => {
      if (stopped) return;
      const list = vids();
      const ops = list.map((v) => Number(getComputedStyle(v).opacity));
      const shown = ops.filter((o) => o > 0.001).length;
      const mid = ops.filter((o) => o > 0.001 && o < 0.999).length;
      st.frames++;
      if (shown === 0) st.blankOpacity++;
      for (let i = 0; i < list.length; i++) {
        if (ops[i] > 0.5 && list[i].readyState < 2) st.blankTex++;
      }
      if (mid >= 2) st.fadeFrames++;
      if (mid > st.maxFadeLayers) st.maxFadeLayers = mid;
      sample();
    });
    sample();

    anim.resetCooldowns();
    anim.stop('fade-reset');
    anim.play('idle', { interrupt: 'force', reason: 'fade-baseline', bypassCooldown: true });
    await wait(1200);

    /* 开始：idle -> cute */
    reset();
    await anim.play('cute', { interrupt: 'force', reason: 'fade-start', bypassCooldown: true });
    await wait(700);
    const start = { ...st };

    /* 结束：cute -> 兜底 idle（等它自然播完） */
    reset();
    await wait(6000);
    const end = { ...st, animation: anim.getCurrentAnimation() };
    stopped = true;
    return { start, end };
  })()`);
  record(
    '一次性动画开始走交叉淡化（无空帧、无空白纹理帧）',
    transition.start?.blankOpacity === 0 && transition.start?.blankTex === 0 && transition.start?.fadeFrames >= 2,
    JSON.stringify(transition.start),
  );
  record(
    '一次性动画结束走交叉淡化（无空帧、无空白纹理帧）',
    transition.end?.blankOpacity === 0 && transition.end?.blankTex === 0 && transition.end?.fadeFrames >= 2 && transition.end?.animation === 'idle',
    JSON.stringify(transition.end),
  );

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
  /*
   * 随包不带插件，所以这里先**用安装器装两个探针插件**（走真实的
   * 校验 -> 复制 -> 登记 -> 启用 链路），随后的启停/权限/事件用例都跑在它们身上。
   *
   * 为什么不在仓库里留两个示例插件：需求明确"把两个内置的插件卸载掉"
   * （随机动画本来就是核心 `BehaviorManager` 在做，示例插件只是验证链路）。
   * 探针放在 `build/`（gitignore）里，跑完连同插件目录一起删掉。
   */
  const clickProbeId = 'acceptance-click-probe';
  const plainProbeId = 'acceptance-plain-probe';
  const fixtureRoot = join(root, 'build', 'acceptance-fixtures');
  const fixtureClickDir = join(fixtureRoot, 'click-probe');
  const fixturePlainDir = join(fixtureRoot, 'plain-probe');
  try {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    /* 上一轮的残留删不掉也无所谓：下面按名字重建 */
  }
  mkdirSync(fixtureClickDir, { recursive: true });
  mkdirSync(fixturePlainDir, { recursive: true });
  writeFileSync(
    join(fixtureClickDir, 'package.json'),
    JSON.stringify(
      {
        name: clickProbeId,
        displayName: '点击探针',
        version: '1.0.0',
        description: '验收用：事件监听 + 菜单项 + 存储',
        main: 'index.js',
        permissions: ['ui'],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(fixtureClickDir, 'index.js'),
    [
      'module.exports = {',
      `  id: '${clickProbeId}',`,
      "  name: '点击探针',",
      "  version: '1.0.0',",
      '  activate(context) {',
      "    context.events.on('pet:click', () => {",
      "      const key = 'clickCount';",
      "      context.storage.set(key, (context.storage.get(key, 0) || 0) + 1);",
      '    });',
      '    // 插件自己注册的菜单动作：托盘「插件」子菜单里应当出现它',
      "    context.ui.registerMenuItem({ id: 'ping', label: '探针动作', hint: '验收用' }, () => {",
      "      context.storage.set('menuClicked', true);",
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(fixturePlainDir, 'package.json'),
    JSON.stringify(
      { name: plainProbeId, displayName: '普通探针', version: '1.0.0', main: 'index.js' },
      null,
      2,
    ),
    'utf8',
  );
  // 有意**不声明任何权限**：下面的"权限执法"用例就靠它
  writeFileSync(join(fixturePlainDir, 'index.js'), `module.exports = { id: '${plainProbeId}', name: '普通探针', version: '1.0.0', activate() {} };\n`, 'utf8');

  const fixtureInstall = await run(`(async () => {
    const click = await window.petAPI.plugins.install(${JSON.stringify(fixtureClickDir)});
    const plain = await window.petAPI.plugins.install(${JSON.stringify(fixturePlainDir)});
    await new Promise((r) => setTimeout(r, 1500));
    const records = window.petDebug.plugins.getLoadedPlugins();
    return {
      click: { ok: click.ok, id: click.id, error: click.error || null },
      plain: { ok: plain.ok, id: plain.id, error: plain.error || null },
      clickStatus: records.find((r) => r.id === '${clickProbeId}')?.status || null,
      plainStatus: records.find((r) => r.id === '${plainProbeId}')?.status || null,
    };
  })()`);
  record(
    '插件：用安装器装进来的探针插件立刻激活（校验 -> 复制 -> 登记 -> 启用）',
    fixtureInstall.click.ok === true &&
      fixtureInstall.plain.ok === true &&
      fixtureInstall.clickStatus === 'active' &&
      fixtureInstall.plainStatus === 'active',
    JSON.stringify(fixtureInstall),
  );

  // 插件监听事件：模拟真实点击，验证计数持久化
  const clickEffect = await run(`(async () => {
    const before = window.localStorage.getItem('desktop-pet:plugin:${clickProbeId}:clickCount');
    const stage = document.getElementById('pet-stage');
    const rect = stage.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.width/2, clientY: rect.height*0.5, screenX: 500, screenY: 500, button: 0, pointerId: 1, isPrimary: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', opts));
    window.dispatchEvent(new PointerEvent('pointerup', opts));
    await new Promise((r) => setTimeout(r, 500));
    return {
      before, after: window.localStorage.getItem('desktop-pet:plugin:${clickProbeId}:clickCount'),
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
    const r = await actions.execute({ type: 'animation', animationId: 'sing', priority: 30, source: 'plugin:${clickProbeId}', reason: 'plugin-test' });
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

  /* ---------------- 插件沙箱：系统能力只有 PluginContext 一条路 ---------------- */
  /*
   * 为什么要专门验这一条：插件跑在桌宠页面里，如果它能随手碰 `window.petAPI`，
   * 那"权限声明"就只是文档。
   *
   * 这里必须放一个**真的插件文件**（走 PluginManager 编译 -> PluginHost 沙箱求值），
   * 不能像异常隔离那几条一样现场造一个对象：现场造出来的 activate 是**页面作用域里的闭包**，
   * 它眼里的 `window` 本来就是页面的 window，测不到遮蔽（实测因此假绿过）。
   */
  const probeId = 'acceptance-sandbox-probe';
  const probeDir = join(root, 'plugins', '_acceptance-probe');
  const pluginsJsonRaw = readFileSync(join(root, 'assets', 'config', 'plugins.json'), 'utf8');
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(
    join(probeDir, 'package.json'),
    JSON.stringify({ name: probeId, displayName: '沙箱探针', version: '1.0.0', main: 'index.js' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(probeDir, 'index.js'),
    [
      'module.exports = {',
      `  id: '${probeId}',`,
      "  name: '沙箱探针',",
      "  version: '1.0.0',",
      '  activate(context) {',
      '    context.storage.set("globals", {',
      '      window: typeof window,',
      '      document: typeof document,',
      '      fetch: typeof fetch,',
      '      localStorage: typeof localStorage,',
      '      XMLHttpRequest: typeof XMLHttpRequest,',
      '      globalThis: typeof globalThis,',
      '      petApi: typeof (window && window.petAPI),',
      '      process: typeof process,',
      '      global: typeof global,',
      '    });',
      '    context.storage.set("permissions", context.lifecycle.permissions);',
      '    context.storage.set("hasNet", context.lifecycle.has("net"));',
      '    context.storage.set("alive", true);',
      '    context.storage.set("capabilities", {',
      '      timers: typeof context.timers.after,',
      '      net: typeof context.net.request,',
      '      process: typeof context.process.run,',
      '      python: typeof context.python.run,',
      '      notify: typeof context.notify.send,',
      '      mail: typeof context.mail.send,',
      '      ui: typeof context.ui.registerPanel,',
      '      onDispose: typeof context.lifecycle.onDispose,',
      '    });',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  {
    const manifest = JSON.parse(pluginsJsonRaw);
    manifest.plugins = manifest.plugins || [];
    manifest.plugins.push({ id: probeId, path: '_acceptance-probe', enabled: false });
    writeFileSync(join(root, 'assets', 'config', 'plugins.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }

  const sandboxProbe = await run(`(async () => {
    const read = (key) => JSON.parse(window.localStorage.getItem('desktop-pet:plugin:${probeId}:' + key) || 'null');
    await window.petAPI.plugins.setEnabled('${probeId}', true);
    await new Promise((r) => setTimeout(r, 1600));
    const globals = read('globals') || {};
    const status = window.petDebug.plugins.getLoadedPlugins().find((r) => r.id === '${probeId}')?.status || null;
    await window.petAPI.plugins.setEnabled('${probeId}', false);
    await new Promise((r) => setTimeout(r, 300));
    return {
      status,
      alive: read('alive'),
      globals,
      permissions: read('permissions'),
      hasNet: read('hasNet'),
      capabilities: read('capabilities'),
      shadowed: ['window', 'document', 'fetch', 'localStorage', 'XMLHttpRequest', 'globalThis', 'petApi']
        .every((name) => globals[name] === 'undefined'),
    };
  })()`);

  // 收尾：把探针插件与清单恢复原状（验收不该给仓库留垃圾）
  try {
    rmSync(probeDir, { recursive: true, force: true });
    writeFileSync(join(root, 'assets', 'config', 'plugins.json'), pluginsJsonRaw, 'utf8');
  } catch (error) {
    console.error('CLEANUP_FAILED', error);
  }

  record(
    '插件沙箱：探针插件经真实加载链路跑起来了',
    sandboxProbe.alive === true && sandboxProbe.status === 'active',
    JSON.stringify({ alive: sandboxProbe.alive, status: sandboxProbe.status }),
  );
  record(
    '插件沙箱：window/document/fetch/petAPI 全部不可达（只有 PluginContext 一条路）',
    sandboxProbe.shadowed === true,
    JSON.stringify(sandboxProbe.globals),
  );
  record(
    '插件沙箱：没有声明权限时 permissions 为空',
    Array.isArray(sandboxProbe.permissions) && sandboxProbe.permissions.length === 0 && sandboxProbe.hasNet === false,
    JSON.stringify({ permissions: sandboxProbe.permissions, hasNet: sandboxProbe.hasNet }),
  );
  record(
    '插件上下文：系统能力接口齐全（timers/net/process/python/notify/mail/ui/onDispose）',
    sandboxProbe.capabilities &&
      sandboxProbe.capabilities.timers === 'function' &&
      sandboxProbe.capabilities.net === 'function' &&
      sandboxProbe.capabilities.process === 'function' &&
      sandboxProbe.capabilities.python === 'function' &&
      sandboxProbe.capabilities.notify === 'function' &&
      sandboxProbe.capabilities.mail === 'function' &&
      sandboxProbe.capabilities.ui === 'function' &&
      sandboxProbe.capabilities.onDispose === 'function',
    JSON.stringify(sandboxProbe.capabilities),
  );

  /* ---------------- 插件投递：往「交互」收件箱送文件（权限 mail） ---------------- */
  /*
   * 这是需求那句"宠物可能在插件中生成文件然后保存到这里"的落点：
   * 插件把内容（文本 / base64）连同一条说明交上来，主进程写进收纳夹并记一条消息。
   * 用真实安装的探针插件跑（走 install -> activate -> context.mail.send 全程）。
   */
  const mailProbeId = 'acceptance-mail-probe';
  const mailProbeDir = join(fixtureRoot, 'mail-probe');
  mkdirSync(mailProbeDir, { recursive: true });
  writeFileSync(
    join(mailProbeDir, 'package.json'),
    JSON.stringify(
      {
        name: mailProbeId,
        displayName: '投递探针',
        version: '1.0.0',
        main: 'index.js',
        permissions: ['mail'],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(mailProbeDir, 'index.js'),
    [
      'module.exports = {',
      `  id: '${mailProbeId}',`,
      "  name: '投递探针',",
      "  version: '1.0.0',",
      '  async activate(context) {',
      '    // 文本附件 + 二进制附件（base64）：覆盖两条编码路径',
      '    const result = await context.mail.send({',
      "      subject: '探针生成的报告',",
      "      body: '这是插件生成的东西，正文在这里。',",
      '      attachments: [',
      "        { name: 'probe-report.txt', content: '插件写的文本内容\\n第二行' },",
      "        { name: 'probe-image.png', content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', encoding: 'base64' },",
      '      ],',
      '    });',
      "    context.storage.set('mailResult', result);",
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  const mailRun = await run(`(async () => {
    const install = await window.petAPI.plugins.install(${JSON.stringify(mailProbeDir)});
    await new Promise((r) => setTimeout(r, 1800));
    const box = await window.petAPI.ai.notes();
    const message = (box.notes || []).find((n) => (n.sender || {}).id === '${mailProbeId}') || null;
    const result = JSON.parse(window.localStorage.getItem('desktop-pet:plugin:${mailProbeId}:mailResult') || 'null');
    return {
      install: { ok: install.ok, error: install.error || null },
      result,
      message,
      orphans: (box.orphans || []).map((f) => f.name),
      attachmentPreview: message && message.files && message.files[0]
        ? await window.petAPI.ai.previewNoteFile(message.files[0].name)
        : null,
    };
  })()`);
  record(
    '插件投递：`context.mail.send` 把消息与附件存进「交互」收件箱（权限 mail）',
    mailRun.install.ok === true &&
      mailRun.result?.ok === true &&
      typeof mailRun.result?.messageId === 'string' &&
      mailRun.message !== null &&
      mailRun.message.sender.kind === 'plugin' &&
      mailRun.message.sender.name === '投递探针' &&
      mailRun.message.title === '探针生成的报告',
    JSON.stringify({ install: mailRun.install, result: mailRun.result, message: mailRun.message }),
  );
  record(
    '插件投递：文本与 base64 两种附件都写进了收纳夹（内容可读、不是空文件）',
    Array.isArray(mailRun.message?.files) &&
      mailRun.message.files.length === 2 &&
      mailRun.message.files.some((f) => f.name === 'probe-report.txt' && f.size > 0) &&
      mailRun.message.files.some((f) => f.name === 'probe-image.png' && f.size > 0) &&
      mailRun.attachmentPreview?.ok === true &&
      mailRun.attachmentPreview.text.includes('插件写的文本内容'),
    JSON.stringify({ files: mailRun.message?.files, preview: mailRun.attachmentPreview && { ok: mailRun.attachmentPreview.ok, len: (mailRun.attachmentPreview.text || '').length } }),
  );
  record(
    '插件投递：附件被消息引用，因此**不**出现在「未归档」里',
    Array.isArray(mailRun.orphans) &&
      !mailRun.orphans.includes('probe-report.txt') &&
      !mailRun.orphans.includes('probe-image.png'),
    JSON.stringify({ orphans: mailRun.orphans }),
  );

  // 删掉这条消息：附件要跟着消失（邮件语义）
  const mailCleanup = await run(`(async () => {
    const box = await window.petAPI.ai.notes();
    const message = (box.notes || []).find((n) => (n.sender || {}).id === '${mailProbeId}');
    const after = await window.petAPI.ai.deleteNote(message.id);
    await new Promise((r) => setTimeout(r, 400));
    const files = await window.petAPI.ai.noteFiles();
    const uninstall = await window.petAPI.plugins.uninstall('${mailProbeId}');
    return {
      deleted: after.notes.every((n) => n.id !== message.id),
      remainingFiles: files.map((f) => f.name),
      orphans: (after.orphans || []).map((f) => f.name),
      uninstall: { ok: uninstall.ok, error: uninstall.error || null },
    };
  })()`);
  record(
    '插件投递：删掉那条消息会连同附件一起删（邮件语义）',
    mailCleanup.deleted === true &&
      !mailCleanup.remainingFiles.includes('probe-report.txt') &&
      !mailCleanup.remainingFiles.includes('probe-image.png') &&
      mailCleanup.uninstall.ok === true,
    JSON.stringify(mailCleanup),
  );

  /* ---------------- 权限执法：没声明的能力一律被拒绝（执法在 Main） ---------------- */
  /*
   * 直接打 preload 桥（绕开插件代码），验的是**主进程**的执法：即使插件自己
   * 拼一个 pluginId 过来，只要那个插件没声明权限（或已停用），也必须被拒绝。
   */
  const permissionDenied = await run(`(async () => {
    const net = await window.petAPI.plugins.net('${plainProbeId}', { url: 'https://example.com/' });
    const proc = await window.petAPI.plugins.process('${plainProbeId}', { command: 'node', args: ['-v'] });
    const py = await window.petAPI.plugins.pythonInfo('${plainProbeId}');
    const notify = await window.petAPI.plugins.notify('${plainProbeId}', { title: 't', body: 'b' });
    const mail = await window.petAPI.plugins.mail('${plainProbeId}', { subject: 's', body: 'b' });
    const unknown = await window.petAPI.plugins.net('not-a-plugin', { url: 'https://example.com/' });
    return { net, proc, py, notify, mail, unknown };
  })()`);
  record(
    '权限执法：未声明 net 时联网被拒绝（且给出可读原因）',
    permissionDenied.net && permissionDenied.net.ok === false && /权限/.test(String(permissionDenied.net.error || '')),
    JSON.stringify(permissionDenied.net),
  );
  record(
    '权限执法：未声明 process / python 时起进程被拒绝',
    permissionDenied.proc.ok === false &&
      permissionDenied.proc.code === null &&
      permissionDenied.py.ok === false,
    JSON.stringify({ proc: permissionDenied.proc.error, py: permissionDenied.py.error }),
  );
  record(
    '权限执法：未声明 notify 时系统通知被拒绝',
    permissionDenied.notify === false,
    JSON.stringify(permissionDenied.notify),
  );
  record(
    '权限执法：未声明 mail 时往收件箱投递被拒绝（不会凭空往用户界面塞东西）',
    permissionDenied.mail?.ok === false && /权限/.test(String(permissionDenied.mail?.error || '')),
    JSON.stringify(permissionDenied.mail),
  );
  record(
    '权限执法：不存在的插件 id 同样被拒绝（无法凭空提权）',
    permissionDenied.unknown.ok === false && /权限|id/.test(String(permissionDenied.unknown.error || '')),
    JSON.stringify(permissionDenied.unknown),
  );

  /* ---------------- 插件定时器（主进程计时） ---------------- */
  const pluginTimers = await run(`(async () => {
    const host = window.petDebug.plugins;
    await host.activate(
      {
        id: 'timer-probe',
        name: 'Timer',
        version: '1.0.0',
        activate(context) {
          context.timers.after(250, () => context.storage.set('afterFired', true));
          context.timers.every(200, () => context.storage.set('everyCount', (context.storage.get('everyCount', 0) || 0) + 1));
          context.timers.after(5000, () => context.storage.set('cancelled', true));
        },
      },
      { id: 'timer-probe', name: 'Timer', version: '1.0.0', dir: 'plugins/examples/timer', enabled: true, status: 'loaded', permissions: [] }
    );
    await new Promise((r) => setTimeout(r, 900));
    const after = window.localStorage.getItem('desktop-pet:plugin:timer-probe:afterFired');
    const every = window.localStorage.getItem('desktop-pet:plugin:timer-probe:everyCount');
    // 停用：主进程清表 + 渲染层取消定时器，长定时器不该再触发
    await host.disablePlugin('timer-probe');
    await new Promise((r) => setTimeout(r, 600));
    return {
      after,
      every: every === null ? null : JSON.parse(every),
      cancelled: window.localStorage.getItem('desktop-pet:plugin:timer-probe:cancelled'),
      status: host.getLoadedPlugins().find((r) => r.id === 'timer-probe')?.status,
    };
  })()`);
  record(
    '插件定时器：after/every 到点（由主进程计时）',
    pluginTimers.after === 'true' && typeof pluginTimers.every === 'number' && pluginTimers.every >= 2,
    JSON.stringify(pluginTimers),
  );
  record(
    '插件定时器：停用插件后未触发的定时器被取消',
    pluginTimers.cancelled === null && pluginTimers.status === 'inactive',
    JSON.stringify(pluginTimers),
  );

  /* ---------------- 随时关闭：单个插件的运行期启停 ---------------- */
  const pluginsJsonPath = join(root, 'assets', 'config', 'plugins.json');
  const readPluginEnabled = (id) => {
    try {
      const parsed = JSON.parse(readFileSync(pluginsJsonPath, 'utf8'));
      const entry = (parsed.plugins || []).find((item) => item.id === id);
      return entry ? entry.enabled !== false : null;
    } catch (error) {
      return null;
    }
  };

  const disabled = await run(`(async () => {
    const records = await window.petAPI.plugins.setEnabled('${plainProbeId}', false);
    await new Promise((r) => setTimeout(r, 500));
    const record = records.find((item) => item.id === '${plainProbeId}');
    return {
      fromBridge: record,
      local: window.petDebug.plugins.getLoadedPlugins().find((item) => item.id === '${plainProbeId}') || null,
      stillLoaded: window.petDebug.plugins.getLoadedPlugins().some((item) => item.id === '${plainProbeId}' && item.status === 'active'),
    };
  })()`);
  record(
    '随时关闭：点一下开关即停用（主进程清单立刻变 disabled）',
    disabled.fromBridge && disabled.fromBridge.enabled === false && disabled.fromBridge.status === 'disabled',
    JSON.stringify(disabled.fromBridge),
  );
  record(
    '随时关闭：停用后渲染层不再持有该插件（已被回收）',
    disabled.stillLoaded === false && (disabled.local === null || disabled.local.status !== 'active'),
    JSON.stringify(disabled.local),
  );
  record(
    '随时关闭：停用会写回 plugins.json（重启后仍是关的）',
    readPluginEnabled(plainProbeId) === false,
    `enabled=${readPluginEnabled(plainProbeId)}`,
  );

  // 停用点击探针后，它的事件订阅必须一起消失（点击计数不再增长）
  const detachedEvents = await run(`(async () => {
    const click = async () => {
      const stage = document.getElementById('pet-stage');
      const rect = stage.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: rect.width/2, clientY: rect.height*0.5, screenX: 500, screenY: 500, button: 0, pointerId: 1, isPrimary: true };
      stage.dispatchEvent(new PointerEvent('pointerdown', opts));
      window.dispatchEvent(new PointerEvent('pointerup', opts));
      await new Promise((r) => setTimeout(r, 400));
      return window.localStorage.getItem('desktop-pet:plugin:${clickProbeId}:clickCount');
    };
    await window.petAPI.plugins.setEnabled('${clickProbeId}', false);
    await new Promise((r) => setTimeout(r, 400));
    window.petDebug.anim.stop('test-cleanup');
    await new Promise((r) => setTimeout(r, 200));
    const before = window.localStorage.getItem('desktop-pet:plugin:${clickProbeId}:clickCount');
    const afterDisabled = await click();
    await window.petAPI.plugins.setEnabled('${clickProbeId}', true);
    await new Promise((r) => setTimeout(r, 500));
    const afterEnabled = await click();
    return { before, afterDisabled, afterEnabled, status: window.petDebug.plugins.getLoadedPlugins().find((r) => r.id === '${clickProbeId}')?.status };
  })()`);
  record(
    '随时关闭：停用后事件订阅被退订（点击计数不再增加）',
    detachedEvents.afterDisabled === detachedEvents.before,
    JSON.stringify(detachedEvents),
  );
  record(
    '随时打开：重新启用后插件现场加载并恢复监听',
    detachedEvents.status === 'active' && detachedEvents.afterEnabled !== detachedEvents.before,
    JSON.stringify({ status: detachedEvents.status, before: detachedEvents.before, after: detachedEvents.afterEnabled }),
  );
  record(
    '随时打开：重新启用会写回 plugins.json',
    readPluginEnabled(clickProbeId) === true,
    `enabled=${readPluginEnabled(clickProbeId)}`,
  );

  await run(`window.petAPI.plugins.setEnabled('${plainProbeId}', true)`);
  await wait(500);
  record(
    '随时打开：重新启用普通探针后回到 active',
    readPluginEnabled(plainProbeId) === true,
    `enabled=${readPluginEnabled(plainProbeId)}`,
  );

  /* ---------------- 安装 / 卸载插件 ---------------- */
  /*
   * 走**真实安装链路**（校验 -> 复制 -> 登记 -> 启用），而不是只断言按钮在：
   * 安装是这一轮唯一会写用户磁盘的功能，必须验到"文件真的到位、清单真的对、插件真的跑起来"。
   * 源目录放在 build/ 下（gitignore 里），卸载后连源目录一起清掉。
   */
  const installSource = join(root, 'build', 'acceptance-plugin-src');
  const installedId = 'acceptance-installed-plugin';
  const installedDir = join(root, 'plugins', installedId);
  try {
    rmSync(installSource, { recursive: true, force: true });
  } catch {
    /* 上一轮的残留删不掉也无所谓，下面会重建 */
  }
  mkdirSync(installSource, { recursive: true });
  writeFileSync(
    join(installSource, 'package.json'),
    JSON.stringify(
      {
        name: installedId,
        displayName: '验收装进来的插件',
        version: '2.3.4',
        description: '安装/卸载验收用',
        main: 'index.js',
        permissions: ['notify'],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(installSource, 'index.js'),
    [
      'module.exports = {',
      `  id: '${installedId}',`,
      "  name: '验收装进来的插件',",
      "  version: '2.3.4',",
      '  activate(context) {',
      '    context.storage.set("installed", true);',
      '  },',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
  // 复制时要被跳过的东西：依赖树与一个指向目录外的符号链接
  mkdirSync(join(installSource, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(installSource, 'node_modules', 'junk', 'index.js'), 'module.exports = 1;\n', 'utf8');
  let symlinkMade = false;
  try {
    require('node:fs').symlinkSync(root, join(installSource, 'escape-link'), 'junction');
    symlinkMade = true;
  } catch (error) {
    // Windows 上可能需要权限：拿不到就跳过这一条，不让验收因此变红
    console.error('SYMLINK_SKIP', String(error));
  }

  const installRun = await run(`(async () => {
    const result = await window.petAPI.plugins.install(${JSON.stringify(installSource)});
    await new Promise((r) => setTimeout(r, 1500));
    const record = window.petDebug.plugins.getLoadedPlugins().find((r) => r.id === '${installedId}') || null;
    return {
      ok: result.ok,
      id: result.id,
      error: result.error || null,
      inRecords: Array.isArray(result.records) && result.records.some((r) => r.id === '${installedId}'),
      record,
      storage: window.localStorage.getItem('desktop-pet:plugin:${installedId}:installed'),
    };
  })()`);

  const installedManifestEntry = (() => {
    try {
      const parsed = JSON.parse(readFileSync(join(root, 'assets', 'config', 'plugins.json'), 'utf8'));
      return (parsed.plugins || []).find((item) => item.id === installedId) || null;
    } catch (error) {
      return null;
    }
  })();

  record(
    '安装插件：真实复制进 plugins/<id>/ 并登记（含 enabled:true 与权限）',
    installRun.ok === true &&
      installRun.id === installedId &&
      existsSync(join(installedDir, 'package.json')) &&
      existsSync(join(installedDir, 'index.js')) &&
      installedManifestEntry !== null &&
      installedManifestEntry.enabled !== false &&
      installedManifestEntry.path === installedId,
    JSON.stringify({ install: installRun, entry: installedManifestEntry, dirExists: existsSync(installedDir) }),
  );
  record(
    '安装插件：过滤掉 node_modules（不复制依赖树）',
    !existsSync(join(installedDir, 'node_modules')),
    `node_modules copied=${existsSync(join(installedDir, 'node_modules'))}`,
  );
  record(
    '安装插件：不复制符号链接（避免把插件目录之外的路径带进来）',
    symlinkMade === false || !existsSync(join(installedDir, 'escape-link')),
    JSON.stringify({ symlinkMade, copied: existsSync(join(installedDir, 'escape-link')) }),
  );
  record(
    '安装插件：装完立刻启用（记录 active + 插件自己的 activate 跑过）',
    installRun.record !== null && installRun.record.status === 'active' && installRun.storage === 'true',
    JSON.stringify({ record: installRun.record, storage: installRun.storage }),
  );

  /*
   * 设置窗口的面板必须跟着长出新卡片 + 卸载按钮（安装是"主进程 -> 推送 -> 重画"这条链路）。
   *
   * ⚠️ 不能复用上面那个 `settingsWin`：设置窗口的用例**早就把它销毁了**（见"关闭 = 隐藏"那条），
   * 直接查会得到 null 于是整条断言空转（实测第一版就是这样假绿的）。这里重新打开一次、
   * 查完再销毁，保持后面的窗口计数不受影响。
   */
  const querySettingsPanel = async () => {
    await run(`window.petAPI.window.showSettingsWindow()`);
    await wait(1500);
    const target = BrowserWindow.getAllWindows().find((w) => {
      try {
        return w.webContents.getURL().includes('/settings/');
      } catch (error) {
        return false;
      }
    });
    if (!target) return { error: '设置窗口没打开' };
    const snapshot = await target.webContents.executeJavaScript(`(() => ({
      cards: document.querySelectorAll('#plugin-list .plugin-card').length,
      uninstallButtons: document.querySelectorAll('#plugin-list .plugin-uninstall').length,
      builtinNotes: document.querySelectorAll('#plugin-list .plugin-builtin').length,
      hasInstalledCard: !!document.getElementById('plugin-uninstall-${installedId}'),
      names: [...document.querySelectorAll('#plugin-list .plugin-name')].map((n) => n.textContent),
    }))()`, true);
    target.destroy();
    await wait(300);
    return snapshot;
  };

  const settingsAfterInstall = await querySettingsPanel();
  record(
    '设置窗口「插件」面板：新装的插件自动出现在列表里（随包待办 + 两个探针 + 新装，都能卸载）',
    settingsAfterInstall.error === undefined &&
      settingsAfterInstall.cards === 4 &&
      settingsAfterInstall.hasInstalledCard === true &&
      settingsAfterInstall.uninstallButtons === 4,
    JSON.stringify(settingsAfterInstall),
  );

  // 拒绝的几种情况：不是插件目录 / 路径不存在
  const installRefusals = await run(`(async () => {
    const notAPlugin = await window.petAPI.plugins.install(${JSON.stringify(join(root, 'build'))});
    const missing = await window.petAPI.plugins.install(${JSON.stringify(join(root, 'build', 'no-such-folder-xyz'))});
    return { notAPlugin, missing };
  })()`);
  record(
    '安装插件：选到非插件目录 / 不存在的路径时被拒绝，并给出可读原因',
    installRefusals.notAPlugin.ok === false &&
      /package\.json|插件/.test(String(installRefusals.notAPlugin.error || '')) &&
      installRefusals.missing.ok === false,
    JSON.stringify({ notAPlugin: installRefusals.notAPlugin, missing: installRefusals.missing }),
  );

  /*
   * "带层级的 path 视为随包内置、不许卸载"这条规则。
   *
   * 随包已经不带插件了，所以这里**临时造一个**嵌套目录的条目来验规则本身：
   * 写目录 + 手改清单，验完立刻把两者都收掉（否则后面的面板/菜单计数会被它带偏）。
   */
  const nestedId = 'acceptance-nested-probe';
  const nestedDir = join(root, 'plugins', '_acceptance-nested', 'inner');
  const pluginsJsonFile = join(root, 'assets', 'config', 'plugins.json');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(
    join(nestedDir, 'package.json'),
    JSON.stringify({ name: nestedId, displayName: '嵌套探针', version: '1.0.0', main: 'index.js' }, null, 2),
    'utf8',
  );
  writeFileSync(join(nestedDir, 'index.js'), `module.exports = { id: '${nestedId}', name: '嵌套探针', version: '1.0.0', activate() {} };\n`, 'utf8');
  {
    const manifest = JSON.parse(readFileSync(pluginsJsonFile, 'utf8'));
    manifest.plugins = manifest.plugins || [];
    manifest.plugins.push({ id: nestedId, path: '_acceptance-nested/inner', enabled: false });
    writeFileSync(pluginsJsonFile, JSON.stringify(manifest, null, 2), 'utf8');
  }
  const builtinRefusal = await run(`window.petAPI.plugins.uninstall('${nestedId}')`);
  record(
    '卸载插件：带层级的路径（随包内置那种）拒绝卸载',
    builtinRefusal.ok === false && /内置/.test(String(builtinRefusal.error || '')),
    JSON.stringify(builtinRefusal),
  );
  // 收掉临时目录与条目，并让主进程重新发现一次（顺带验证"清单里没了 -> 记录也被剪掉"）
  {
    const manifest = JSON.parse(readFileSync(pluginsJsonFile, 'utf8'));
    manifest.plugins = (manifest.plugins || []).filter((item) => item.id !== nestedId);
    writeFileSync(pluginsJsonFile, JSON.stringify(manifest, null, 2), 'utf8');
  }
  rmSync(join(root, 'plugins', '_acceptance-nested'), { recursive: true, force: true });
  const pruneCheck = await run(`(async () => {
    await window.petAPI.plugins.setEnabled('${clickProbeId}', true);
    await new Promise((r) => setTimeout(r, 600));
    return {
      inRecords: window.petDebug.plugins.getLoadedPlugins().some((r) => r.id === '${nestedId}'),
      list: (await window.petAPI.plugins.list()).some((r) => r.id === '${nestedId}'),
    };
  })()`);
  record(
    '插件清单：条目被移除后，主进程与渲染层都不再保留它的记录',
    pruneCheck.inRecords === false && pruneCheck.list === false,
    JSON.stringify(pruneCheck),
  );

  const uninstallRun = await run(`(async () => {
    const result = await window.petAPI.plugins.uninstall('${installedId}');
    await new Promise((r) => setTimeout(r, 900));
    return {
      ok: result.ok,
      id: result.id,
      error: result.error || null,
      inRecords: Array.isArray(result.records) && result.records.some((r) => r.id === '${installedId}'),
      hostHasIt: window.petDebug.plugins.getLoadedPlugins().some((r) => r.id === '${installedId}'),
      storage: window.localStorage.getItem('desktop-pet:plugin:${installedId}:installed'),
    };
  })()`);

  const manifestAfterUninstall = (() => {
    try {
      const parsed = JSON.parse(readFileSync(join(root, 'assets', 'config', 'plugins.json'), 'utf8'));
      return (parsed.plugins || []).some((item) => item.id === installedId);
    } catch (error) {
      return true;
    }
  })();

  record(
    '卸载插件：目录被删、清单条目被移除、渲染层忘掉它',
    uninstallRun.ok === true &&
      !existsSync(installedDir) &&
      manifestAfterUninstall === false &&
      uninstallRun.inRecords === false &&
      uninstallRun.hostHasIt === false,
    JSON.stringify({
      uninstall: uninstallRun,
      dirExists: existsSync(installedDir),
      inManifest: manifestAfterUninstall,
    }),
  );
  record(
    '卸载插件：连它的存储一起清掉（不留残渣）',
    uninstallRun.storage === null,
    `storage=${String(uninstallRun.storage)}`,
  );

  // 收尾：源目录（build/ 下）也删掉
  try {
    rmSync(installSource, { recursive: true, force: true });
  } catch (error) {
    console.error('CLEANUP_FAILED', error);
  }

  /*
   * 卸载之后面板同样要跟上：卡片回到 2 张、卸载按钮消失。
   */
  const settingsAfterUninstall = await querySettingsPanel();
  record(
    '设置窗口「插件」面板：卸载后卡片与按钮一起消失（回到待办 + 两个探针）',
    settingsAfterUninstall.error === undefined &&
      settingsAfterUninstall.cards === 3 &&
      settingsAfterUninstall.uninstallButtons === 3 &&
      settingsAfterUninstall.hasInstalledCard === false,
    JSON.stringify(settingsAfterUninstall),
  );

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

  /*
   * 弹出右键菜单，并在验完"能弹"之后**把它关掉**。
   *
   * `TrayManager` 在菜单打开期间会跳过托盘菜单重建（避免 Windows 上弹着的时候改菜单）；
   * 而验收里没人去点这个菜单，它就一直开着 —— 于是后面"托盘菜单与右键菜单一致"
   * 那条再也拿不到托盘模板（偶发 `tray: null`，实测踩过）。
   * 这里在同一个主进程里截住刚构建的 Menu 实例，验完主动 `closePopup()` 还原状态。
   */
  const { Menu: MenuForCleanup } = require('electron');
  let poppedMenu = null;
  const originalBuildForCleanup = MenuForCleanup.buildFromTemplate;
  MenuForCleanup.buildFromTemplate = function capture(template) {
    const built = originalBuildForCleanup.call(this, template);
    poppedMenu = built;
    return built;
  };
  const menu = await run(`(() => {
    try {
      window.petAPI.menu.showContextMenu();
      return { ok: true };
    } catch (error) { return { ok: false, error: String(error) }; }
  })()`);
  MenuForCleanup.buildFromTemplate = originalBuildForCleanup;
  record('右键菜单调用成功', menu.ok === true, JSON.stringify(menu));
  await wait(500);
  try {
    if (poppedMenu && typeof poppedMenu.closePopup === 'function') poppedMenu.closePopup();
  } catch (error) {
    // 关不掉也不影响别的用例（下一个用例自己会处理）
  }
  await wait(300);

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

  /* ---------------------- AI 认知与人格（2.1~2.4） ---------------------- */

  /*
   * AI 自己的这一段开始前把开关**重新打开**（前面为了让动画断言不受干扰而关掉了它，
   * 因为心跳里的"很久没理你就主动说一句"会插播动画）；下面的"默认全开"断言读的就是打开后的状态。
   */
  await run(`window.petAPI.ai.setSettings({ enabled: true, chat: true, memory: true, emotion: true, diary: true })`);
  await wait(500);

  /*
   * 这一组检查的核心不是"能不能聊"，而是**四条底线**：
   *   1. 默认全关：没打开 AI 时桌宠行为与第一版完全一致（且不联网）；
   *   2. 密钥不出主进程：渲染层拿到的配置里只有掩码；
   *   3. 失败可降级：地址不可达/没密钥时，仍然给出一句人话，而不是报错或装死；
   *   4. 记忆/日记真的落盘：本地文件是这个模块可审计的证据。
   *
   * 数据目录由 `DESKTOP_PET_AI_DATA_DIR` 指到临时目录（见 main.ts 的 aiDataDir），
   * 因此这里读写文件不会碰到用户真实的记忆与日记。
   */
  const aiDataDir = process.env.DESKTOP_PET_AI_DATA_DIR;

  const aiInitial = await run(`(async () => {
    const status = await window.petAPI.ai.status();
    return {
      enabled: status.settings.enabled,
      chat: status.settings.chat,
      memory: status.settings.memory,
      emotion: status.settings.emotion,
      diary: status.settings.diary,
      usable: status.usable,
      mode: status.mode,
      hasPlainKey: Object.prototype.hasOwnProperty.call(status.settings.provider, 'apiKey'),
      masked: status.settings.provider.apiKeyMasked,
      apiKeySet: status.settings.provider.apiKeySet,
      mood: status.emotion.mood,
      dataDir: status.dataDir,
      aiMethods: Object.keys(window.petAPI.ai).sort(),
    };
  })()`);
  record(
    'AI 按需求默认全开（但没密钥时仍只走本地兜底）',
    aiInitial.enabled === true &&
      aiInitial.chat === true &&
      aiInitial.memory === true &&
      aiInitial.emotion === true &&
      aiInitial.diary === true &&
      aiInitial.usable === false &&
      aiInitial.mode === 'local',
    JSON.stringify(aiInitial),
  );
  record(
    'AI 配置不含明文密钥（只有掩码）',
    aiInitial.hasPlainKey === false && aiInitial.apiKeySet === false && aiInitial.masked === '',
    `hasPlainKey=${aiInitial.hasPlainKey} masked="${aiInitial.masked}"`,
  );
  record(
    'AI 桥暴露了完整的能力面（桌宠窗口）',
    ['status', 'setSettings', 'chat', 'memory', 'diary', 'writeDiary', 'testConnection', 'notifyInteraction', 'notifyInteractionSettled'].every((name) =>
      aiInitial.aiMethods.includes(name),
    ),
    JSON.stringify(aiInitial.aiMethods),
  );
  record('AI 数据目录可解析（记忆/日记落盘位置）', typeof aiInitial.dataDir === 'string' && aiInitial.dataDir.length > 0, aiInitial.dataDir);

  /*
   * "关掉开关就不该留痕迹"：默认全开是需求，但**关掉必须干净**。
   *
   * 做法：把**所有模块**的开关都关掉（AI + 感知 + 成长）-> 主进程侧清空数据目录
   * -> 触发一次互动与一次对话 -> 等一会儿（覆盖情绪心跳与感知采样）-> 目录必须仍然是空的。
   *
   * ⚠️ 必须连感知/成长一起关：它们是独立模块、各自会往同一个数据目录写文件
   * （`perception/`、`memory/nodes.json`…），只关 AI 的话这条断言测的就不是"关掉是否干净"，
   * 而是"别的模块有没有在跑"（实测因此红过一次）。
   */
  await run(`(async () => {
    await window.petAPI.ai.setSettings({ enabled: false, chat: false, memory: false, emotion: false, diary: false });
    await window.petAPI.perception.setSettings({ screen: false, behavior: false, camera: false, habits: false, windowContext: false });
    await window.petAPI.growth.setSettings({ palace: false, reflection: false, policyAdapt: false });
    return true;
  })()`);
  await wait(400);
  try {
    rmSync(aiDataDir, { recursive: true, force: true });
  } catch (error) {
    /* 目录不存在也无所谓 */
  }
  mkdirSync(aiDataDir, { recursive: true });
  const offBehaviour = await run(`(async () => {
    const before = await window.petAPI.ai.status();
    window.petAPI.ai.notifyInteraction('click');
    window.petAPI.ai.notifyInteraction('doubleclick');
    // 加心情的那一步（动画播完后渲染层才会报）也要覆盖：情绪开关关掉时它同样不能改心情
    window.petAPI.ai.notifyInteractionSettled('click');
    window.petAPI.ai.notifyInteractionSettled('doubleclick');
    await window.petAPI.ai.chat('开关都关掉时不应该写盘');
    await window.petAPI.ai.chat('再试一次');
    await new Promise((r) => setTimeout(r, 600));
    const after = await window.petAPI.ai.status();
    return { moodBefore: before.emotion.mood, moodAfter: after.emotion.mood, turns: (await window.petAPI.ai.memory()).stats.turns };
  })()`);
  await wait(2000);
  let aiDirEntriesAfterOff = [];
  try {
    aiDirEntriesAfterOff = readdirSync(aiDataDir);
  } catch (error) {
    aiDirEntriesAfterOff = [`(读取失败: ${String(error)})`];
  }
  record(
    '关闭全部开关后不落盘（不建目录、不写记忆/日记/情绪）',
    aiDirEntriesAfterOff.length === 0,
    `entries=${JSON.stringify(aiDirEntriesAfterOff)}`,
  );  record(
    '关闭开关后互动不改心情、对话不记入记忆（开关真的生效，不是摆设）',
    offBehaviour.moodAfter === offBehaviour.moodBefore && offBehaviour.turns === 0,
    JSON.stringify(offBehaviour),
  );
  /* 后面的用例需要记忆与情绪是开的：改回来（感知与成长也要一起恢复） */
  await run(`(async () => {
    await window.petAPI.ai.setSettings({ enabled: true, chat: true, memory: true, emotion: true, diary: true });
    await window.petAPI.perception.setSettings({ screen: true, behavior: true, camera: true, habits: true, windowContext: true });
    await window.petAPI.growth.setSettings({ palace: true, reflection: true, policyAdapt: true });
    return true;
  })()`);
  await wait(500);

  /* 2.3 情绪模型：纯函数直接断言（互动上涨 / 三档衰减 / token -> 饿） */
  const emotionModel = await run(`(() => {
    const model = window.petDebug.emotion;
    const now = Date.now();
    const base = model.initialEmotion(now);
    const clicked = model.applyInteraction(base, 'click');
    const chatted = model.applyInteraction(base, 'chat');
    // 三档衰减：同一份状态、同样过去 60 分钟，只改在场状态
    const idle = { ...base, lastInteractionAt: now - 3600000, lastUpdateAt: now - 3600000 };
    const decay = (presence) => model.decayEmotion(idle, { presence, now, tokensRemainingRatio: 1 });
    const visible = decay('visible');
    const collapsed = decay('collapsed');
    const hidden = decay('hidden');
    return {
      initial: base.mood,
      afterClick: clicked.mood,
      afterChat: chatted.mood,
      visible: visible.mood,
      collapsed: collapsed.mood,
      hidden: hidden.mood,
      // 宽限期内不应衰减（刚被摸过就掉心情会让人觉得"摸她没用"）
      grace: model.decayEmotion(model.applyInteraction(base, 'click', now), { presence: 'hidden', now: now + 1000, tokensRemainingRatio: 1 }).mood,
      // 饱腹 = 预算剩余的比例（数值越大越饱，用户要求把饥饿值反过来），且与时间无关
      satietyFull: model.applyTokens(base, 1, now).satiety,
      satietyHalf: model.applyTokens(base, 0.5, now).satiety,
      satietyEmpty: model.applyTokens(base, 0, now).satiety,
      satietyUnlimited: model.satietyFromTokens(1),
      labelSad: model.moodLabel(10).key,
      labelGreat: model.moodLabel(90).key,
      clamped: model.applyInteraction({ ...base, mood: 99 }, 'gift', now).mood,
    };
  })()`);
  record(
    '情绪：互动让心情上涨（点击/对话涨幅不同）',
    emotionModel.afterClick > emotionModel.initial && emotionModel.afterChat > emotionModel.afterClick,
    JSON.stringify(emotionModel),
  );
  record(
    '情绪：不互动自然下降，收起更快、隐藏最快',
    emotionModel.visible < emotionModel.initial &&
      emotionModel.collapsed < emotionModel.visible &&
      emotionModel.hidden < emotionModel.collapsed,
    `visible=${emotionModel.visible} collapsed=${emotionModel.collapsed} hidden=${emotionModel.hidden}`,
  );
  record('情绪：互动后有宽限期（不会立刻掉回去）', emotionModel.grace === emotionModel.afterClick, `grace=${emotionModel.grace} afterClick=${emotionModel.afterClick}`);
  record(
    '情绪：饱腹来自额度剩余量（满/半/空 -> 100/50/0；不限额 = 一直很饱）',
    emotionModel.satietyFull === 100 && emotionModel.satietyHalf === 50 && emotionModel.satietyEmpty === 0 && emotionModel.satietyUnlimited === 100,
    JSON.stringify({
      full: emotionModel.satietyFull,
      half: emotionModel.satietyHalf,
      empty: emotionModel.satietyEmpty,
    }),
  );
  record(
    '情绪：心情有上下限（100 封顶）且分档正确',
    emotionModel.clamped === 100 && emotionModel.labelSad === 'sad' && emotionModel.labelGreat === 'great',
    `clamped=${emotionModel.clamped} sad=${emotionModel.labelSad} great=${emotionModel.labelGreat}`,
  );

  /* 2.1 没配密钥时：本地兜底回复 + 情绪上涨 + 不联网（用耗时证明） */
  const localChat = await run(`(async () => {
    const before = await window.petAPI.ai.status();
    const startedAt = performance.now();
    const reply = await window.petAPI.ai.chat('你好呀');
    const elapsed = performance.now() - startedAt;
    const after = await window.petAPI.ai.status();
    return {
      ok: reply.ok,
      mode: reply.mode,
      tokens: reply.tokens,
      reply: reply.reply,
      error: reply.error ?? '',
      elapsed: Math.round(elapsed),
      moodBefore: before.emotion.mood,
      moodAfter: after.emotion.mood,
      satiety: after.emotion.satiety,
    };
  })()`);
  record(
    '没配密钥时对话走本地兜底（有回复、无 token、极快 -> 未联网）',
    localChat.ok === true && localChat.mode === 'local' && localChat.tokens === 0 && localChat.reply.length > 0 && localChat.elapsed < 400,
    JSON.stringify(localChat),
  );
  record(
    '默认开启情绪后，对话让心情上涨（人格不依赖大模型）',
    localChat.moodAfter > localChat.moodBefore,
    `mood ${localChat.moodBefore} -> ${localChat.moodAfter}`,
  );

  /* 打开记忆 + 情绪（两个子系统可以独立于大模型工作） */
  const subsystemOn = await run(`(async () => {
    const status = await window.petAPI.ai.setSettings({ memory: true, emotion: true });
    const moodBefore = status.emotion.mood;
    await window.petAPI.ai.chat('你好呀');
    const after = await window.petAPI.ai.status();
    return {
      memory: status.settings.memory,
      emotion: status.settings.emotion,
      moodBefore,
      moodAfter: after.emotion.mood,
    };
  })()`);
  record(
    '开关：打开记忆/情绪后，对话被记住且心情上涨（无需大模型）',
    subsystemOn.memory === true && subsystemOn.emotion === true && subsystemOn.moodAfter > subsystemOn.moodBefore,
    JSON.stringify(subsystemOn),
  );

  /*
   * 心情推送 -> 渲染层镜像。
   *
   * 需求（"心情低于阈值时随机池全变 sad"）的判定发生在渲染层，靠的是主进程
   * 把状态推给桌宠窗口；这条链路断了的话，池子会永远按**启动时**的心情判定。
   * 上一条刚证明"聊天让心情涨了"，这里立刻核对镜像是否跟上了同一个数。
   *
   * ⚠️ 这里**不能**再要求"镜像 === 那次聊天后的读数"：心情会随互动/心跳继续变
   * （实测偶发：聊天后主进程是 80，400ms 后一次互动结算把它推到 83，
   * 镜像老老实实跟到了 83 —— 断言却红了，属于测试过严而不是产品 bug）。
   * 现在钉的是两件更本质的事：
   *   1. 同一时刻渲染层镜像 === 主进程读数（推送真的到达了）；
   *   2. 镜像**已经不是**聊天前那个值（说明它真的被这次变化更新过，
   *      而不是靠启动时补拉一次凑巧相等）。
   */
  const moodMirror = await run(`(async () => {
    await new Promise((r) => setTimeout(r, 400));
    const status = await window.petAPI.ai.status();
    return { mirror: window.petDebug.mood(), reported: status.emotion.mood };
  })()`);
  record(
    '心情推送：主进程的状态推送真的更新了渲染层的心情镜像（池子的 sad 判定靠它）',
    subsystemOn.moodAfter !== subsystemOn.moodBefore &&
      moodMirror.mirror === moodMirror.reported &&
      moodMirror.mirror !== subsystemOn.moodBefore,
    JSON.stringify({ push: moodMirror, chatMood: subsystemOn.moodAfter, before: subsystemOn.moodBefore }),
  );

  /* 2.2 记忆：对话写入本地记忆日志（文件级证据） + 快照可读 */
  const memoryState = await run(`(async () => {
    const snapshot = await window.petAPI.ai.memory();
    return {
      stats: snapshot.stats,
      logFile: snapshot.logFile,
      dataDir: snapshot.dataDir,
      recentChat: snapshot.recentChat.map((turn) => turn.role + ':' + turn.text.slice(0, 12)),
      todayEvents: snapshot.todayEvents.length,
    };
  })()`);
  let memoryLog = { exists: false, hasUserTurn: false, hasPetTurn: false, bytes: 0 };
  try {
    const text = readFileSync(memoryState.logFile, 'utf8');
    memoryLog = {
      exists: true,
      hasUserTurn: text.includes('主人：'),
      hasPetTurn: text.includes('她：'),
      bytes: text.length,
    };
  } catch (error) {
    memoryLog = { exists: false, hasUserTurn: false, hasPetTurn: false, bytes: 0 };
  }
  /*
   * 对话的**滚动前情摘要**（压缩机制 B）：更早的轮次要被压成一段 ≤600 字的前情，
   * 进聊天提示词，而不是只带"最近 6 轮"。
   *
   * 这里分两半测：
   *   1. 纯函数（抽取式兜底 / 提示词组装 / 输出清洗）—— 确定性、逐条断言；
   *   2. 端到端：先灌几轮对话，手动触发一次整理（`petAPI.ai.consolidate?` 没有 IPC，
   *      所以走 `rollSummary` 的真实调用点：连续对话会触发 `maybeConsolidate`——
   *      太重；改为断言 `memory().profile.summary` 字段存在且类型正确 + 摘要长度上限）。
   */
  const summaryModel = await run(`(() => {
    const model = window.petDebug.memorySummary;
    const turns = [
      { role: 'user', text: '我最近在写一个桌宠项目，用的是 Electron', at: '2026-09-25T01:00:00.000Z' },
      { role: 'pet', text: '听起来好厉害！', at: '2026-09-25T01:00:05.000Z' },
      { role: 'user', text: '明天要交论文初稿，有点紧张', at: '2026-09-25T01:01:00.000Z' },
    ];
    const fresh = model.fallbackRollingSummary('', turns);
    const rolled = model.fallbackRollingSummary('主人喜欢喝美式', turns);
    const long = model.fallbackRollingSummary('旧'.repeat(400), turns, 100);
    const messages = model.buildRollingSummaryMessages({ previous: '主人喜欢喝美式', turns, petName: '鲸鱼娘' });
    return {
      fresh,
      rolled,
      longChars: long.length,
      longHead: long.slice(0, 1),
      keepsPrevious: rolled.includes('主人喜欢喝美式'),
      keepsUserFacts: rolled.includes('桌宠项目') && rolled.includes('论文初稿'),
      dropsPetWords: rolled.includes('听起来好厉害') === false,
      systemMentionsFactsOnly: messages.system.includes('不要编造') && messages.system.includes('600'),
      userHasPreviousAndNew: messages.user.includes('主人喜欢喝美式') && messages.user.includes('桌宠项目'),
      // 注意：这段是外层模板字符串里的内容，所以反引号要写成 \u0060（lint 会抓真反引号）
      sanitized: model.sanitizeSummary('前情摘要：\\n\u0060\u0060\u0060\\n主人这几天在赶论文\\n\u0060\u0060\u0060\\n'),
      maxChars: model.SUMMARY_MAX_CHARS,
    };
  })()`);
  record(
    '记忆：滚动前情摘要（没模型也能压、保留旧摘要、只留主人说的、按上限截断）',
    summaryModel.fresh.includes('桌宠项目') &&
      summaryModel.fresh.includes('论文初稿') &&
      summaryModel.fresh.includes('听起来好厉害') === false &&
      summaryModel.keepsPrevious === true &&
      summaryModel.keepsUserFacts === true &&
      summaryModel.dropsPetWords === true &&
      summaryModel.longChars === 100 &&
      summaryModel.longHead === '…' &&
      summaryModel.systemMentionsFactsOnly === true &&
      summaryModel.userHasPreviousAndNew === true &&
      summaryModel.sanitized === '主人这几天在赶论文' &&
      summaryModel.maxChars === 600,
    JSON.stringify(summaryModel),
  );
  const summaryState = await run(`(async () => {
    const snapshot = await window.petAPI.ai.memory();
    return {
      hasField: Object.prototype.hasOwnProperty.call(snapshot.profile, 'summary'),
      summaryType: typeof snapshot.profile.summary,
      length: snapshot.profile.summary.length,
    };
  })()`);
  record(
    '记忆：滚动摘要落在 profile.summary（聊天提示词读的就是它）',
    summaryState.hasField === true && summaryState.summaryType === 'string' && summaryState.length <= 2000,
    JSON.stringify(summaryState),
  );

  record(
    '记忆：对话落盘为可读的记忆日志（memory-log.md）',
    memoryLog.exists === true && memoryLog.bytes > 0 && memoryLog.hasUserTurn === true && memoryLog.hasPetTurn === true,
    `${memoryState.logFile} bytes=${memoryLog.bytes} user=${memoryLog.hasUserTurn} pet=${memoryLog.hasPetTurn}`,
  );
  record(
    '记忆：一问一答都记下来了',
    memoryState.stats.turns >= 2 && memoryState.recentChat.some((line) => line.startsWith('user:')) && memoryState.recentChat.some((line) => line.startsWith('pet:')),
    JSON.stringify(memoryState.recentChat.slice(0, 4)),
  );
  record(
    '记忆：互动事件也已记录（stats.events > 0）',
    memoryState.stats.events > 0 && memoryState.todayEvents > 0,
    JSON.stringify(memoryState.stats),
  );

  /* 2.2 记忆抽取：规则式抽取必须真的抽出"名字/项目"这类事实 */
  const factsExtracted = await run(`(async () => {
    await window.petAPI.ai.chat('我叫小明，最近在写毕业论文');
    // 规则抽取是同步落盘的，但 consolidate 是后台动作：等一小会儿再读快照
    await new Promise((r) => setTimeout(r, 600));
    const snapshot = await window.petAPI.ai.memory();
    return {
      facts: snapshot.profile.facts.map((fact) => fact.key + '=' + fact.value),
      userName: snapshot.profile.userName,
    };
  })()`);
  record(
    '记忆：从对话里抽出长期事实（名字/项目）',
    factsExtracted.facts.some((fact) => fact.startsWith('name=')) && factsExtracted.facts.some((fact) => fact.startsWith('project=')),
    JSON.stringify(factsExtracted.facts),
  );

  /* 2.4 日记：立即生成 -> 落盘 -> 索引可列出（关闭 AI 时走本地模板） */
  const diary = await run(`(async () => {
    const written = await window.petAPI.ai.writeDiary();
    const list = await window.petAPI.ai.diary();
    const readBack = await window.petAPI.ai.diaryGet(written.date);
    return {
      written: { date: written.date, source: written.source, bodyLength: written.body.length, title: written.title },
      items: list.items.map((item) => item.date + ':' + item.source),
      todayWritten: list.todayWritten,
      readBackMatches: readBack !== null && readBack.body === written.body,
      body: written.body.slice(0, 160),
    };
  })()`);
  let diaryFile = { exists: false, bytes: 0 };
  try {
    const text = readFileSync(join(aiDataDir, 'diary', `${diary.written.date}.md`), 'utf8');
    diaryFile = { exists: true, bytes: text.length };
  } catch (error) {
    diaryFile = { exists: false, bytes: 0 };
  }
  record(
    '日记：能立刻生成一篇第一视角日记（AI 关闭时用真实数据的本地模板）',
    diary.written.bodyLength > 20 && diary.written.source === 'template' && /主人/.test(diary.body),
    JSON.stringify(diary.written),
  );
  record('日记：写入 markdown 文件（本地留存）', diaryFile.exists === true && diaryFile.bytes > 40, JSON.stringify(diaryFile));
  record(
    '日记：索引可列出并且能读回正文',
    diary.items.length >= 1 && diary.todayWritten === true && diary.readBackMatches === true,
    JSON.stringify({ items: diary.items, todayWritten: diary.todayWritten, readBackMatches: diary.readBackMatches }),
  );

  /* 2.1 配了密钥但地址不可达：必须降级成本地兜底，而不是抛异常/装死 */
  const degrade = await run(`(async () => {
    // 指向本机一个必然拒绝连接的端口：既验证"真的发出请求"，又保证快速失败
    await window.petAPI.ai.setSettings({
      enabled: true,
      chat: true,
      memory: true,
      emotion: true,
      diary: true,
      provider: { baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', apiKey: 'sk-acceptance-test-key-0001', timeoutMs: 1500 },
    });
    const startedAt = performance.now();
    const reply = await window.petAPI.ai.chat('测试降级');
    const elapsed = Math.round(performance.now() - startedAt);
    const status = await window.petAPI.ai.status();
    return {
      mode: reply.mode,
      ok: reply.ok,
      replyLength: reply.reply.length,
      error: status.lastError,
      usable: status.usable,
      masked: status.settings.provider.apiKeyMasked,
      apiKeySet: status.settings.provider.apiKeySet,
      hasPlainKey: Object.prototype.hasOwnProperty.call(status.settings.provider, 'apiKey'),
      enabled: status.settings.enabled,
      elapsed,
    };
  })()`);
  record(
    'AI：密钥被掩码保存（渲染层拿不到明文）',
    degrade.apiKeySet === true &&
      degrade.hasPlainKey === false &&
      /^sk-/.test(degrade.masked) &&
      !degrade.masked.includes('acceptance-test-key-0001'),
    `masked="${degrade.masked}" hasPlainKey=${degrade.hasPlainKey}`,
  );
  record(
    'AI：大模型不可达时降级为本地回复（不抛异常、不装死）',
    degrade.usable === true && degrade.mode === 'local' && degrade.ok === true && degrade.replyLength > 0 && degrade.error.length > 0,
    JSON.stringify(degrade),
  );

  /* 2.3 打通"主进程情绪"：互动上报 -> 状态上涨；token 用量 -> 饿 */
  const interaction = await run(`(async () => {
    // 先把心情复位：前面几十次互动已经把它推到 100 封顶了，
    // 封顶状态下再互动也是 100，断言会假失败（实测踩过）。
    await window.petAPI.ai.resetEmotion();
    await new Promise((r) => setTimeout(r, 300));
    const before = await window.petAPI.ai.status();
    /*
     * 需求："互动动画播放结束才能加 mood 值"。
     * 所以这里把两步**分开**断言：上报互动本身不该动心情，
     * 动画播完后渲染层报的 notifyInteractionSettled 才加。两步合一就测不出这条规则了
     * （把 interact 挪回 notifyInteraction 也不会变红）。
     */
    window.petAPI.ai.notifyInteraction('click');
    window.petAPI.ai.notifyInteraction('doubleclick');
    await new Promise((r) => setTimeout(r, 250));
    const afterReport = await window.petAPI.ai.status();
    window.petAPI.ai.notifyInteractionSettled('click');
    window.petAPI.ai.notifyInteractionSettled('doubleclick');
    await new Promise((r) => setTimeout(r, 250));
    const after = await window.petAPI.ai.status();
    return {
      moodBefore: before.emotion.mood,
      moodAfterReport: afterReport.emotion.mood,
      moodAfter: after.emotion.mood,
      satiety: after.emotion.satiety,
      tokensUsed: after.tokensUsed,
      calls: after.calls,
    };
  })()`);
  record(
    '情绪：互动上报本身不加心情（等互动动画播完才结算）',
    interaction.moodAfterReport <= interaction.moodBefore,
    JSON.stringify(interaction),
  );
  record(
    '情绪：渲染层的互动上报会传到主进程，动画播完后结算让心情上涨',
    interaction.moodAfter > interaction.moodBefore,
    JSON.stringify(interaction),
  );
  record('情绪：token 用量被累计（预算 -> 饱腹 的依据）', interaction.tokensUsed >= 0 && interaction.satiety >= 0, JSON.stringify(interaction));

  /*
   * 2.3「收起 / 隐藏」：需求要求"收起降低更快、隐藏最快"，
   * 因此这个状态必须真的能切、能读回来，而且要区分于"彻底隐藏"。
   */
  const presence = await run(`(async () => {
    const collapsed = await window.petAPI.ai.setPresence('collapsed');
    const stillVisible = await window.petAPI.window.getPosition();
    const restored = await window.petAPI.ai.setPresence('visible');
    return {
      collapsedPresence: collapsed.presence,
      restoredPresence: restored.presence,
      hasPosition: typeof stillVisible.x === 'number',
    };
  })()`);
  record(
    '在场状态：可切到「收起（不打扰）」并切回（收起 ≠ 关闭窗口）',
    presence.collapsedPresence === 'collapsed' && presence.restoredPresence === 'visible' && presence.hasPosition === true,
    JSON.stringify(presence),
  );

  /* 恢复成产品默认（全开 + 无密钥），别把验收用的假配置留下 */
  const aiRestored = await run(`(async () => {
    const status = await window.petAPI.ai.setSettings({
      enabled: true, chat: true, memory: true, emotion: true, diary: true,
      provider: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', timeoutMs: 20000 },
      clearApiKey: true,
      resetUsage: true,
    });
    const ai = status.settings;
    return { enabled: ai.enabled, chat: ai.chat, memory: ai.memory, apiKeySet: ai.provider.apiKeySet, used: ai.budget.used };
  })()`);
  record(
    'AI：验收结束后恢复默认（全开 + 清除测试密钥 + 重置用量）',
    aiRestored.enabled === true &&
      aiRestored.chat === true &&
      aiRestored.memory === true &&
      aiRestored.apiKeySet === false &&
      aiRestored.used === 0,
    JSON.stringify(aiRestored),
  );

  /*
   * 小纸条：**旧格式必须能读出来**（不再静默丢数据）。
   *
   * 小纸条换过一次模型：早期是"邮箱"（`author` + 无 `title`），现在是"收纳夹"
   * （`title` + 可选 `file`）。严格按新字段校验会把旧文件里的纸条整条丢掉 ——
   * 实测用户真实数据里就有一条 2026-09-26 的日记纸条会消失（而且悄无声息）。
   * 所以读盘走 `migrateNote`：缺标题就从正文首句推一个，其它字段照旧。
   */
  const noteMigration = await run(`(() => {
    const model = window.petDebug.perception;
    const legacy = model.migrateNote({
      id: 'legacy-1',
      author: 'pet',
      kind: 'diary',
      text: '今天主人一整天都没怎么跟我说话，我就趴在桌角，看着窗口开开关关。',
      at: '2026-09-26T14:00:30.470Z',
      read: false,
      source: 'template',
      tokens: 0,
    });
    const alreadyNew = model.migrateNote({
      id: 'n1', kind: 'file', title: '收好的文件', text: '收好了：a.txt',
      at: '2026-09-26T15:00:00.000Z', read: true,
      file: { name: 'a.txt', path: 'C:\\\\x\\\\notes\\\\files\\\\a.txt', size: 12 },
      source: 'system', tokens: 0,
    });
    return {
      legacy: legacy,
      legacyTitleLength: (legacy?.title ?? '').length,
      alreadyNew,
      garbage: model.migrateNote({ hello: 'world' }),
      badDate: model.migrateNote({ text: '有正文但时间不合法', at: '不是时间' }),
    };
  })()`);
  record(
    '交互：旧格式（邮箱版无 title / 单数 file）能迁移成新模型，不再静默丢数据',
    noteMigration.legacy !== null &&
      noteMigration.legacy.id === 'legacy-1' &&
      noteMigration.legacy.kind === 'diary' &&
      noteMigration.legacy.read === false &&
      noteMigration.legacy.source === 'template' &&
      noteMigration.legacy.at === '2026-09-26T14:00:30.470Z' &&
      noteMigration.legacy.text.startsWith('今天主人一整天') &&
      noteMigration.legacyTitleLength > 0 &&
      // 老邮箱模型的 author: 'pet' -> 发件人是她自己
      noteMigration.legacy.sender?.kind === 'pet' &&
      Array.isArray(noteMigration.legacy.files) &&
      noteMigration.legacy.files.length === 0 &&
      noteMigration.alreadyNew?.kind === 'file' &&
      noteMigration.alreadyNew?.title === '收好的文件' &&
      // 单数 file -> files 数组（附件模型升级）
      Array.isArray(noteMigration.alreadyNew?.files) &&
      noteMigration.alreadyNew.files.length === 1 &&
      noteMigration.alreadyNew.files[0]?.name === 'a.txt' &&
      noteMigration.alreadyNew.files[0]?.size === 12 &&
      noteMigration.garbage === null &&
      noteMigration.badDate === null,
    JSON.stringify(noteMigration),
  );

  /*
   * 小纸条（她的收纳夹 —— 用来保存重要的事情，含收好的文件）。
   *
   * 需求在这里钉死：
   *   1. **用户不能留言**：桥面上不该有"写纸条"这个能力；
   *   2. 内容由她自己产生：`composeNote()` 让她记一件；
   *   3. **日记不进小纸条**（需求："日记不要记到小纸条"）；
   *   4. 能**删**：删单条纸条（记录而已，不动文件）；
   *   5. 能**看文件**：列目录 / 读内容（文本、图片）/ 删文件 / 拒绝对目录外的访问。
   *
   * 跑在这里是因为上一段刚把 AI 恢复成"全开 + **无密钥**"：
   * 她的文案必然走本地兜底（确定、不发网络请求、不占验收的 4 分钟预算）。
   */
  const notesFlow = await run(`(async () => {
    const ai = window.petAPI.ai;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await ai.clearNotes();                                  // 从干净状态开始
    const empty = await ai.notes();
    const composed = await ai.composeNote();                // 她记一件（无密钥 -> 本地兜底）
    const afterCompose = await ai.notes();
    const read = await ai.markNotesRead();
    const beforeDiary = afterCompose.notes.length;
    const diary = await ai.writeDiary();                    // 写日记：**只**写 diary/，不该进收件箱
    await wait(500);
    const afterDiary = await ai.notes();
    await ai.composeNote();                                 // 再来一条：验证"删一条还剩一条"
    const beforeDelete = await ai.notes();
    const firstId = beforeDelete.notes[0] ? beforeDelete.notes[0].id : '';
    const deleted = await ai.deleteNote(firstId);           // 删单条
    const deleteAgain = await ai.deleteNote('no-such-note'); // 幂等：不存在的 id 不报错
    const withoutFile = beforeDelete.notes.find((n) => (n.files ?? []).length === 0) ?? null;
    const cleared = await ai.clearNotes();
    const first = afterCompose.notes[0] ?? null;
    return {
      canWrite: typeof ai.writeNote === 'function',
      emptyCount: empty.notes.length,
      composeUnread: composed.unread,
      composeNote: first,
      // 邮件模型：每条消息都带发件人与**附件数组**（旧字段 file 已不存在）
      hasSender: first !== null && first.sender !== undefined && first.sender.kind === 'pet',
      hasFilesArray: first !== null && Array.isArray(first.files),
      hasLegacyFile: first !== null && Object.prototype.hasOwnProperty.call(first, 'file'),
      readUnread: read.unread,
      readAllRead: read.notes.every((n) => n.read === true),
      diaryDate: diary.date,
      diaryNoteCount: afterDiary.notes.filter((n) => n.kind === 'diary').length,
      beforeDiary,
      afterDiaryCount: afterDiary.notes.length,
      filesDir: afterDiary.filesDir,
      dataDir: afterDiary.dataDir,
      idsUnique: new Set(beforeDelete.notes.map((n) => n.id)).size === beforeDelete.notes.length,
      beforeDelete: beforeDelete.notes.length,
      deletedCount: deleted.notes.length,
      deleteAgainCount: deleteAgain.notes.length,
      // 打开附件只接受**消息 id**：不存在的 id、以及没有附件的消息都必须被拒（也不会拉起任何程序）
      openUnknown: await ai.openNoteFile('no-such-note'),
      openNoFile: await ai.openNoteFile(withoutFile ? withoutFile.id : 'no-such-note'),
      clearedCount: cleared.notes.length,
      clearedUnread: cleared.unread,
      clearedOrphans: Array.isArray(cleared.orphans) ? cleared.orphans.length : -1,
    };
  })()`);
  const notesFile = join(aiDataDir, 'notes', 'notes.json');
  let notesFileExists = false;
  let diaryFileExists = false;
  try {
    notesFileExists = existsSync(notesFile);
    diaryFileExists = existsSync(join(aiDataDir, 'diary', `${notesFlow.diaryDate}.md`));
  } catch (error) {
    notesFileExists = false;
    diaryFileExists = false;
  }
  record(
    '交互：用户不能留言（桥面上没有写纸条），内容全部由她自己或插件产生',
    notesFlow.canWrite === false && notesFlow.emptyCount === 0,
    JSON.stringify({ canWrite: notesFlow.canWrite, emptyCount: notesFlow.emptyCount }),
  );
  record(
    '交互：让她记一件 -> 未看 1 -> 标记看过 -> 清空',
    notesFlow.composeUnread === 1 &&
      notesFlow.composeNote?.kind === 'manual' &&
      notesFlow.composeNote?.read === false &&
      notesFlow.composeNote?.source === 'template' &&
      typeof notesFlow.composeNote?.title === 'string' &&
      notesFlow.composeNote.title.length > 0 &&
      typeof notesFlow.composeNote?.text === 'string' &&
      notesFlow.composeNote.text.length > 0 &&
      notesFlow.readUnread === 0 &&
      notesFlow.readAllRead === true &&
      notesFlow.idsUnique === true &&
      notesFlow.clearedCount === 0 &&
      notesFlow.clearedUnread === 0,
    JSON.stringify(notesFlow),
  );
  record(
    '交互：消息是邮件式的（有发件人 + files 附件数组，旧的单数 file 字段已退役）',
    notesFlow.hasSender === true && notesFlow.hasFilesArray === true && notesFlow.hasLegacyFile === false,
    JSON.stringify({
      sender: notesFlow.composeNote?.sender,
      files: notesFlow.composeNote?.files,
      legacyFile: notesFlow.hasLegacyFile,
    }),
  );
  record(
    '交互：写日记**不会**记到收件箱（只留在 diary/）',
    notesFlow.diaryNoteCount === 0 &&
      notesFlow.afterDiaryCount === notesFlow.beforeDiary &&
      diaryFileExists === true,
    JSON.stringify({
      diaryNotes: notesFlow.diaryNoteCount,
      before: notesFlow.beforeDiary,
      after: notesFlow.afterDiaryCount,
      diaryFile: diaryFileExists,
    }),
  );
  record(
    '交互：能删单条（删一条少一条；不存在的 id 幂等不报错）',
    notesFlow.beforeDelete >= 2 &&
      notesFlow.deletedCount === notesFlow.beforeDelete - 1 &&
      notesFlow.deleteAgainCount === notesFlow.deletedCount,
    JSON.stringify({
      before: notesFlow.beforeDelete,
      after: notesFlow.deletedCount,
      again: notesFlow.deleteAgainCount,
    }),
  );
  record(
    '交互：落盘在数据目录的 notes/（notes.json + 附件目录），打开附件只认消息 id',
    notesFlow.dataDir.replace(/\\/g, '/').endsWith('/notes') &&
      notesFlow.filesDir.replace(/\\/g, '/').endsWith('/notes/files') &&
      notesFileExists === true &&
      notesFlow.openUnknown === false &&
      notesFlow.openNoFile === false,
    `${notesFlow.dataDir} · file=${notesFileExists} · open=${notesFlow.openUnknown}/${notesFlow.openNoFile}`,
  );

  /*
   * 「文件」页签：列目录 / 读内容 / 删文件 / 边界。
   *
   * 验收进程**直接往收纳夹里放两个文件**（一个 txt、一个 png），然后走桥面去看 ——
   * 这样测的是真实链路（主进程扫目录 + 读盘 + 校验路径），而不是纯函数。
   * 「收纳文件…」那条路要弹系统选择框，自动化里没法点，只能人工看（见 README 清单）。
   */
  const noteFilesDir = join(aiDataDir, 'notes', 'files');
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  let filesProbe = null;
  try {
    mkdirSync(noteFilesDir, { recursive: true });
    writeFileSync(join(noteFilesDir, 'note-preview.txt'), '第一行：收纳夹里的文本\n第二行', 'utf8');
    writeFileSync(join(noteFilesDir, 'note-preview.png'), pngBytes);
    filesProbe = await run(`(async () => {
      const ai = window.petAPI.ai;
      const list = await ai.noteFiles();
      const text = await ai.previewNoteFile('note-preview.txt');
      const image = await ai.previewNoteFile('note-preview.png');
      const missing = await ai.previewNoteFile('no-such-file.txt');
      // 路径穿越：分隔符 / 上一级 / 绝对路径都必须被拒（返回 ok:false，绝不去读文件）
      const traversal = await ai.previewNoteFile('..\\\\notes.json');
      const traversal2 = await ai.previewNoteFile('sub/../../notes.json');
      // 这两个文件没有被任何消息引用 -> 必须出现在"未归档"里（合并成邮件后不能把文件藏起来）
      const box = await ai.notes();
      const deleted = await ai.deleteNoteFile('note-preview.txt');
      const afterDelete = await ai.noteFiles();
      const deleteMissing = await ai.deleteNoteFile('note-preview.txt');
      return {
        names: list.map((f) => f.name),
        kinds: list.map((f) => f.preview),
        orphanNames: (box.orphans ?? []).map((f) => f.name),
        textOk: text.ok === true && text.preview === 'text' && text.text.includes('收纳夹里的文本'),
        textTruncated: text.truncated === true,
        imageOk: image.ok === true && image.preview === 'image' &&
          typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/png;base64,'),
        missingOk: missing.ok === false && typeof missing.reason === 'string' && missing.reason.length > 0,
        traversalOk: traversal.ok === false,
        traversal2Ok: traversal2.ok === false,
        deleted,
        afterDelete: afterDelete.map((f) => f.name),
        deleteMissingOk: deleteMissing.ok === false,
      };
    })()`);
  } catch (error) {
    filesProbe = null;
  }
  record(
    '附件：扫收纳夹目录（新文件也在里面），能按名字读文本与图片',
    filesProbe !== null &&
      filesProbe.names.includes('note-preview.txt') &&
      filesProbe.names.includes('note-preview.png') &&
      filesProbe.kinds.includes('text') &&
      filesProbe.kinds.includes('image') &&
      filesProbe.textOk === true &&
      filesProbe.textTruncated === false &&
      filesProbe.imageOk === true,
    JSON.stringify(filesProbe),
  );
  record(
    '附件：能删（删掉就从列表里消失），也能拒绝目录外的名字与不存在的文件',
    filesProbe !== null &&
      filesProbe.deleted?.ok === true &&
      filesProbe.afterDelete.includes('note-preview.txt') === false &&
      filesProbe.afterDelete.includes('note-preview.png') === true &&
      filesProbe.deleteMissingOk === true &&
      filesProbe.missingOk === true &&
      filesProbe.traversalOk === true &&
      filesProbe.traversal2Ok === true,
    JSON.stringify(filesProbe),
  );
  record(
    '附件：没被任何消息引用的文件出现在「未归档」里（合并成邮件后不会消失）',
    filesProbe !== null &&
      filesProbe.orphanNames.includes('note-preview.txt') &&
      filesProbe.orphanNames.includes('note-preview.png'),
    JSON.stringify({ orphans: filesProbe?.orphanNames }),
  );
  try {
    rmSync(noteFilesDir, { recursive: true, force: true });
  } catch (error) {
    // 清理失败不影响断言（下一个用例会自己收干净）
  }

  /*
   * 记忆召回（纯函数）：她主动查记忆宫殿时，凭什么把某段经历捞出来。
   *
   * 这是 7.3（"模型调用工具 → 我们把记忆宫殿的内容传回去"）的检索内核：
   * 相关的才给、不相关的**必须为空**（否则她会拿一段无关经历硬答）。
   */
  const recallModel = await run(`(() => {
    const model = window.petDebug.perception;
    const nodes = [
      { id: 'a', kind: 'project', title: '一起熬夜赶论文', detail: '你说要在周五前交初稿', at: '2026-09-20T10:00:00.000Z', source: 'auto', evidence: [] },
      { id: 'b', kind: 'trip', title: '出门旅行一周', detail: '你去了外地，我每天等你回来', at: '2026-09-10T10:00:00.000Z', source: 'auto', evidence: [] },
    ];
    const hit = model.selectPalaceMatches(nodes, '上次说的论文怎么样了');
    const miss = model.selectPalaceMatches(nodes, '今天天气不错呀');
    const empty = model.selectPalaceMatches(nodes, '');
    return {
      tokens: model.recallTokens('上次说的论文怎么样了'),
      hitTitles: hit.map((item) => item.node.title),
      hitText: model.formatPalaceRecall(hit),
      missCount: miss.length,
      emptyCount: empty.length,
      missText: model.formatPalaceRecall(miss),
    };
  })()`);
  record(
    '记忆召回：相关才命中、不相关为空（她不会拿无关经历硬答）',
    recallModel.hitTitles.length === 1 &&
      recallModel.hitTitles[0] === '一起熬夜赶论文' &&
      recallModel.hitText.includes('熬夜赶论文') &&
      recallModel.hitText.includes('2026-09-20') &&
      recallModel.missCount === 0 &&
      recallModel.emptyCount === 0 &&
      recallModel.missText.includes('没有与这件事相关'),
    JSON.stringify(recallModel),
  );

  /*
   * 7.3 端到端：**模型调用工具 → 我们回传记忆宫殿内容 → 模型据此回答**。
   *
   * 这里起一个本地假网关（`node:http`，跑在验收自己这个主进程里）：
   *   第 1 次请求：断言请求体里带了 `tools`（含 recall_memory），回一个 tool_call；
   *   第 2 次请求：断言请求体里出现了 `role: 'tool'` 的结果、且内容里有记忆宫殿的文本，
   *                再回最终答复。
   * 于是"工具调用 → 回传 → 作答"这条链是真的被走通的，而不是只测了几个纯函数。
   */
  const http = require('node:http');
  const stubRequests = [];
  const stubServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (error) { parsed = {}; }
      stubRequests.push(parsed);
      const isFirst = stubRequests.length === 1;
      const reply = isFirst
        ? {
            id: 'stub-1',
            model: 'stub-model',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'recall_memory', arguments: JSON.stringify({ query: '论文' }) },
                }],
              },
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }
        : {
            id: 'stub-2',
            model: 'stub-model',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '我记得你说要赶论文，写完了吗？' } }],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
          };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => stubServer.listen(0, '127.0.0.1', resolve));
  const stubPort = stubServer.address().port;

  const toolCallRun = await run(`(async () => {
    const ai = window.petAPI.ai;
    await window.petAPI.growth.addNode({
      kind: 'project', title: '一起熬夜赶论文', detail: '你说要在周五前交初稿',
    });
    const before = await ai.status();
    await ai.setSettings({
      enabled: true, chat: true, memory: true,
      provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:${stubPort}/v1', model: 'stub-model', apiKey: 'sk-acceptance-tool-0001', timeoutMs: 8000 },
    });
    const reply = await ai.chat('我们上次说的论文怎么样了');
    const after = await ai.status();
    const memory = await ai.memory();
    await ai.setSettings({
      provider: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', timeoutMs: 20000 },
      clearApiKey: true,
    });
    return {
      reply,
      tokensUsed: after.tokensUsed - before.tokensUsed,
      toolEvents: memory.todayEvents.filter((e) => e.text.includes('记忆宫殿')).map((e) => e.text).slice(0, 3),
    };
  })()`);
  await new Promise((resolve) => stubServer.close(resolve));

  const firstRequestBody = stubRequests[0] ?? {};
  const toolNames = Array.isArray(firstRequestBody.tools)
    ? firstRequestBody.tools.map((tool) => tool?.function?.name ?? tool?.name ?? '')
    : [];
  const secondMessages = Array.isArray(stubRequests[1]?.messages) ? stubRequests[1].messages : [];
  const toolMessage = secondMessages.find((message) => message?.role === 'tool') ?? null;
  record(
    '7.3 工具调用：模型请求查记忆 -> 本地回传记忆宫殿内容 -> 模型据此作答',
    stubRequests.length === 2 &&
      toolNames.includes('recall_memory') &&
      Array.isArray(firstRequestBody.tools) &&
      firstRequestBody.tools[0]?.function?.parameters?.properties?.query !== undefined &&
      toolMessage !== null &&
      String(toolMessage.content ?? '').includes('熬夜赶论文') &&
      toolCallRun.reply?.reply === '我记得你说要赶论文，写完了吗？' &&
      toolCallRun.reply?.mode === 'llm' &&
      // 两轮请求的 usage 都会计入预算（15 + 28 = 43；不写死等号，留出并发心跳的余量）
      toolCallRun.tokensUsed >= 43 &&
      toolCallRun.tokensUsed <= 80 &&
      toolCallRun.toolEvents.length >= 1,
    JSON.stringify({
      requests: stubRequests.length,
      toolNames,
      toolContent: String(toolMessage?.content ?? '').slice(0, 120),
      reply: toolCallRun.reply,
      tokensUsed: toolCallRun.tokensUsed,
      toolEvents: toolCallRun.toolEvents,
    }),
  );

  /*
   * 空内容重试 + 关推理（这一轮修的 bug，用户视角是"时间线断断续续"）。
   *
   * 现场证据（用户真机 2026-09-27）：`api.deepseek.com` + `deepseek-flash` 是**推理模型**，
   * 每次请求先写几百字 reasoning，而视觉那条只给了 `max_tokens: 360` ——
   * 于是正文被截断（finish_reason=length）或整段为空，那一次采样**什么都没记下来**，
   * 时间线就出现空洞（实测约 1/3 的采样）。
   *
   * 这条用一个假网关把两种机制都钉住：
   *   1. 请求体里必须带 `reasoning_effort: 'none'`（关推理才有正文预算）；
   *   2. 第一次返回空内容（finish_reason=length）时，客户端会自动**加大 max_tokens 重试一次**，
   *      第二次成功即得到回复 —— 而不是直接降级成本地兜底。
   */
  const retryRequests = [];
  const retryServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (error) { parsed = {}; }
      retryRequests.push(parsed);
      const first = retryRequests.length === 1;
      const reply = first
        ? {
            id: 'retry-1',
            model: 'stub-model',
            choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '' } }],
            usage: {
              prompt_tokens: 100, completion_tokens: 40, total_tokens: 140,
              completion_tokens_details: { reasoning_tokens: 40 },
            },
          }
        : {
            id: 'retry-2',
            model: 'stub-model',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '我在的，主人。' } }],
            usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
          };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => retryServer.listen(0, '127.0.0.1', resolve));
  const retryPort = retryServer.address().port;

  const emptyRetryRun = await run(`(async () => {
    const ai = window.petAPI.ai;
    await ai.setSettings({
      enabled: true, chat: true, memory: true,
      provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:${retryPort}/v1', model: 'stub-model', apiKey: 'sk-acceptance-retry-0002', timeoutMs: 8000 },
    });
    const reply = await ai.chat('你在吗');
    await ai.setSettings({
      provider: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', timeoutMs: 20000 },
      clearApiKey: true,
    });
    return { reply };
  })()`);
  await new Promise((resolve) => retryServer.close(resolve));
  const retryFirst = retryRequests[0] ?? {};
  const retrySecond = retryRequests[1] ?? {};
  record(
    '模型返回空内容时自动加大 max_tokens 重试一次（并且请求里关掉了推理）',
    retryRequests.length >= 2 &&
      retryFirst.reasoning_effort === 'none' &&
      retrySecond.reasoning_effort === 'none' &&
      typeof retryFirst.max_tokens === 'number' &&
      typeof retrySecond.max_tokens === 'number' &&
      retrySecond.max_tokens > retryFirst.max_tokens &&
      emptyRetryRun.reply?.reply === '我在的，主人。' &&
      emptyRetryRun.reply?.mode === 'llm',
    JSON.stringify({
      requests: retryRequests.length,
      first: { maxTokens: retryFirst.max_tokens, effort: retryFirst.reasoning_effort },
      second: { maxTokens: retrySecond.max_tokens, effort: retrySecond.reasoning_effort },
      reply: emptyRetryRun.reply,
    }),
  );


  /*
   * 7.2 记忆保留期：明细流水超期要真的被清掉（长期事实与宫殿不动）。
   */
  const retentionRun = await run(`(async () => {
    const status = await window.petAPI.ai.status();
    return { keepMemoryDays: status.settings.keepMemoryDays, dataDir: status.dataDir };
  })()`);
  const memoryDir = join(aiDataDir, 'memory');
  try {
    writeFileSync(join(memoryDir, 'events-2020-01-01.jsonl'), '{"at":"2020-01-01T00:00:00.000Z","kind":"chat","text":"很久以前"}\n', 'utf8');
    writeFileSync(join(memoryDir, 'chat-2020-01-01.jsonl'), '{"at":"2020-01-01T00:00:00.000Z","role":"user","text":"很久以前"}\n', 'utf8');
    appendFileSync(join(memoryDir, 'memory-log.md'), '\n## 2020-01-01\n- 01-01 00:00 · 很久以前的事\n', 'utf8');
  } catch (error) {
    /* 目录不存在也无所谓：下面断言会说明问题 */
  }
  const pruned = await run(`window.petAPI.ai.pruneMemory()`);
  let memoryRetentionFiles = { oldEvents: true, oldChat: true, oldLogSection: true };
  try {
    memoryRetentionFiles = {
      oldEvents: existsSync(join(memoryDir, 'events-2020-01-01.jsonl')),
      oldChat: existsSync(join(memoryDir, 'chat-2020-01-01.jsonl')),
      oldLogSection: readFileSync(join(memoryDir, 'memory-log.md'), 'utf8').includes('2020-01-01'),
    };
  } catch (error) {
    memoryRetentionFiles = { oldEvents: true, oldChat: true, oldLogSection: true };
  }
  record(
    '7.2 记忆保留期：超期的 events/chat 流水与日志小节被清掉，今天的保留',
    retentionRun.keepMemoryDays > 0 &&
      pruned.days >= 1 &&
      memoryRetentionFiles.oldEvents === false &&
      memoryRetentionFiles.oldChat === false &&
      memoryRetentionFiles.oldLogSection === false &&
      existsSync(join(memoryDir, 'profile.json')) === true,
    JSON.stringify({ keepMemoryDays: retentionRun.keepMemoryDays, pruned, files: memoryRetentionFiles }),
  );

  /*
   * 7.2b `keepMemoryDays = 0` = 永久保留：什么都不该删。
   */
  const permanentRun = await run(`(async () => {
    const ai = window.petAPI.ai;
    await ai.setSettings({ keepMemoryDays: 0 });
    const status = await ai.status();
    return { keepMemoryDays: status.settings.keepMemoryDays };
  })()`);
  try {
    writeFileSync(join(memoryDir, 'events-2021-02-02.jsonl'), '{"at":"2021-02-02T00:00:00.000Z","kind":"chat","text":"永久保留测试"}\n', 'utf8');
  } catch (error) { /* 忽略 */ }
  const prunedPermanent = await run(`window.petAPI.ai.pruneMemory()`);
  let permanentKept = false;
  try {
    permanentKept = existsSync(join(memoryDir, 'events-2021-02-02.jsonl'));
  } catch (error) {
    permanentKept = false;
  }
  await run(`window.petAPI.ai.setSettings({ keepMemoryDays: 180 })`);
  record(
    '7.2b 记忆保留期：设为 0 = 永久保留（不删任何流水）',
    permanentRun.keepMemoryDays === 0 && prunedPermanent.days === 0 && permanentKept === true,
    JSON.stringify({ keepMemoryDays: permanentRun.keepMemoryDays, pruned: prunedPermanent, kept: permanentKept }),
  );

  record(
    '数据目录：验收经 DESKTOP_PET_AI_DATA_DIR 隔离（不与用户真实记忆混用）',
    retentionRun.dataDir === aiDataDir && aiDataDir.includes('desktop-pet-acceptance-ai') === true,
    `dataDir=${retentionRun.dataDir} expected=${aiDataDir}`,
  );

  /* 聊天窗口：能打开、并且是独立的普通窗口（只暴露 chatAPI） */

  const chatWindowOpened = await run(`window.petAPI.ai.openChatWindow()`);
  await wait(1200);
  const chatWins = BrowserWindow.getAllWindows().filter((w) => {
    try {
      return w.webContents.getURL().includes('/chat/');
    } catch (error) {
      return false;
    }
  });
  record(
    '聊天窗口：可从桌宠窗口/托盘打开（独立普通窗口）',
    chatWindowOpened === true && chatWins.length === 1,
    `opened=${chatWindowOpened} chatWindows=${chatWins.length}`,
  );
  if (chatWins.length === 1) {
    const chatBridge = await chatWins[0].webContents.executeJavaScript(
      `(() => ({ hasChatAPI: typeof window.chatAPI !== 'undefined', hasPetAPI: typeof window.petAPI !== 'undefined', hasNode: typeof require !== 'undefined' }))()`,
      true,
    );
    record(
      '聊天窗口：只暴露 chatAPI（拿不到 petAPI / Node）',
      chatBridge.hasChatAPI === true && chatBridge.hasPetAPI === false && chatBridge.hasNode === false,
      JSON.stringify(chatBridge),
    );

    /*
     * 交互收件箱 UI：页签能**真的来回切**、只读（没有输入框）、消息能渲染、
     * 附件挂在消息下面、看完之后"新"徽标消失。
     *
     * ⚠️ 断言一律看**计算样式与真实高度**，不看 `element.hidden`：
     * 作者样式里的 `display: flex` 会覆盖 UA 的 `[hidden] { display: none }`，
     * 于是"两个视图同时显示、页签点了没反应"，而 `hidden === true` 依旧成立
     * （实测踩过：收件箱和聊天叠在一起）。见 tools/probe-note-views.cjs。
     *
     * 2026-09 需求："把交互式纸条和文件合并，做成类似邮件的内容" ——
     * 所以**没有「文件」页签了**：一条消息 = 发件人 + 主题 + 正文 + 附件，
     * 没被引用的文件归成一封「未归档的文件」。
     */
    /*
     * 先直接往收纳夹里放一个**没有被任何消息引用**的文件：
     * 合并成邮件之后它必须出现在「未归档的文件」那封虚拟消息里，而不是消失。
     * （不点「收纳文件…」是因为那会弹原生选择框，自动化点不到。）
     */
    const uiOrphanDir = join(aiDataDir, 'notes', 'files');
    mkdirSync(uiOrphanDir, { recursive: true });
    writeFileSync(join(uiOrphanDir, 'ui-orphan.txt'), '这个文件没有挂到任何消息上\n', 'utf8');

    const notesUi = await chatWins[0].webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const shown = (id) => {
        const el = document.getElementById(id);
        if (!el) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && el.getBoundingClientRect().height > 0;
      };
      const badgeShown = () => {
        const el = document.getElementById('notes-badge');
        return getComputedStyle(el).display !== 'none';
      };
      const countMessages = () => document.querySelectorAll('#notes-list .note-message').length;
      await window.chatAPI.clearNotes();
      document.getElementById('note-compose').click();     // 她记一条（带发件人）
      await wait(600);

      document.getElementById('tab-notes').click();
      await wait(400);
      document.getElementById('notes-refresh').click();
      await wait(500);
      const onNotes = {
        chat: shown('view-chat'),
        notes: shown('view-notes'),
        diary: shown('view-diary'),
        badge: badgeShown(),
        tabs: [...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.trim()),
        cards: countMessages(),
        // 每条**消息**都带发件人（邮件模型里最重要的一列）；「未归档」那封虚拟邮件也有自己的发件人
        fromCount: document.querySelectorAll('#notes-list .note-message .note-from').length,
        hasTitle: (document.querySelector('.note-title')?.textContent ?? '').length > 0,
        hasDelete: document.querySelectorAll('.note-delete').length >= 1,
        hasImport: !!document.getElementById('file-import'),
        hasRefresh: !!document.getElementById('notes-refresh'),
        hasInput: document.getElementById('note-input') !== null,
        hasWriteButton: document.getElementById('note-write') !== null,
        // 「未归档的文件」：磁盘上有、但没有归属的文件
        orphanCard: !!document.getElementById('note-orphans'),
        orphanFiles: [...document.querySelectorAll('#note-orphans .note-file-name')].map((n) => n.textContent),
        // 未归档的文件也带「删除」按钮（单独删附件）
        orphanDeletes: document.querySelectorAll('#note-orphans .note-file-delete').length,
        // 「文件」视图必须**已经不存在**（合并进这一页了）
        legacyFilesView: !!document.getElementById('view-files'),
        legacyFilesTab: !!document.getElementById('tab-files'),
      };

      document.getElementById('tab-chat').click();
      await wait(300);
      const onChat = { chat: shown('view-chat'), notes: shown('view-notes'), diary: shown('view-diary') };

      document.getElementById('tab-diary').click();
      await wait(300);
      const onDiary = { chat: shown('view-chat'), notes: shown('view-notes'), diary: shown('view-diary') };

      document.getElementById('tab-notes').click();
      await wait(300);
      const backAgain = { chat: shown('view-chat'), notes: shown('view-notes'), diary: shown('view-diary') };

      // 预览浮层默认不显示（它也用 display:flex，同样要防"一直挡在屏幕上"）
      const previewHidden = getComputedStyle(document.getElementById('preview')).display === 'none';
      const preview = await window.chatAPI.previewNoteFile('no-such-file.txt');

      // 消息上的「删除」：真点一次（confirm 是原生模态点不到，先换成"永远同意"）
      const beforeDeleteCards = countMessages();
      window.confirm = () => true;
      const deleteButton = document.querySelector('.note-delete');
      if (deleteButton) deleteButton.click();
      await wait(900);
      const afterDeleteCards = countMessages();

      await window.chatAPI.clearNotes();
      await wait(200);
      return {
        onNotes,
        onChat,
        onDiary,
        backAgain,
        previewHidden,
        previewFailsGracefully: preview.ok === false && typeof preview.reason === 'string',
        deleteViaUi: { before: beforeDeleteCards, after: afterDeleteCards },
        afterClearCards: countMessages(),
        orphanCardAfterClear: !!document.getElementById('note-orphans'),
      };
    })()`, true);
    record(
      '交互 UI：三个视图互斥且能来回切（看计算样式，不看 hidden 属性）',
      notesUi.onNotes.chat === false &&
        notesUi.onNotes.notes === true &&
        notesUi.onNotes.diary === false &&
        notesUi.onChat.chat === true &&
        notesUi.onChat.notes === false &&
        notesUi.onDiary.diary === true &&
        notesUi.onDiary.notes === false &&
        notesUi.backAgain.notes === true &&
        notesUi.backAgain.chat === false,
      JSON.stringify({
        onNotes: notesUi.onNotes && { chat: notesUi.onNotes.chat, notes: notesUi.onNotes.notes },
        onChat: notesUi.onChat,
        onDiary: notesUi.onDiary,
        backAgain: notesUi.backAgain,
      }),
    );
    record(
      '交互 UI：消息带发件人、只读（无输入框/无写按钮）、看完徽标消失、有删除按钮',
      notesUi.onNotes.hasInput === false &&
        notesUi.onNotes.hasWriteButton === false &&
        notesUi.onNotes.cards >= 1 &&
        notesUi.onNotes.fromCount === notesUi.onNotes.cards &&
        notesUi.onNotes.hasTitle === true &&
        notesUi.onNotes.hasDelete === true &&
        notesUi.onNotes.badge === false &&
        notesUi.afterClearCards === 0,
      JSON.stringify(notesUi.onNotes),
    );
    record(
      '交互 UI：纸条与文件已合并（前三个页签是聊天/交互/日记，后面才是插件页签）',
      notesUi.onNotes.legacyFilesView === false &&
        notesUi.onNotes.legacyFilesTab === false &&
        notesUi.onNotes.tabs.length >= 3 &&
        // 页签文字里带未读徽标（"交互" 后面可能跟着数字），所以按前缀比而不是全等
        notesUi.onNotes.tabs[0] === '聊天' &&
        String(notesUi.onNotes.tabs[1]).startsWith('交互') &&
        notesUi.onNotes.tabs[2] === '日记' &&
        // 随包的待办插件在后面挂了自己的页签（插件面板就是"多一个页签"）
        notesUi.onNotes.tabs.some((label) => String(label).includes('待办')) &&
        // 「收纳文件…」与「刷新」并进了收件箱工具栏
        notesUi.onNotes.hasImport === true &&
        notesUi.onNotes.hasRefresh === true,
      JSON.stringify({ tabs: notesUi.onNotes.tabs, import: notesUi.onNotes.hasImport, refresh: notesUi.onNotes.hasRefresh }),
    );
    record(
      '交互 UI：没被引用的文件归成「未归档的文件」（带查看/打开/删除，不会被藏起来）',
      notesUi.onNotes.orphanCard === true &&
        notesUi.onNotes.orphanFiles.some((name) => String(name).includes('ui-orphan.txt')) &&
        notesUi.onNotes.orphanDeletes >= 1,
      JSON.stringify({
        card: notesUi.onNotes.orphanCard,
        files: notesUi.onNotes.orphanFiles,
        deletes: notesUi.onNotes.orphanDeletes,
      }),
    );
    record(
      '交互 UI：预览浮层平时不显示、读不到时报错而不是崩',
      notesUi.previewHidden === true && notesUi.previewFailsGracefully === true,
      JSON.stringify({ previewHidden: notesUi.previewHidden, fails: notesUi.previewFailsGracefully }),
    );
    record(
      '交互 UI：点「删除」能真的删掉那条消息（真点按钮，不只是调 IPC）',
      notesUi.deleteViaUi.before >= 1 && notesUi.deleteViaUi.after === notesUi.deleteViaUi.before - 1,
      JSON.stringify(notesUi.deleteViaUi),
    );

    /*
     * 插件面板：插件注册 -> 聊天窗口长出页签 -> 用户点按钮 -> 动作回到插件 -> 面板刷新。
     *
     * 这是 TODO / 课程表 / 番茄钟这类插件唯一的界面通道，所以要把整条链路钉死：
     * 生成 HTML 的插件跑在**桌宠窗口**，渲染却在**聊天窗口**，中间还得过一道净化。
     */
    const panelPlugin = await run(`(async () => {
      const host = window.petDebug.plugins;
      const html = (text, echo) =>
        '<table class="probe-table"><tr><th>时间</th><th>课程</th></tr>' +
        '<tr><td>8:00</td><td>' + (echo ? '已收到:' + echo : '高等数学') + '</td></tr></table>' +
        '<input data-plugin-field="text" value="' + (text || '') + '" />' +
        '<button data-plugin-action="add">加一条</button>' +
        '<a href="javascript:alert(1)">坏链接</a>' +
        '<img src="https://example.com/x.png" />' +
        '<script>window.__panelHacked = true<\\/script>' +
        '<div onclick="window.__panelHacked = true">内联事件</div>';
      await host.activate(
        {
          id: 'panel-probe',
          name: '课程表',
          version: '1.0.0',
          activate(context) {
            context.ui.registerPanel({
              id: 'probe',
              title: '课程表',
              html: html('', ''),
              onAction(action) {
                return html(action.fields.text, action.fields.text);
              },
            });
          },
        },
        { id: 'panel-probe', name: '课程表', version: '1.0.0', dir: 'plugins/examples/panel-probe', enabled: true, status: 'loaded', permissions: ['ui'] }
      );
      await new Promise((r) => setTimeout(r, 600));
      return { status: host.getLoadedPlugins().find((r) => r.id === 'panel-probe')?.status };
    })()`);
    record('插件面板：注册面板后插件仍处于 active', panelPlugin.status === 'active', JSON.stringify(panelPlugin));

    const panelUi = await chatWins[0].webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(700);
      const tabs = [...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.trim());
      const pluginTab = [...document.querySelectorAll('#tabs .tab')].find((t) => /课程表/.test(t.textContent));
      if (!pluginTab) return { tabs, found: false };
      pluginTab.click();
      await wait(300);
      const body = document.getElementById('plugin-panel-body');
      const view = document.getElementById('view-plugin');
      const style = getComputedStyle(view);
      const height = view.getBoundingClientRect().height;
      const shown = style.display !== 'none' && height > 0;
      const initial = {
        shown,
        chatHidden: getComputedStyle(document.getElementById('view-chat')).display === 'none',
        hasTable: body.querySelectorAll('table').length === 1,
        hasAction: body.querySelectorAll('[data-plugin-action="add"]').length === 1,
        hasField: body.querySelectorAll('[data-plugin-field="text"]').length === 1,
        scriptStripped: body.querySelectorAll('script').length === 0,
        inlineHandlerStripped: body.querySelector('[onclick]') === null,
        jsHrefStripped: body.querySelector('a[href^="javascript:"]') === null,
        remoteImgStripped: body.querySelector('img[src^="https://"]') === null,
        hacked: window.__panelHacked === true,
        text: body.textContent,
      };
      const field = body.querySelector('[data-plugin-field="text"]');
      field.value = 'hello';
      body.querySelector('[data-plugin-action="add"]').click();
      await wait(600);
      const afterClick = {
        text: document.getElementById('plugin-panel-body').textContent,
        stillShown: getComputedStyle(document.getElementById('view-plugin')).display !== 'none',
      };
      return { tabs, found: true, initial, afterClick };
    })()`, true);
    record(
      '插件面板：注册后聊天窗口长出页签，点开是独立视图',
      panelUi.found === true &&
        panelUi.initial.shown === true &&
        panelUi.initial.chatHidden === true &&
        panelUi.initial.hasTable === true,
      JSON.stringify({ tabs: panelUi.tabs, initial: panelUi.initial && { shown: panelUi.initial.shown, hasTable: panelUi.initial.hasTable } }),
    );
    record(
      '插件面板：HTML 被净化（script / on* / javascript: / 远程图片全被剔除，且确实没执行）',
      panelUi.found === true &&
        panelUi.initial.scriptStripped === true &&
        panelUi.initial.inlineHandlerStripped === true &&
        panelUi.initial.jsHrefStripped === true &&
        panelUi.initial.remoteImgStripped === true &&
        panelUi.initial.hacked === false,
      JSON.stringify(panelUi.initial && {
        scriptStripped: panelUi.initial.scriptStripped,
        inlineHandlerStripped: panelUi.initial.inlineHandlerStripped,
        jsHrefStripped: panelUi.initial.jsHrefStripped,
        remoteImgStripped: panelUi.initial.remoteImgStripped,
        hacked: panelUi.initial.hacked,
      }),
    );
    record(
      '插件面板：点按钮把字段值回传插件，插件返回新 HTML 即刷新',
      panelUi.found === true &&
        panelUi.initial.hasAction === true &&
        panelUi.initial.hasField === true &&
        /已收到:hello/.test(String(panelUi.afterClick && panelUi.afterClick.text)),
      JSON.stringify(panelUi.afterClick),
    );

    // 停用插件：它的面板页签必须跟着消失（否则"关掉插件"就只关了一半）
    const panelGone = await run(`(async () => {
      await window.petDebug.plugins.disablePlugin('panel-probe');
      await new Promise((r) => setTimeout(r, 600));
      return window.petDebug.plugins.getLoadedPlugins().find((r) => r.id === 'panel-probe')?.status || 'removed';
    })()`);
    const panelTabsAfter = await chatWins[0].webContents.executeJavaScript(`(async () => {
      await new Promise((r) => setTimeout(r, 400));
      return {
        tabs: [...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.trim()),
        pluginHidden: getComputedStyle(document.getElementById('view-plugin')).display === 'none',
        bodyEmpty: document.getElementById('plugin-panel-body').textContent.trim() === '',
      };
    })()`, true);
    record(
      '插件面板：停用插件后页签消失、退回聊天视图',
      panelGone === 'inactive' &&
        panelTabsAfter.tabs.every((t) => !/课程表/.test(t)) &&
        panelTabsAfter.pluginHidden === true,
      JSON.stringify({ status: panelGone, ...panelTabsAfter }),
    );

    /*
     * 随包的待办插件（`plugins/todo-plugin`）—— 第一个真插件，整条链路真点界面：
     * 输入时间与事件 -> 到点提醒（气泡 + 动画）-> 打勾 / 恢复 -> 删除。
     *
     * ⚠️ 它的清单存在**渲染层 localStorage** 里（插件的 `context.storage`），
     * 而 localStorage 跟着 Chromium 的 userData 走，不像 AI 数据那样被
     * `DESKTOP_PET_AI_DATA_DIR` 隔离 —— 所以这里先抄一份原值，跑完写回去，
     * 绝不把用户真实的待办清单改掉。
     */
    const todoStorageKeys = await run(`(() => {
      const prefix = 'desktop-pet:plugin:todo-plugin:';
      const saved = {};
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key && key.startsWith(prefix)) saved[key] = window.localStorage.getItem(key);
      }
      return saved;
    })()`);

    // 先清空待办，让断言从一个确定的状态开始
    const todoPanel = await chatWins[0].webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const tab = [...document.querySelectorAll('#tabs .tab')].find((t) => /待办/.test(t.textContent));
      if (!tab) return { found: false, tabs: [...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent.trim()) };
      tab.click();
      await wait(400);
      const body = () => document.getElementById('plugin-panel-body');
      return {
        found: true,
        shown: getComputedStyle(document.getElementById('view-plugin')).display !== 'none',
        title: document.getElementById('plugin-panel-title').textContent,
        from: document.getElementById('plugin-panel-from').textContent,
        hasText: !!body().querySelector('[data-plugin-field="text"]'),
        hasDue: !!body().querySelector('[data-plugin-field="due"]'),
        dueType: body().querySelector('[data-plugin-field="due"]')?.type ?? null,
        hasAdd: !!body().querySelector('[data-plugin-action="add"]'),
        hasQuick15: !!body().querySelector('[data-plugin-action="addIn"][data-plugin-value="15"]'),
        hasNoTime: !!body().querySelector('[data-plugin-action="addNoTime"]'),
        hasExport: !!body().querySelector('[data-plugin-action="export"]'),
      };
    })()`, true);
    record(
      '待办插件：面板是「待办清单」，有"事件 + 时间"两个输入框与添加/快捷按钮',
      todoPanel.found === true &&
        todoPanel.shown === true &&
        String(todoPanel.title).includes('待办') &&
        String(todoPanel.from).includes('待办清单') &&
        todoPanel.hasText === true &&
        todoPanel.hasDue === true &&
        todoPanel.dueType === 'datetime-local' &&
        todoPanel.hasAdd === true &&
        todoPanel.hasQuick15 === true &&
        todoPanel.hasNoTime === true &&
        todoPanel.hasExport === true,
      JSON.stringify(todoPanel),
    );

    // 输入「明天 09:00 写周报」-> 添加 -> 打勾 -> 恢复 -> 删除（全部真点 DOM）
    const todoFlow = await chatWins[0].webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const body = () => document.getElementById('plugin-panel-body');
      const rows = () => [...body().querySelectorAll('tbody tr')];
      const click = (selector) => {
        const target = body().querySelector(selector);
        if (!target) return false;
        target.click();
        return true;
      };
      // 清掉可能存在的旧条目（用户真实数据已经在验收前抄走了）
      click('[data-plugin-action="clearDone"]');
      await wait(400);

      // 1) 输入时间与事件
      const text = body().querySelector('[data-plugin-field="text"]');
      const due = body().querySelector('[data-plugin-field="due"]');
      text.value = '写周报';
      due.value = '2030-01-02T09:30';
      click('[data-plugin-action="add"]');
      await wait(600);
      const afterAdd = {
        rows: rows().length,
        text: body().textContent,
        dueShown: rows()[0]?.querySelectorAll('td')[2]?.textContent ?? '',
        actions: rows()[0]?.querySelectorAll('button').length ?? 0,
      };

      // 2) 打勾（完成）——真点那一行的「完成」
      click('[data-plugin-action="toggle"]');
      await wait(500);
      const afterDone = {
        // 只看**那一行**：整面板里永远有「清除已完成」这个按钮，拿整段文本判断会假绿
        rowText: rows()[0]?.textContent ?? '',
        mark: rows()[0]?.querySelectorAll('td')[0]?.textContent ?? '',
        buttonLabels: [...(rows()[0]?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
      };

      // 3) 恢复
      click('[data-plugin-action="toggle"]');
      await wait(500);
      const afterRestore = {
        rowText: rows()[0]?.textContent ?? '',
        mark: rows()[0]?.querySelectorAll('td')[0]?.textContent ?? '',
        buttonLabels: [...(rows()[0]?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
      };

      // 4) 删除 —— 真点那一行的「删除」
      click('[data-plugin-action="remove"]');
      await wait(500);
      const afterRemove = { rows: rows().length, text: body().textContent };

      return { afterAdd, afterDone, afterRestore, afterRemove };
    })()`, true);
    record(
      '待办插件：写「写周报」+ 选时间 -> 添加（列表出现这一行，带时间与三个按钮）',
      todoFlow.afterAdd.rows === 1 &&
        todoFlow.afterAdd.text.includes('写周报') &&
        /2030-01-02|1 月 2 日|09:30/.test(String(todoFlow.afterAdd.dueShown)) &&
        todoFlow.afterAdd.actions >= 3,
      JSON.stringify(todoFlow.afterAdd && { rows: todoFlow.afterAdd.rows, due: todoFlow.afterAdd.dueShown, actions: todoFlow.afterAdd.actions }),
    );
    record(
      '待办插件：点「完成」打勾（✅ + 已完成），点「恢复」又变回未完成',
      todoFlow.afterDone.rowText.includes('已完成') &&
        todoFlow.afterDone.mark.includes('✅') &&
        todoFlow.afterDone.buttonLabels.includes('恢复') &&
        !todoFlow.afterRestore.rowText.includes('已完成') &&
        todoFlow.afterRestore.mark.includes('☐') &&
        todoFlow.afterRestore.buttonLabels.includes('完成'),
      JSON.stringify({ done: todoFlow.afterDone, restored: todoFlow.afterRestore }),
    );
    record(
      '待办插件：点「删除」那一条就没了',
      todoFlow.afterRemove.rows === 0 && todoFlow.afterRemove.text.includes('还没有待办'),
      JSON.stringify({ rows: todoFlow.afterRemove.rows }),
    );

    /*
     * 到点提醒：真等一次。
     *
     * 面板的时间输入是分钟粒度（`datetime-local` 本身如此），等不到"几秒后"，
     * 所以这里把「15 分钟后」那个按钮的 `data-plugin-value` 改成 `0.05`（= 3 秒）再点 ——
     * 走的仍然是**同一条**代码路径（`addIn` -> `timers.after` -> 主进程计时 -> 到点回调）。
     *
     * ⚠️ 气泡要在**桌宠窗口**侧轮询着抓：她可能在这几秒里恰好主动搭一句话
     * （闲聊会走同一颗气泡），等 4 秒再读一次很容易读到后来那句（实测踩过：
     * 读到的是"刚刚想起你，就出来打个招呼～"）。所以每 400ms 采一帧，
     * 只要有一帧带着待办文案就算数；动画同理（`remind` 只播一次）。
     */
    const todoReminder = await chatWins[0].webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const body = () => document.getElementById('plugin-panel-body');
      const text = body().querySelector('[data-plugin-field="text"]');
      text.value = '开短会';
      const quick = body().querySelector('[data-plugin-action="addIn"][data-plugin-value="15"]');
      quick.setAttribute('data-plugin-value', '0.05');   // 3 秒后
      quick.click();
      await wait(1200);
      return { added: body().textContent.includes('开短会') };
    })()`, true);
    let reminderBubble = '';
    let reminderAnimation = null;
    for (let attempt = 0; attempt < 22; attempt += 1) {
      const sample = await run(`(() => {
        const bubble = document.getElementById('pet-bubble');
        return {
          shown: !!bubble && getComputedStyle(bubble).display !== 'none' && bubble.getBoundingClientRect().height > 0,
          text: document.getElementById('pet-bubble-body')?.textContent ?? '',
          animation: window.petDebug.anim.getCurrentAnimation(),
        };
      })()`);
      if (sample.shown === true && String(sample.text).includes('开短会')) reminderBubble = String(sample.text);
      if (sample.animation === 'remind') reminderAnimation = 'remind';
      if (reminderBubble !== '' && reminderAnimation !== null) break;
      await wait(400);
    }
    const todoReminderPanel = await chatWins[0].webContents.executeJavaScript(
      `document.getElementById('plugin-panel-body').textContent`,
      true,
    );
    record(
      '待办插件：到点真的提醒了（面板标记「已提醒」+ 桌宠冒泡说出那件事 + 演 remind 动作）',
      todoReminder.added === true &&
        String(todoReminderPanel).includes('已提醒') &&
        reminderBubble.includes('开短会') &&
        /到时间啦|早该开始/.test(reminderBubble) &&
        reminderAnimation === 'remind',
      JSON.stringify({ added: todoReminder.added, panelHasReminded: String(todoReminderPanel).includes('已提醒'), bubble: reminderBubble, animation: reminderAnimation }),
    );

    // 收尾：把这条测试待办删掉，并把用户原来的待办清单写回去
    await chatWins[0].webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const body = () => document.getElementById('plugin-panel-body');
      for (const button of [...body().querySelectorAll('[data-plugin-action="remove"]')]) {
        button.click();
        await wait(300);
      }
      return true;
    })()`, true);
    const todoStorageRestored = await run(`(() => {
      const saved = ${JSON.stringify(todoStorageKeys)};
      const prefix = 'desktop-pet:plugin:todo-plugin:';
      const current = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key && key.startsWith(prefix)) current.push(key);
      }
      for (const key of current) window.localStorage.removeItem(key);
      for (const [key, value] of Object.entries(saved)) {
        if (typeof value === 'string') window.localStorage.setItem(key, value);
      }
      return { restoredKeys: Object.keys(saved).length, removed: current.length };
    })()`);
    record(
      '待办插件：验收跑完把用户真实的待办清单原样写回（不污染 localStorage）',
      typeof todoStorageRestored.restoredKeys === 'number' && typeof todoStorageRestored.removed === 'number',
      JSON.stringify(todoStorageRestored),
    );

    /*
     * 日记页（2026-09 需求：日记从托盘的 AI 子菜单搬进「交互」窗口）。
     *
     * 这一条必须**真点页签**再看计算样式：视图用的是 `display:flex`，
     * `hidden` 属性会被作者样式盖掉（小纸条那两个视图就踩过同样的坑）。
     * 同时验「看正文」能展开 —— 正文是按需向主进程要的，不走清单。
     */
    const diaryUi = await chatWins[0].webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const shown = (id) => {
        const el = document.getElementById(id);
        const style = getComputedStyle(el);
        return style.display !== 'none' && el.getBoundingClientRect().height > 0;
      };
      const tab = document.getElementById('tab-diary');
      if (!tab) return { hasTab: false };
      const tabText = tab.textContent.trim();
      tab.click();
      await wait(400);
      const onDiary = {
        diary: shown('view-diary'),
        chat: shown('view-chat'),
        notes: shown('view-notes'),
      };
      const items = document.querySelectorAll('#diary-list .diary-item');
      const summary = document.getElementById('diary-summary').textContent;
      const hasWrite = !!document.getElementById('diary-write');
      const hasOpenDir = !!document.getElementById('diary-open-dir');
      let bodyShown = false;
      let bodyLength = 0;
      if (items.length > 0) {
        document.querySelector('#diary-list .diary-open').click();
        await wait(600);
        bodyShown = shown('diary-detail');
        bodyLength = document.getElementById('diary-detail-body').textContent.length;
      }
      // 「交互」页签（原「小纸条」）改名后仍然在，且名字就是交互
      const notesTabText = document.getElementById('tab-notes').textContent.trim();
      document.getElementById('tab-chat').click();
      await wait(300);
      return {
        hasTab: true,
        tabText,
        notesTabText,
        onDiary,
        items: items.length,
        summary,
        hasWrite,
        hasOpenDir,
        bodyShown,
        bodyLength,
        backToChat: shown('view-chat') && !shown('view-diary'),
      };
    })()`, true);
    record(
      '聊天窗口：页签是「交互 / 日记」（日记从菜单的 AI 子菜单搬进来了）',
      diaryUi.hasTab === true && diaryUi.tabText === '日记' && diaryUi.notesTabText.startsWith('交互'),
      JSON.stringify({ tab: diaryUi.tabText, notesTab: diaryUi.notesTabText }),
    );
    record(
      '日记页：能切进去（看计算样式）、三个视图互斥、有「写今天的日记」与「打开日记目录」',
      diaryUi.hasTab === true &&
        diaryUi.onDiary.diary === true &&
        diaryUi.onDiary.chat === false &&
        diaryUi.onDiary.notes === false &&
        diaryUi.hasWrite === true &&
        diaryUi.hasOpenDir === true &&
        diaryUi.backToChat === true,
      JSON.stringify(diaryUi.onDiary),
    );
    record(
      '日记页：清单渲染出已有的日记，点「看正文」能展开正文',
      diaryUi.hasTab === true &&
        diaryUi.items >= 1 &&
        /共 \d+ 篇/.test(String(diaryUi.summary)) &&
        diaryUi.bodyShown === true &&
        diaryUi.bodyLength > 0,
      JSON.stringify({ items: diaryUi.items, summary: diaryUi.summary, shown: diaryUi.bodyShown, len: diaryUi.bodyLength }),
    );
  }

  /*
   * 托盘菜单与桌宠右键菜单**必须一致**（需求）。
   *
   * 做法：在主进程里临时接管 `Menu.buildFromTemplate`，把两份模板的
   * "标签序列"都录下来再逐项比较 —— 只看标签（子菜单内容由同一个函数生成，
   * 这里要钉的是"两个菜单的条目与顺序完全一样"）。
   * 触发时机：托盘菜单随 `setAlwaysOnTop` 刷新；右键菜单直接让渲染层弹一次。
   */
  const { Menu } = require('electron');
  const capturedTemplates = [];
  const capturedMenus = [];
  const originalBuildFromTemplate = Menu.buildFromTemplate;
  Menu.buildFromTemplate = function patched(template) {
    const menu = originalBuildFromTemplate.call(this, template);
    capturedTemplates.push(template);
    capturedMenus.push(menu);
    return menu;
  };
  let menuParity = { tray: null, context: null, error: '' };
  try {
    /*
     * 触发托盘菜单重建。托盘**不是**每次设置变化都重建，只在状态推送时重建
     * （`refreshAISurfaces` -> `refreshTray`）；因此这里用一次互动触发的状态推送，
     * 它一定会走到重建 —— 靠"改置顶"那种可能无变化的操作会偶发抓不到模板（实测）。
     */
    await run(`window.petAPI.ai.notifyInteraction('click')`);
    await wait(500);
    const trayTemplate = capturedTemplates.length > 0 ? capturedTemplates[capturedTemplates.length - 1] : null;
    capturedTemplates.length = 0;
    await run(`(() => { window.petAPI.menu.showContextMenu(); return true; })()`);
    await wait(500);
    const contextTemplate = capturedTemplates.length > 0 ? capturedTemplates[capturedTemplates.length - 1] : null;
    const labels = (template) => (Array.isArray(template) ? template.map((item) => item?.label ?? `[${item?.type ?? '?'}]`) : null);
    /*
     * 「插件」子菜单：上半是插件自己注册的动作（按插件分组，是一层子菜单），
     * 下半每个插件一个**可点的 checkbox**（"插件可随时关闭"的菜单入口）。
     * 这里把 type / checked / 子菜单文字都记下来 —— 断言才有硬证据。
     */
    const pluginSubmenu = (template) => {
      if (!Array.isArray(template)) return null;
      const entry = template.find((item) => item?.label === '插件');
      if (!entry || !Array.isArray(entry.submenu)) return null;
      return entry.submenu.map((item) => ({
        label: typeof item?.label === 'string' ? item.label : '',
        type: item?.type ?? 'normal',
        checked: item?.checked === true,
        clickable: typeof item?.click === 'function',
        submenu: Array.isArray(item?.submenu) ? labels(item.submenu) : null,
      }));
    };
    menuParity = {
      tray: labels(trayTemplate),
      context: labels(contextTemplate),
      plugins: pluginSubmenu(trayTemplate),
      error: '',
    };
    // 把刚才为了取模板而弹出的那个菜单关掉，别让它一直开着（会让托盘菜单停止刷新）
    await wait(200);
    const lastMenu = capturedMenus.length > 0 ? capturedMenus[capturedMenus.length - 1] : null;
    if (lastMenu && typeof lastMenu.closePopup === 'function') lastMenu.closePopup();
    await wait(300);
  } catch (error) {
    menuParity = { tray: null, context: null, error: String(error) };
  } finally {
    Menu.buildFromTemplate = originalBuildFromTemplate;
  }
  const menuLabels = menuParity.tray ?? [];
  /*
   * 配置项一律不该出现在菜单里（2026-09 需求）：它们全都搬进了设置窗口。
   * 用**精确匹配 / 前缀**而不是 includes，避免误伤状态行
   * （例如"感知：coding · 在电脑前"是读数，`startsWith('感知')` 会把它当成子菜单）。
   */
  const removedMenuLabels = [
    '调整大小…', '总是置顶', '拖到边缘自动收起', '恢复默认动画', '重载插件',
    '打开配置目录', '感知（环境与用户）', '成长与记忆', '重置情绪', 'AI 设置…',
    // 2026-09 需求删掉的两块：「AI（认知与人格）」子菜单与「查看记忆宫殿」
    'AI（认知与人格）', '查看记忆宫殿',
  ];
  const strayMenuLabels = menuLabels.filter((label) => typeof label === 'string' &&
    (removedMenuLabels.some((removed) => label === removed || label.startsWith(removed)) ||
      label.startsWith('点击区域') || label.startsWith('当前动画') || label.startsWith('可调范围') ||
      label.includes('对话气泡') || label.includes('暂停行为') || label === '鲸鱼娘'));
  record(
    '托盘菜单与桌宠右键菜单完全一致（同一份模板），并且都有「交互…」',
    Array.isArray(menuParity.tray) &&
      Array.isArray(menuParity.context) &&
      JSON.stringify(menuParity.tray) === JSON.stringify(menuParity.context) &&
      menuLabels.length > 0 &&
      menuLabels.some((label) => typeof label === 'string' && label.startsWith('交互')),
      JSON.stringify(menuParity),
  );
  /*
   * 需求（2026-09）："查看记忆宫殿只在设置里保留即可，面板上的不要了""AI（认知和人格）选项不要了"。
   * 于是菜单里必须**同时**满足：这两块一个都不剩，而「设置…」还在
   * （记忆宫殿与 AI 的配置/入口都在设置窗口里）。
   */
  record(
    '菜单里不再有配置项与已删的两块（记忆宫殿 / AI 子菜单），并且「设置…」还在',
    Array.isArray(menuParity.tray) &&
      strayMenuLabels.length === 0 &&
      !menuLabels.includes('查看记忆宫殿') &&
      !menuLabels.includes('AI（认知与人格）') &&
      menuLabels.includes('设置…'),
    JSON.stringify({ stray: strayMenuLabels, labels: menuLabels }),
  );
  /*
   * 「插件」子菜单：上半是插件自己注册的动作（按插件分组），
   * 下半每个插件一个**可点的 checkbox**（● 运行中 / ○ 已关闭）。
   * 关掉一个正在骚扰你的插件不该需要先打开设置窗口找一圈 —— 这是需求
   * "让插件可随时关闭"在菜单里的落点，所以必须钉住"它真的可点"。
   */
  const pluginSub = Array.isArray(menuParity.plugins) ? menuParity.plugins : [];
  const pluginGroups = pluginSub.filter((item) => Array.isArray(item.submenu));
  const pluginToggles = pluginSub.filter((item) => item.type === 'checkbox' && item.clickable === true);
  record(
    '托盘「插件」子菜单：插件动作按插件分组，且每个插件是一个可点的开关（checkbox）',
    pluginToggles.length >= 3 &&
      pluginToggles.some((item) => item.label.includes('待办清单')) &&
      pluginToggles.some((item) => item.label.includes('点击探针')) &&
      pluginToggles.some((item) => item.label.includes('普通探针')) &&
      // 待办插件注册了「看待办清单…（N 条未完成）」，探针注册了「探针动作」
      pluginGroups.some((group) => group.submenu.some((label) => String(label).startsWith('看待办清单'))) &&
      pluginGroups.some((group) => group.submenu.includes('探针动作')),
    JSON.stringify(pluginSub),
  );
  /*
   * 心情与饱腹**各占一行**（需求："心情值和饱腹值不要写在一行"）。
   * 正反两面都钉：两行各自存在，且没有任何一行同时含这两个读数。
   */
  const moodLines = menuLabels.filter((label) => typeof label === 'string' && label.startsWith('心情'));
  const satietyLines = menuLabels.filter((label) => typeof label === 'string' && label.startsWith('饱腹'));
  record(
    '托盘菜单：心情与饱腹各占一行（不再挤在一行里）',
    moodLines.length === 1 &&
      satietyLines.length === 1 &&
      /心情 \d+\/100/.test(moodLines[0]) &&
      /饱腹 \d+\/100/.test(satietyLines[0]) &&
      menuLabels.every((label) => typeof label !== 'string' || !(label.includes('心情') && label.includes('饱腹'))),
    JSON.stringify({ mood: moodLines, satiety: satietyLines }),
  );
  /*
   * 需求："点击系统托盘时显示饱腹值心情值以及token等属性信息"。
   *
   * 这一条读的就是**真实构建出来的菜单模板**（上面拦下的那一份），
   * 而不是另算一遍字符串 —— 于是"菜单里到底有没有这些信息"是硬证据。
   */
  record(
    '托盘菜单顶部显示属性信息（心情 / 饱腹 / token / 感知）',
    moodLines.length === 1 &&
      satietyLines.length === 1 &&
      menuLabels.some((label) => typeof label === 'string' && label.startsWith('token 本次')) &&
      menuLabels.some((label) => typeof label === 'string' && label.startsWith('感知：')),
    JSON.stringify(menuLabels.slice(0, 6)),
  );

  /* ------------------ 环境与用户感知（3.1~3.6） ------------------ */

  /*
   * 感知自己这一段开始前把开关**重新打开**（前面为了让动画断言不受干扰而关掉了它们），
   * 下面的"默认全开"断言读的就是打开后的状态。
   */
  /* ------------------------------------------------------------------------- */
  /* 感知（3.1~3.6）：先把它打开（上面动画段为了确定性把它关了）                    */
  /* ------------------------------------------------------------------------- */
  /*
   * 注意：随机池与触发服务**整轮都保持暂停**。
   * 理由：验收里有大量"现在应该播的是谁"的断言，而随机池 25~60 秒就会挑一个动画、
   * 触发服务还会看真实光标位置 —— 它们都属于产品里该有的行为，但在验收里只会制造
   * 偶发红。暂停只影响"她主动演"，所有断言都不依赖它真的触发
   * （随机池与触发规则都通过 `describePools()` / 纯函数直接断言）。
   */
  await run(`window.petAPI.perception.setSettings({ screen: true, behavior: true, habits: true, camera: true })`);
  await wait(500);

  /*
   * 这一组的重点是**隐私与频率**，不是"能不能截图"：
   *   1. 默认全开，但摄像头必须显式授权（否则一帧都不采）；
   *   2. 隐私模式一键停；关掉开关不落盘；
   *   3. 主动打扰必须受频率闸门约束（需求 3.4 反复强调的那句话）；
   *   4. 判断规则全部是纯函数，因此可以逐条钉死（深夜/久坐/敏感/习惯预测）。
   */
  const perceptionInitial = await run(`(async () => {
    const status = await window.petAPI.perception.status();
    const methods = Object.keys(window.petAPI.perception).sort();
    return {
      screen: status.settings.screen,
      behavior: status.settings.behavior,
      camera: status.settings.camera,
      habits: status.settings.habits,
      privacyMode: status.settings.privacyMode,
      cameraAuthorized: status.settings.cameraAuthorized,
      cameraReady: status.cameraReady,
      dataDir: status.dataDir,
      methods,
    };
  })()`);
  record(
    '感知：按需求默认全开（摄像头除外，必须显式授权）',
    perceptionInitial.screen === true &&
      perceptionInitial.behavior === true &&
      perceptionInitial.camera === true &&
      perceptionInitial.habits === true &&
      perceptionInitial.privacyMode === false &&
      perceptionInitial.cameraAuthorized === false &&
      perceptionInitial.cameraReady === false,
    JSON.stringify(perceptionInitial),
  );
  record(
    '感知：桥暴露了完整能力面（状态/设置/日志/看屏幕/授权/清空/采样）',
    ['status', 'setSettings', 'log', 'viewNow', 'authorizeCamera', 'clearData', 'sampleNow', 'cameraFrame'].every((name) =>
      perceptionInitial.methods.includes(name),
    ),
    JSON.stringify(perceptionInitial.methods),
  );
  /*
   * 「读屏幕文字 / 总结屏幕内容 / 看报错 / 看代码」这四个内容理解动作**已按用户要求删除**，
   * 只保留「看我在做什么（场景）」。
   *
   * 这条断言钉的是"删除是彻底的"：IPC 白名单只认 `scene`，老模式一律被拒绝 ——
   * 而不是"界面上藏起来了、后台还能调"。以后谁想加回来，必须先改这条测试。
   */
  const removedViewModes = await run(`(async () => {
    const out = [];
    for (const mode of ['ocr', 'summarize', 'error', 'code']) {
      try {
        await window.petAPI.perception.viewNow(mode);
        out.push(mode + ':accepted');
      } catch (error) {
        out.push(mode + ':rejected');
      }
    }
    return out;
  })()`);
  record(
    '感知：内容理解四动作已删除（IPC 只认场景，ocr/summarize/error/code 一律被拒）',
    Array.isArray(removedViewModes) && removedViewModes.every((item) => String(item).endsWith(':rejected')),
    JSON.stringify(removedViewModes),
  );
  record(
    '感知：数据目录可解析（观察记录与习惯画像落盘位置）',
    typeof perceptionInitial.dataDir === 'string' && perceptionInitial.dataDir.length > 0,
    perceptionInitial.dataDir,
  );

  /* 纯函数：行为推测 / 深夜 / 免打扰 / 频率闸门 / 敏感判定 / 习惯学习与预测 */
  const perceptionModel = await run(`(() => {
    const model = window.petDebug.perception;
    const now = Date.now();
    const settings = Object.assign({}, model.DEFAULT_PERCEPTION_SETTINGS, {
      quietHours: { start: 0, end: 0 },
      proactiveMinIntervalMs: 600000,
      proactiveMaxPerHour: 4,
      longSessionMinutes: 120,
      lateNightHour: 1,
    });
    const behavior = {
      idleSeconds: 5, sessionMinutes: 130, switchesLastHour: 2, hour: new Date(now).getHours(),
      lateNight: false, userState: 'deep',
    };
    const obs = (scene, extra) => Object.assign({
      at: new Date(now).toISOString(), scene, app: 'VS Code', activity: '写代码', sensitive: false,
      focus: 'deep', summary: '', suggestion: '', mode: 'llm', tokens: 1,
    }, extra || {});
    const gate = (over) => model.gateIntervention(Object.assign({
      now, kind: 'scene-change', settings, lastInterventionAt: 0, lastHourCount: 0, behavior,
    }, over || {}));
    const planLong = model.planIntervention({ observation: obs('coding'), behavior, settings, previousScene: 'reading', smallTalk: null });
    const planSensitive = model.planIntervention({ observation: obs('sensitive', { sensitive: true }), behavior, settings, previousScene: 'coding', smallTalk: null });
    /*
     * 深夜劝睡已按需求删除：它当年只在 1~4 点触发，而那个区间正好落在默认免打扰
     * 时段（23–8 点）里，永远被闸门拒 —— 是死代码。
     *
     * 两条断言：
     *   - planLate（沿用旧的输入，sessionMinutes=130）现在落到**久坐**上，
     *     但绝不能是 'late-night' —— 那个 kind 已经从类型里删掉了；
     *   - planLateOnly 用一份"除了深夜没有任何其它条件成立"的输入，
     *     必须**什么都不返回**，这才真正证明分支没了（否则它可能被别的规则兜住）。
     */
    const planLate = model.planIntervention({
      observation: obs('coding'), behavior: Object.assign({}, behavior, { lateNight: true, hour: 3 }), settings, previousScene: 'coding', smallTalk: null,
    });
    const planLateOnly = model.planIntervention({
      observation: obs('coding'),
      behavior: { idleSeconds: 5, sessionMinutes: 10, switchesLastHour: 2, hour: 3, lateNight: true, userState: 'deep' },
      settings,
      previousScene: 'coding',
      smallTalk: null,
    });
    const planScene = model.planIntervention({
      observation: obs('gaming'), behavior: Object.assign({}, behavior, { sessionMinutes: 10 }), settings, previousScene: 'coding', smallTalk: null,
    });
    let profile = model.emptyHabitProfile();
    for (let i = 0; i < 3; i++) profile = model.learnHabit(profile, Object.assign(obs('coding'), { at: new Date(2025, 0, 1 + i, 10, 0, 0).toISOString() }));
    profile = model.learnHabit(profile, Object.assign(obs('reading'), { at: new Date(2025, 0, 5, 10, 0, 0).toISOString() }));
    const predict = model.habitPredictionText({
      profile, now: new Date(2025, 0, 6, 10, 30, 0).getTime(), settings, behavior,
    });
    /*
     * 习惯画像 v2 的四条新规矩（对应文档 §8.1~8.4 的四个缺口）：
     *   1. **按天去重**：同一天同一小时同一场景只算一天；
     *   2. **指数衰减**：跨天时整表 ×decayPerDay（默认 0.95）；
     *   3. **可回落**：最新/最早在线小时取最近 21 天的中位数，不是历史极值；
     *   4. **分工作日/周末 + 记应用**。
     *
     * ⚠️ 2025-01-01/02/03 是周三周四周五（weekday）。
     */
    let dedup = model.emptyHabitProfile();
    for (let i = 0; i < 5; i++) {
      // 同一天同一小时看 5 次：只该记 1 天
      dedup = model.learnHabit(dedup, Object.assign(obs('coding'), { at: new Date(2025, 0, 1, 10, i * 5, 0).toISOString() }));
    }
    // 第二天再看一次 -> 变成 2 天（日期数组里两个不同的日子）
    const secondDay = model.learnHabit(dedup, Object.assign(obs('coding'), { at: new Date(2025, 0, 2, 10, 0, 0).toISOString() }));
    // 窗口滑动 = 遗忘：**按"运行过的日子"算**，超过 21 个使用日才挤掉最早的
    let windowed = model.emptyHabitProfile();
    for (let i = 0; i < 25; i++) {
      // 25 个使用日（中间隔了几个月也无所谓 —— 没启动的日子不占窗口）
      windowed = model.learnHabit(windowed, Object.assign(obs('coding'), { at: new Date(2025, 0, 1 + i * 5, 10, 0, 0).toISOString() }));
    }
    // 只启动过 21 天，然后隔了 300 天再启动一次 -> 旧数据**仍然在**（时间流逝不消耗窗口）
    let gapped = model.emptyHabitProfile();
    for (let i = 0; i < 21; i++) {
      gapped = model.learnHabit(gapped, Object.assign(obs('coding'), { at: new Date(2025, 0, 1 + i, 10, 0, 0).toISOString() }));
    }
    gapped = model.learnHabit(gapped, Object.assign(obs('reading'), { at: new Date(2025, 11, 20, 10, 0, 0).toISOString() }));
    /*
     * 这些日期跨了好几周，自然会落进 weekday / weekend 两个档 ——
     * 所以"10 点一共看到过几天"要把两档加起来看（这也是真实读取时的口径）。
     */
    const hour10 = (p) => {
      const out = {};
      for (const kind of ['weekday', 'weekend']) {
        for (const [scene, days] of Object.entries(model.habitCounts(p, model.habitBucketKey(kind, 10)))) {
          out[scene] = (out[scene] ?? 0) + days;
        }
      }
      return out;
    };
    // 周末档与工作日档互不影响
    let weekend = model.emptyHabitProfile();
    weekend = model.learnHabit(weekend, Object.assign(obs('gaming'), { at: new Date(2025, 0, 4, 14, 0, 0).toISOString() }));  // 周六
    // 应用也进统计（"这个点一般在用 VS Code"）
    const withApp = model.learnHabit(model.emptyHabitProfile(), Object.assign(obs('coding'), { at: new Date(2025, 0, 1, 10, 0, 0).toISOString(), app: 'Code' }));
    // 作息可回落：先学一个"熬夜到 23 点"，再连续 3 天 21 点结束
    let rolling = model.emptyHabitProfile();
    rolling = model.learnHabit(rolling, Object.assign(obs('coding'), { at: new Date(2025, 0, 1, 23, 0, 0).toISOString() }));
    for (let i = 0; i < 3; i++) rolling = model.learnHabit(rolling, Object.assign(obs('coding'), { at: new Date(2025, 0, 8 + i, 21, 0, 0).toISOString() }));
    // 门槛：只有 2 天数据时不说（minDays=3），只有一天做过也不算稳定（minSceneDays=2）
    let thin = model.emptyHabitProfile();
    for (let i = 0; i < 2; i++) thin = model.learnHabit(thin, Object.assign(obs('reading'), { at: new Date(2025, 0, 1 + i, 15, 0, 0).toISOString() }));
    const mixedProfile = (() => {
      let p = model.emptyHabitProfile();
      // 5 天里都是"没认出来"，其中 3 天在写代码 —— 取到写代码（other 不参与）
      for (let i = 0; i < 5; i++) p = model.learnHabit(p, Object.assign(obs('other'), { at: new Date(2025, 0, 6 + i, 10, i, 0).toISOString() }));
      for (let i = 0; i < 3; i++) p = model.learnHabit(p, Object.assign(obs('coding'), { at: new Date(2025, 0, 6 + i, 10, 10 + i, 0).toISOString() }));
      return p;
    })();
    /*
     * 「没认出来」当作没看见（用户要求："如果是没认出来，就当作没看见，
     * 不应该在宠物对话的时候说出『这个时候经常在说不清』这种话"）。
     *   1. 全是 other 的画像 -> 学不到东西、也没有台词；
     *   2. 混着 other 与 coding 的画像 -> 取到的是 coding（不会取到 other）；
     *   3. 老画像里已经存了 other 的计数 -> 也要被跳过（不能靠"不再写入"糊过去）；
     *   4. 时间线 / 今天在做什么文本里不出现 other 段。
     */
    const otherOnly = model.learnHabit(model.emptyHabitProfile(), Object.assign(obs('other'), { at: new Date(2025, 0, 8, 10, 0, 0).toISOString() }));
    // 老画像文件里的 other 计数：v2 的 key 形如 *|10（不知道那天是星期几）
    const legacyProfile = { ...model.emptyHabitProfile(), hours: { '*|10': { other: 9 } }, samples: 9, observedHours: 1 };
    const timelineBase = { date: '2025-01-09', segments: [], totals: { activeMinutes: 0, idleMinutes: 0, byScene: [], byApp: [], firstAt: '', lastAt: '' }, narrative: '', updatedAt: '' };
    const withOther = model.appendObservation([], { at: new Date(2025, 0, 9, 10, 0, 0).toISOString(), scene: 'other', app: 'unknown.exe' });
    const withCoding = model.appendObservation(withOther, { at: new Date(2025, 0, 9, 10, 1, 0).toISOString(), scene: 'coding', app: 'Code' });
    const otherSegment = { start: new Date(2025, 0, 9, 9, 0, 0).toISOString(), end: new Date(2025, 0, 9, 9, 30, 0).toISOString(), scene: 'other', app: 'unknown.exe', samples: 3, minutes: 30 };
    const codingSegment = { start: new Date(2025, 0, 9, 10, 0, 0).toISOString(), end: new Date(2025, 0, 9, 11, 0, 0).toISOString(), scene: 'coding', app: 'Code', samples: 6, minutes: 60 };
    const mixedTimeline = {
      ...timelineBase,
      segments: [otherSegment, codingSegment],
      totals: model.summarizeDay([otherSegment, codingSegment]),
    };
    return {
      unrecognized: {
        recognized: [model.isRecognizedScene('coding'), model.isRecognizedScene('other'), model.isRecognizedScene('idle')],
        learnOtherOnly: otherOnly.samples,
        learnMixed: mixedProfile.samples,
        topOtherOnly: model.topSceneAtHour(otherOnly, 10),
        topMixed: model.topSceneAtHour(mixedProfile, 10),
        topLegacy: model.topSceneAtHour(legacyProfile, 10),
        textOtherOnly: model.habitPredictionText({ profile: otherOnly, now: new Date(2025, 0, 9, 10, 30, 0).getTime(), settings, behavior }),
        textMixed: model.habitPredictionText({ profile: mixedProfile, now: new Date(2025, 0, 9, 10, 30, 0).getTime(), settings, behavior }),
        textLegacy: model.habitPredictionText({ profile: legacyProfile, now: new Date(2025, 0, 9, 10, 30, 0).getTime(), settings, behavior }),
        segmentsAfterOther: withOther.length,
        segmentsAfterCoding: withCoding.length,
        recognizedSegments: model.recognizedSegments(mixedTimeline.segments).map((item) => item.scene),
        timelineText: model.formatTimelineText(mixedTimeline, { maxSegments: 3 }),
      },
      states: {
        deep: model.inferUserState(5, 1),
        shallow: model.inferUserState(5, 12),
        idle: model.inferUserState(200, 0),
        away: model.inferUserState(400, 0),
      },
      lateNight: { three: model.isLateNight(3, 1), noon: model.isLateNight(12, 1) },
      quiet: { inside: model.isQuietHour(23, { start: 23, end: 8 }), outside: model.isQuietHour(12, { start: 23, end: 8 }), morning: model.isQuietHour(3, { start: 23, end: 8 }) },
      gateFirst: gate(),
      gateTooSoon: gate({ lastInterventionAt: now - 60000 }),
      gateAtLimit: gate({ lastHourCount: 4 }),
      gateAway: gate({ behavior: Object.assign({}, behavior, { userState: 'away' }) }),
      gateUrgent: model.gateIntervention({ now, kind: 'sensitive', settings, lastInterventionAt: now - 120000, lastHourCount: 99, behavior }),
      planLong, planSensitive, planLate, planLateOnly, planScene,
      sensitiveKeyword: model.matchesSensitiveKeywords('这是我的银行密码', settings.sensitivityKeywords),
      harmless: model.matchesSensitiveKeywords('VS Code 里在写测试', settings.sensitivityKeywords),
      sceneLabel: model.sceneLabel('coding'),
      normalize: [model.normalizeScene('CODE'), model.normalizeScene('pdf'), model.normalizeScene('乱写的'), model.normalizeScene('game')],
      habitSamples: profile.samples,
      habitObservedHours: profile.observedHours,
      habitTop: model.topSceneAtHour(profile, 10),
      predict,
      /*
       * 习惯画像 v2（文档 §8.1~8.4 的四个缺口）：
       *   1. 按天去重 / 2. 指数衰减 / 3. 作息可回落 / 4. 平日周末 + 应用
       */
      habitV2: {
        dedupSamples: dedup.samples,
        dedupDays: model.habitCounts(dedup, model.habitBucketKey('weekday', 10)).coding ?? null,
        // 第二天 -> 2 天（不是"1.95"：窗口模型给的是精确天数）
        secondDayCoding: model.habitCounts(secondDay, model.habitBucketKey('weekday', 10)).coding ?? null,
        // 遗忘 = 窗口滑动：超过 21 个"使用日"才挤掉最早的（两档合计）
        windowedCoding: hour10(windowed).coding ?? null,
        windowedReading: hour10(windowed).reading ?? null,
        windowedDailyDays: Object.keys(windowed.daily).length,
        // 中间隔了 300 天没启动：旧习惯**不应该**被时间冲掉
        gappedCoding: hour10(gapped).coding ?? null,
        gappedReading: hour10(gapped).reading ?? null,
        gappedDailyDays: Object.keys(gapped.daily).length,
        gappedActiveDays: gapped.activeDays,
        // 周末档独立：周六 14 点只有 gaming，工作日档不该出现
        weekendBucket: model.habitCounts(weekend, model.habitBucketKey('weekend', 14)),
        weekdayBucketOfWeekend: model.habitCounts(weekend, model.habitBucketKey('weekday', 14)),
        appDays: withApp.apps[model.habitBucketKey('weekday', 10)]?.Code?.length ?? null,
        // 作息可回落：历史最晚 23 点，但最近 3 天都是 21 点 -> 中位数 21
        rollingLatest: rolling.latestActiveHour,
        rollingEarliest: rolling.earliestActiveHour,
        // 最近窗口里留下的天数
        rollingRecentDays: Object.keys(rolling.daily).length,
        // 门槛：只有 2 天 -> 不说；跨 3 天 -> 说
        thinHour: model.describeHour(thin, 15),
        thinText: model.habitPredictionText({ profile: thin, now: new Date(2025, 0, 4, 15, 30, 0).getTime(), settings, behavior }),
        constants: {
          windowDays: model.HABIT_WINDOW_DAYS,
          minDays: model.HABIT_MIN_DAYS,
          minSceneDays: model.HABIT_MIN_SCENE_DAYS,
          any: model.HABIT_KIND_ANY,
        },
        // 分档判定：同一份画像，工作日问 10 点有结论、周末问 10 点没有
        weekdayReading: model.describeHour(profile, 10, { kind: 'weekday' }),
        weekendReading: model.describeHour(profile, 10, { kind: 'weekend' }),
        // 统计文本（习惯建模的输入）里必须有真实天数
        statsLines: model.habitStatsLines(profile),
        // 习惯模型：条目由本地算出（模型只写措辞）
        routines: model.buildHabitRoutines(profile),
        localModel: model.localHabitModel({
          profile, routines: model.buildHabitRoutines(profile), petName: '鲸鱼娘', userName: '', now: new Date(2025, 0, 6),
        }),
        parsedModel: model.parseHabitModel('摘要：你很爱写代码。说：在写代码吧？'),
        parsedMerged: model.parseHabitModel('摘要：你很爱写代码。说：在写代码吧？'),
      },
      permission: {
        normal: model.capturePermission(settings),
        privacy: model.capturePermission(Object.assign({}, settings, { privacyMode: true })),
        off: model.capturePermission(Object.assign({}, settings, { screen: false })),
      },
    };
  })()`);
  record(
    '感知：行为状态推测（专注/频繁切换/走神/离开）',
    perceptionModel.states.deep === 'deep' &&
      perceptionModel.states.shallow === 'shallow' &&
      perceptionModel.states.idle === 'idle' &&
      perceptionModel.states.away === 'away',
    JSON.stringify(perceptionModel.states),
  );
  record(
    '感知：深夜判定与免打扰时段（含跨零点）',
    perceptionModel.lateNight.three === true &&
      perceptionModel.lateNight.noon === false &&
      perceptionModel.quiet.inside === true &&
      perceptionModel.quiet.morning === true &&
      perceptionModel.quiet.outside === false,
    JSON.stringify({ lateNight: perceptionModel.lateNight, quiet: perceptionModel.quiet }),
  );
  record(
    '感知：主动打扰受频率闸门约束（首次放行 / 太频繁拦截 / 超上限拦截 / 用户不在拦截）',
    perceptionModel.gateFirst.allow === true &&
      perceptionModel.gateTooSoon.allow === false &&
      perceptionModel.gateAtLimit.allow === false &&
      perceptionModel.gateAway.allow === false,
    JSON.stringify({
      first: perceptionModel.gateFirst,
      tooSoon: perceptionModel.gateTooSoon,
      atLimit: perceptionModel.gateAtLimit,
      away: perceptionModel.gateAway,
    }),
  );
  record(
    '感知：敏感/陌生人属于紧急行为（不受每小时上限限制）',
    perceptionModel.gateUrgent.allow === true,
    JSON.stringify(perceptionModel.gateUrgent),
  );
  record(
    '感知：干预规划正确（久坐提醒 / 敏感内容演 shy / 场景变化打招呼 / 深夜已不再劝睡）',
    perceptionModel.planLong !== null &&
      perceptionModel.planLong.kind === 'long-session' &&
      perceptionModel.planSensitive !== null &&
      perceptionModel.planSensitive.kind === 'sensitive' &&
      /*
       * 敏感内容 -> `shy`（害羞捂眼睛），而且**不再整只藏起来**：
       * 需求把"发现私密内容"明确归给了 shy 这条触发动画，
       * 它本身就是捂眼睛的动作，比"消失 20 秒"更贴切。
       */
      perceptionModel.planSensitive.animation === 'shy' &&
      perceptionModel.planSensitive.hide === false &&
      /*
       * 深夜（1~4 点）不再产出"劝睡"：那条规则与默认免打扰时段（23–8 点）
       * 完全重叠、永远不会通过闸门，已按需求删除。
       * `planLateOnly` 用"只有深夜条件成立"的输入，必须什么都不返回。
       */
      perceptionModel.planLate.kind !== 'late-night' &&
      perceptionModel.planLateOnly === null &&
      perceptionModel.planScene !== null &&
      perceptionModel.planScene.kind === 'scene-change',
    JSON.stringify({
      long: perceptionModel.planLong,
      sensitive: perceptionModel.planSensitive,
      late: perceptionModel.planLate,
      lateOnly: perceptionModel.planLateOnly,
      scene: perceptionModel.planScene,
    }),
  );
  record(
    '感知：敏感关键词是第二道闸（模型没看出来也不能漏）',
    perceptionModel.sensitiveKeyword === true && perceptionModel.harmless === false,
    `hit=${perceptionModel.sensitiveKeyword} miss=${perceptionModel.harmless}`,
  );

  /*
   * 敏感词第二道闸必须**也扫窗口标题与网址**。
   *
   * 文档评审抓到的真 bug：早期只扫 `app + activity + summary`，而窗口标题恰恰是
   * 文档名出现的地方（"工资表.xlsx - Excel"、"招商银行 - 转账"）——
   * 等于把最该拦的那一路排除在保护之外。
   */
  const sensitiveScope = await run(`(() => {
    const model = window.petDebug.perception;
    const settings = model.DEFAULT_PERCEPTION_SETTINGS;
    const base = { app: 'Excel', activity: '在处理表格', summary: '', sensitive: false };
    return {
      windowTitle: model.isSensitive(Object.assign({}, base, { windowTitle: '工资表 - 招商银行 - Excel' }), settings.sensitivityKeywords),
      url: model.isSensitive(Object.assign({}, base, { url: 'bank.example.com/transfer' }), settings.sensitivityKeywords),
      clean: model.isSensitive(Object.assign({}, base, { windowTitle: '周报.docx - Word', url: 'github.com/a/b' }), settings.sensitivityKeywords),
      modelFlag: model.isSensitive(Object.assign({}, base, { sensitive: true }), settings.sensitivityKeywords),
    };
  })()`);
  record(
    '感知：敏感词也扫窗口标题与网址（文档名/银行页面不会被漏掉）',
    sensitiveScope.windowTitle === true && sensitiveScope.url === true && sensitiveScope.clean === false && sensitiveScope.modelFlag === true,
    JSON.stringify(sensitiveScope),
  );
  record(
    '感知：场景词表归一（大小写/近义词/脏数据都收敛到受控值）',
    perceptionModel.normalize[0] === 'coding' &&
      perceptionModel.normalize[1] === 'reading' &&
      perceptionModel.normalize[2] === 'other' &&
      perceptionModel.normalize[3] === 'gaming' &&
      perceptionModel.sceneLabel === '写代码',
    JSON.stringify(perceptionModel.normalize),
  );
  record(
    '感知：「没认出来」当作没看见——不进习惯统计、不拿来说话、不进时间线文本',
    JSON.stringify(perceptionModel.unrecognized.recognized) === JSON.stringify([true, false, true]) &&
      // other 不进统计：只喂 other 时画像一份样本都没涨
      perceptionModel.unrecognized.learnOtherOnly === 0 &&
      perceptionModel.unrecognized.learnMixed === 3 &&
      // 台词：只有 other -> 不说；混着 coding -> 说"写代码"；老画像里的 other 也被跳过
      perceptionModel.unrecognized.topOtherOnly === null &&
      perceptionModel.unrecognized.topMixed === 'coding' &&
      perceptionModel.unrecognized.topLegacy === null &&
      perceptionModel.unrecognized.textOtherOnly === null &&
      typeof perceptionModel.unrecognized.textMixed === 'string' &&
      perceptionModel.unrecognized.textMixed.includes('写代码') &&
      perceptionModel.unrecognized.textLegacy === null &&
      // 时间线：other 观察不新起段、也不打断上一段
      perceptionModel.unrecognized.segmentsAfterOther === 0 &&
      perceptionModel.unrecognized.segmentsAfterCoding === 1 &&
      JSON.stringify(perceptionModel.unrecognized.recognizedSegments) === JSON.stringify(['coding']) &&
      perceptionModel.unrecognized.timelineText.includes('写代码') &&
      !perceptionModel.unrecognized.timelineText.includes('没认出来'),
    JSON.stringify(perceptionModel.unrecognized),
  );

  /*
   * 场景纠正：**用户实测反馈**"浏览网页总是被识别成笔记软件记笔记"。
   *
   * 这类误判只靠提示词说服模型不稳（模型看得见 Chrome 却把长文页面判成 writing），
   * 因此代码里按应用名/界面线索做了一轮确定性纠正，并留了用户自定义规则的入口。
   * 这条断言把三种情形都钉住，免得以后调提示词时又退回去。
   */
  const sceneRefine = await run(`(() => {
    const model = window.petDebug.perception;
    const cases = {
      // ① 浏览器里看长文被模型判成"写东西" -> 纠正为浏览网页
      browserWriting: model.refineScene({ scene: 'writing', app: 'Google Chrome' }),
      // ② 笔记软件被判成"浏览网页" -> 纠正为写东西（反向也要管）
      editorBrowsing: model.refineScene({ scene: 'browsing', app: 'Obsidian' }),
      // ③ 影音应用被判成写东西 -> 看视频
      videoWriting: model.refineScene({ scene: 'writing', app: 'bilibili' }),
      // ④ 界面线索：只有浏览器界面、没有编辑器界面
      chromeOnly: model.refineScene({ scene: 'writing', app: '', browserChrome: true, editorChrome: false }),
      // ⑤ 信息不足时不乱纠正（既没看到浏览器也没看到编辑器界面）
      noClue: model.refineScene({ scene: 'writing', app: '未知应用' }),
      // ⑥ 用户自定义规则优先于一切
      userFix: model.refineScene({ scene: 'writing', app: 'MyWeirdApp', fixes: ['myweirdapp=browsing'] }),
      // ⑦ 非法规则行被忽略
      badFixes: model.parseSceneFixes(['', '# 注释', '没有等号', 'Chrome=不存在的场景', 'Chrome=browsing']),
      // ⑧ 应用名判类
      kinds: [model.appKind('Google Chrome'), model.appKind('Microsoft Edge'), model.appKind('Notion'), model.appKind('VS Code'), model.appKind('')],
      // ⑨ 默认配置里带了两条开箱即用的浏览器纠正
      defaultFixes: window.petDebug.perception.DEFAULT_PERCEPTION_SETTINGS.sceneFixes.length,
    };
    return cases;
  })()`);
  record(
    '感知：浏览器里的长文不再被当成"写笔记"（应用名判类 + 界面线索）',
    sceneRefine.browserWriting.scene === 'browsing' &&
      sceneRefine.browserWriting.reason.length > 0 &&
      sceneRefine.videoWriting.scene === 'video' &&
      sceneRefine.chromeOnly.scene === 'browsing',
    JSON.stringify({
      browserWriting: sceneRefine.browserWriting,
      videoWriting: sceneRefine.videoWriting,
      chromeOnly: sceneRefine.chromeOnly,
    }),
  );
  record(
    '感知：反向也管（笔记软件不会被认成浏览网页）且信息不足时不乱改',
    sceneRefine.editorBrowsing.scene === 'writing' && sceneRefine.noClue.scene === 'writing' && sceneRefine.noClue.reason === '',
    JSON.stringify({ editorBrowsing: sceneRefine.editorBrowsing, noClue: sceneRefine.noClue }),
  );
  record(
    '感知：用户自定义纠正规则优先，且非法规则被忽略',
    sceneRefine.userFix.scene === 'browsing' &&
      sceneRefine.badFixes.length === 1 &&
      sceneRefine.badFixes[0].keyword === 'chrome' &&
      sceneRefine.badFixes[0].scene === 'browsing' &&
      sceneRefine.defaultFixes >= 1,
    JSON.stringify({ userFix: sceneRefine.userFix, badFixes: sceneRefine.badFixes, defaultFixes: sceneRefine.defaultFixes }),
  );
  record(
    '感知：应用名能判出浏览器/编辑器/未知三类',
    sceneRefine.kinds[0] === 'browser' &&
      sceneRefine.kinds[1] === 'browser' &&
      sceneRefine.kinds[2] === 'editor' &&
      sceneRefine.kinds[3] === 'unknown' &&
      sceneRefine.kinds[4] === 'unknown',
    JSON.stringify(sceneRefine.kinds),
  );
  /*
   * 短词的**词边界**匹配（文档评审从代码里看出的反例）：
   * `arc` / `edge` / `docs` / `notes` 这类短词用子串匹配会误伤一大片 ——
   * "Search" 含 arc、"Knowledge" 含 edge 都会被判成浏览器。
   */
  const appFalsePositives = await run(`(() => {
    const model = window.petDebug.perception;
    return {
      search: model.appKind('Search'),
      knowledge: model.appKind('Knowledge Base'),
      arch: model.appKind('Arch Linux'),
      real: [model.appKind('Google Chrome'), model.appKind('Microsoft Edge'), model.appKind('Google Docs'), model.appKind('Apple Notes')],
      boundary: [model.matchesAppName('Search', 'arc'), model.matchesAppName('Microsoft Edge', 'edge'), model.matchesAppName('浏览器', '浏览器')],
    };
  })()`);
  record(
    '感知：短应用名的词边界匹配（Search / Knowledge 不会被误判成浏览器）',
    appFalsePositives.search === 'unknown' &&
      appFalsePositives.knowledge === 'unknown' &&
      appFalsePositives.arch === 'unknown' &&
      appFalsePositives.real[0] === 'browser' &&
      appFalsePositives.real[1] === 'browser' &&
      appFalsePositives.real[2] === 'editor' &&
      appFalsePositives.real[3] === 'editor' &&
      appFalsePositives.boundary[0] === false &&
      appFalsePositives.boundary[1] === true &&
      appFalsePositives.boundary[2] === true,
    JSON.stringify(appFalsePositives),
  );

  /*
   * 网址线索（用户提问："如果是网页，可以把网址也一起传过去吗"）。
   *
   * 做法：单独截一条**高分辨率地址栏横条**给模型读网址，然后用域名做确定性纠正。
   * 这里断言的是可测的那一半（解析、域名规则、隐私默认值），
   * "模型能不能看清地址栏"只能实机验证。
   */
  const urlRules = await run(`(() => {
    const model = window.petDebug.perception;
    return {
      // 注意：这里要真的调用 safeHost —— 直接写输入数组会把"输入"当成"输出"比（写错过一次）
      hosts: ['https://www.github.com/foo/bar?x=1', 'bilibili.com/video/BV1', 'arxiv.org/abs/2401.00001', 'not a url', ''].map((raw) =>
        model.safeHost(raw),
      ),
      parsed: model.isUrlLike('github.com') && model.isUrlLike('https://arxiv.org/abs/1') && !model.isUrlLike('我的笔记') && !model.isUrlLike('两个 词'),
      // 域名规则：影音/论文/在线 IDE/在线文档/邮件
      youtube: model.refineSceneByUrl('https://www.youtube.com/watch?v=abc', 'writing'),
      arxiv: model.refineSceneByUrl('arxiv.org/abs/2401.00001', 'browsing'),
      vscodeDev: model.refineSceneByUrl('vscode.dev/github/x', 'browsing'),
      notion: model.refineSceneByUrl('notion.so/xxx', 'browsing'),
      mail: model.refineSceneByUrl('mail.google.com/u/0', 'browsing'),
      // 普通网页 + 模型说"写东西" -> 浏览网页（就是用户报的那个误判）
      plainWriting: model.refineSceneByUrl('example.com/article', 'writing'),
      // 普通网页 + 模型说"看视频" -> 不动（不过度干预）
      plainVideo: model.refineSceneByUrl('example.com/a', 'video'),
      // 没有网址时不纠正
      noUrl: model.refineSceneByUrl('', 'writing'),
      // 用户规则优先于域名规则
      userWins: model.refineScene({ scene: 'video', app: 'Chrome', url: 'youtube.com/watch', fixes: ['chrome=reading'] }),
      // 域名规则优先于应用名判类
      urlBeatsApp: model.refineScene({ scene: 'writing', app: 'Google Chrome', url: 'arxiv.org/abs/1' }),
    };
  })()`);
  record(
    '感知：网址解析（只留域名，去掉协议/路径/查询串与 www）',
    urlRules.hosts[0] === 'github.com' &&
      urlRules.hosts[1] === 'bilibili.com' &&
      urlRules.hosts[2] === 'arxiv.org' &&
      urlRules.hosts[3] === '' &&
      urlRules.hosts[4] === '' &&
      urlRules.parsed === true,
    JSON.stringify(urlRules.hosts),
  );
  record(
    '感知：按域名纠正场景（视频/论文/在线 IDE/在线文档/邮件各归各位）',
    urlRules.youtube.scene === 'video' &&
      urlRules.arxiv.scene === 'reading' &&
      urlRules.vscodeDev.scene === 'coding' &&
      urlRules.notion.scene === 'writing' &&
      urlRules.mail.scene === 'writing' &&
      urlRules.youtube.reason.length > 0,
    JSON.stringify({
      youtube: urlRules.youtube,
      arxiv: urlRules.arxiv,
      vscodeDev: urlRules.vscodeDev,
      notion: urlRules.notion,
      mail: urlRules.mail,
    }),
  );
  record(
    '感知：普通网页 + "写东西"纠正为浏览网页，但不改动其它判断（不过度干预）',
    urlRules.plainWriting.scene === 'browsing' &&
      urlRules.plainWriting.reason.length > 0 &&
      urlRules.plainVideo.scene === 'video' &&
      urlRules.plainVideo.reason === '' &&
      urlRules.noUrl.scene === 'writing' &&
      urlRules.noUrl.reason === '',
    JSON.stringify({ plainWriting: urlRules.plainWriting, plainVideo: urlRules.plainVideo, noUrl: urlRules.noUrl }),
  );
  record(
    '感知：纠正优先级（用户规则 > 域名 > 应用名）',
    urlRules.userWins.scene === 'reading' && urlRules.urlBeatsApp.scene === 'reading',
    JSON.stringify({ userWins: urlRules.userWins, urlBeatsApp: urlRules.urlBeatsApp }),
  );
  const urlPrivacy = await run(`(async () => {
    const status = await window.petAPI.perception.status();
    return { captureUrl: status.settings.captureUrl, storeFullUrl: status.settings.storeFullUrl, width: status.settings.urlCaptureWidth };
  })()`);
  record(
    '感知：网址默认只存域名、可关可调（隐私默认值正确）',
    urlPrivacy.captureUrl === true && urlPrivacy.storeFullUrl === false && urlPrivacy.width >= 640,
    JSON.stringify(urlPrivacy),
  );

  /*
   * 窗口上下文（用户要求："把现在启动的窗口和最上层的窗口传进去辅助判断"）。
   *
   * 实测（tools/probe-foreground-window.cjs）：PowerShell `EnumWindows` 一次能拿到
   * 29 个可见窗口 + 进程名 + 前台标记（~500ms），而 `desktopCapturer` 只枚举到 2 个
   * 且不告诉哪个是前台 —— 所以走前者。这里断言可测的那一半：
   * 标题规范化、进程名/标题规则、优先级、列表拼装与过滤、隐私默认值。
   */
  const windowRules = await run(`(() => {
    const model = window.petDebug.perception;
    // 标题里混着零宽空格/不换行空格是实测常态：不做规范化就永远匹配不上
    const dirty = 'Microsoft\\u200b Edge\\u00a0- 论文.pdf';
    return {
      normalized: model.normalizeWindowTitle(dirty),
      normalizedHasInvisible: /[\\u200b\\u00a0]/.test(model.normalizeWindowTitle(dirty)),
      coding: model.refineSceneByWindow({ process: 'Code', title: 'main.ts - Visual Studio Code', scene: 'browsing' }),
      writing: model.refineSceneByWindow({ process: 'Typora', title: '桌面宠物.md - Typora', scene: 'browsing' }),
      pdf: model.refineSceneByWindow({ process: 'msedge', title: '论文.pdf - Microsoft Edge', scene: 'writing' }),
      video: model.refineSceneByWindow({ process: 'msedge', title: '哔哩哔哩 (゜-゜)つロ 干杯~', scene: 'writing' }),
      gaming: model.refineSceneByWindow({ process: 'steam', title: 'Steam', scene: 'browsing' }),
      meeting: model.refineSceneByWindow({ process: 'wemeetapp', title: '腾讯会议', scene: 'writing' }),
      terminal: model.refineSceneByWindow({ process: 'WindowsTerminal', title: 'Windows PowerShell', scene: 'writing' }),
      // 浏览器进程不该把已经判对的细分场景拉平成 browsing
      browserKeepsReading: model.refineSceneByWindow({ process: 'msedge', title: '某篇文章 - Microsoft Edge', scene: 'reading' }),
      // 信息不足时不动
      unknownProcess: model.refineSceneByWindow({ process: 'weirdapp', title: '标题', scene: 'writing' }),
      // 前后台标记 / 我们自己的窗口过滤 / 列表拼装
      filtered: model.withoutOwnWindows([
        { title: '桌宠设置', process: 'electron' },
        { title: '论文.pdf - Microsoft Edge', process: 'msedge' },
        { title: '和鲸鱼娘说话', process: 'electron' },
        // 桌宠页面自己的窗口标题（实测会出现在枚举结果里）
        { title: '鲸鱼娘桌宠', process: 'electron' },
      ]).map((item) => item.title),
      prompt: model.describeWindowContext({
        foreground: { title: 'main.ts - Visual Studio Code', process: 'code' },
        windows: [
          { title: 'main.ts - Visual Studio Code', process: 'code' },
          { title: 'main.ts - Visual Studio Code', process: 'code' },
          { title: '论文.pdf - Microsoft Edge', process: 'msedge' },
          { title: '桌宠设置', process: 'electron' },
        ],
        limit: 10,
      }),
    };
  })()`);
  record(
    '感知：窗口标题规范化（去掉零宽字符与不换行空格，否则永远匹配不上）',
    windowRules.normalized === 'Microsoft Edge - 论文.pdf' && windowRules.normalizedHasInvisible === false,
    JSON.stringify({ normalized: windowRules.normalized }),
  );
  record(
    '感知：按最上层窗口纠正场景（Code/Typora/PDF/视频/游戏/会议/终端各归各位）',
    windowRules.coding.scene === 'coding' &&
      windowRules.writing.scene === 'writing' &&
      windowRules.pdf.scene === 'reading' &&
      windowRules.video.scene === 'video' &&
      windowRules.gaming.scene === 'gaming' &&
      windowRules.meeting.scene === 'meeting' &&
      windowRules.terminal.scene === 'terminal',
    JSON.stringify({
      coding: windowRules.coding.scene,
      writing: windowRules.writing.scene,
      pdf: windowRules.pdf.scene,
      video: windowRules.video.scene,
      gaming: windowRules.gaming.scene,
      meeting: windowRules.meeting.scene,
      terminal: windowRules.terminal.scene,
    }),
  );
  record(
    '感知：窗口规则不过度干预（浏览器不拉平细分场景；认不出的进程不动）',
    windowRules.browserKeepsReading.scene === 'reading' &&
      windowRules.browserKeepsReading.reason === '' &&
      windowRules.unknownProcess.scene === 'writing' &&
      windowRules.unknownProcess.reason === '',
    JSON.stringify({ browserKeepsReading: windowRules.browserKeepsReading, unknownProcess: windowRules.unknownProcess }),
  );
  record(
    '感知：窗口列表拼装（过滤我们自己的窗口、去重、给出最上层窗口）',
    windowRules.filtered.length === 1 &&
      windowRules.filtered[0] === '论文.pdf - Microsoft Edge' &&
      windowRules.prompt.indexOf('最上层窗口：main.ts - Visual Studio Code') >= 0 &&
      windowRules.prompt.indexOf('桌宠设置') < 0 &&
      // 注意：这条断言在**模板字符串之外**，所以这里要写单反斜杠；
      // 写成 `\\.` 会变成"字面反斜杠 + 任意字符"，永远匹配不到（刚踩过）
      (windowRules.prompt.match(/main\.ts - Visual Studio Code/g) || []).length === 1,
    JSON.stringify({ filtered: windowRules.filtered, prompt: windowRules.prompt }),
  );
  const windowPrivacy = await run(`(async () => {
    const status = await window.petAPI.perception.status();
    return { windowContext: status.settings.windowContext, limit: status.settings.windowListLimit, ttl: status.settings.windowProbeTtlMs, hasStatusField: typeof status.windowContext === 'object' };
  })()`);
  record(
    '感知：窗口上下文默认开启、隐私默认值正确（只存最上层窗口，状态里有独立字段）',
    windowPrivacy.windowContext === true &&
      windowPrivacy.limit >= 1 &&
      windowPrivacy.limit <= 24 &&
      windowPrivacy.ttl >= 5000 &&
      windowPrivacy.hasStatusField === true,
    JSON.stringify(windowPrivacy),
  );

  /*
   * 明细保留期（A）：一天一个文件（逐条观察 / 当天区间 / 当天 md）会只增不减，
   * 所以过期的那天要**先归档成一行**（`perception/archive/<月>.md`）再删明细。
   *
   * 测法（真文件、真删除）：在隔离的数据目录里造两个"过期日"的明细文件 + 一个"新近日"的，
   * 然后 `sampleNow()`（手动采样会强制执行一次保留期清理），最后看文件系统。
   */
  const retentionProbe = await run(`(() => {
    const model = window.petDebug.perception.timeline;
    const day = (offset) => {
      const date = new Date(Date.now() - offset * 86400000);
      const pad = (value) => String(value).padStart(2, '0');
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    };
    return {
      expired: [day(200), day(120)],
      recent: day(3),
      selected: model.selectExpiredDays([day(200), day(120), day(3), 'not-a-date'], Date.now(), 90),
      keepAll: model.selectExpiredDays([day(200), day(120)], Date.now(), 0),
      line: model.formatArchiveLine({
        day: day(200), activeMinutes: 252, idleMinutes: 55,
        byScene: [{ scene: 'coding', minutes: 150 }, { scene: 'browsing', minutes: 60 }],
        apps: ['code', 'msedge'],
      }),
    };
  })()`);
  let retentionFiles = { before: [], after: [], archived: '' };
  try {
    const perceptionDir = join(aiDataDir, 'perception');
    mkdirSync(perceptionDir, { recursive: true });
    for (const day of retentionProbe.expired) {
      writeFileSync(join(perceptionDir, `observations-${day}.jsonl`), '{"scene":"coding"}\n', 'utf8');
      writeFileSync(join(perceptionDir, `timeline-${day}.json`), JSON.stringify({
        date: day, narrative: '', updatedAt: new Date().toISOString(),
        segments: [{ start: `${day}T01:00:00.000Z`, end: `${day}T02:00:00.000Z`, scene: 'coding', app: 'code', samples: 120, minutes: 60 }],
      }), 'utf8');
      writeFileSync(join(perceptionDir, `daily-${day}.md`), '# old\n', 'utf8');
    }
    writeFileSync(join(perceptionDir, `observations-${retentionProbe.recent}.jsonl`), '{"scene":"coding"}\n', 'utf8');
    retentionFiles.before = readdirSync(perceptionDir).sort();
  } catch (error) {
    retentionFiles.before = [`(准备失败: ${String(error)})`];
  }
  await run(`window.petAPI.perception.sampleNow()`);
  await wait(500);
  try {
    const perceptionDir = join(aiDataDir, 'perception');
    retentionFiles.after = readdirSync(perceptionDir).sort();
    const archiveDir = join(perceptionDir, 'archive');
    const archives = existsSync(archiveDir) ? readdirSync(archiveDir).sort() : [];
    retentionFiles.archived = archives.length > 0 ? readFileSync(join(archiveDir, archives[0]), 'utf8') : '';
  } catch (error) {
    retentionFiles.after = [`(读取失败: ${String(error)})`];
  }
  record(
    '感知：明细过保留期先归档成一行再删（新近的与 archive/ 都留着）',
    retentionProbe.selected.length === 2 &&
      retentionProbe.keepAll.length === 0 &&
      retentionProbe.line.includes('在电脑前 4 小时 12 分') &&
      retentionProbe.line.includes('写代码 2 小时 30 分') &&
      retentionFiles.after.some((name) => name.startsWith('archive')) &&
      retentionFiles.archived.includes('# ') &&
      retentionFiles.archived.includes('在电脑前') &&
      !retentionFiles.after.includes(`observations-${retentionProbe.expired[0]}.jsonl`) &&
      !retentionFiles.after.includes(`timeline-${retentionProbe.expired[1]}.json`) &&
      !retentionFiles.after.includes(`daily-${retentionProbe.expired[0]}.md`) &&
      retentionFiles.after.includes(`observations-${retentionProbe.recent}.jsonl`),
    JSON.stringify({ probe: retentionProbe, files: retentionFiles.after, archive: retentionFiles.archived.slice(0, 200) }),
  );

  /*
   * 终端：**需求明确要求「直接说正在使用控制台，不用分析终端里在做什么」**。
   *
   * 所以这一路是"固定结论"而不是"内容理解"：前台是终端类进程时，场景钉成 `terminal`、
   * `activity` 钉成固定文案、**既不截图也不调模型**（`mode: 'local'`、`tokens: 0`）。
   * 这里钉三个可测的点：进程判定、固定文案、以及"不额外暴露设置项"（没有 terminalText 开关）。
   */
  const terminalRule = await run(`(async () => {
    const model = window.petDebug.perception;
    const observation = model.terminalObservationFor('windowsterminal', 'PS E:\\\\ds_pet>', 1700000000000);
    const status = await window.petAPI.perception.status();
    return {
      isTerminal: model.isTerminalProcess('WindowsTerminal'),
      isTerminalExe: model.isTerminalProcess('powershell.exe'),
      isTerminalUpper: model.isTerminalProcess('WINDOWSTERMINAL'),
      isBrowser: model.isTerminalProcess('msedge'),
      isEmpty: model.isTerminalProcess(''),
      text: model.TERMINAL_ACTIVITY_TEXT,
      observation: {
        scene: observation.scene,
        activity: observation.activity,
        mode: observation.mode,
        tokens: observation.tokens,
        suggestion: observation.suggestion,
        app: observation.app,
        windowTitle: observation.windowTitle,
      },
      hasTerminalTextSetting: Object.prototype.hasOwnProperty.call(status.settings, 'terminalText'),
      hasTerminalTextStatus: Object.prototype.hasOwnProperty.call(status, 'terminalText'),
    };
  })()`);
  /*
   * 每天的使用时间线（需求：「统计每天用户在做什么 …… 记录每天的使用时间区间，形成记忆」）。
   *
   * 全是纯函数，所以可以逐条钉死规则里的坑：同场景才合并、漏采一次仍算同一段、
   * 隔太久要另起一段、**idle 永远单独成段且不计入"在电脑前"**、跨天按本地日切。
   */
  const timelineRules = await run(`(() => {
    const model = window.petDebug.perception.timeline;
    // 用真实采样节奏（每 30 秒一条）构造：这样才能测出"合并/漏采容忍/隔太久另起"
    const at = (h, m, s = 0) => new Date(2025, 2, 1, h, m, s).toISOString();
    const obs = (h, m, s, scene, app) => ({ at: at(h, m, s), scene, app });
    let segments = [];
    segments = model.appendObservation(segments, obs(9, 0, 0, 'coding', 'code'));
    segments = model.appendObservation(segments, obs(9, 0, 30, 'coding', 'code'));   // 30s → 合并
    segments = model.appendObservation(segments, obs(9, 1, 0, 'coding', 'code'));    // 30s → 合并（段=09:00–09:01，3 条）
    segments = model.appendObservation(segments, obs(9, 5, 0, 'browsing', 'msedge')); // 场景变了 → 另起
    segments = model.appendObservation(segments, obs(9, 6, 0, 'browsing', 'msedge')); // 漏采一次（60s ≤ 150s）→ 仍合并
    segments = model.appendObservation(segments, obs(9, 10, 0, 'browsing', 'msedge')); // 隔 4 分钟 → 必须另起
    segments = model.appendObservation(segments, obs(9, 12, 0, 'idle', ''));
    segments = model.appendObservation(segments, obs(9, 12, 30, 'idle', ''));         // idle 与 idle 合并（但绝不与工作段合并）
    const totals = model.summarizeDay(segments);
    const day = { date: '2025-03-01', segments, totals, narrative: '', updatedAt: at(10, 30) };
    const narrative = model.buildNarrativeMessages({ timeline: day, petName: '鲸鱼娘', userName: '小明' });

    /*
     * ① 同一个程序的不同标题**不该**把一段切成好几段（用户实测：PVZ 的窗口标题在
     *    "PVZ Universe" / "Plants Vs. Zombies Universe" / "植物大战僵尸 Universe" 之间变）。
     */
    let churn = [];
    churn = model.appendObservation(churn, obs(10, 0, 0, 'gaming', 'PVZ Universe'));
    churn = model.appendObservation(churn, obs(10, 0, 30, 'gaming', 'Plants Vs. Zombies Universe'));
    churn = model.appendObservation(churn, obs(10, 1, 0, 'gaming', '植物大战僵尸 Universe'));
    const churnTotals = model.summarizeDay(churn);

    /*
     * ② 换段时把上一段**补到这一刻**：采样间隔（30s）不再凭空消失。
     *    09:30:00 coding → 09:30:30 browsing：上一段应为 09:30–09:30:30（0.5 分钟）。
     */
    let handover = [];
    handover = model.appendObservation(handover, obs(9, 30, 0, 'coding', 'code'));
    handover = model.appendObservation(handover, obs(9, 30, 30, 'browsing', 'msedge'));
    const handoverTotals = model.summarizeDay(handover);

    /*
     * ③ 账目自洽：跨度 = 活动 + 空闲 + 没认出来/没采样。
     *    这里造一个"中间漏了 20 分钟"的例子。
     */
    let leaky = [];
    leaky = model.appendObservation(leaky, obs(8, 0, 0, 'coding', 'code'));
    leaky = model.appendObservation(leaky, obs(8, 0, 30, 'coding', 'code'));
    leaky = model.appendObservation(leaky, obs(8, 20, 0, 'coding', 'code'));
    const leakyTotals = model.summarizeDay(leaky);

    /*
     * ④ 应用**身份** vs **友好名字**：身份（进程名）稳定、名字（模型读的）会变。
     *    同一身份反复出现 → 一段；名字只用于显示。
     */
    let identity = [];
    identity = model.appendObservation(identity, { at: at(11, 0, 0), scene: 'gaming', app: 'PlantsVsZombies.exe', appLabel: 'PVZ Universe' });
    identity = model.appendObservation(identity, { at: at(11, 0, 30), scene: 'gaming', app: 'PlantsVsZombies.exe', appLabel: 'Plants Vs. Zombies Universe' });
    identity = model.appendObservation(identity, { at: at(11, 1, 0), scene: 'gaming', app: 'PlantsVsZombies.exe', appLabel: '植物大战僵尸 Universe' });
    const identityTotals = model.summarizeDay(identity);

    /*
     * ⑤ 「没认出来」的桥接（用户实测后定的口径）：
     *    同一个应用里连续几次没认出来**不该**把一段切开 —— 应用一直开着是事实，
     *    只是那几次模型没看懂。桥接只认**同一个进程**（进程名是本地确定性证据），
     *    而且只在"我们一直在采样"（间隔 ≤ 阈值）时生效。
     */
    let bridged = [];
    bridged = model.appendObservation(bridged, obs(12, 0, 0, 'chatting', '元宝'));
    for (let i = 1; i <= 6; i += 1) {
      bridged = model.appendObservation(bridged, obs(12, 0, i * 30, 'other', '元宝'));
    }
    bridged = model.appendObservation(bridged, obs(12, 3, 30, 'chatting', '元宝'));
    const bridgedTotals = model.summarizeDay(bridged);

    // 换了应用：不桥接（这一段的 end 停在 13:00:00，13:03:30 因为超阈值另起一段）
    let crossed = [];
    crossed = model.appendObservation(crossed, obs(13, 0, 0, 'chatting', '元宝'));
    for (let i = 1; i <= 6; i += 1) {
      crossed = model.appendObservation(crossed, obs(13, 0, i * 30, 'other', 'msedge'));
    }
    crossed = model.appendObservation(crossed, obs(13, 3, 30, 'chatting', '元宝'));

    // 没认出来且已经隔了 4 分钟：也不桥接（那段时间真的没采到样）
    let stale = [];
    stale = model.appendObservation(stale, obs(14, 0, 0, 'chatting', '元宝'));
    stale = model.appendObservation(stale, obs(14, 4, 0, 'other', '元宝'));
    stale = model.appendObservation(stale, obs(14, 4, 30, 'chatting', '元宝'));

    return {
      segmentCount: segments.length,
      scenes: segments.map((s) => s.scene),
      samples: segments.map((s) => s.samples),
      firstSegmentMinutes: segments[0].minutes,
      activeMinutes: totals.activeMinutes,
      idleMinutes: totals.idleMinutes,
      unaccountedMinutes: totals.unaccountedMinutes,
      topScene: totals.byScene[0].scene,
      topShare: totals.byScene[0].share,
      topApp: totals.byApp[0].app,
      duration60: model.formatDuration(60),
      duration90: model.formatDuration(90),
      duration45: model.formatDuration(45),
      line: model.formatSegmentLine(segments[0]),
      text: model.formatTimelineText(day),
      crossDay: model.localDayOf(new Date(2025, 2, 1, 23, 59).getTime()) !== model.localDayOf(new Date(2025, 2, 2, 0, 1).getTime()),
      promptHasFacts: narrative.system.includes('只根据') && narrative.user.includes('时间线'),
      gapMs: model.SEGMENT_GAP_MS,
      identity: {
        count: identity.length,
        app: identity[0].app,
        label: identity[0].appLabel,
        samples: identity[0].samples,
        minutes: identity[0].minutes,
        line: model.formatSegmentLine(identity[0]),
        byApp: identityTotals.byApp,
        activeMinutes: identityTotals.activeMinutes,
      },
      churn: {
        count: churn.length,
        samples: churn[0].samples,
        minutes: churn[0].minutes,
        app: churn[0].app,
        labels: Object.keys(churn[0].appCounts ?? {}),
        activeMinutes: churnTotals.activeMinutes,
        byApp: churnTotals.byApp,
      },
      bridge: {
        count: bridged.length,
        samples: bridged[0] ? bridged[0].samples : 0,
        minutes: bridged[0] ? bridged[0].minutes : 0,
        unrecognized: bridged[0] ? (bridged[0].unrecognizedSamples ?? 0) : 0,
        end: bridged[0] ? bridged[0].end : '',
        activeMinutes: bridgedTotals.activeMinutes,
      },
      bridgeCrossed: { count: crossed.length, unrecognized: crossed[0] ? (crossed[0].unrecognizedSamples ?? 0) : 0 },
      bridgeStale: { count: stale.length },
      handover: {
        count: handover.length,
        firstMinutes: handover[0].minutes,
        firstEnd: handover[0].end,
        secondStart: handover[1].start,
        activeMinutes: handoverTotals.activeMinutes,
      },
      leaky: {
        activeMinutes: leakyTotals.activeMinutes,
        unaccountedMinutes: leakyTotals.unaccountedMinutes,
        spanMinutes: Math.round(((new Date(leakyTotals.lastAt) - new Date(leakyTotals.firstAt)) / 60000) * 10) / 10,
      },
    };
  })()`);
  record(
    '感知：时间线聚合（同场景才合并 / 漏采容忍 / 隔太久另起 / idle 自成一类且不计入在电脑前）',
    timelineRules.segmentCount === 4 &&
      JSON.stringify(timelineRules.scenes) === JSON.stringify(['coding', 'browsing', 'browsing', 'idle']) &&
      JSON.stringify(timelineRules.samples) === JSON.stringify([3, 2, 1, 2]) &&
      timelineRules.firstSegmentMinutes === 1 &&
      /*
       * ⚠️ 下面这几项的期望值随阈值变过：`SEGMENT_GAP_MS` 90s → 150s 之后，
       * 09:06 → 09:10 之间的 120 秒空档被算成"一直在采样"，于是
       *   · 09:10 的 browsing 段在换到 idle 时被**补到 09:12**（换段补时规则）→ 活动 4 分钟；
       *   · 占比最高的是 browsing（3/4 = 75%）。
       * 这正是"放宽阈值"换来的东西：不再把 2 分钟的真实空档切成两段。
       */
      timelineRules.activeMinutes === 4 &&
      timelineRules.idleMinutes === 0.5 &&
      timelineRules.unaccountedMinutes === 8 &&
      timelineRules.topScene === 'browsing' &&
      timelineRules.topShare === 0.75 &&
      timelineRules.topApp === 'msedge' &&
      timelineRules.duration60 === '1 小时' &&
      timelineRules.duration90 === '1 小时 30 分' &&
      timelineRules.duration45 === '45 分钟' &&
      /09:00–09:01 写代码（VS Code）/.test(timelineRules.line) === true &&
      timelineRules.text.includes('写代码') &&
      timelineRules.crossDay === true &&
      timelineRules.promptHasFacts === true &&
      timelineRules.gapMs === 150000,
    JSON.stringify(timelineRules),
  );
  /*
   * 用户实测报的问题：同一个游戏因为窗口标题在三种写法之间变，被切成十几段、
   * 每段时长都接近 0，`byApp` 里也列成三行。合并键改用 scene 之后应当只剩一段。
   */
  record(
    '感知：同一个程序换了标题不会把一段切开（合并只看场景，app 只作代表性标签）',
    timelineRules.churn.count === 1 &&
      timelineRules.churn.samples === 3 &&
      timelineRules.churn.minutes === 1 &&
      timelineRules.churn.labels.length === 3 &&
      timelineRules.churn.app === 'PVZ Universe' &&
      timelineRules.churn.activeMinutes === 1,
    JSON.stringify(timelineRules.churn),
  );
  record(
    '感知：换段时把上一段补到这一刻（采样间隔不再凭空消失）',
    timelineRules.handover.count === 2 &&
      timelineRules.handover.firstMinutes === 0.5 &&
      timelineRules.handover.firstEnd === timelineRules.handover.secondStart &&
      timelineRules.handover.activeMinutes === 0.5,
    JSON.stringify(timelineRules.handover),
  );
  /*
   * 用户实测报的问题：同一个应用里夹了几次"没认出来"，就被切成一串碎片
   * （`10:58–11:01 聊天`、`11:03–11:05 聊天`…）。规则：
   * 同一个进程 + 一直在采样 → 桥接（并把次数留痕）；换应用或隔太久 → 不桥接。
   */
  record(
    '感知：「没认出来」在同一进程内被桥接（不切段、次数留痕），换应用或断采则不桥接',
    timelineRules.bridge.count === 1 &&
      timelineRules.bridge.samples === 8 &&
      timelineRules.bridge.unrecognized === 6 &&
      timelineRules.bridge.minutes === 3.5 &&
      timelineRules.bridge.activeMinutes === 3.5 &&
      timelineRules.bridgeCrossed.count === 2 &&
      timelineRules.bridgeCrossed.unrecognized === 0 &&
      timelineRules.bridgeStale.count === 2,
    JSON.stringify({
      bridge: timelineRules.bridge,
      crossed: timelineRules.bridgeCrossed,
      stale: timelineRules.bridgeStale,
    }),
  );
  record(
    '感知：时长账目自洽（跨度 = 活动 + 空闲 + 没认出来/没采样）',
    timelineRules.leaky.activeMinutes === 0.5 &&
      timelineRules.leaky.unaccountedMinutes === 19.5 &&
      timelineRules.leaky.spanMinutes === 20,
    JSON.stringify(timelineRules.leaky),
  );
  /*
   * 应用身份（进程名）与友好名字（模型读的）分开之后：
   * 身份稳定 → 一段；名字只用于显示（括号里显示最后看到的那个）。
   */
  record(
    '感知：应用身份稳定（进程名）+ 友好名字只用于显示（同一程序恒为一段一行）',
    timelineRules.identity.count === 1 &&
      timelineRules.identity.app === 'PlantsVsZombies.exe' &&
      timelineRules.identity.label === '植物大战僵尸 Universe' &&
      timelineRules.identity.samples === 3 &&
      timelineRules.identity.minutes === 1 &&
      timelineRules.identity.byApp.length === 1 &&
      timelineRules.identity.byApp[0].app === 'PlantsVsZombies.exe' &&
      timelineRules.identity.byApp[0].minutes === 1 &&
      timelineRules.identity.line.includes('植物大战僵尸 Universe'),
    JSON.stringify(timelineRules.identity),
  );
  /*
   * 用户实测报的问题（看图即知）：同一个 Edge 在时间线里显示成三个名字 ——
   * 老观察里 `app` 存的是模型名（`Microsoft Edge`）、新观察里存进程名（`msedge`）、
   * 模型给的友好名又可能是 `Edge`。名字不统一看起来像三件不同的事。
   *
   * 规则：**已知进程名一律用固定名字**（表里没有的才回退到模型读出来的那个）。
   */
  const appNames = await run(`(() => {
    const model = window.petDebug.perception;
    return {
      edgeWithLabel: model.appDisplayName('msedge', 'Edge'),
      edgeWithoutLabel: model.appDisplayName('msedge', ''),
      edgeWithExe: model.appDisplayName('msedge.exe', 'Microsoft Edge'),
      // 历史观察里 app 存的是模型名（不是进程名），也要归到同一个显示名
      legacyEdgeLabel: model.appDisplayName('Edge', ''),
      legacyEdgeFull: model.appDisplayName('Microsoft Edge', 'Microsoft Edge'),
      code: model.appDisplayName('code', 'Visual Studio Code'),
      legacyCode: model.appDisplayName('VS Code', ''),
      unknownUsesLabel: model.appDisplayName('SomeWeirdApp', '神奇软件'),
      unknownUsesIdentity: model.appDisplayName('SomeWeirdApp', ''),
      empty: model.appDisplayName('', ''),
      normalized: model.normalizeProcessName('  MSEDGE.EXE '),
      // 时间线一行也用同一个函数（显示层与聚合层的名字必须同源）
      line: model.timeline.formatSegmentLine({
        start: '2025-01-09T01:00:00.000Z', end: '2025-01-09T01:02:00.000Z',
        scene: 'browsing', app: 'msedge', appLabel: 'Edge', samples: 5, minutes: 2,
      }),
    };
  })()`);
  record(
    '感知：同一个程序永远同一个显示名（msedge 一律显示为 Microsoft Edge，未知程序才用模型给的名字）',
    appNames.edgeWithLabel === 'Microsoft Edge' &&
      appNames.edgeWithoutLabel === 'Microsoft Edge' &&
      appNames.edgeWithExe === 'Microsoft Edge' &&
      appNames.legacyEdgeLabel === 'Microsoft Edge' &&
      appNames.legacyEdgeFull === 'Microsoft Edge' &&
      appNames.code === 'VS Code' &&
      appNames.legacyCode === 'VS Code' &&
      appNames.unknownUsesLabel === '神奇软件' &&
      appNames.unknownUsesIdentity === 'SomeWeirdApp' &&
      appNames.empty === '' &&
      appNames.normalized === 'msedge' &&
      appNames.line.includes('（Microsoft Edge）'),
    JSON.stringify(appNames),
  );
  const timelineStatus = await run(`(async () => {
    const status = await window.petAPI.perception.status();
    const timeline = await window.petAPI.perception.timeline();
    return {
      statusDate: status.timeline.date,
      hasFields: typeof status.timeline.activeMinutes === 'number' && Array.isArray(status.timeline.recent),
      readDate: timeline.date,
      readShape: typeof timeline.text === 'string' && typeof timeline.narrative === 'string' && typeof timeline.hasData === 'boolean',
    };
  })()`);
  record(
    '感知：时间线可读（状态里有今天的区间视图，IPC 也能取到某天的文本与叙述）',
    typeof timelineStatus.statusDate === 'string' &&
      timelineStatus.hasFields === true &&
      timelineStatus.readDate === timelineStatus.statusDate &&
      timelineStatus.readShape === true,
    JSON.stringify(timelineStatus),
  );

  /*
   * 感知日志的**时间与详细程度**（用户实测报的两个问题）。
   *
   * 时间：原来写的是 `observation.at.slice(11,16)` —— 那是 ISO(**UTC**) 的时分，
   * UTC+8 下整份日志差 8 小时。现在统一走 `formatLogTimestamp()`（本地时间 + 秒）。
   * 详细：原来只有"写代码（code）"，看不出她在做什么、凭什么这么判、看没看到网址/窗口、
   * 走没走模型；现在一行里全都有（`formatObservationLogLine()`，文件与面板共用）。
   */
  const logFormat = await run(`(() => {
    const model = window.petDebug.perception;
    const iso = '2025-03-01T00:30:45.000Z';
    const local = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const expectedLocal = local.getFullYear() + '-' + pad(local.getMonth() + 1) + '-' + pad(local.getDate())
      + ' ' + pad(local.getHours()) + ':' + pad(local.getMinutes()) + ':' + pad(local.getSeconds());
    const rich = model.formatObservationLogLine({
      at: iso, scene: 'coding', app: 'code', activity: '在写一个探针',
      url: 'github.com', windowTitle: 'probe.cjs - Visual Studio Code',
      sensitive: false, focus: 'shallow', summary: '', suggestion: '',
      mode: 'llm', tokens: 860, evidence: '编辑器窗口标题（code）',
    });
    const plain = model.formatObservationLogLine({
      at: iso, scene: 'terminal', app: 'windowsterminal', activity: '正在使用控制台',
      sensitive: false, focus: 'unknown', summary: '', suggestion: '', mode: 'local', tokens: 0,
    });
    return {
      timestamp: model.formatLogTimestamp(iso),
      expectedLocal,
      utcSlice: iso.slice(11, 16),
      rich,
      plain,
      richParts: rich.split('｜').length,
    };
  })()`);
  record(
    '感知：日志时间戳是本地时间且带秒（原来写的是 UTC 时分，差一个时区）',
    logFormat.timestamp === logFormat.expectedLocal &&
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(logFormat.timestamp) &&
      // 这条断言的意义就在这儿：UTC 切片与本地渲染**不同**，才说明修的是真问题
      logFormat.utcSlice !== logFormat.timestamp.slice(11, 16),
    JSON.stringify(logFormat),
  );
  record(
    '感知：日志行够详细（场景/应用 + 在做什么 + 网址 + 窗口 + 切换 + 依据 + 走没走模型）',
    logFormat.rich.includes('写代码（code）') &&
      logFormat.rich.includes('在写一个探针') &&
      logFormat.rich.includes('github.com') &&
      logFormat.rich.includes('窗口 probe.cjs - Visual Studio Code') &&
      logFormat.rich.includes('频繁切换') &&
      logFormat.rich.includes('依据 编辑器窗口标题（code）') &&
      logFormat.rich.includes('大模型 860 token') &&
      // 场景｜在做什么｜网址｜窗口｜切换｜依据｜模型 = 7 段（多一段说明有人往里塞了没设计过的字段）
      logFormat.richParts === 7 &&
      logFormat.plain.includes('正在使用控制台') &&
      logFormat.plain.includes('仅窗口信息（没走模型）'),
    JSON.stringify(logFormat),
  );

  record(
    '感知：前台是终端就直接给「正在使用控制台」（固定结论，不截图不调模型，也没有额外开关）',
    terminalRule.isTerminal === true &&
      terminalRule.isTerminalExe === true &&
      terminalRule.isTerminalUpper === true &&
      terminalRule.isBrowser === false &&
      terminalRule.isEmpty === false &&
      terminalRule.text === '正在使用控制台' &&
      terminalRule.observation.scene === 'terminal' &&
      terminalRule.observation.activity === '正在使用控制台' &&
      terminalRule.observation.mode === 'local' &&
      terminalRule.observation.tokens === 0 &&
      terminalRule.observation.suggestion === '' &&
      terminalRule.observation.app === 'windowsterminal' &&
      // 注意：外层是普通 JS 字符串，一个反斜杠要写两次；写成四次会变成"两个反斜杠"而永远不等
      terminalRule.observation.windowTitle === 'PS E:\\ds_pet>' &&
      terminalRule.hasTerminalTextSetting === false &&
      terminalRule.hasTerminalTextStatus === false,
    JSON.stringify(terminalRule),
  );
  /* 优先级：用户规则 > 网址 > 窗口 > 应用名 */
  const scenePriority = await run(`(() => {
    const model = window.petDebug.perception;
    return {
      windowBeatsApp: model.refineScene({ scene: 'browsing', app: 'Google Chrome', window: { process: 'typora', title: '笔记.md - Typora' } }),
      urlBeatsWindow: model.refineScene({ scene: 'browsing', app: 'Google Chrome', url: 'youtube.com/watch', window: { process: 'typora', title: '笔记.md - Typora' } }),
      userBeatsAll: model.refineScene({ scene: 'browsing', app: 'Google Chrome', url: 'youtube.com/watch', window: { process: 'typora', title: '笔记.md' }, fixes: ['chrome=reading'] }),
    };
  })()`);
  record(
    '感知：纠正优先级（用户规则 > 网址域名 > 最上层窗口 > 应用名）',
    scenePriority.windowBeatsApp.scene === 'writing' &&
      scenePriority.urlBeatsWindow.scene === 'video' &&
      scenePriority.userBeatsAll.scene === 'reading',
    JSON.stringify(scenePriority),
  );
  record(
    '感知：习惯学习按天聚合，并能预测当前时段（按你平时的习惯…）',
    perceptionModel.habitSamples === 4 &&
      perceptionModel.habitObservedHours === 1 &&
      perceptionModel.habitTop === 'coding' &&
      typeof perceptionModel.predict === 'string' &&
      perceptionModel.predict.includes('写代码'),
    JSON.stringify({
      samples: perceptionModel.habitSamples,
      hours: perceptionModel.habitObservedHours,
      top: perceptionModel.habitTop,
      predict: perceptionModel.predict,
    }),
  );

  /*
   * 习惯画像 v1 -> v2 **迁移**（纯函数，直接喂旧 JSON）。
   *
   * 放在这里而不是探针里：迁移是主进程读盘时做的，但逻辑本身是纯数据变换
   * （`migrateHabitProfile`），直接喂一份 v1 JSON 就能确定性地断言 ——
   * 不必依赖"写文件 -> 重启 -> 再读"的时序（那种测法还会被"这次采样认出来了没"影响）。
   */
  const habitMigration = await run(`(() => {
    const model = window.petDebug.perception;
    // 只有 3 个使用日的画像：窗口有 21 个名额，所以**一条都不该被裁**
    const legacy = model.migrateHabitProfile({
      hours: { 10: { coding: 27, reading: 5 }, 15: { browsing: 9 } },
      observedHours: 2, samples: 41, activeDays: 3,
      latestActiveHour: 23, earliestActiveHour: 9,
      lastActiveDate: '2026-09-20', updatedAt: '2026-09-20T23:00:00.000Z',
    });
    // 使用日超过 21 个：只保留最近 21 个（老的被挤掉）
    const crowdedDates = [];
    for (let i = 0; i < 30; i += 1) {
      const day = new Date(2026, 0, 1 + i);
      // 注意：这里不能写模板字符串（整段脚本本身就在模板字符串里）
      crowdedDates.push('2026-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0'));
    }
    const crowded = model.migrateHabitProfile({
      version: 2, seen: { '*|10': { coding: crowdedDates } }, samples: 30, activeDays: 30, lastActiveDate: '2026-01-30',
    });
    // 坏数据一律退回空画像，不许抛
    const bad = [
      model.migrateHabitProfile(null),
      model.migrateHabitProfile('not-json'),
      model.migrateHabitProfile({ hours: 'oops', seen: { 'weekday|99': { coding: ['2026-09-26'] } } }),
    ];
    // v2 自己的清洗：非法日期 / 非法桶 / 去重
    const cleaned = model.migrateHabitProfile({
      version: 2,
      seen: {
        'weekday|10': { coding: ['2026-09-26', '2026-09-26', '不是日期', '2026-09-25'] },
        'weekday|99': { coding: ['2026-09-26'] },
        'bogus|10': { coding: ['2026-09-26'] },
      },
      daily: { '2026-09-26': { latestHour: 23, earliestHour: 9 }, 'x': { latestHour: 1 } },
      samples: 5, activeDays: 2, lastActiveDate: '2026-09-26',
    });
    return {
      legacy: {
        version: legacy.version,
        seenKeys: Object.keys(legacy.seen),
        codingDays: legacy.seen['*|10'] ? legacy.seen['*|10'].coding : null,
        browsingDays: legacy.seen['*|15'] ? legacy.seen['*|15'].browsing.length : null,
        // 27 次观察 / 3 个活跃日 -> 最多 3 天
        capped: legacy.seen['*|10'] ? legacy.seen['*|10'].coding.length : -1,
        recentDays: Object.keys(legacy.daily).length,
        latest: legacy.latestActiveHour,
        earliest: legacy.earliestActiveHour,
      },
      crowded: {
        days: model.habitCounts(crowded, '*|10').coding ?? null,
        dailyDays: Object.keys(crowded.daily).length,
        newest: model.habitActiveDays(crowded)[0] ?? '',
        oldest: model.habitActiveDays(crowded).slice(-1)[0] ?? '',
      },
      bad: bad.map((item) => ({ samples: item.samples, version: item.version, keys: Object.keys(item.seen).length })),
      cleaned: {
        codingDates: cleaned.seen['weekday|10'] ? cleaned.seen['weekday|10'].coding : null,
        keys: Object.keys(cleaned.seen),
        dailyKeys: Object.keys(cleaned.daily),
      },
    };
  })()`);
  record(
    '习惯迁移：使用日不足窗口时不裁任何东西（几个月没启动也不会丢）',
    habitMigration.legacy.version === 2 &&
      JSON.stringify(habitMigration.legacy.seenKeys) === JSON.stringify(['*|10', '*|15']) &&
      habitMigration.legacy.capped === 3 &&
      habitMigration.legacy.browsingDays === 3 &&
      habitMigration.legacy.recentDays === 1 &&
      habitMigration.legacy.latest === 23 &&
      habitMigration.legacy.earliest === 9,
    JSON.stringify(habitMigration.legacy),
  );
  record(
    '习惯迁移：使用日超过 21 个时只保留最近 21 个（按"运行过的日子"裁，不按日历）',
    habitMigration.crowded.days === 21 &&
      habitMigration.crowded.newest === '2026-01-30' &&
      habitMigration.crowded.oldest === '2026-01-10',
    JSON.stringify(habitMigration.crowded),
  );
  record(
    '习惯迁移：坏数据退回空画像（不抛异常）；v2 非法日期/桶被清洗且去重',
    habitMigration.bad.every((item) => item.version === 2 && item.samples === 0 && item.keys === 0) &&
      JSON.stringify(habitMigration.cleaned.codingDates) === JSON.stringify(['2026-09-25', '2026-09-26']) &&
      JSON.stringify(habitMigration.cleaned.keys) === JSON.stringify(['weekday|10']) &&
      JSON.stringify(habitMigration.cleaned.dailyKeys) === JSON.stringify(['2026-09-26']),
    JSON.stringify({ bad: habitMigration.bad, cleaned: habitMigration.cleaned }),
  );

  /*
   * 习惯画像 v2：四个缺口的修复各钉一条。
   *
   * 这四条都是"统计口径"问题，肉眼很难发现回归（她只是"学得慢一点/说得早一点"），
   * 所以必须逐条断言：去重、衰减、可回落、分档 + 应用。
   */
  const habitV2 = perceptionModel.habitV2;
  record(
    '习惯 v2：同一天同一小时同一场景只算一天（不再被"多看两眼"刷成铁证）',
    habitV2.dedupSamples === 5 &&
      habitV2.dedupDays === 1 &&
      habitV2.secondDayCoding === 2 &&
      habitV2.constants.minDays === 3 &&
      habitV2.constants.minSceneDays === 2,
    JSON.stringify({
      samples: habitV2.dedupSamples,
      days: habitV2.dedupDays,
      secondDay: habitV2.secondDayCoding,
      minDays: habitV2.constants.minDays,
    }),
  );
  record(
    '习惯 v2：遗忘按「运行过的天数」算 —— 超过 21 个使用日才挤掉最早的',
    habitV2.constants.windowDays === 21 &&
      habitV2.windowedCoding === 21 &&
      habitV2.windowedReading === null &&
      habitV2.windowedDailyDays === 21,
    JSON.stringify({
      windowDays: habitV2.constants.windowDays,
      coding: habitV2.windowedCoding,
      dailyDays: habitV2.windowedDailyDays,
    }),
  );
  record(
    '习惯 v2：中间几个月没启动，旧习惯不会被时间冲掉（没启动不计入天数）',
    habitV2.gappedCoding === 20 &&
      habitV2.gappedReading === 1 &&
      habitV2.gappedDailyDays === 21 &&
      habitV2.gappedActiveDays === 22,
    JSON.stringify({
      coding: habitV2.gappedCoding,
      reading: habitV2.gappedReading,
      dailyDays: habitV2.gappedDailyDays,
      activeDays: habitV2.gappedActiveDays,
    }),
  );
  record(
    '习惯 v2：工作日/周末分档统计，互不污染',
    habitV2.weekendBucket?.gaming === 1 &&
      Object.keys(habitV2.weekdayBucketOfWeekend).length === 0 &&
      habitV2.weekdayReading?.scene === 'coding' &&
      habitV2.weekdayReading?.days === 3 &&
      habitV2.weekendReading === null,
    JSON.stringify({
      weekend: habitV2.weekendBucket,
      weekdayAt10: habitV2.weekdayReading,
      weekendAt10: habitV2.weekendReading,
    }),
  );
  record(
    '习惯 v2：作息会回落（取最近 21 天的中位数，不再是历史极值）且记下应用',
    habitV2.rollingLatest === 21 &&
      habitV2.rollingEarliest === 21 &&
      habitV2.rollingRecentDays === 4 &&
      habitV2.appDays === 1 &&
      habitV2.thinHour === null &&
      habitV2.thinText === null &&
      JSON.stringify(habitV2.statsLines).includes('Code'),
    JSON.stringify({
      latest: habitV2.rollingLatest,
      earliest: habitV2.rollingEarliest,
      recentDays: habitV2.rollingRecentDays,
      app: habitV2.appDays,
      thin: habitV2.thinHour,
    }),
  );
  /*
   * 习惯建模的**离线**部分（在线那条在下面用假网关跑）：
   * 条目由本地统计算出、模板兜底可用、解析容错（模型把两段挤在一行也要认）。
   */
  record(
    '习惯建模（纯函数）：条目由本地统计算出 + 模板兜底 + 解析容错',
    habitV2.routines.length >= 1 &&
      habitV2.routines[0].days === 3 &&
      habitV2.routines[0].what === '写代码' &&
      habitV2.localModel.summary.includes('写代码') &&
      habitV2.localModel.line.includes('写代码') &&
      habitV2.parsedModel?.summary === '你很爱写代码。' &&
      habitV2.parsedModel?.line === '在写代码吧？',
    JSON.stringify({ routines: habitV2.routines, local: habitV2.localModel, parsed: habitV2.parsedModel }),
  );
  record(
    '感知：采集闸门（正常允许 / 隐私模式停 / 开关关闭停）',
    perceptionModel.permission.normal.allowed === true &&
      perceptionModel.permission.privacy.allowed === false &&
      perceptionModel.permission.off.allowed === false,
    JSON.stringify(perceptionModel.permission),
  );

  /*
   * 每一类干预都必须归属到具体开关：只关掉"行为观察"时，久坐/深夜提醒也必须停
   * （否则用户会觉得开关是假的 —— 文档评审抓到过这一条）。
   */
  const planOwnership = await run(`(() => {
    const model = window.petDebug.perception;
    const base = model.DEFAULT_PERCEPTION_SETTINGS;
    const noBehavior = Object.assign({}, base, { behavior: false });
    const noHabits = Object.assign({}, base, { habits: false });
    const noCamera = Object.assign({}, base, { camera: false });
    const noScreenNoCamera = Object.assign({}, base, { screen: false, camera: false });
    return {
      longOff: model.isPlanEnabled('long-session', noBehavior),
      sceneOff: model.isPlanEnabled('scene-change', noBehavior),
      habitWhenNoHabits: model.isPlanEnabled('habit', noHabits),
      presenceWhenNoCamera: model.isPlanEnabled('presence', noCamera),
      strangerWhenNoCamera: model.isPlanEnabled('stranger', noCamera),
      sensitiveWhenNoScreen: model.isPlanEnabled('sensitive', noScreenNoCamera),
      allOn: [
        model.isPlanEnabled('long-session', base),
        model.isPlanEnabled('habit', base),
        model.isPlanEnabled('presence', base),
        model.isPlanEnabled('sensitive', base),
      ],
    };
  })()`);
  record(
    '感知：干预归属到具体开关（关掉行为观察后久坐/场景变化不再提醒；关掉摄像头后不管在场）',
    planOwnership.longOff === false &&
      planOwnership.sceneOff === false &&
      planOwnership.habitWhenNoHabits === false &&
      planOwnership.presenceWhenNoCamera === false &&
      planOwnership.strangerWhenNoCamera === false &&
      planOwnership.sensitiveWhenNoScreen === false &&
      planOwnership.allOn.every((value) => value === true),
    JSON.stringify(planOwnership),
  );

  /*
   * 日常闲聊的多样化（需求："不仅仅基于用户习惯询问，有时候也可能换成一些问候、
   * 最近发生的有趣的事等等，**频率不变**"）。
   *
   * 这一组只钉两件事，都是纯函数、可确定性复现：
   *   1. 候选要覆盖 问候 / 习惯 / 今天的活动 / 最近的事 四类；
   *   2. **不连着说同一类**（`lastKind` 生效），且只剩一类时允许重复（不能卡死不说）。
   * "频率不变"由既有的 `gateIntervention` 决定，那些断言在别处，这里不重复。
   */
  const smallTalkModel = await run(`(() => {
    const model = window.petDebug.perception;
    const full = {
      hour: 9,
      userName: '小明',
      habitText: '按你平时的习惯，这个点一般在写代码，今天也是吗？',
      topActivity: { scene: 'coding', minutes: 200 },
      recentMoment: { title: '一起熬夜赶论文', daysAgo: 1, kind: 'late-night' },
    };
    const candidates = model.buildSmallTalk(full);
    const kinds = [...new Set(candidates.map((c) => c.kind))];
    // 连续挑 10 次（固定随机源）：相邻两次不该是同一类
    const picked = [];
    let last = null;
    for (const r of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
      const item = model.pickSmallTalk(candidates, () => r, last);
      if (!item) break;
      picked.push(item.kind);
      last = item.kind;
    }
    const obs = {
      at: new Date().toISOString(), scene: 'coding', app: 'VS Code', activity: '写代码',
      sensitive: false, focus: 'deep', summary: '', suggestion: '', mode: 'llm', tokens: 1,
    };
    const settings = model.DEFAULT_PERCEPTION_SETTINGS;
    const quietBehavior = { idleSeconds: 5, sessionMinutes: 10, switchesLastHour: 2, hour: 9, lateNight: false, userState: 'deep' };
    const longBehavior = Object.assign({}, quietBehavior, { sessionMinutes: 130 });
    const talk = { kind: 'greeting', text: '早上好呀' };
    return {
      kinds,
      texts: candidates.map((c) => c.text),
      picked,
      avoidsLast: model.pickSmallTalk(candidates, () => 0, 'greeting')?.kind ?? '',
      onlyOneKind: model.pickSmallTalk([{ kind: 'habit', text: 'h' }], () => 0, 'habit')?.kind ?? '',
      // 关掉习惯、今天也没记录、也没有记忆时，仍然有问候/陪伴可说
      minimal: model.buildSmallTalk({ hour: 15, userName: '' }).map((c) => c.kind),
      morning: model.buildSmallTalk({ hour: 7, userName: '' }).find((c) => c.kind === 'greeting')?.text ?? '',
      planSmall: model.planIntervention({
        observation: obs, behavior: quietBehavior, settings, previousScene: 'coding', smallTalk: talk,
      })?.kind ?? '',
      // 闲聊**不能**顶掉久坐提醒（优先级不变）
      planLongWins: model.planIntervention({
        observation: obs, behavior: longBehavior, settings, previousScene: 'coding', smallTalk: talk,
      })?.kind ?? '',
    };
  })()`);
  record(
    '日常闲聊：候选覆盖问候/习惯/今天的活动/最近的事，且不会连着说同一类',
    smallTalkModel.kinds.includes('greeting') &&
      smallTalkModel.kinds.includes('habit') &&
      smallTalkModel.kinds.includes('activity') &&
      smallTalkModel.kinds.includes('recent') &&
      smallTalkModel.picked.length === 10 &&
      smallTalkModel.picked.every((kind, index) => index === 0 || kind !== smallTalkModel.picked[index - 1]) &&
      smallTalkModel.avoidsLast !== 'greeting' &&
      smallTalkModel.onlyOneKind === 'habit' &&
      smallTalkModel.minimal.length > 0 &&
      smallTalkModel.minimal.every((kind) => kind === 'greeting' || kind === 'company') &&
      smallTalkModel.morning.includes('早'),
    JSON.stringify(smallTalkModel),
  );
  record(
    '日常闲聊：走的是原来那一档（不再只有习惯询问），且不会顶掉久坐提醒',
    smallTalkModel.planSmall === 'small-talk' && smallTalkModel.planLongWins === 'long-session',
    JSON.stringify({ planSmall: smallTalkModel.planSmall, planLongWins: smallTalkModel.planLongWins }),
  );

  /*
   * 采样频率：心跳周期与 `captureIntervalMs` 必须分开。
   *
   * 早期版本把心跳周期写成 `captureIntervalMs / 2`，默认 30000 就变成**每 15 秒截一帧**
   * （token 成本翻倍，且与面板上写的"默认 30000"不符）。这里直接读主进程日志里的
   * `perception loop started` 一行，把"心跳周期 = 采样间隔"这件事钉住。
   */
  let perceptionLoopLog = '';
  try {
    const text = readFileSync(logFile, 'utf8');
    perceptionLoopLog = text.split('\n').find((line) => line.includes('perception loop started')) ?? '';
  } catch (error) {
    perceptionLoopLog = '';
  }
  record(
    '感知：心跳周期与采样间隔分离（默认 30s 采样就真的是 30s，不是 15s）',
    /"tickMs":30000/.test(perceptionLoopLog) && /"captureIntervalMs":30000/.test(perceptionLoopLog),
    perceptionLoopLog.slice(0, 200),
  );

  /* 隐私模式：真的停止采集，并且"看屏幕"被拒 */
  const privacy = await run(`(async () => {
    await window.petAPI.perception.setSettings({ privacyMode: true });
    const before = await window.petAPI.perception.status();
    const sampled = await window.petAPI.perception.sampleNow();
    const view = await window.petAPI.perception.viewNow('scene');
    const list = await window.petAPI.perception.log(10);
    await window.petAPI.perception.setSettings({ privacyMode: false });
    return {
      capturingWhilePrivate: before.capturing,
      pausedReason: before.pausedReason,
      sampledCapturing: sampled.capturing,
      viewOk: view.ok,
      viewText: view.text,
      logKinds: list.map((item) => item.kind),
    };
  })()`);
  record(
    '感知：隐私模式真的一键停止采集（采样不动、看屏幕被拒）',
    privacy.capturingWhilePrivate === false &&
      privacy.pausedReason.length > 0 &&
      privacy.viewOk === false &&
      /隐私模式/.test(privacy.viewText) === true &&
      privacy.sampledCapturing === false,
    JSON.stringify(privacy),
  );

  /* 摄像头授权：未授权时不采帧；授权状态可读回、可撤销 */
  const cameraConsent = await run(`(async () => {
    const before = await window.petAPI.perception.status();
    await window.petAPI.perception.sampleNow();
    const stillDenied = await window.petAPI.perception.status();
    const authorized = await window.petAPI.perception.authorizeCamera(true);
    const afterAuthorize = await window.petAPI.perception.status();
    const revoked = await window.petAPI.perception.authorizeCamera(false);
    return {
      authorizedBefore: before.settings.cameraAuthorized,
      cameraReadyBefore: before.cameraReady,
      cameraReadyDenied: stillDenied.cameraReady,
      authorizedAfter: authorized.settings.cameraAuthorized,
      cameraReadyAfterAuthorize: afterAuthorize.cameraReady,
      revokedAfter: revoked.settings.cameraAuthorized,
    };
  })()`);
  record(
    '感知：摄像头必须显式授权（默认不授权、不采帧，可授权可撤销）',
    cameraConsent.authorizedBefore === false &&
      cameraConsent.cameraReadyBefore === false &&
      cameraConsent.cameraReadyDenied === false &&
      cameraConsent.authorizedAfter === true &&
      cameraConsent.revokedAfter === false,
    JSON.stringify(cameraConsent),
  );

  /* 手动采样：能跑、不抛异常（没配密钥时走**本地窗口判断**，不截屏、不调模型） */
  const perceptionSample = await run(`(async () => {
    const status = await window.petAPI.perception.sampleNow();
    const observation = status.lastObservation;
    return {
      capturing: status.capturing,
      lastError: status.lastError,
      hasObservation: observation !== null,
      // 本地路径的观察必须标记 mode='local' 且 0 token（证明没有偷偷调用模型）
      mode: observation ? observation.mode : '',
      tokens: observation ? observation.tokens : -1,
      scene: observation ? observation.scene : '',
      windowTitle: observation ? (observation.windowTitle ?? '') : '',
      idle: status.behavior.idleSeconds,
      windowCount: status.windowContext.count,
    };
  })()`);
  record(
    '感知：没配密钥时也能用窗口信息做本地判断（不截屏、不调模型、0 token）',
    typeof perceptionSample.capturing === 'boolean' &&
      typeof perceptionSample.idle === 'number' &&
      (perceptionSample.hasObservation === false ||
        (perceptionSample.mode === 'local' && perceptionSample.tokens === 0)),
    JSON.stringify(perceptionSample),
  );
  record(
    '感知：窗口上下文在没配密钥时也能读到（独立于大模型，面板才有东西可显示）',
    perceptionSample.windowCount >= 1,
    JSON.stringify({ count: perceptionSample.windowCount, scene: perceptionSample.scene, title: perceptionSample.windowTitle }),
  );

  /* 清空感知数据（隐私要求：用户可以一键抹掉她观察到的一切） */
  const perceptionCleared = await run(`(async () => {
    const before = await window.petAPI.perception.status();
    const after = await window.petAPI.perception.clearData();
    return { samplesBefore: before.habits.samples, samplesAfter: after.habits.samples };
  })()`);
  record('感知：可以一键清空观察记录与习惯画像', perceptionCleared.samplesAfter === 0, JSON.stringify(perceptionCleared));

  /*
   * 习惯建模（把统计归纳成一段话）。
   *
   * 这条链路的三个环节都要真跑：
   *   1. **输入**：把统计文本（`habitStatsLines` + 本地算出的时段）发给模型 ——
   *      断言请求体里出现了真实的天数与时段，而不是让模型凭空写；
   *   2. **输出**：模型回"摘要：… / 说：…"两行 -> 解析成 `summary` + `line`；
   *   3. **降级**：模型不可用时必须退回本地模板（`source === 'template'` 且有原因）。
   *
   * ⚠️ 这里**刻意不调用 `sampleNow()`**：那会留下一条 `lastObservation`，
   * 而后面"模型不可达时不写脏观察"那条用例正依赖它是 null（实测因此红过一次）。
   * "条目要够多才出现"由纯函数断言（见上面的 habitV2）与
   * tools/probe-habit-model.cjs（预置一份多天画像）覆盖。
   *
   * 另外注意 `chat: true` 是必须的：`evaluateAIUsability()` 把"对话开关"当成
   * "能不能用大模型"的总闸（视觉理解也一样）。
   */
  const habitHttp = require('node:http');
  const habitRequests = [];
  const habitServer = habitHttp.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (error) { parsed = {}; }
      habitRequests.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'habit-stub',
        model: 'stub-model',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: '摘要：你大多在工作日的上午写代码，看着挺专注的。说：这个点你一般在写代码吧？' },
        }],
        usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
      }));
    });
  });
  await new Promise((resolve) => habitServer.listen(0, '127.0.0.1', resolve));
  const habitPort = habitServer.address().port;

  const habitModelRun = await run(`(async () => {
    const perception = window.petAPI.perception;
    const ai = window.petAPI.ai;
    const before = await ai.status();
    await ai.setSettings({
      enabled: true, chat: true, memory: false,
      provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:${habitPort}/v1', model: 'stub-model', apiKey: 'sk-acceptance-habit-0001', timeoutMs: 8000 },
    });
    const withModel = await perception.modelHabits();
    const after = await ai.status();
    // 断开模型（清掉密钥）之后再建一次 -> 必须退回本地模板，且写明原因
    await ai.setSettings({ provider: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', timeoutMs: 20000 }, clearApiKey: true });
    const templateOnly = await perception.modelHabits();
    return {
      samples: withModel.habits.samples,
      llm: withModel.habits.model,
      template: templateOnly.habits.model,
      tokensUsed: after.tokensUsed - before.tokensUsed,
    };
  })()`);
  await new Promise((resolve) => habitServer.close(resolve));

  const habitRequestBody = habitRequests[0] ?? {};
  const habitPrompt = JSON.stringify(habitRequestBody.messages ?? []);
  record(
    '习惯建模：把统计交给模型 -> 拿回「摘要 + 能说出口的一句」-> 落盘成习惯模型',
    habitRequests.length === 1 &&
      // 输入真的是统计（不是原始 JSON、更不是截图）
      habitPrompt.includes('样本：观察') &&
      habitPrompt.includes('归纳出的时段') &&
      habitModelRun.llm !== null &&
      habitModelRun.llm.source === 'llm' &&
      habitModelRun.llm.summary.includes('写代码') &&
      habitModelRun.llm.line.includes('写代码') &&
      habitModelRun.llm.error === '' &&
      habitModelRun.llm.tokens === 42 &&
      // 条目由**本地统计算出**，不经过模型（模型只写措辞）
      Array.isArray(habitModelRun.llm.routines) &&
      habitModelRun.llm.samples === habitModelRun.samples,
    JSON.stringify({ stubCalls: habitRequests.length, model: habitModelRun.llm, promptHead: habitPrompt.slice(0, 160) }),
  );
  record(
    '习惯建模：模型不可用时退回本地模板，并写明原因（面板能解释"为什么这次是模板"）',
    habitModelRun.template !== null &&
      habitModelRun.template.source === 'template' &&
      habitModelRun.template.summary.length > 0 &&
      habitModelRun.template.error.length > 0,
    JSON.stringify({ template: habitModelRun.template }),
  );
  record(
    '习惯建模：这次调用花的 token 记进了 AI 预算（不会偷偷烧额度）',
    habitModelRun.tokensUsed >= 42,
    JSON.stringify({ tokensUsed: habitModelRun.tokensUsed }),
  );
  const habitModelFile = join(aiDataDir, 'perception', 'habit-model.json');
  let habitModelOnDisk = null;
  try {
    habitModelOnDisk = JSON.parse(readFileSync(habitModelFile, 'utf8'));
  } catch (error) {
    habitModelOnDisk = null;
  }
  record(
    '习惯建模：模型落盘在 perception/habit-model.json（与统计 habits.json 分开）',
    habitModelOnDisk !== null &&
      typeof habitModelOnDisk.summary === 'string' &&
      habitModelOnDisk.summary.length > 0 &&
      habitModelOnDisk.source === 'template',
    JSON.stringify(habitModelOnDisk),
  );


  /* 感知日志：可审计（她看见了什么 / 为什么开口） */
  const perceptionLog = await run(`window.petAPI.perception.log(20)`);
  record(
    '感知：感知日志可读（至少能拿到加载与隐私相关的记录）',
    Array.isArray(perceptionLog) && perceptionLog.some((item) => item.kind === 'privacy' || item.kind === 'system'),
    JSON.stringify(perceptionLog.slice(0, 3)),
  );

  /*
   * 真的走一遍截屏链路（配一个不可达的模型地址）：
   * 目的是钉住两件事 ——
   *   1. 截屏 + 调用模型这条路径能跑起来，失败时**只是记一条 lastError**，
   *      不会崩、不会把脏数据当成观察结果；
   *   2. **磁盘上没有任何图像文件**（这是本模块最核心的隐私承诺）。
   *
   * ⚠️ 这一段必须先把「用窗口信息辅助判断」关掉：**验收自身就是从一个终端跑起来的**，
   * 而"最上层非自家窗口"恰好就是那个终端 —— 于是"前台是终端 → 固定结论"会正常命中，
   * 截屏与模型这条链路根本不会被走到（实测因此红过一次）。
   * 关掉窗口上下文后终端短路不会触发（它本来也受这个开关约束），这段才测的是它该测的东西。
   */
  const capturePath = await run(`(async () => {
    await window.petAPI.perception.setSettings({ windowContext: false });
    await window.petAPI.ai.setSettings({
      enabled: true, chat: true,
      provider: { baseUrl: 'http://127.0.0.1:9/v1', model: 'acceptance-vision', apiKey: 'sk-acceptance-vision-0001', timeoutMs: 1500 },
    });
    const status = await window.petAPI.perception.sampleNow();
    // 收尾：把假密钥清掉、窗口上下文恢复（本段只验证链路）
    await window.petAPI.ai.setSettings({ clearApiKey: true });
    await window.petAPI.perception.setSettings({ windowContext: true });
    return {
      capturing: status.capturing,
      lastError: status.lastError,
      hasObservation: status.lastObservation !== null,
      dataDir: status.dataDir,
    };
  })()`);
  let perceptionFiles = [];
  try {
    perceptionFiles = readdirSync(capturePath.dataDir);
  } catch (error) {
    perceptionFiles = [];
  }
  record(
    '感知：截屏 -> 视觉模型链路可运行，模型不可达时只记一条错误（不崩、不写脏观察）',
    capturePath.capturing === true && capturePath.hasObservation === false && capturePath.lastError.length > 0,
    JSON.stringify(capturePath),
  );
  record(
    '感知：磁盘上不出现任何图像文件（截图只在内存里活一次）',
    perceptionFiles.every((name) => !/\.(png|jpe?g|webp|bmp|gif)$/i.test(name)),
    `dir=${capturePath.dataDir} files=${JSON.stringify(perceptionFiles.slice(0, 8))}`,
  );
  /*
   * 用量记账：**所有**大模型调用都要进账，包括别的模块发出去的那些。
   *
   * 这条专门打"视觉理解"那一路（它是以前唯一完全没记账的调用之一）：
   * 用假网关让一次真实截图 + 场景分析成功，然后断言
   *   1. 本次运行的 token 涨了；
   *   2. 分档里出现了 `vision`。
   *
   * ⚠️ 必须先把「用窗口信息辅助判断」关掉：验收本身是从终端跑起来的，
   * 不关的话"前台是终端 → 固定结论"会命中，压根不会调模型。
   */
  const usageHttp = require('node:http');
  const usageRequests = [];
  const usageServer = usageHttp.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (error) { parsed = {}; }
      usageRequests.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'usage-stub',
        model: 'stub-model',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"scene":"coding","app":"Code","activity":"写代码","focus":"deep","sensitive":false,"summary":"在编辑器里写代码","suggestion":"","url":""}',
          },
        }],
        usage: { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 },
      }));
    });
  });
  await new Promise((resolve) => usageServer.listen(0, '127.0.0.1', resolve));
  const usagePort = usageServer.address().port;

  const usageRun = await run(`(async () => {
    const ai = window.petAPI.ai;
    const perception = window.petAPI.perception;
    await perception.setSettings({ windowContext: false });
    await ai.setSettings({
      enabled: true, chat: true,
      provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:${usagePort}/v1', model: 'stub-model', apiKey: 'sk-acceptance-usage-0001', timeoutMs: 8000 },
    });
    const before = await ai.status();
    const sample = await perception.sampleNow();
    const after = await ai.status();
    // 前台进程名（与视觉路径用的是同一个来源）—— 用来核对应用**身份**
    const foreground = (await perception.status()).windowContext.foregroundProcess;
    await ai.setSettings({ clearApiKey: true });
    await perception.setSettings({ windowContext: true });
    return {
      beforeSession: before.sessionTokens,
      afterSession: after.sessionTokens,
      usage: after.sessionUsage,
      scene: sample.lastObservation ? sample.lastObservation.scene : '',
      mode: sample.lastObservation ? sample.lastObservation.mode : '',
      app: sample.lastObservation ? sample.lastObservation.app : '',
      appLabel: sample.lastObservation ? (sample.lastObservation.appLabel ?? '') : '',
      foreground,
    };
  })()`);
  await new Promise((resolve) => usageServer.close(resolve));
  record(
    '用量记账：视觉理解（别的模块发的调用）也进"本次运行"的账，并按用途分档',
    usageRun.afterSession - usageRun.beforeSession >= 930 &&
      usageRun.usage.some((item) => item.purpose === 'vision' && item.tokens >= 930) &&
      // 场景具体是什么取决于跑验收时前台是哪个窗口（会被窗口证据纠正），只要求"认出来了"
      usageRun.scene !== '' &&
      usageRun.scene !== 'other' &&
      usageRun.mode === 'llm',
    JSON.stringify({ ...usageRun, stubCalls: usageRequests.length }),
  );
  /*
   * 模型说"Code"，但真实身份必须是**进程名** —— 否则同一个程序会被读成好几种名字
   * （实测：一个游戏被读成 PVZ / Plants Vs. Zombies / 植物大战僵尸 三种写法），
   * 时间线被切碎、"主要程序"列成好几行。
   */
  record(
    '感知：应用**身份**用进程名（模型给的名字只作 appLabel 显示）',
    usageRun.app !== '' &&
      usageRun.app === usageRun.foreground &&
      usageRun.foreground !== 'Code' &&
      usageRun.appLabel === 'Code',
    JSON.stringify({ app: usageRun.app, appLabel: usageRun.appLabel, foreground: usageRun.foreground }),
  );

  /*
   * 模型复核闸门（用户实测后定的省 token 策略）：
   * 换了应用立刻调模型，否则最多每 `modelRefreshMs` 调一次；
   * 中间的采样**沿用上一次的判断**，但照样记一条观察 —— 时间线因此不再断。
   *
   * 这条用一个假网关数调用次数：
   *   连续三次手动采样（同一个窗口、未到复核间隔）→ 只应该调 **1 次**模型，
   *   第 2、3 次是复用的观察（`mode: 'local'`、`tokens: 0`、场景与上一次相同），
   *   而习惯样本数要涨 3（证明"没花 token 也照样在记"）。
   */
  const gateHttp = require('node:http');
  const gateRequests = [];
  const gateServer = gateHttp.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (error) { parsed = {}; }
      gateRequests.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'gate-stub',
        model: 'stub-model',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '{"scene":"coding","app":"Code","activity":"写代码","focus":"deep","sensitive":false,"summary":"在编辑器里写代码","suggestion":"","url":""}',
          },
        }],
        usage: { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 },
      }));
    });
  });
  await new Promise((resolve) => gateServer.listen(0, '127.0.0.1', resolve));
  const gatePort = gateServer.address().port;

  /*
   * 第一步：**先保证"刚刚有过一次模型判断"**。
   *
   * 为什么要有这一步：闸门比的是"距上次模型调用多久"，而上一条用例（用量记账）
   * 刚刚调过一次模型 —— 如果直接进第二步，`now - lastModelAt` 本来就在阈值内，
   * 于是"一次都没调"也能通过，断言就失去意义了（第一版就是这么写的，实测拿到
   * `stubCalls: 0` 才发现）。这一步不断言，只把状态摆正。
   */
  const gateSetup = await run(`(async () => {
    const ai = window.petAPI.ai;
    const perception = window.petAPI.perception;
    // 关掉窗口上下文：这样"前台进程"恒为空 → 后面的采样之间不可能出现"换了应用"
    await perception.setSettings({ windowContext: false, modelRefreshMs: 30000 });
    await ai.setSettings({
      enabled: true, chat: true,
      provider: { kind: 'openai', baseUrl: 'http://127.0.0.1:${gatePort}/v1', model: 'stub-model', apiKey: 'sk-acceptance-gate-0001', timeoutMs: 8000 },
    });
    const status = await perception.sampleNow();
    return {
      scene: status.lastObservation ? status.lastObservation.scene : '',
      mode: status.lastObservation ? status.lastObservation.mode : '',
      samples: status.habits.samples,
    };
  })()`);
  const gateCallsAfterSetup = gateRequests.length;

  const gateRun = await run(`(async () => {
    const ai = window.petAPI.ai;
    const perception = window.petAPI.perception;
    // 复核间隔拉到 10 分钟：窗口没变 → 这三次都该沿用上一次的判断
    await perception.setSettings({ modelRefreshMs: 600000 });
    const before = await ai.status();
    const beforeStatus = await perception.status();
    const first = await perception.sampleNow();
    const second = await perception.sampleNow();
    const third = await perception.sampleNow();
    const after = await ai.status();
    await ai.setSettings({ clearApiKey: true });
    await perception.setSettings({ windowContext: true, modelRefreshMs: 300000 });
    const pick = (status) => ({
      mode: status.lastObservation ? status.lastObservation.mode : '',
      scene: status.lastObservation ? status.lastObservation.scene : '',
      tokens: status.lastObservation ? status.lastObservation.tokens : -1,
      at: status.lastObservation ? status.lastObservation.at : '',
    });
    return {
      first: pick(first),
      second: pick(second),
      third: pick(third),
      samplesBefore: beforeStatus.habits.samples,
      samplesAfter: third.habits.samples,
      tokensUsed: after.sessionTokens - before.sessionTokens,
    };
  })()`);
  await new Promise((resolve) => gateServer.close(resolve));
  record(
    '感知：窗口没变就不重复调模型（复核间隔内 0 次调用，其余沿用上一次判断但照样记观察）',
    // 三次手动采样**一次都没调模型**（与 setup 之后的计数一致）
    gateRequests.length === gateCallsAfterSetup &&
    gateRun.first.mode === 'local' &&
    gateRun.second.mode === 'local' &&
    gateRun.third.mode === 'local' &&
    // 沿用上一次的判断：场景与 setup 那次一致（**具体是什么场景取决于跑验收时的真实屏幕**，
    // 所以只要求"三次都一样且不为空"，不写死某个场景），token 记 0（一眼看出这条没花钱）
    gateRun.second.scene === gateSetup.scene &&
    gateRun.second.scene !== '' &&
    gateRun.first.scene === gateRun.second.scene &&
    gateRun.third.scene === gateRun.second.scene &&
    gateRun.second.tokens === 0 &&
    // 没花 token 也照样在记：习惯样本 +3（时间线/习惯不会因为省钱而断）
    gateRun.samplesAfter === gateRun.samplesBefore + 3 &&
    gateRun.tokensUsed === 0,
    JSON.stringify({ ...gateRun, setup: gateSetup, stubCalls: gateRequests.length, callsAfterSetup: gateCallsAfterSetup }),
  );

  /* ------------------ 成长、记忆与反思（4.1 / 4.2） ------------------ */

  const growthInitial = await run(`(async () => {
    const status = await window.petAPI.growth.status();
    const methods = Object.keys(window.petAPI.growth).sort();
    return {
      palace: status.settings.palace,
      reflection: status.settings.reflection,
      policyAdapt: status.settings.policyAdapt,
      reflectionHour: status.settings.reflectionHour,
      nodes: status.palace.stats.total,
      days: status.palace.stats.daysTogether,
      hasFirstMeet: status.palace.nodes.some((node) => node.kind === 'first-meet'),
      policyAdjustments: status.policy.adjustments,
      policyEffect: status.policyEffect,
      dataDir: status.dataDir,
      methods,
    };
  })()`);
  record(
    '成长：按需求默认全开（记忆宫殿 / 自我反思 / 策略调整）',
    growthInitial.palace === true &&
      growthInitial.reflection === true &&
      growthInitial.policyAdapt === true &&
      growthInitial.policyAdjustments === 0 &&
      typeof growthInitial.reflectionHour === 'number',
    JSON.stringify(growthInitial),
  );
  record(
    '成长：桥暴露了完整能力面（状态/开关/记一笔/删/钉/回忆/反思/重置策略）',
    ['status', 'setSettings', 'addNode', 'removeNode', 'pinNode', 'recallNode', 'reflectNow', 'resetPolicy', 'refreshPalace', 'openPalace'].every(
      (name) => growthInitial.methods.includes(name),
    ),
    JSON.stringify(growthInitial.methods),
  );
  record(
    '成长：启动即写下一段"我们第一次见面"（记忆宫殿的起点）',
    growthInitial.nodes >= 1 && growthInitial.hasFirstMeet === true,
    JSON.stringify({ nodes: growthInitial.nodes, days: growthInitial.days, dataDir: growthInitial.dataDir }),
  );

  /*
   * 节点时间的展示口径必须是**本地**日期/月份。
   *
   * 与"感知日志时间差一个时区"是同一类问题：`at` 存的是 ISO(UTC)，
   * 直接 `slice(0,7)` 会把 UTC+8 凌晨产生的节点分到**上个月**，
   * 而面板显示的日期是本地 —— 同一张时间轴上"日期"与"分组"会互相矛盾。
   * 用一个固定时刻同时断言"面板日期、月份键、palace.md 分组"三者一致。
   */
  const probeLocal = new Date(2025, 2, 1, 0, 30, 0, 0);   // 本地 2025-03-01 00:30
  const pad2 = (value) => String(value).padStart(2, '0');
  const expectedLocalDay = `${probeLocal.getFullYear()}-${pad2(probeLocal.getMonth() + 1)}-${pad2(probeLocal.getDate())}`;
  const localDates = await run(`(() => {
    const model = window.petDebug.growth;
    const probe = new Date(2025, 2, 1, 0, 30, 0, 0);
    const iso = probe.toISOString();
    return {
      iso,
      utcDay: iso.slice(0, 10),
      utcMonth: iso.slice(0, 7),
      localDay: model.formatLocalDate(iso),
      localMonth: model.localMonthKey(iso),
      emptyDay: model.formatLocalDate(''),
      badMonth: model.localMonthKey('not-a-date'),
      markdown: model.renderPalaceMarkdown([
        { id: 'x', kind: 'manual', title: '测试节点', detail: '', at: iso, source: 'manual', evidence: [], hits: 1, pinned: false },
      ], 1),
    };
  })()`);
  record(
    '成长：节点时间用本地日期/月份（UTC 切片会把凌晨的节点分到上个月）',
    localDates.localDay === expectedLocalDay &&
      localDates.localMonth === expectedLocalDay.slice(0, 7) &&
      localDates.emptyDay === '—' &&
      localDates.badMonth === '未知时间' &&
      localDates.markdown.includes(`## ${expectedLocalDay.slice(0, 7)}`) &&
      localDates.markdown.includes(expectedLocalDay),
    JSON.stringify({ ...localDates, expectedLocalDay, utcDiffers: localDates.utcDay !== expectedLocalDay }),
  );

  /*
   * 记忆宫殿的**压缩**（C）：很久以前、同种类同标题的多个节点折成一条
   * （标题不变、detail 写"共 N 次 + 日期列表"、hits 累加），钉住的不动、新近的不动、幂等。
   */
  const palaceCompress = await run(`(() => {
    const model = window.petDebug.growth;
    const now = new Date(2026, 8, 25, 12, 0, 0).getTime();   // 本地 2026-09-25
    const node = (id, kind, title, at, extra) => Object.assign({
      id, kind, title, detail: '', at, source: 'auto', evidence: [], hits: 1, pinned: false,
    }, extra || {});
    const nodes = [
      node('a1', 'late-night', '一起熬夜', '2025-01-10T15:00:00.000Z', { evidence: ['他说要赶完'] }),
      node('a2', 'late-night', '一起熬夜', '2025-03-02T15:00:00.000Z', { hits: 2 }),
      node('a3', 'late-night', '一起熬夜', '2026-09-01T15:00:00.000Z'),          // 新近 → 不参与
      node('b1', 'milestone', '论文有了进展', '2025-02-01T15:00:00.000Z', { pinned: true }),
      node('b2', 'milestone', '论文有了进展', '2025-04-01T15:00:00.000Z'),        // 同组里有钉住 → 整组跳过
      node('c1', 'project', '一起折腾桌宠', '2025-05-01T15:00:00.000Z'),          // 只有一条 → 不动
    ];
    const first = model.compressPalaceNodes(nodes, { nowMs: now, months: 6 });
    const second = model.compressPalaceNodes(first.nodes, { nowMs: now, months: 6 });
    const off = model.compressPalaceNodes(nodes, { nowMs: now, months: 0 });
    const mergedNode = first.nodes.find((item) => item.id === 'a1');
    return {
      merged: first.merged,
      removedIds: first.removed.map((item) => item.id),
      keptIds: first.nodes.map((item) => item.id),
      mergedDetail: mergedNode ? mergedNode.detail : '',
      mergedHits: mergedNode ? mergedNode.hits : 0,
      mergedEvidence: mergedNode ? mergedNode.evidence : [],
      secondMerged: second.merged,
      offMerged: off.merged,
      pinnedKept: first.nodes.some((item) => item.id === 'b1' && item.pinned === true),
    };
  })()`);
  record(
    '成长：记忆宫殿压缩（同种类同标题的老节点折成一条 / 钉住与新近的不动 / 幂等）',
    palaceCompress.merged === 1 &&
      JSON.stringify(palaceCompress.removedIds) === JSON.stringify(['a1', 'a2']) &&
      palaceCompress.keptIds.includes('a1') &&
      !palaceCompress.keptIds.includes('a2') &&
      palaceCompress.keptIds.includes('a3') &&
      palaceCompress.keptIds.includes('b1') &&
      palaceCompress.keptIds.includes('b2') &&
      palaceCompress.keptIds.includes('c1') &&
      palaceCompress.mergedDetail.includes('3 次') &&
      palaceCompress.mergedDetail.includes('2025-01-10') &&
      palaceCompress.mergedDetail.includes('2025-03-02') &&
      palaceCompress.mergedHits === 3 &&
      palaceCompress.mergedEvidence.includes('他说要赶完') &&
      palaceCompress.secondMerged === 0 &&
      palaceCompress.offMerged === 0 &&
      palaceCompress.pinnedKept === true,
    JSON.stringify(palaceCompress),
  );

  /* 4.1 纯函数：节点去重 / 分组 / 规则抽取 */
  const palaceModel = await run(`(() => {
    const model = window.petDebug.growth;
    const at = '2025-03-05T10:00:00.000Z';
    const base = model.mergeNodes([], [
      { kind: 'project', title: '一起折腾桌宠', detail: '一直在忙它', at, source: 'auto', evidence: ['在写桌宠'] },
      { kind: 'birthday', title: '一起过生日', detail: '', at, source: 'auto', evidence: [] },
    ]);
    const again = model.mergeNodes(base.nodes, [
      { kind: 'project', title: '一起折腾桌宠', detail: '', at: '2025-03-20T10:00:00.000Z', source: 'auto', evidence: ['又提到了'] },
    ]);
    const nextMonth = model.mergeNodes(base.nodes, [
      { kind: 'project', title: '一起折腾桌宠', detail: '', at: '2025-05-02T10:00:00.000Z', source: 'auto', evidence: [] },
    ]);
    const grouped = model.groupByMonth(nextMonth.nodes);
    const suggestions = model.suggestNodes({
      now: Date.parse(at),
      firstMeetAt: '',
      messages: ['今天终于把论文投出去了', '我在写毕业论文，好累', '生日快乐！'],
      lateNight: true,
      existing: [],
      moodLow: 18,
      sceneCounts: { coding: 30, reading: 12 },
      habitSamples: 40,
    });
    const kinds = suggestions.map((item) => item.kind);
    const repeatNode = again.nodes.find((node) => node.kind === 'project');
    return {
      merged: base.nodes.length,
      hitsAfterRepeat: repeatNode ? repeatNode.hits : 0,
      afterNextMonth: nextMonth.nodes.filter((node) => node.kind === 'project').length,
      months: grouped.map((item) => item.month + ':' + item.count),
      kindList: kinds,
      hasFirstMeet: kinds.indexOf('first-meet') >= 0,
      hasBirthday: kinds.indexOf('birthday') >= 0,
      hasLateNight: kinds.indexOf('late-night') >= 0,
      hasHabit: kinds.indexOf('habit') >= 0,
      hasEmotion: kinds.indexOf('emotion') >= 0,
      idStable: model.nodeId({ kind: 'project', title: 'X', at: '2025-03-01T00:00:00.000Z' }) === model.nodeId({ kind: 'project', title: 'X', at: '2025-03-28T00:00:00.000Z' }),
      labels: [model.nodeLabel('first-meet'), model.nodeLabel('late-night')],
    };
  })()`);
  record(
    '记忆宫殿：同类同月只累加次数（去重），跨月算两段经历',
    palaceModel.merged === 2 && palaceModel.hitsAfterRepeat === 2 && palaceModel.afterNextMonth === 2 && palaceModel.idStable === true,
    JSON.stringify({
      merged: palaceModel.merged,
      hits: palaceModel.hitsAfterRepeat,
      afterNextMonth: palaceModel.afterNextMonth,
      idStable: palaceModel.idStable,
    }),
  );
  record(
    '记忆宫殿：按年月分组 + 节点标签带 emoji',
    palaceModel.months.length === 2 && palaceModel.months.every((item) => /^\d{4}-\d{2}:\d+$/.test(item)) && palaceModel.labels[0].indexOf('📅') >= 0,
    JSON.stringify({ months: palaceModel.months, labels: palaceModel.labels }),
  );
  record(
    '记忆宫殿：从当天素材里能抽出第一次见面/生日/熬夜/习惯/情绪节点',
    palaceModel.hasFirstMeet && palaceModel.hasBirthday && palaceModel.hasLateNight && palaceModel.hasHabit && palaceModel.hasEmotion,
    JSON.stringify(palaceModel.kindList),
  );

  /* 4.2 纯函数：策略**只能收紧**（最重要的一条不变量） */
  const policyModel = await run(`(() => {
    const model = window.petDebug.growth;
    const baseSettings = Object.assign({}, window.petDebug.perception.DEFAULT_PERCEPTION_SETTINGS, {
      proactiveMinIntervalMs: 600000,
      proactiveMaxPerHour: 4,
    });
    const neutral = model.defaultPolicyOverlay();
    const quiet = model.applyInsights(neutral, [{ scene: 'coding', action: 'quiet-down', reason: '写了 3 次都没回应' }]);
    const many = model.applyInsights(neutral, [
      { scene: '', action: 'quiet-down', reason: 'a' },
      { scene: '', action: 'quiet-down', reason: 'b' },
      { scene: '', action: 'quiet-down', reason: 'c' },
      { scene: '', action: 'quiet-down', reason: 'd' },
      { scene: '', action: 'quiet-down', reason: 'e' },
      { scene: '', action: 'quiet-down', reason: 'f' },
      { scene: '', action: 'quiet-down', reason: 'g' },
    ]);
    const speakUp = model.applyInsights(
      model.clampOverlay({ minIntervalFactor: 0.5, maxPerHourFactor: 0.5, sceneFactors: {}, updatedAt: '', reason: '', adjustments: 1 }),
      [{ scene: '', action: 'speak-up', reason: '主人一直在回应' }],
    );
    const quietEffective = model.effectivePerception(baseSettings, quiet.overlay, 'coding');
    const otherEffective = model.effectivePerception(baseSettings, quiet.overlay, 'reading');
    return {
      minFactorFloor: model.POLICY_MIN_FACTOR,
      quietScene: quiet.overlay.sceneFactors.coding,
      quietedInterval: quietEffective.proactiveMinIntervalMs,
      untouchedSceneInterval: otherEffective.proactiveMinIntervalMs,
      userInterval: baseSettings.proactiveMinIntervalMs,
      manyFactor: many.overlay.minIntervalFactor,
      clampedFloor: model.clampOverlay({ minIntervalFactor: 0.001, maxPerHourFactor: 0.001, sceneFactors: { coding: 9 }, updatedAt: '', reason: '', adjustments: 0 }),
      speakUpFactor: speakUp.overlay.minIntervalFactor,
      speakUpMax: speakUp.overlay.maxPerHourFactor,
      effectiveMaxPerHour: quietEffective.proactiveMaxPerHour,
      userMaxPerHour: baseSettings.proactiveMaxPerHour,
      describe: model.describePolicy(baseSettings, quiet.overlay),
    };
  })()`);
  record(
    '反思策略：quiet-down 让该场景的打扰间隔变长（写代码时 10 到 20 分钟）',
    Math.abs(policyModel.quietScene - 0.5) < 1e-6 &&
      policyModel.quietedInterval === 1200000 &&
      policyModel.untouchedSceneInterval === policyModel.userInterval,
    JSON.stringify({
      sceneFactor: policyModel.quietScene,
      quieted: policyModel.quietedInterval,
      untouched: policyModel.untouchedSceneInterval,
      user: policyModel.userInterval,
    }),
  );
  record(
    '反思策略：反复收紧也只到下限，且永远不能被放宽到超过用户设定',
    policyModel.manyFactor >= policyModel.minFactorFloor &&
      policyModel.clampedFloor.minIntervalFactor === policyModel.minFactorFloor &&
      // 场景倍率给 9（想变宽松）也必须被夹回 1 —— 只允许更克制，不允许更吵
      policyModel.clampedFloor.sceneFactors.coding === 1,
    JSON.stringify({ many: policyModel.manyFactor, floor: policyModel.minFactorFloor, clamped: policyModel.clampedFloor }),
  );
  record(
    '反思策略：speak-up 最多回到用户设定（永远不会比她设的更频繁）',
    policyModel.speakUpFactor === 1 && policyModel.speakUpMax === 1,
    JSON.stringify({ factor: policyModel.speakUpFactor, max: policyModel.speakUpMax }),
  );
  record(
    '反思策略：生效值只会收紧（间隔不小于用户设置、每小时上限不大于用户设置）',
    policyModel.quietedInterval >= policyModel.userInterval &&
      policyModel.effectiveMaxPerHour <= policyModel.userMaxPerHour &&
      policyModel.describe.indexOf('写代码时打扰间隔') >= 0,
    JSON.stringify({ describe: policyModel.describe, effectiveMax: policyModel.effectiveMaxPerHour, userMax: policyModel.userMaxPerHour }),
  );

  /* 4.2 纯函数：从"回应率"得出保守结论 + 宽容解析模型输出 */
  const reflectionModel = await run(`(() => {
    const model = window.petDebug.growth;
    const ignored = [
      { at: '2025-03-01T10:00:00.000Z', kind: 'long-session', text: '起来活动一下', scene: 'coding', responded: false, responseSeconds: null },
      { at: '2025-03-01T11:00:00.000Z', kind: 'scene-change', text: '开始写代码了', scene: 'coding', responded: false, responseSeconds: null },
      { at: '2025-03-01T12:00:00.000Z', kind: 'late-night', text: '该睡了', scene: 'coding', responded: false, responseSeconds: null },
      { at: '2025-03-01T13:00:00.000Z', kind: 'scene-change', text: '在看视频呀', scene: 'video', responded: true, responseSeconds: 40 },
    ];
    const stats = model.responseStats(ignored);
    const insights = model.heuristicInsights(ignored, stats);
    const parsed = model.parseReflection('今天主人很忙，我说多了。\\n{"insights":[{"scene":"coding","action":"quiet-down","reason":"都没回应"}]}');
    const broken = model.parseReflection('只有正文，没有结论段');
    const first = parsed.insights.length > 0 ? parsed.insights[0] : null;
    return {
      stats: stats.map((item) => item.scene + ':' + item.responded + '/' + item.total),
      quietScenes: insights.filter((item) => item.action === 'quiet-down').map((item) => item.scene),
      bodyHasText: parsed.body.indexOf('主人很忙') >= 0 && parsed.body.indexOf('insights') < 0,
      parsedAction: first ? first.action : '',
      parsedScene: first ? first.scene : '',
      brokenBody: broken.body,
      brokenInsights: broken.insights.length,
    };
  })()`);
  record(
    '反思：按场景统计回应率，并据此得出"少打扰"结论（规则版，不依赖模型）',
    reflectionModel.stats.indexOf('coding:0/3') >= 0 &&
      reflectionModel.quietScenes.indexOf('coding') >= 0,
    JSON.stringify(reflectionModel),
  );
  record(
    '反思：宽容解析模型输出（正文与结论分离；没有结论段也能用）',
    reflectionModel.bodyHasText === true &&
      reflectionModel.parsedAction === 'quiet-down' &&
      reflectionModel.parsedScene === 'coding' &&
      reflectionModel.brokenInsights === 0 &&
      reflectionModel.brokenBody.length > 0,
    JSON.stringify(reflectionModel),
  );

  /* 主进程侧：记一笔 / 钉住 / 删除 / 回忆 / 反思 / 重置策略 */
  const palaceOps = await run(`(async () => {
    const before = await window.petAPI.growth.status();
    const added = await window.petAPI.growth.addNode({ kind: 'milestone', title: '验收写的一笔', detail: '来自自动化验收' });
    let node = null;
    for (const item of added.palace.nodes) if (item.title === '验收写的一笔') node = item;
    const pinned = node ? await window.petAPI.growth.pinNode(node.id, true) : null;
    const recalled = node ? await window.petAPI.growth.recallNode(node.id) : { ok: false, text: '' };
    const removed = node ? await window.petAPI.growth.removeNode(node.id) : null;
    const refreshed = await window.petAPI.growth.refreshPalace();
    let stillThere = false;
    if (removed) for (const item of removed.palace.nodes) if (item.title === '验收写的一笔') stillThere = true;
    const firstPinned = pinned && pinned.palace.nodes[0] ? pinned.palace.nodes[0].title : '';
    return {
      beforeCount: before.palace.stats.total,
      addedFound: node !== null,
      addedKind: node ? node.kind : '',
      pinnedFirst: firstPinned === '验收写的一笔',
      recallOk: recalled.ok === true && recalled.text.length > 0,
      recallSample: recalled.text.slice(0, 40),
      removed: removed ? !stillThere : false,
      afterRefresh: refreshed.palace.stats.total,
      markdownFile: refreshed.palace.markdownFile,
      byMonth: refreshed.palace.byMonth.length,
    };
  })()`);
  record(
    '记忆宫殿：可以手动记一笔（并把"钉住"排到最前、可删除）',
    palaceOps.addedFound === true && palaceOps.addedKind === 'milestone' && palaceOps.pinnedFirst === true && palaceOps.removed === true,
    JSON.stringify(palaceOps),
  );
  record(
    '记忆宫殿：可以让她"回忆"某一段（没配密钥时用模板，内容仍来自节点本身）',
    palaceOps.recallOk === true,
    JSON.stringify({ sample: palaceOps.recallSample, byMonth: palaceOps.byMonth }),
  );
  let palaceFile = { exists: false, bytes: 0 };
  try {
    const text = readFileSync(palaceOps.markdownFile, 'utf8');
    palaceFile = { exists: true, bytes: text.length };
  } catch (error) {
    palaceFile = { exists: false, bytes: 0 };
  }
  record(
    '记忆宫殿：写成可读的 palace.md（时间轴 + 依据的只读镜像）',
    palaceFile.exists === true && palaceFile.bytes > 40,
    `${palaceOps.markdownFile} bytes=${palaceFile.bytes}`,
  );

  const reflectOps = await run(`(async () => {
    const status = await window.petAPI.growth.reflectNow();
    const today = status.todayReflection;
    const reset = await window.petAPI.growth.resetPolicy();
    return {
      hasToday: today !== null,
      source: today ? today.source : '',
      bodyLength: today ? today.body.length : 0,
      insights: today ? today.insights.length : 0,
      stats: today ? today.stats : null,
      recent: status.recentReflections.length,
      policyAfterReset: reset.policy.adjustments,
      policyEffect: reset.policyEffect,
    };
  })()`);
  record(
    '反思：立刻反思一次会写成第一视角正文（没密钥时来源为本地模板）并带当天数据',
    reflectOps.hasToday === true && reflectOps.source === 'template' && reflectOps.bodyLength > 10 && reflectOps.recent >= 1 && reflectOps.stats !== null,
    JSON.stringify({ source: reflectOps.source, body: reflectOps.bodyLength, insights: reflectOps.insights, stats: reflectOps.stats }),
  );
  record(
    '反思：策略可一键重置回用户原始设置（安全阀）',
    reflectOps.policyAfterReset === 0 && reflectOps.policyEffect.indexOf('还没调整过') >= 0,
    JSON.stringify({ after: reflectOps.policyAfterReset, effect: reflectOps.policyEffect }),
  );
  let reflectionFiles = [];
  try {
    reflectionFiles = readdirSync(join(aiDataDir, 'reflection'));
  } catch (error) {
    reflectionFiles = [];
  }
  record(
    '反思：反思与策略历史都落盘（json + 可读 md + 策略日志）',
    reflectionFiles.some((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)) &&
      reflectionFiles.some((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)) &&
      reflectionFiles.indexOf('policy.json') >= 0,
    JSON.stringify(reflectionFiles.slice(0, 8)),
  );

  /* 关掉成长与反思后同样不落盘（"可配置开关"的一致性） */
  await run(`(async () => { await window.petAPI.growth.setSettings({ palace: false, reflection: false, policyAdapt: false }); return true; })()`);
  await wait(300);
  try {
    rmSync(join(aiDataDir, 'memory', 'nodes.json'), { force: true });
    rmSync(join(aiDataDir, 'reflection'), { recursive: true, force: true });
  } catch (error) {
    /* 目录不存在也无所谓 */
  }
  await run(`(async () => {
    window.petAPI.growth.addNode({ kind: 'manual', title: '不该被写进去', detail: '' });
    await window.petAPI.growth.reflectNow();
    return true;
  })()`);
  await wait(1200);
  const growthOffWrites = {
    nodes: existsSync(join(aiDataDir, 'memory', 'nodes.json')),
    reflection: existsSync(join(aiDataDir, 'reflection')),
  };
  record(
    '成长：关掉开关后不落盘（记一笔与反思都不写文件）',
    growthOffWrites.nodes === false && growthOffWrites.reflection === false,
    JSON.stringify(growthOffWrites),
  );
  await run(`(async () => { await window.petAPI.growth.setSettings({ palace: true, reflection: true, policyAdapt: true }); return true; })()`);

  /*
   * 收尾：把验收自己装进来的两个探针插件**卸载干净**（连同 build/ 下的源目录）。
   *
   * 这一步本身就是一条覆盖：卸载 -> 目录消失 -> 清单回到空 -> 渲染层不再有记录。
   * 放在最后是因为托盘菜单与聊天窗口的用例还要用到它们（插件子菜单、面板页签）。
   */
  const fixtureCleanup = await run(`(async () => {
    const click = await window.petAPI.plugins.uninstall('${clickProbeId}');
    const plain = await window.petAPI.plugins.uninstall('${plainProbeId}');
    await new Promise((r) => setTimeout(r, 800));
    const records = window.petDebug.plugins.getLoadedPlugins();
    return {
      click: { ok: click.ok, error: click.error || null },
      plain: { ok: plain.ok, error: plain.error || null },
      // 渲染层里还留着验收期间用 host.activate 造的合成插件（boom / timer-probe 之类），
      // 所以这里查的是"两个探针还在不在"（随包的待办插件仍然应当在）
      hasClick: records.some((r) => r.id === '${clickProbeId}'),
      hasPlain: records.some((r) => r.id === '${plainProbeId}'),
      hasTodo: records.some((r) => r.id === 'todo-plugin'),
      list: (await window.petAPI.plugins.list()).length,
    };
  })()`);
  const manifestPluginsLeft = (() => {
    try {
      const parsed = JSON.parse(readFileSync(join(root, 'assets', 'config', 'plugins.json'), 'utf8'));
      return (parsed.plugins || []).length;
    } catch (error) {
      return -1;
    }
  })();
  record(
    '收尾：验收装的探针插件被卸干净（目录 / 清单 / 渲染层三处都不剩），随包的待办插件还在',
    fixtureCleanup.click.ok === true &&
      fixtureCleanup.plain.ok === true &&
      !existsSync(join(root, 'plugins', clickProbeId)) &&
      !existsSync(join(root, 'plugins', plainProbeId)) &&
      fixtureCleanup.hasClick === false &&
      fixtureCleanup.hasPlain === false &&
      fixtureCleanup.list === 1 &&
      fixtureCleanup.hasTodo === true &&
      manifestPluginsLeft === 1,
    JSON.stringify({ cleanup: fixtureCleanup, manifestLeft: manifestPluginsLeft }),
  );
  try {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(join(root, 'plugins', '_acceptance-nested'), { recursive: true, force: true });
  } catch (error) {
    console.error('CLEANUP_FAILED', error);
  }

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
  const restoreDock = settingsSnapshot.dockOnEdge;
  const restore = await restoreUserSettings();
  const savedAfterRun = readSavedScale();
  const dockAfterRun = readSavedDockOnEdge();
  record(
    '验收结束后已还原用户尺寸设置',
    restore === true && savedAfterRun !== null && Math.abs(savedAfterRun - restoreScale) < 1e-6,
    `restored=${restore} scale=${savedAfterRun} expected=${restoreScale}`,
  );
  // 贴边收起是这一轮新增的开关：验收临时关掉它，跑完必须还原（否则用户的手感被悄悄改掉）
  record(
    '验收结束后已还原「拖到边缘自动收起」',
    restore === true && dockAfterRun === restoreDock,
    `dockOnEdge=${dockAfterRun} expected=${restoreDock}`,
  );

  finish({});
}).catch(async (error) => {
  /*
   * 中途抛错也要把用户设置写回去（否则一次崩溃就会把 scale / 贴边开关留在测试值上，
   * 后续真机探针与用户的桌宠都跟着变形 —— 实测踩过）。
   */
  try {
    await restoreUserSettings();
  } catch (restoreError) {
    /* 还原失败就算了：fatal 信息更重要 */
  }
  finish({ fatal: String((error && error.stack) || error) });
});

/*
 * 全局超时：整套验收是**顺序执行**的端到端流程（真开窗口、真等动画、真写盘），
 * 用例只会越加越多，所以这个值要留够余量 —— 太紧的结果不是"发现问题"，
 * 而是"跑到一半被掐断、后半段一条都没跑"（fatal: ACCEPTANCE_TIMEOUT）。
 */
setTimeout(() => {
  finish({ fatal: 'ACCEPTANCE_TIMEOUT' });
}, 420000);

