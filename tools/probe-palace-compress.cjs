// @ts-check
/**
 * 探针：**记忆宫殿压缩在真实启动路径上生效吗**（C）。
 *
 * 验收只能断言纯函数（`compressPalaceNodes`），而这条链路的接线上有三个容易漏的点：
 *   1. 启动时到底有没有调它（`load()` → `compressPalace()`）；
 *   2. 被折掉的**原始节点有没有先写进 `memory/archive/palace-<年>.json`**；
 *   3. `nodes.json` 与 `palace.md` 有没有真的更新（而不是只在内存里折了）。
 *
 * 做法：先在隔离数据目录里**预置**一份 nodes.json（三条同种类同标题的老节点 + 一条新近的）
 * 与 `growth-settings.json`（`palaceCompressMonths` 用默认 6），然后启动桌宠，
 * 最后直接读文件核对。
 *
 * 用法：npx electron tools/probe-palace-compress.cjs
 * 输出：build/palace-compress.json
 */
const { app } = require('electron');
const { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
// PROBE_PALACE_OFF=1 时走"关掉压缩"分支：验证 palaceCompressMonths=0 ⇒ 一个字节都不写。
const offMode = process.env.PROBE_PALACE_OFF === '1';
const outFile = join(root, 'build', offMode ? 'palace-compress-off.json' : 'palace-compress.json');
const dataDir = join(tmpdir(), 'desktop-pet-probe-palace');
process.env.DESKTOP_PET_AI_DATA_DIR = dataDir;
try { rmSync(dataDir, { recursive: true, force: true }); } catch (error) { /* 忽略 */ }
mkdirSync(join(dataDir, 'memory'), { recursive: true });

/** 造三条"很久以前"的同种类同标题节点 + 一条新近的（不应被折）。 */
const node = (id, kind, title, at, extra = {}) => ({
  id, kind, title, detail: '', at, source: 'auto', evidence: [], hits: 1, pinned: false, ...extra,
});
const seeded = [
  node('old-1', 'late-night', '一起熬夜', '2024-11-10T15:00:00.000Z', { evidence: ['赶论文'] }),
  node('old-2', 'late-night', '一起熬夜', '2025-02-02T15:00:00.000Z', { hits: 2 }),
  node('old-3', 'late-night', '一起熬夜', '2025-04-18T15:00:00.000Z'),
  node('fresh', 'coding', '开始研究 AI', new Date(Date.now() - 3 * 86400000).toISOString()),
];
writeFileSync(join(dataDir, 'memory', 'nodes.json'), JSON.stringify(seeded, null, 1), 'utf8');
// 压缩阈值（其余用默认）：验证"面板/设置里的这个数真的被读到"；off 模式则关掉压缩
writeFileSync(join(dataDir, 'growth-settings.json'), JSON.stringify({ palaceCompressMonths: offMode ? 0 : 6 }, null, 1), 'utf8');

app.disableHardwareAcceleration();
require(join(root, 'dist', 'main', 'main.js'));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  await wait(7000);
  const memoryDir = join(dataDir, 'memory');
  const nodesFile = join(memoryDir, 'nodes.json');
  const palaceFile = join(memoryDir, 'palace.md');
  const archiveDir = join(memoryDir, 'archive');
  const nodes = existsSync(nodesFile) ? JSON.parse(readFileSync(nodesFile, 'utf8')) : [];
  const palace = existsSync(palaceFile) ? readFileSync(palaceFile, 'utf8') : '';
  const archives = existsSync(archiveDir) ? readdirSync(archiveDir).sort() : [];
  const archived = archives.length > 0
    ? JSON.parse(readFileSync(join(archiveDir, archives[0]), 'utf8'))
    : [];
  const merged = nodes.find((item) => item.id === 'old-1');
  if (offMode) {
    // 关掉压缩：三条老节点必须原样留着（不被折、不写 detail），且不许出现 archive 目录。
    // 注意：`palace` 开关本身仍是开的，所以「第一次见面」那条自动节点照常出现 —— 那与压缩无关。
    const ids = nodes.map((item) => item.id).sort();
    const oldNodes = nodes.filter((item) => item.id.startsWith('old-'));
    const result = {
      nodeIds: ids,
      archives,
      verdict: {
        seededNodesUntouched: ['fresh', 'old-1', 'old-2', 'old-3'].every((id) => ids.includes(id)),
        oldNodesNotCollapsed: oldNodes.length === 3 && oldNodes.every((item) => item.detail === ''),
        hitsUntouched: oldNodes.find((item) => item.id === 'old-2').hits === 2,
        noArchiveWritten: archives.length === 0,
      },
    };
    writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
    console.log('[result]', JSON.stringify(result, null, 1));
    app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
    return;
  }
  const result = {
    nodeIds: nodes.map((item) => item.id),
    mergedDetail: merged ? merged.detail : '',
    mergedHits: merged ? merged.hits : 0,
    mergedEvidence: merged ? merged.evidence : [],
    archives,
    archivedNodeIds: Array.isArray(archived) && archived[0] ? archived[0].nodes.map((item) => item.id) : [],
    // 镜像里的折叠后标题只应出现一次（原来是三条独立的「一起熬夜」）
    palaceMergedTitleLines: palace.split('\n').filter((line) => line.includes('**一起熬夜**')).length,
    palaceHasMergedDetail: Boolean(merged) && merged.detail !== '' && palace.includes(merged.detail),
    verdict: {
      collapsedToSingleNode: nodes.filter((item) => item.id.startsWith('old-')).length === 1,
      keptFreshNode: nodes.some((item) => item.id === 'fresh'),
      hitsSummed: Boolean(merged) && merged.hits === 4,
      datesListed: Boolean(merged) && merged.detail.includes('2024-11-10') && merged.detail.includes('2025-04-18'),
      evidenceMerged: Boolean(merged) && merged.evidence.includes('赶论文'),
      archivedOriginals: archives.length > 0 &&
        Array.isArray(archived) && archived[0] && archived[0].nodes.length === 3,
      palaceMirrorUpdated: Boolean(merged) && merged.detail !== '' && palace.includes(merged.detail) &&
        palace.split('\n').filter((line) => line.includes('**一起熬夜**')).length === 1,
    },
  };
  writeFileSync(outFile, JSON.stringify(result, null, 1), 'utf8');
  console.log('[result]', JSON.stringify(result, null, 1));
  app.exit(Object.values(result.verdict).every(Boolean) ? 0 : 1);
}).catch((error) => {
  try { writeFileSync(outFile, JSON.stringify({ fatal: String(error), stack: error && error.stack }, null, 1), 'utf8'); } catch (e) { /* 忽略 */ }
  console.error('FAILED', error);
  app.exit(1);
});

setTimeout(() => app.exit(2), 120000);
