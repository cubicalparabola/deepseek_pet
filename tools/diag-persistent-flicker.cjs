// @ts-check
/**
 * 诊断：持续动画"循环时闪一下"到底出自哪里？
 *
 * 采集三类可能造成闪烁的信号（覆盖**一整个循环周期**）：
 *   A. 可见缓冲交换 —— `.layer-active` 是否在循环瞬间换元素（双缓冲换源的特征）
 *   B. 画面透明化 —— 可见 `<video>` 的采样 alpha 是否突然变全透明（空纹理帧）
 *   C. 时间轴异常 —— currentTime 是否出现"跳变/回退异常"（而不是平滑回绕）
 *
 * 采样用 rAF + setInterval 双管齐下，确保不漏帧。
 *
 * 用法：npx electron tools/diag-persistent-flicker.cjs [animationId] [seconds]
 * 输出：build/persistent-flicker.json
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outFile = join(root, 'build', 'persistent-flicker.json');
const animationId = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'read';
const seconds = Number(process.argv[3] ?? 14);

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 启动真实桌宠
require(join(root, 'dist', 'main', 'main.js'));

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 6000));
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    writeFileSync(outFile, JSON.stringify({ fatal: 'no window' }), 'utf8');
    app.exit(1);
    return;
  }

  const result = await win.webContents.executeJavaScript(
    `(async () => {
      const anim = window.petDebug.anim;
      const bus = window.petDebug.bus;
      const stage = document.getElementById('pet-stage');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const visibleVideo = () => document.querySelector('video.layer-active');
      const sample = () => {
        const v = visibleVideo();
        if (!v || !v.videoWidth) return { ok: false };
        const w = 60, h = 80;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(v, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let transparent = 0, opaque = 0, sum = 0;
        for (let i = 3; i < d.length; i += 4) {
          const a = d[i];
          sum += a;
          if (a === 0) transparent++; else if (a === 255) opaque++;
        }
        const total = w * h;
        return {
          ok: true,
          id: v.id,
          t: Number(v.currentTime.toFixed(3)),
          paused: v.paused,
          rs: v.readyState,
          transparentPct: Number(((transparent / total) * 100).toFixed(1)),
          opaquePct: Number(((opaque / total) * 100).toFixed(1)),
          meanAlpha: Number((sum / total).toFixed(1)),
        };
      };

      anim.resetCooldowns();
      // 让开场段 + 至少两轮循环都发生在采样窗口内
      await anim.play('${animationId}', { interrupt: 'force', reason: 'flicker-diag' });

      const samples = [];
      const events = [];
      const subCycle = bus.on('animation:loop-cycle', (p) => events.push({ type: 'loop-cycle', cycle: p.cycle, at: Date.now() }));
      const subStart = bus.on('animation:start', (p) => events.push({ type: 'start', id: p.animationId, at: Date.now() }));
      const subEnd = bus.on('animation:end', (p) => events.push({ type: 'end', id: p.animationId, reason: p.reason, at: Date.now() }));

      const t0 = Date.now();
      const timer = setInterval(() => {
        samples.push({ at: Date.now() - t0, ...sample() });
      }, 16);

      await new Promise((r) => setTimeout(r, ${Math.round(seconds * 1000)}));
      clearInterval(timer);
      subCycle.unsubscribe(); subStart.unsubscribe(); subEnd.unsubscribe();

      // 分析：找出异常点
      const findings = { activeVideoSwaps: [], blankFrames: [], timeJumps: [] };
      let lastId = null, lastT = null;
      for (const s of samples) {
        if (!s.ok) { findings.blankFrames.push({ at: s.at, reason: 'no-video' }); continue; }
        if (lastId !== null && s.id !== lastId) findings.activeVideoSwaps.push({ at: s.at, from: lastId, to: s.id });
        if (s.transparentPct > 95) findings.blankFrames.push({ at: s.at, transparentPct: s.transparentPct, id: s.id });
        if (lastT !== null) {
          const delta = s.t - lastT;
          // 正常前进 <=0.05s；回绕时应该是"大幅回退到接近 0"
          if (delta > 0.1) findings.timeJumps.push({ at: s.at, from: lastT, to: s.t, delta: Number(delta.toFixed(3)), kind: 'forward-jump' });
          else if (delta < -0.05) findings.timeJumps.push({ at: s.at, from: lastT, to: s.t, delta: Number(delta.toFixed(3)), kind: 'rewind' });
        }
        lastId = s.id; lastT = s.t;
      }

      // 只看循环事件附近的样本（前后 300ms）
      const cycles = events.filter((e) => e.type === 'loop-cycle');
      const around = [];
      for (const c of cycles) {
        const rel = c.at - t0;
        around.push({
          cycle: c.cycle,
          at: rel,
          window: samples.filter((s) => Math.abs(s.at - rel) <= 300).map((s) => ({ d: s.at - rel, id: s.id, t: s.t, rs: s.rs, tp: s.transparentPct, op: s.opaquePct, ma: s.meanAlpha, paused: s.paused })),
        });
      }

      return {
        animationId: '${animationId}',
        sampleCount: samples.length,
        events,
        findings: {
          activeVideoSwaps: findings.activeVideoSwaps,
          blankFrameCount: findings.blankFrames.length,
          blankFrames: findings.blankFrames.slice(0, 20),
          timeJumpCount: findings.timeJumps.length,
          timeJumps: findings.timeJumps.slice(0, 20),
        },
        aroundCycles: around,
      };
    })()`,
    true,
  );

  mkdirSync(join(root, 'build'), { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('=== 诊断结果 ===');
  console.log('样本数:', result.sampleCount);
  console.log('事件:', JSON.stringify(result.events));
  console.log('可见缓冲交换:', result.findings.activeVideoSwaps.length, JSON.stringify(result.findings.activeVideoSwaps.slice(0, 5)));
  console.log('空画面帧(透明>95%):', result.findings.blankFrameCount, JSON.stringify(result.findings.blankFrames.slice(0, 5)));
  console.log('时间轴异常:', result.findings.timeJumpCount, JSON.stringify(result.findings.timeJumps.slice(0, 5)));
  for (const c of result.aroundCycles) {
    console.log(`--- 第 ${c.cycle} 轮循环前后 300ms ---`);
    for (const s of c.window) {
      console.log(`  d=${String(s.d).padStart(5)}ms id=${s.id} t=${String(s.t).padStart(6)} rs=${s.rs} 透明=${String(s.tp).padStart(5)}% 不透明=${String(s.op).padStart(5)}% 均alpha=${s.ma} paused=${s.paused}`);
    }
  }
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error) }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 180000);
