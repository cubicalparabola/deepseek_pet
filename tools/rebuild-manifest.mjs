// @ts-check
/**
 * 按素材重建 `assets/config/animations.json` 与 `assets/config/behavior.json`。
 *
 * 动画清单（共 27 条动画，39 个 webm）按需求分四类：
 *
 *   状态动画 3：idle（正常默认）/ lie（下方收起默认）/ watch（右侧收起默认）
 *   随机动画 10：roll / hot / sleep / peek / bomb / play / shake / sing / spin / swim
 *   触发动画 11：catch_down / catch_right / hungry / remind / talk / sad / offline /
 *                shy / overheat / work / read
 *   点击动画 3：cute / fawning / stroke（**不可打断**：必须播完才能再点）
 *
 * 其中三段式（start → loop × N → end）6 条：overheat / read / sad / sleep / watch / work。
 * `loopCountRange` 让每次循环的轮数随机（需求："loop 需要循环随机次"）；watch 故意
 * 不配次数 = 无限循环，因为它是"右侧收起"的默认动画，只在离开收起状态时才播收尾。
 *
 * 随机池与间隔写在 `behavior.json`（见 shared/behavior-config.ts）：
 * 正常 25–60 秒随机挑一个，收起状态只有一个候选且间隔 3–8 分钟。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const outFile = join(root, 'assets', 'config', 'animations.json');
const behaviorFile = join(root, 'assets', 'config', 'behavior.json');

/** 随机循环次数范围（需求：loop 循环随机次）。 */
const LOOP_COUNT_RANGE = [2, 5];

/**
 * 一次性动画：id -> { label, category, priority, cooldown, tags, loop? }
 *
 * `category` 四类之一；`loop: true` 只给 idle（兜底必须循环，否则点击后画面停在最后一帧）。
 */
const ONE_SHOTS = [
  // ── 状态动画 ──────────────────────────────────────────────────────────
  // idle 是正常状态的兜底：必须循环，否则反应动画结束后画面会停在最后一帧。
  // （lie 也是状态动画，但它是三段式，写在下面的 PERSISTENT 里。）
  { id: 'idle', label: '待机', category: 'state', priority: 0, cooldown: 0, fallback: true, loop: true, tags: ['idle', 'loop', 'base'] },

  // ── 随机动画 ──────────────────────────────────────────────────────────
  { id: 'roll', label: '翻滚', category: 'random', priority: 45, cooldown: 5000, tags: ['random', 'action'] },
  { id: 'hot', label: '好热', category: 'random', priority: 35, cooldown: 6000, tags: ['random', 'state'] },
  { id: 'play', label: '玩耍', category: 'random', priority: 45, cooldown: 6000, tags: ['random', 'show'] },
  { id: 'shake', label: '甩水', category: 'random', priority: 45, cooldown: 5000, tags: ['random', 'action'] },
  { id: 'sing', label: '唱歌', category: 'random', priority: 30, cooldown: 5000, tags: ['random', 'show'] },
  { id: 'spin', label: '转圈', category: 'random', priority: 45, cooldown: 5000, tags: ['random', 'action'] },
  { id: 'swim', label: '游泳', category: 'random', priority: 40, cooldown: 6000, tags: ['random', 'action'] },
  { id: 'bomb', label: '爆炸', category: 'random', priority: 100, cooldown: 300000, tags: ['random', 'special'] },
  { id: 'peek', label: '偷看', category: 'random', priority: 35, cooldown: 5000, tags: ['random', 'reaction'] },

  // ── 触发动画 ──────────────────────────────────────────────────────────
  { id: 'catch_down', label: '接住（下）', category: 'trigger', priority: 35, cooldown: 5000, tags: ['trigger', 'catching'] },
  { id: 'catch_right', label: '接住（右）', category: 'trigger', priority: 35, cooldown: 5000, tags: ['trigger', 'catching'] },
  { id: 'hungry', label: '饿了', category: 'trigger', priority: 30, cooldown: 8000, tags: ['trigger', 'state'] },
  { id: 'remind', label: '提醒', category: 'trigger', priority: 60, cooldown: 10000, tags: ['trigger', 'notify'] },
  { id: 'talk', label: '说话', category: 'trigger', priority: 40, cooldown: 3000, tags: ['trigger', 'social'] },
  { id: 'shy', label: '害羞（捂眼睛）', category: 'trigger', priority: 55, cooldown: 60000, tags: ['trigger', 'privacy'] },
  { id: 'offline', label: '掉线', category: 'trigger', priority: 30, cooldown: 300000, tags: ['trigger', 'state'] },

  // ── 点击动画（不可打断） ───────────────────────────────────────────────
  { id: 'cute', label: '卖萌', category: 'click', priority: 50, cooldown: 3000, tags: ['click', 'touch'], interruptible: false },
  { id: 'fawning', label: '撒娇', category: 'click', priority: 50, cooldown: 3000, tags: ['click', 'touch'], interruptible: false },
  { id: 'stroke', label: '被抚摸', category: 'click', priority: 50, cooldown: 4000, tags: ['click', 'touch'], interruptible: false },
];

