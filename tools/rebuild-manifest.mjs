// @ts-check
/**
 * 一次性：按新素材重建 assets/config/animations.json。
 *
 * 结构（共 24 条动画）：
 *   一次性 19 条：bomb / catch_down / catch_right / cute / fawning / hot / hungry /
 *                idle / lie / peek / play / remind / roll / shake / sing / spin /
 *                stroke / swim / talk
 *   持续   5 条：overheat / read / sleep / watch / work（各含 start + loop + end）
 *
 * loopCount 取值依据 tools/verify-loop-seam.mjs 的实测与时长：
 *   - 循环段接缝完美（seam=0）的可以放心设有限次数；
 *   - watch 是"必须循环播放"的台词，且其循环段接缝略高（ratio 6.9），设为无限循环，
 *     只在中途被打断时才播收尾。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const outFile = join(root, 'assets', 'config', 'animations.json');

/** 一次性动画：id -> { label, priority, cooldown, className } */
const ONE_SHOTS = [
  // idle 是兜底动画：**必须循环**，否则点击反应结束后画面会停在最后一帧
  { id: 'idle', label: '待机', priority: 0, cooldown: 0, fallback: true, loop: true, tags: ['idle', 'loop', 'base'] },
  { id: 'cute', label: '卖萌', priority: 50, cooldown: 3000, tags: ['reaction', 'touch'] },
  { id: 'fawning', label: '撒娇', priority: 50, cooldown: 3000, tags: ['reaction', 'touch'] },
  { id: 'stroke', label: '被抚摸', priority: 50, cooldown: 4000, tags: ['reaction', 'touch'] },
  { id: 'talk', label: '说话', priority: 40, cooldown: 3000, tags: ['reaction', 'social'] },
  { id: 'sing', label: '唱歌', priority: 30, cooldown: 5000, tags: ['show'] },
  { id: 'play', label: '玩耍', priority: 45, cooldown: 6000, tags: ['show'] },
  { id: 'hungry', label: '饿了', priority: 30, cooldown: 8000, tags: ['state'] },
  { id: 'remind', label: '提醒', priority: 60, cooldown: 10000, tags: ['notify'] },
  { id: 'hot', label: '好热', priority: 35, cooldown: 6000, tags: ['state'] },
  { id: 'lie', label: '趴下', priority: 10, cooldown: 0, tags: ['rest'] },
  { id: 'peek', label: '偷看', priority: 35, cooldown: 5000, tags: ['reaction'] },
  { id: 'bomb', label: '爆炸', priority: 100, cooldown: 300000, tags: ['special'] },
  { id: 'catch_down', label: '接住（下）', priority: 35, cooldown: 5000, tags: ['reaction', 'catching'] },
  { id: 'catch_right', label: '接住（右）', priority: 35, cooldown: 5000, tags: ['reaction', 'catching'] },
  { id: 'roll', label: '翻滚', priority: 45, cooldown: 5000, tags: ['action'] },
  { id: 'shake', label: '甩水', priority: 45, cooldown: 5000, tags: ['action'] },
  { id: 'spin', label: '转圈', priority: 45, cooldown: 5000, tags: ['action'] },
  { id: 'swim', label: '游泳', priority: 40, cooldown: 6000, tags: ['action'] },
];

/**
 * 持续动画：start -> loop × loopCount -> end。
 * loopCount 省略或 0 = 无限循环（只在中途被打断时才播收尾）。
 */
const PERSISTENT = [
  { id: 'overheat', label: '过热', priority: 40, loopCount: 3, tags: ['persistent', 'state'] },
  { id: 'read', label: '看书', priority: 20, loopCount: 4, tags: ['persistent', 'routine'] },
  { id: 'sleep', label: '睡觉', priority: 10, loopCount: 6, tags: ['persistent', 'rest'] },
  // watch 是"必须循环播放"的台词：无限循环，被打断才播 end
  { id: 'watch', label: '看着你', priority: 15, tags: ['persistent', 'idle'] },
  { id: 'work', label: '工作', priority: 20, loopCount: 4, tags: ['persistent', 'routine'] },
];

const manifest = {};

for (const item of ONE_SHOTS) {
  manifest[item.id] = {
    type: 'video',
    source: `animations/${item.id}.webm`,
    loop: item.loop === true,
    priority: item.priority,
    interruptible: true,
    cooldown: item.cooldown,
    ...(item.fallback ? { fallback: true } : {}),
    label: item.label,
    tags: item.tags,
    render: { className: `anim-${item.id.replace(/_/g, '-')}` },
  };
}

for (const item of PERSISTENT) {
  manifest[item.id] = {
    type: 'video',
    // source 指向 start 段：没有分段素材时（未来被删）仍能播点东西出来
    source: `animations/${item.id}-start.webm`,
    loop: false,
    priority: item.priority,
    interruptible: true,
    cooldown: 0,
    kind: 'persistent',
    segments: {
      start: `animations/${item.id}-start.webm`,
      loop: `animations/${item.id}-loop.webm`,
      end: `animations/${item.id}-end.webm`,
      ...(item.loopCount !== undefined ? { loopCount: item.loopCount } : {}),
    },
    label: item.label,
    tags: item.tags,
    render: { className: `anim-${item.id}` },
  };
}

writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const oneShotIds = Object.keys(manifest).filter((id) => manifest[id].kind !== 'persistent');
const persistentIds = Object.keys(manifest).filter((id) => manifest[id].kind === 'persistent');
console.log(`[manifest] 共 ${Object.keys(manifest).length} 条动画`);
console.log(`[manifest] 一次性 ${oneShotIds.length}: ${oneShotIds.join(', ')}`);
console.log(`[manifest] 持续   ${persistentIds.length}: ${persistentIds.join(', ')}`);
console.log(`[manifest] 已写入 ${outFile}`);
