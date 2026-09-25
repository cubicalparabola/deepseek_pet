// @ts-check
/**
 * 逐帧量化动画**开始 / 结束**时的画面变化，判断"闪"属于哪一种：
 *   - 空帧：覆盖率掉到 0（换源丢帧）
 *   - 硬切跳变：相邻帧画面差异骤大（一次性动画目前走 commitVideoSwap 硬切）
 *   - 交叉淡化：有过渡带（持续动画的切段走这条）
 *
 * 做法：每帧把**可见的 video** 画到 64x64 的 canvas 上，统计
 *   - 不透明像素占比（原图 alpha > 40 的像素比例）
 *   - 与上一帧的逐像素差异（0~255 平均）
 * 全都是小画布运算，每帧约 1~2ms，不会拖住渲染。
 *
 * 用法：npx electron tools/diag-switch-jump.cjs
 * 输出：build/switch-jump.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'switch-jump.json');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 要测的动画：一次性 + 持续（对照）。 */
const CASES = ['cute', 'stroke', 'play', 'talk', 'read', 'watch'];

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { app.exit(1); return; }
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`(() => { window.petAPI.bubble.set(null); return true; })()`);
  await wait(500);

  /* 安装逐帧采样器 */
  await js(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    window.__samples = [];
    window.__rec = false;
    window.__prev = null;

    const sample = () => {
      window.__raf = requestAnimationFrame(() => {
        if (window.__rec) {
          const vids = Array.from(document.querySelectorAll('#pet-stage video'));
          /* 取可见的那个（layer-active） */
          const v = vids.find((e) => e.classList.contains('layer-active')) || null;
          const cs = v ? getComputedStyle(v) : null;
          let cover = 0;
          let diff = 0;
          if (v && cs) {
            try {
              ctx.clearRect(0, 0, 64, 64);
              if (v.readyState >= 2) {
                ctx.drawImage(v, 0, 0, 64, 64);
                const d = ctx.getImageData(0, 0, 64, 64).data;
                let opaque = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 40) opaque += 1;
                cover = opaque / (64 * 64);
                if (window.__prev) {
                  let sum = 0;
                  for (let i = 3; i < d.length; i += 4) sum += Math.abs(d[i] - window.__prev[i]);
                  diff = sum / (64 * 64);
                }
                window.__prev = new Uint8Array(d);
              }
            } catch (e) { /* 跨源/未就绪忽略 */ }
          } else {
            window.__prev = null;
          }
          /* 两个缓冲的完整状态：用于判断"可见的那个是不是刚被释放/正在淡化" */
          const buffs = vids.map((e) => {
            const c = getComputedStyle(e);
            return {
              id: e.id,
              src: String(e.currentSrc || e.src || '').split('/').pop(),
              op: Number(Number(c.opacity).toFixed(2)),
              rs: e.readyState,
              paused: e.paused,
              active: e.classList.contains('layer-active'),
            };
          });
          window.__samples.push({
            t: Number(performance.now().toFixed(1)),
            cover: Number(cover.toFixed(4)),
            diff: Number(diff.toFixed(2)),
            src: v ? String(v.currentSrc || v.src || '').split('/').pop() : null,
            op: cs ? Number(Number(cs.opacity).toFixed(2)) : 0,
            rs: v ? v.readyState : 0,
            phase: window.petDebug.anim.getPersistentPhase(),
            anim: window.petDebug.anim.getCurrentAnimation(),
            buffs,
          });
        }
        sample();
      });
    };
    sample();
    return true;
  })()`);

  const runs = [];
  for (const id of CASES) {
    await js(`(() => {
      window.__samples = []; window.__prev = null; window.__rec = true;
      window.petDebug.anim.resetCooldowns();
      window.petDebug.anim.stop('jump-reset');
      return true;
    })()`);
    await wait(600);
    /* 从 idle 切到这个动画（= 开始），跑一会儿（= 结束回 idle） */
    await js(`window.petDebug.anim.play('${id}', { interrupt: 'force', reason: 'jump-probe', bypassCooldown: true })`);
    await wait(7000);
    await js('window.__rec = false; true');
    const samples = await js('window.__samples');
    runs.push({ id, samples });
  }

  /* 分析：找"空帧"与"单帧跳变" */
  const analysis = runs.map((run) => {
    const s = run.samples ?? [];
    const blanks = [];
    const jumps = [];
    /* 准备状态掉落：可见缓冲从"有帧"掉到 ≤1（画不出内容） */
    const rstateDrops = [];
    /* 释放事件的近似标志：某个缓冲的 src 变空 */
    const releases = [];
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1];
      const b = s[i];
      if (a.cover > 0.05 && b.cover < 0.01) blanks.push({ i, t: b.t, from: a.cover, aSrc: a.src, bSrc: b.src, rs: b.rs });
      if (b.diff > 25) jumps.push({ i, t: b.t, diff: b.diff, aSrc: a.src, bSrc: b.src, aCover: a.cover, bCover: b.cover });
      if ((a.rs ?? 0) >= 2 && (b.rs ?? 0) <= 1) {
        rstateDrops.push({ i, t: b.t, rs: `${a.rs} -> ${b.rs}`, src: b.src, paused: b.buffs?.find((x) => x.active)?.paused });
      }
      /* 缓冲 src 由非空变空 = 被释放 */
      for (let k = 0; k < (b.buffs?.length ?? 0); k++) {
        const pa = a.buffs?.[k];
        const pb = b.buffs?.[k];
        if (pa && pb && pa.src && !pb.src) releases.push({ i, t: b.t, id: pb.id, wasSrc: pa.src });
      }
    }
    const srcSeq = [];
    let prev = '';
    for (const f of s) if (f.src && f.src !== prev) { srcSeq.push(f.src); prev = f.src; }
    return {
      id: run.id,
      frameCount: s.length,
      srcSeq,
      blanks,
      rstateDropCount: rstateDrops.length,
      rstateDrops: rstateDrops.slice(0, 12),
      releases: releases.slice(0, 12),
      jumpCount: jumps.length,
      topJumps: jumps.sort((x, y) => y.diff - x.diff).slice(0, 5),
    };
  });

  writeFileSync(outFile, JSON.stringify({ analysis, runs }, null, 1), 'utf8');
  console.log('=== 动画开始/结束的逐帧跳变 ===');
  for (const a of analysis) {
    console.log(`\n[${a.id}] 帧数=${a.frameCount} 空帧=${a.blanks.length} 跳变帧(diff>25)=${a.jumpCount} 准备状态掉落=${a.rstateDropCount}`);
    console.log(`  素材序列: ${a.srcSeq.join(' -> ')}`);
    for (const j of a.topJumps) {
      console.log(`    跳变 @${j.t}ms diff=${j.diff}  ${j.aSrc}(${j.aCover}) -> ${j.bSrc}(${j.bCover})`);
    }
    for (const b of a.blanks.slice(0, 4)) console.log(`    空帧 @${b.t}ms ${b.aSrc} -> ${b.bSrc}  rs=${b.rs}`);
    for (const d of a.rstateDrops.slice(0, 5)) console.log(`    准备掉落 @${d.t}ms ${d.rs} src=${d.src} paused=${d.paused}`);
    for (const r of a.releases.slice(0, 5)) console.log(`    释放缓冲 @${r.t}ms ${r.id} wasSrc=${r.wasSrc}`);
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 240000);