/**
 * 三段式动画：start -> loop × 随机次数 -> end。
 * `loopCountRange` 省略 = 无限循环（只在中途被打断时才播收尾）。
 */
const PERSISTENT = [
  /*
   * watch 是"右侧收起"的默认动画：**故意不配轮数**（无限循环），
   * 只在离开收起状态（或被打断）时才播收尾 —— 所以这里显式写 null。
   *
   * `offsetXPercent`：把这套素材整体**向右**挪一点再渲染（用户要求
   * "watch 动画再向右一点播放位置"）。素材本身在她贴住屏幕右边缘时
   * 看着还差一点，用渲染偏移补最省事 —— 不动窗口、也不动贴边几何。
   * 数值是相对**素材自身宽度**的百分比（6 ≈ 默认尺寸下 13px）。
   * 想再挪就改这一个数（清单里的 `render.offsetXPercent`）。
   */
  { id: 'watch', label: '看着你', category: 'state', priority: 15, loopCountRange: null, offsetXPercent: 6, tags: ['state', 'idle'] },
  /*
   * sleep 是"下方收起"的默认姿势（用户要求与 lie 对调角色）。
   * 它本来就是三段式，动作正好连贯：
   *   start = sleep-start（从站到躺下、闭眼）
   *   loop  = sleep-loop（睡觉）
   *   end   = sleep-end（醒来站起来）
   * 作为"收起的默认姿势"时渲染层会传 `loopCountRange: 'forever'` 覆盖成无限；
   * 作为触发（深夜劝睡）时用定义里的默认轮数 [2,5] 自己结束。
   */
  { id: 'sleep', label: '睡觉', category: 'state', priority: 10, tags: ['state', 'rest'] },
  /*
   * lie 现在的角色是"下方收起的**随机**动画"（用户要求与 sleep 对调），
   * 同时也在正常状态的随机池里。它同样是三段式，首尾复用 sleep 的躺下/起身：
   *   start = sleep-start、loop = lie（趴着的姿势）、end = sleep-end
   * 默认轮数 [2,4]：被触发时（"主人不在呀"演一次）趴一会儿自己起来；
   * 池里会传 [1,2] 压短（见 behavior.json）。
   */
  {
    id: 'lie', label: '趴下', category: 'random', priority: 10,
    segments: { start: 'animations/sleep-start.webm', loop: 'animations/lie.webm', end: 'animations/sleep-end.webm' },
    loopCountRange: [2, 4], tags: ['random', 'rest'],
  },
  { id: 'sad', label: '难过', category: 'trigger', priority: 45, tags: ['trigger', 'mood'] },
  { id: 'overheat', label: '过热', category: 'trigger', priority: 40, tags: ['trigger', 'state'] },
  { id: 'read', label: '看书', category: 'trigger', priority: 20, tags: ['trigger', 'routine'] },
  { id: 'work', label: '工作', category: 'trigger', priority: 20, tags: ['trigger', 'routine'] },
];

const manifest = {};

for (const item of ONE_SHOTS) {
  manifest[item.id] = {
    type: 'video',
    source: `animations/${item.id}.webm`,
    loop: item.loop === true,
    priority: item.priority,
    interruptible: item.interruptible !== false,
    cooldown: item.cooldown,
    category: item.category,
    ...(item.fallback ? { fallback: true } : {}),
    label: item.label,
    tags: item.tags,
    render: { className: `anim-${item.id.replace(/_/g, '-')}` },
  };
}

