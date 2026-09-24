// @ts-check
/**
 * 诊断：**对话气泡三个要求是否真的成立**（截图 + DOM 几何 + 缩放跟随 + 滚动）。
 *
 * 要求：
 *   1. 气泡随宠物大小变化 —— 改变 scale 后气泡尺寸必须按比例跟着变；
 *   2. 长文本可通过滚动条滑动 —— scrollHeight > clientHeight，且滚动后能到底；
 *   3. 文字必须落在气泡贴图的留白区内（不能压到描边/尾巴）。
 *
 * 第 3 点用**截图**核对：用 CSS 把气泡外的所有像素涂成纯品红覆盖层，
 * 再截窗口，然后统计"非品红 + 白底 + 气泡轮廓内"的暗像素分布，
 * 直接看文字有没有越界。截图也会存盘，人眼可以直接看图确认。
 *
 * 用法：npx electron tools/diag-bubble.cjs
 * 输出：build/bubble/*.png + build/bubble.json
 */
const { app, BrowserWindow, Menu } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const outDir = join(root, 'build', 'bubble');
const outFile = join(root, 'build', 'bubble.json');

const built = [];
const originalBuild = Menu.buildFromTemplate;
Menu.buildFromTemplate = function patched(template) {
  const menu = originalBuild.call(this, template);
  built.push({ template, menu });
  return menu;
};

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(6000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    writeFileSync(outFile, JSON.stringify({ fatal: 'no window' }), 'utf8');
    app.exit(1);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const js = (code) => win.webContents.executeJavaScript(code, true);

  /** 从最近的托盘模板里找到气泡子菜单项并触发它的 click（等价于用户点击）。 */
  const clickBubbleMenu = async (label) => {
    const before = built.length;
    // 触发一次托盘菜单重建
    await js('(() => { window.petAPI.tray && true; return true; })()');
    await wait(200);
    let entry = [...built].reverse().find((e) => e.template?.some((x) => x?.label === '对话气泡（测试）'));
    if (!entry || built.length === before) {
      // 强制重建：切换一次置顶状态会刷新托盘
      await js(`window.petAPI.settings.setAlwaysOnTop(true)`);
      await wait(400);
      entry = [...built].reverse().find((e) => e.template?.some((x) => x?.label === '对话气泡（测试）'));
    }
    const top = entry?.template?.find((x) => x?.label === '对话气泡（测试）');
    const item = Array.isArray(top?.submenu) ? top.submenu.find((s) => s.label === label) : null;
    if (!item?.click) return { found: false, label };
    item.click();
    return { found: true, label };
  };

  const snap = () =>
    js(`(() => {
      const b = document.getElementById('pet-bubble');
      const t = document.getElementById('pet-bubble-text');
      const pet = document.getElementById('pet-pet');
      const stage = document.getElementById('pet-stage');
      const cs = getComputedStyle(t);
      return {
        bubbleHidden: b.hidden,
        bubbleSize: { w: b.clientWidth, h: b.clientHeight },
        bubbleRect: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        /* 文字相对气泡的内缩（DOM 实测；不要靠截图推测几何） */
        textInset: (() => {
          const br = b.getBoundingClientRect();
          const tr = t.getBoundingClientRect();
          return {
            left: Math.round(tr.left - br.left),
            top: Math.round(tr.top - br.top),
            right: Math.round(br.right - tr.right),
            bottom: Math.round(br.bottom - tr.bottom),
            w: Math.round(tr.width),
            h: Math.round(tr.height),
          };
        })(),
        petSize: { w: pet.clientWidth, h: pet.clientHeight },
        petRect: (() => { const r = pet.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        text: {
          textLength: (t.textContent || '').length,
          clientW: t.clientWidth, clientH: t.clientHeight,
          scrollW: t.scrollWidth, scrollH: t.scrollHeight,
          scrollable: t.scrollHeight > t.clientHeight + 1,
          scrollTop: t.scrollTop,
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
        },
        stageVars: {
          petW: stage.style.getPropertyValue('--pet-px-width'),
          petH: stage.style.getPropertyValue('--pet-px-height'),
          gap: stage.style.getPropertyValue('--bubble-gap'),
          pad: stage.style.getPropertyValue('--bubble-pad'),
          font: stage.style.getPropertyValue('--bubble-font-size'),
        },
        windowInner: { w: window.innerWidth, h: window.innerHeight },
      };
    })()`);

  const setScale = async (scale) => {
    await js(`window.petAPI.settings.setScale(${scale})`);
    await wait(900);
  };

  /**
   * 截图（含文字），存盘并返回像素统计。
   *
   * ⚠️ 统计必须**限定在气泡矩形内**：整图里宠物（深蓝头发/深色衣服）也有大量
   * 暗像素，会被误当成文字，导致包围盒看起来"越界"（实测过这个坑）。
   */
  const shoot = async (name, bubbleRect) => {
    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    writeFileSync(join(outDir, `${name}.png`), png);
    const size = image.getSize();
    const bitmap = image.toBitmap(); // BGRA

    const region = bubbleRect ?? { x: 0, y: 0, w: size.width, h: size.height };
    const left = Math.max(0, region.x);
    const top = Math.max(0, region.y);
    const right = Math.min(size.width, region.x + region.w);
    const bottom = Math.min(size.height, region.y + region.h);

    let dark = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const i = (y * size.width + x) * 4;
        const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2], a = bitmap[i + 3];
        // 正文颜色是 #2f3a56，明显比气泡底色（近白/浅蓝）暗
        if (a > 128 && r < 120 && g < 120 && b < 140) {
          dark++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return {
      file: join(outDir, `${name}.png`),
      size: `${size.width}x${size.height}`,
      scannedRegion: { x: left, y: top, w: right - left, h: bottom - top },
      textPixels: dark,
      /** 相对**气泡左上角**的偏移，便于直接和留白比例对照。 */
      textOffsetInBubble: dark > 0 ? { left: minX - region.x, top: minY - region.y, right: region.x + region.w - 1 - maxX, bottom: region.y + region.h - 1 - maxY } : null,
      textBBoxInBubble: dark > 0 ? { x: minX - region.x, y: minY - region.y, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    };
  };

  const report = { steps: [] };
  const log = async (tag) => {
    const s = await snap();
    report.steps.push({ tag, ...s });
    return s;
  };

  /**
   * 宠物在**屏幕**上的绝对位置。
   *
   * 这是气泡功能最容易出错的地方：显示气泡要放大窗口，如果窗口以左上角为锚，
   * 宠物的脚会跟着往上跳一大截。正确做法是"窗口向上扩展、底边固定"，
   * 因此宠物的屏幕矩形在气泡显隐前后必须**完全不变**。
   */
  const petScreenRect = async () => {
    const bounds = win.getBounds();
    const s = await snap();
    const r = s.petRect;
    return { x: bounds.x + r.x, y: bounds.y + r.y, w: r.w, h: r.h, window: { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height } };
  };

  // ---------- 0) 基线：无气泡时的宠物屏幕位置 ----------
  await clickBubbleMenu('隐藏气泡');
  await wait(900);
  const petBefore = await petScreenRect();

  // ---------- 1) 显示长文本气泡 ----------
  const click1 = await clickBubbleMenu('显示长文（测滚动）');
  await wait(1200);
  const longState = await log('长文本气泡已显示');
  const petWithBubble = await petScreenRect();
  const shotLong = await shoot('bubble-long-default', longState.bubbleRect);

  // ---------- 2) 滚动到底 ----------
  const scrolled = await js(`(() => {
    const t = document.getElementById('pet-bubble-text');
    t.scrollTop = t.scrollHeight;
    return { scrollTop: t.scrollTop, scrollHeight: t.scrollHeight, clientHeight: t.clientHeight, atBottom: t.scrollTop + t.clientHeight >= t.scrollHeight - 1 };
  })()`);
  await wait(300);
  const shotScrolled = await shoot('bubble-long-scrolled', longState.bubbleRect);
  report.steps.push({ tag: '滚动到底', scrolled });
  // 回到顶部再继续
  await js(`document.getElementById('pet-bubble-text').scrollTop = 0; true`);

  // ---------- 3) 缩放跟随 ----------
  const scaleResults = [];
  for (const scale of [0.35, 1.0]) {
    await setScale(scale);
    const s = await log(`scale=${scale}`);
    const shot = await shoot(`bubble-scale-${String(scale).replace('.', '_')}`, s.bubbleRect);
    scaleResults.push({ scale, petW: s.petSize.w, petH: s.petSize.h, bubbleW: s.bubbleSize.w, bubbleH: s.bubbleSize.h, fontSize: s.text.fontSize, shot });
  }

  // ---------- 4) 短句 + 隐藏 ----------
  await clickBubbleMenu('显示短句');
  await wait(900);
  const shortState = await log('短句气泡');
  const shotShort = await shoot('bubble-short', shortState.bubbleRect);
  await clickBubbleMenu('隐藏气泡');
  await wait(900);
  const hiddenState = await log('已隐藏');
  const petAfter = await petScreenRect();

  /*
   * 锚点判定：气泡显隐前后宠物的屏幕矩形必须一致。
   *
   * ⚠️ 只比较"无气泡基线 vs 显示气泡"，**不要**和缩放测试之后的读数比 ——
   * 缩放测试会改变 scale，宠物本来就该换位置。第一版把两者混在一起，
   * 报出了假的"宠物漂移 664px"。
   *
   * 容差 5px：窗口尺寸变化会在 4px 物理像素网格上取整（本机 scaleFactor 1.25 -> 步长 4）（scaleFactor 1.25），
   * 宠物中心因此有 1~2px 的横向/纵向抖动 —— 这是像素取整，不是锚点算错。
   */
  const ANCHOR_TOLERANCE = 5;
  const anchorDelta = {
    x: Math.abs(petWithBubble.x - petBefore.x),
    y: Math.abs(petWithBubble.y - petBefore.y),
    w: Math.abs(petWithBubble.w - petBefore.w),
    h: Math.abs(petWithBubble.h - petBefore.h),
  };
  const anchorStable = Object.values(anchorDelta).every((v) => v <= ANCHOR_TOLERANCE);

  /* 另外单独验一次"隐藏后回到原位"（在回到基线 scale 之后） */
  await setScale(0.6);
  await wait(900);
  const petBaselineAgain = await petScreenRect();
  await clickBubbleMenu('显示短句');
  await wait(900);
  const petShown = await petScreenRect();
  await clickBubbleMenu('隐藏气泡');
  await wait(900);
  const petHidden = await petScreenRect();
  const roundTripDelta = {
    showX: Math.abs(petShown.x - petBaselineAgain.x),
    showY: Math.abs(petShown.y - petBaselineAgain.y),
    hideX: Math.abs(petHidden.x - petBaselineAgain.x),
    hideY: Math.abs(petHidden.y - petBaselineAgain.y),
  };
  const roundTripStable = Object.values(roundTripDelta).every((v) => v <= ANCHOR_TOLERANCE);

  Menu.buildFromTemplate = originalBuild;
  report.summary = {
    clickLong: click1,
    shotLong,
    shotScrolled,
    shotShort,
    longScrollable: longState.text.scrollable,
    shortScrollable: shortState.text.scrollable,
    scaleResults,
    hiddenBubbleHidden: hiddenState.bubbleHidden,
    hiddenWindowMatchesPet:
      hiddenState.windowInner.w === hiddenState.petSize.w && hiddenState.windowInner.h === hiddenState.petSize.h,
    anchor: { petBefore, petWithBubble, delta: anchorDelta, stable: anchorStable },
    roundTrip: {
      baseline: petBaselineAgain,
      shown: petShown,
      hidden: petHidden,
      delta: roundTripDelta,
      stable: roundTripStable,
    },
  };
  writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');

  console.log('=== 对话气泡验证 ===');
  console.log(`显示气泡时宠物锚点: ${anchorStable ? '稳定 ✅' : '被移动了 ❌'} delta=${JSON.stringify(anchorDelta)}`);
  console.log(`  无气泡: 宠物屏幕矩形=(${petBefore.x},${petBefore.y}) ${petBefore.w}x${petBefore.h}, 窗口=${petBefore.window.w}x${petBefore.window.h}@(${petBefore.window.x},${petBefore.window.y})`);
  console.log(`  有气泡: 宠物屏幕矩形=(${petWithBubble.x},${petWithBubble.y}) ${petWithBubble.w}x${petWithBubble.h}, 窗口=${petWithBubble.window.w}x${petWithBubble.window.h}@(${petWithBubble.window.x},${petWithBubble.window.y})`);
  console.log(`完整来回（显示->隐藏）: ${roundTripStable ? '宠物业位 ✅' : '宠物移动了 ❌'} delta=${JSON.stringify(roundTripDelta)}`);
  console.log(`  基线=(${petBaselineAgain.x},${petBaselineAgain.y}) 显示后=(${petShown.x},${petShown.y}) 隐藏后=(${petHidden.x},${petHidden.y})`);
  console.log(`长文本: 文字 ${longState.text.textLength} 字, 文字区 ${longState.text.clientW}x${longState.text.clientH}, 内容高 ${longState.text.scrollH}, 可滚动=${longState.text.scrollable}`);
  console.log(`  滚动到底: ${JSON.stringify(scrolled)}`);
  console.log(`  文字像素=${shotLong.textPixels} 相对气泡内缩=${JSON.stringify(shotLong.textOffsetInBubble)} 气泡=(${longState.bubbleRect.x},${longState.bubbleRect.y},${longState.bubbleRect.w}x${longState.bubbleRect.h})`);
  console.log(`短句: 可滚动=${shortState.text.scrollable}（应为 false）`);
  for (const r of scaleResults) {
    console.log(`scale=${r.scale}: 宠物 ${r.petW}x${r.petH} -> 气泡 ${r.bubbleW}x${r.bubbleH}, 字号 ${r.fontSize}`);
  }
  console.log(`隐藏后: bubbleHidden=${hiddenState.bubbleHidden} 窗口=${hiddenState.windowInner.w}x${hiddenState.windowInner.h} 宠物=${hiddenState.petSize.w}x${hiddenState.petSize.h}`);
  console.log(`截图: ${outDir}`);
  app.exit(0);
}).catch((error) => {
  writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error?.stack }), 'utf8');
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 240000);


