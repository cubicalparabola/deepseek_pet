// @ts-check
/**
 * 逐帧量化**用户真正看到的画面**在"动画开始 / 结束"那一瞬间的变化。
 *
 * 与 diag-switch-jump.cjs 的区别：那个只采样"可见的那个缓冲"，
 * 因此看不到**交叉淡化**期间两层叠加的效果（而淡化正是靠叠加抹掉跳变的）。
 * 这里按 DOM 顺序把 `#pet-pet` 里的每个媒体层按它的 `opacity` 与
 * `mix-blend-mode` 叠到同一张 64x64 画布上，得到接近屏幕的合成帧，再统计：
 *
 *   - cover：不透明像素占比 —— 掉到 0 = **整只透明**（"闪一下"里最糟的一种）
 *   - diff ：与上一帧的平均像素差 —— 骤大 = **可见跳变**（硬切）
 *   - 每帧记录各层的 src / opacity / readyState / paused，便于定位是谁的锅
 *
 * 用法：npx electron tools/diag-transition-composite.cjs
 *       设 DIAG_OUT=<文件名> 可换输出名（A/B 对比两种实现）
 * 输出：build/<DIAG_OUT 或 transition-composite.json>，控制台打印摘要
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outName = process.env.DIAG_OUT || 'transition-composite.json';
const outFile = join(root, 'build', outName);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 要测的动画：一次性（cute/stroke/talk）+ 持续（read/watch）。 */
const CASES = ['cute', 'stroke', 'talk', 'read', 'watch'];
/** 每个用例采样的总时长（覆盖"开始 -> 结束回 idle"）。 */
const RUN_MS = 9000;

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`(() => { window.petAPI.bubble.set(null); return true; })()`);
  await wait(500);

  /* 安装合成采样器 */
  await js(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    /* 第二张画布：只画"最上面那一层"，用来看跳变是不是素材自己的内容变化 */
    const self = document.createElement('canvas');
    self.width = 64; self.height = 64;
    const sctx = self.getContext('2d', { willReadFrequently: true });
    window.__samples = [];
    window.__rec = false;
    window.__prev = null;
    window.__prevSelf = null;
    /* 可选：把过渡窗口内的原始像素也留下来（DIAG_DUMP_CASE=watch 时启用） */
    window.__dump = [];
    window.__dumpOn = false;

    const compose = () => {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, 64, 64);
      const layers = [];
      /* DOM 顺序 = 叠加顺序（video, video-b, image） */
      for (const el of document.querySelectorAll('#pet-pet .pet-media')) {
        const cs = getComputedStyle(el);
        const alpha = Number(cs.opacity);
        const w = el.naturalWidth || el.videoWidth || 0;
        const h = el.naturalHeight || el.videoHeight || 0;
        layers.push({
          id: el.id,
          src: String(el.currentSrc || el.src || '').split('/').pop(),
          op: Number(alpha.toFixed(2)),
          rs: el.readyState === undefined ? null : el.readyState,
          paused: el.paused === undefined ? null : el.paused,
          blend: cs.mixBlendMode,
          w, h,
        });
        if (alpha <= 0.001 || !w || !h) continue;
        ctx.globalAlpha = alpha;
        ctx.globalCompositeOperation = cs.mixBlendMode === 'plus-lighter' ? 'lighter' : 'source-over';
        try { ctx.drawImage(el, 0, 0, 64, 64); } catch (e) { /* 未就绪忽略 */ }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      return layers;
    };

    /* 只画"不透明度最高的那一层"（= 当前主体），用于区分素材内容变化与叠加过渡 */
    const composeSelf = (layers) => {
      const top = layers.filter((l) => l.op > 0.001).sort((a, b) => b.op - a.op)[0] || null;
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = 'source-over';
      sctx.clearRect(0, 0, 64, 64);
      if (!top || !top.w || !top.h) return null;
      const el = document.getElementById(top.id);
      if (!el) return null;
      try { sctx.drawImage(el, 0, 0, 64, 64); } catch (e) { return null; }
      return top.id + ':' + top.src;
    };

    const sample = () => {
      window.__raf = requestAnimationFrame(() => {
        if (window.__rec) {
          const layers = compose();
          const d = ctx.getImageData(0, 0, 64, 64).data;
          let opaque = 0;
          let diff = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 40) opaque += 1;
          }
          const cover = opaque / (64 * 64);
          if (window.__prev) {
            let sum = 0;
            for (let i = 0; i < d.length; i++) sum += Math.abs(d[i] - window.__prev[i]);
            diff = sum / d.length;
          }
          window.__prev = new Uint8Array(d);

          /* 主体自己的逐帧差异 */
          const topKey = composeSelf(layers);
          let selfDiff = 0;
          if (topKey) {
            const sd = sctx.getImageData(0, 0, 64, 64).data;
            if (window.__prevSelf && window.__prevSelfKey === topKey) {
              let sum = 0;
              for (let i = 0; i < sd.length; i++) sum += Math.abs(sd[i] - window.__prevSelf[i]);
              selfDiff = sum / sd.length;
            }
            window.__prevSelf = new Uint8Array(sd);
            window.__prevSelfKey = topKey;
          } else {
            window.__prevSelf = null;
            window.__prevSelfKey = null;
          }

          window.__samples.push({
            t: Number(performance.now().toFixed(1)),
            cover: Number(cover.toFixed(4)),
            diff: Number(diff.toFixed(2)),
            selfDiff: Number(selfDiff.toFixed(2)),
            anim: window.petDebug.anim.getCurrentAnimation(),
            phase: window.petDebug.anim.getPersistentPhase(),
            layers,
          });
          if (window.__dumpOn && window.__dump.length < 40) {
            window.__dump.push({
              t: Number((performance.now() - window.__t0).toFixed(1)),
              data: Array.from(d),
              layers,
            });
          }
        }
        sample();
      });
    };
    sample();
    return true;
  })()`);

  const runs = [];
  for (const id of CASES) {
    /*
     * 每个用例都必须从**干净的兜底 idle** 开始。
     *
     * 为什么不能只 stop() 就等：持续动画在收尾段被打断时，兜底 idle 不一定
     * 立刻接回来（要靠看门狗），上一个用例的"收尾帧"会留在画面上，
     * 把下一个用例的"开始"过渡数据污染掉（实测踩过：watch 用例的开头
     * 还挂着 read-end 的画面，于是那次跳变是上一轮的收尾，不是 watch 的）。
     */
    await js(`(() => {
      window.__samples = []; window.__prev = null;
      window.petDebug.anim.resetCooldowns();
      window.petDebug.anim.stop('composite-reset');
      window.petDebug.anim.play('idle', { interrupt: 'force', reason: 'composite-baseline', bypassCooldown: true });
      return true;
    })()`);
    /* 等 idle 真的上了画面（最多 4s） */
    for (let i = 0; i < 40; i++) {
      const ok = await js(`(() => {
        const a = window.petDebug.anim;
        if (a.getCurrentAnimation() !== 'idle') return false;
        const v = Array.from(document.querySelectorAll('#pet-pet video')).find((e) => e.classList.contains('layer-active'));
        return !!v && String(v.currentSrc || '').endsWith('idle.webm') && v.readyState >= 2 && !v.paused;
      })()`);
      if (ok) break;
      await wait(100);
    }
    await wait(500);
    await js('window.__rec = true; true');
    const dumpCase = process.env.DIAG_DUMP_CASE === id;
    await js(`(() => {
      window.__dump = []; window.__dumpOn = ${dumpCase ? 'true' : 'false'};
      window.__t0 = performance.now();
      window.petDebug.anim.play('${id}', { interrupt: 'force', reason: 'composite-probe', bypassCooldown: true });
      return true;
    })()`);
    await wait(RUN_MS);
    await js('window.__rec = false; window.__dumpOn = false; true');
    if (dumpCase) {
      const dump = await js('window.__dump');
      writeFileSync(join(root, 'build', `dump-${id}.json`), JSON.stringify(dump), 'utf8');
      console.log(`（已写出 build/dump-${id}.json，${dump.length} 帧原始像素）`);
    }
    const samples = await js('window.__samples');
    const t0 = await js('window.__t0');
    runs.push({ id, t0, samples });
  }

  /* 分析 */
  const analysis = runs.map((run) => {
    const s = run.samples ?? [];
    const blanks = [];
    const jumps = [];
    /* 素材换段（可见层的 src 组合发生变化）的时刻 */
    const switches = [];
    let prevKey = '';
    for (let i = 0; i < s.length; i++) {
      const f = s[i];
      const key = f.layers.filter((l) => l.op > 0.001).map((l) => l.id + ':' + l.src).join(' | ');
      if (key !== prevKey) {
        switches.push({ i, t: Number((f.t - run.t0).toFixed(0)), from: prevKey, to: key });
        prevKey = key;
      }
      if (i === 0) continue;
      const a = s[i - 1];
      if (a.cover > 0.05 && f.cover < 0.01) {
        blanks.push({ t: Number((f.t - run.t0).toFixed(0)), from: a.cover, to: f.cover, layers: f.layers.filter((l) => l.op > 0.001) });
      }
      if (f.diff > 12) {
        jumps.push({
          t: Number((f.t - run.t0).toFixed(0)),
          diff: f.diff,
          selfDiff: f.selfDiff,
          aCover: a.cover, bCover: f.cover,
          aAnim: a.anim, bAnim: f.anim, bPhase: f.phase,
          layers: f.layers.filter((l) => l.op > 0.001),
        });
      }
    }
    return {
      id: run.id,
      frameCount: s.length,
      blankCount: blanks.length,
      blanks: blanks.slice(0, 8),
      jumpCount: jumps.length,
      topJumps: jumps.sort((x, y) => y.diff - x.diff).slice(0, 6),
      switches: switches.slice(0, 14),
      /* 逐帧原始序列：[相对ms, cover, diff, 可见层] —— 便于离线细看过渡那几帧 */
      frames: s.map((f) => [
        Number((f.t - run.t0).toFixed(0)),
        f.cover,
        f.diff,
        f.layers.filter((l) => l.op > 0.001).map((l) => `${l.id}:${l.src}@${l.op}${l.paused ? '(p)' : ''}`).join('|'),
        f.selfDiff,
      ]),
    };
  });

  writeFileSync(outFile, JSON.stringify({ outName, analysis }, null, 1), 'utf8');
  console.log(`=== 合成画面：开始/结束过渡 ===  (${outName})`);
  for (const a of analysis) {
    console.log(`\n[${a.id}] 帧数=${a.frameCount} 空帧=${a.blankCount} diff>12=${a.jumpCount}`);
    console.log('  素材切换:');
    for (const sw of a.switches) console.log(`    @${sw.t}ms  ${sw.from || '(空)'}  ->  ${sw.to}`);
    for (const b of a.blanks) console.log(`  ⚠ 空帧 @${b.t}ms cover ${b.from} -> ${b.to}  层=${b.layers.map((l) => l.id + ':' + l.src + '@' + l.op).join(', ')}`);
    for (const j of a.topJumps) console.log(`  ↯ 跳变 @${j.t}ms diff=${j.diff} 主体自身diff=${j.selfDiff} cover ${j.aCover}->${j.bCover} ${j.aAnim}->${j.bAnim}/${j.bPhase} 层=${j.layers.map((l) => l.src + '@' + l.op + '/' + l.blend).join(', ')}`);
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 300000);