for (const item of PERSISTENT) {
  const segments = item.segments ?? {
    start: `animations/${item.id}-start.webm`,
    loop: `animations/${item.id}-loop.webm`,
    end: `animations/${item.id}-end.webm`,
  };
  // 轮数：显式 null = 不写（无限循环）；显式数组 = 用它；没写 = 默认 [2,5]
  const range = item.loopCountRange === null ? null : (item.loopCountRange ?? LOOP_COUNT_RANGE);
  manifest[item.id] = {
    type: 'video',
    // source 指向 start 段：分段素材万一被删也能播点东西出来
    source: segments.start,
    loop: false,
    priority: item.priority,
    interruptible: true,
    cooldown: 0,
    category: item.category,
    kind: 'persistent',
    segments: {
      ...segments,
      ...(range ? { loopCountRange: range } : {}),
    },
    label: item.label,
    tags: item.tags,
    render: { className: `anim-${item.id}`, ...(item.offsetXPercent !== undefined ? { offsetXPercent: item.offsetXPercent } : {}) },
  };
}

writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

/* -------------------------------------------------------------------------- */
/* behavior.json：显示状态 -> 默认动画 + 随机池 + 间隔                          */
/* -------------------------------------------------------------------------- */

const behavior = {
  version: 1,
  states: {
    normal: { label: '正常', defaultAnimation: 'idle', pools: ['normal-random'] },
    'docked-bottom': { label: '下方收起', defaultAnimation: 'sleep', pools: ['docked-bottom-random'] },
    'docked-right': { label: '右侧收起', defaultAnimation: 'watch', pools: ['docked-right-random'] },
    hidden: { label: '隐藏', defaultAnimation: null, pools: [] },
  },
  pools: {
    'normal-random': {
      label: '随机小动作',
      animations: ['roll', 'hot', 'bomb', 'lie', 'play', 'shake', 'sing', 'spin', 'swim'],
      intervalMs: [25000, 60000],
      initialDelayMs: 15000,
      cooldownMs: 8000,
      // 池里的三段式成员压成一两轮：趴下歇一会儿就自己爬起来，不是一直趴着
      persistentLoopCountRange: [1, 2],
      onlyWhenIdle: true,
    },
    'docked-bottom-random': {
      // 下方收起的随机动画是 **lie**（用户要求与 sleep 对调角色）
      label: '收起时趴一会儿',
      animations: ['lie'],
      intervalMs: [180000, 480000],
      initialDelayMs: 60000,
      cooldownMs: 30000,
      persistentLoopCountRange: [1, 2],
      onlyWhenIdle: true,
    },
    'docked-right-random': {
      label: '收起时偷看',
      animations: ['peek'],
      intervalMs: [180000, 480000],
      initialDelayMs: 60000,
      cooldownMs: 30000,
      onlyWhenIdle: true,
    },
  },
};

writeFileSync(behaviorFile, `${JSON.stringify(behavior, null, 2)}\n`, 'utf8');

/* --------------------------------- 汇总 ---------------------------------- */

const byCategory = { state: [], random: [], trigger: [], click: [] };
for (const [id, entry] of Object.entries(manifest)) {
  const list = byCategory[entry.category];
  if (list) list.push(id);
}
console.log(`[manifest] 共 ${Object.keys(manifest).length} 条动画`);
for (const [category, ids] of Object.entries(byCategory)) {
  console.log(`[manifest]   ${category.padEnd(8)} ${ids.length}: ${ids.join(', ')}`);
}
console.log(`[manifest] 已写入 ${outFile}`);
console.log(`[manifest] 已写入 ${behaviorFile}`);

// 顺便核对：池里引用的动画必须都存在（写错 id 是最容易犯的错）
const referenced = new Set();
for (const pool of Object.values(behavior.pools)) {
  for (const id of pool.animations) {
    if (!(id in manifest)) throw new Error(`behavior.json 的池引用了不存在的动画: ${id}`);
    referenced.add(id);
  }
}
console.log(`[manifest] 随机池引用动画 ${referenced.size} 个，全部存在于清单中`);

// 素材文件真的都在（清单写了但文件不在 = 运行时才炸）
const missing = [];
for (const entry of Object.values(manifest)) {
  const files = [entry.source, ...Object.values(entry.segments ?? {})].filter((v) => typeof v === 'string');
  for (const file of files) {
    try {
      readFileSync(join(root, 'assets', file));
    } catch {
      missing.push(file);
    }
  }
}
if (missing.length > 0) throw new Error(`清单引用了不存在的素材: ${missing.join(', ')}`);
console.log('[manifest] 清单引用的素材全部存在');
