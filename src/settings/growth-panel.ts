/**
 * 「成长与反思」设置面板（4.1 记忆宫殿 / 4.2 自我反思与行为策略）。
 *
 * 与 `ai-panel.ts` / `perception-panel.ts` 同构：面板是**自包含的挂载函数**，拿到容器 +
 * 桥 + 初始快照就自带事件与刷新逻辑，设置页面只要一行接线。四个特别之处：
 * 1. **时间轴是主角**。4.1 的全部意义是"让用户看见我们一起经历了这么多"，所以节点不是列表项
 *    而是一张张卡片，按 `YYYY-MM` 分组挂在竖线上；倒序与"钉住的排最前"由主进程的
 *    `palace.nodes` 决定，这里只按给定顺序渲染。
 * 2. **状态推送很密，但时间轴很重**。每次推送都重建几十张卡片会丢滚动位置、丢焦点，还会让
 *    正在看时间轴的人眼前一跳 —— 因此只读部分走 3 秒节流，只有"节点总数 / 今天的反思日期 /
 *    策略调整次数"变化才立刻刷（见 `renderKey` 与 `refresh`）。
 * 3. **绝不覆盖用户正在编辑的输入框**。状态推送只刷新只读区域；`reflectionHour` /
 *    `keepReflectionDays` 只在挂载时与**保存成功之后**回填，并仍带 `document.activeElement`
 *    守卫（推送与慢回执都可能晚到）。
 * 4. **任何 api 调用都不许把面板弄崩**。全部 .catch()，失败原因写进状态行，按钮在 finally
 *    里复位：任何时刻都不会留下一个转不停的按钮。
 *
 * CSP：动态文本一律 `textContent`。反思正文、节点标题/细节/依据都可能是模型产出。
 */

import type {
  GrowthSettingsPatch,
  GrowthStatus,
  MemoryNode,
  MemoryNodeKind,
  ReflectionEntry,
  ReflectionInsight,
} from '../shared/growth-types';
import { NODE_KINDS } from '../shared/growth-types';
import { daysBetween, nodeLabel, sceneName } from '../shared/growth';
import type { GrowthAPI } from '../shared/ipc';
/* 通用小工具（纯 DOM，不碰业务状态）。 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}
function makeInput(kind: 'text' | 'number', id: string, label: string): HTMLInputElement {
  const node = el('input', 'growth-input'); node.type = kind;
  node.id = id;
  // aria-label 与 <label for> 双保险：本面板控件全部由脚本动态创建，
  // 只靠 for 关联时个别读屏软件会漏读用途。
  node.setAttribute('aria-label', label);
  return node;
}
function makeCheckbox(id: string, label: string): HTMLInputElement {
  const node = el('input', 'growth-check-input'); node.type = 'checkbox';
  node.id = id;
  node.setAttribute('aria-label', label);
  return node;
}
function makeButton(id: string, label: string, variant: 'primary' | 'ghost'): HTMLButtonElement {
  // 类名故意不叫 primary/ghost：settings.css 里有同名全局按钮样式，撞上会互相污染
  const node = el('button', variant === 'primary' ? 'growth-btn-primary' : 'growth-btn-ghost'); node.type = 'button';
  node.id = id;
  node.textContent = label;
  node.setAttribute('aria-label', label);
  return node;
}
/** 一行"标签 + 控件"（可选小字说明，说明横跨两列）。 */
function fieldRow(id: string, labelText: string, control: HTMLElement, hint?: string): HTMLDivElement {
  const row = el('div', 'growth-field');
  const label = el('label', 'growth-field-label');
  label.htmlFor = id;
  label.textContent = labelText;
  row.append(label, control);
  if (hint === undefined) return row;
  const note = el('p', 'growth-hint'); note.textContent = hint;
  row.appendChild(note);
  return row;
}
/** 复选框行：整行可点（框在左、文字在右）。 */
function checkRow(labelText: string, control: HTMLInputElement): HTMLLabelElement {
  const row = el('label', 'growth-check');
  const span = el('span'); span.textContent = labelText;
  row.append(control, span);
  return row;
}
/** 开关项：复选框 + 一行"关掉会怎样"的小字说明（每项独占一个容器）。 */
function switchItem(labelText: string, control: HTMLInputElement, hint: string): HTMLDivElement {
  const item = el('div', 'growth-switch-item');
  const note = el('p', 'growth-hint growth-switch-hint'); note.textContent = hint;
  item.append(checkRow(labelText, control), note);
  return item;
}
function makeSection(title: string): HTMLElement {
  const node = el('section', 'growth-section');
  const heading = el('h2'); heading.textContent = title;
  node.appendChild(heading);
  return node;
}
/** 只读读数行：返回行元素与值元素（值元素后续会被反复覆写）。 */
function makeReadout(labelText: string): { row: HTMLDivElement; value: HTMLSpanElement } {
  const row = el('div', 'growth-readout');
  const label = el('span', 'growth-readout-label');
  const value = el('span', 'growth-readout-value'); label.textContent = labelText;
  value.textContent = '—';
  row.append(label, value);
  return { row, value };
}
function actionRow(...controls: HTMLElement[]): HTMLDivElement {
  const row = el('div', 'growth-actions');
  row.append(...controls);
  return row;
}
/** 表格：表头整行 + 若干数据行；单元格文本一律 textContent。 */
function tableRow(cells: readonly string[], header = false): HTMLTableRowElement {
  const row = el('tr');
  for (const text of cells) {
    const cell = el(header ? 'th' : 'td'); cell.textContent = text;
    row.appendChild(cell);
  }
  return row;
}
function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
/** 输入框里的数字：空串/非数字返回 null（调用方据此拒绝提交，而不是猜一个默认值）。 */
function numberValue(control: HTMLInputElement): number | null {
  const raw = control.value.trim();
  if (raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === '' ? '未知错误' : message;
}
/**
 * 时间戳 -> `YYYY-MM-DD`（面板时间口径统一，便于与时间轴分组对照）。
 * 与 `node.at.slice(0, 10)` 同口径，不用 `toLocaleString`：后者在别的区域设置下会变成
 * `2025/3/5`，和分组标题对不上。
 */
function formatDate(iso: string): string {
  if (iso.trim() === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
/** `2025-03` -> `2025 年 3 月`（分组标题用中文，比 `2025-03` 更像日记本）。 */
function monthTitle(month: string): string {
  const [year, mon] = month.split('-');
  if (year === undefined || mon === undefined) return month;
  return `${year} 年 ${String(Number(mon))} 月`;
}
/** 倍率 -> "间隔倍数"：0.5 的因子意味着间隔 ×2（因子越小她越克制）。 */
function intervalTimes(factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0) return '×1';
  return `×${(1 / factor).toFixed(1)}`;
}
/** 反思结论段只有这三种动作（与 `ReflectionInsight['action']` 一一对应）。 */
const ACTION_LABELS: Readonly<Record<ReflectionInsight['action'], string>> = {
  'quiet-down': '少打扰',
  keep: '保持',
  'speak-up': '可以多说一点',
};
function sourceLabel(source: ReflectionEntry['source']): string {
  return source === 'llm' ? '大模型' : '本地模板';
}
/** 列表里显示的首行：多行正文只取第一行，截断到 60 字（列表要短才好扫）。 */
function firstLine(body: string, limit = 60): string {
  // 正文可能是模型产出的多行文本：去掉空行后取第一行，避免列表项高度乱跳
  const line = body.split('\n').map((part) => part.trim()).find((part) => part !== '') ?? '';
  if (line === '') return '（空）';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}
/** 时间轴分组用的月份键（`at` 可能是空串，坏数据也要有个位置）。 */
function monthKey(iso: string): string {
  const key = iso.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(key) ? key : '未知时间';
}
/** 请求超时（毫秒）：让"立刻反思一次"这类长调用不会转一辈子。 */
const REQUEST_TIMEOUT_MS = 120000;
/** 只读部分的刷新节流窗口：状态推送很密，时间轴不能每次都重建。 */
const RENDER_THROTTLE_MS = 3000;
/**
 * 只读刷新指纹：只有这三项变化才说明"时间轴上真的多了/少了一段经历或策略被调过"。其余推送
 * （`policyEffect` 文案微调之类）等节流窗口即可，否则正在翻看记忆的人每几秒就会被重建一次的
 * 列表弹回顶部。
 */
function renderKey(status: GrowthStatus): string {
  return `${status.palace.stats.total}:${status.todayReflection?.date ?? ''}:${status.policy.adjustments}`;
}
/**
 * 带超时的 Promise：主进程若卡在模型调用上，按钮不能永远转下去。
 * 刻意不取消底层请求（IPC 没有取消通道）：这里只**让界面先恢复**，迟到的结果照旧处理。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
/** 把「成长与反思」面板挂到给定容器里。 */
export function mountGrowthPanel(root: HTMLElement, api: GrowthAPI, initial: GrowthStatus): void {
  const panel = el('div', 'growth-panel');
  root.appendChild(panel);
  /** 最近一次已知状态：保存成功后回填输入框、以及别处回执缺失时兜底都用它。 */
  let latest: GrowthStatus = initial;
  /** 只读刷新节流时间戳与上一次的刷新指纹。 */
  let lastRender = 0;
  let lastKey = '';
  /** "已保存"提示的淡出计时器句柄。 */
  let savedTimer: number | null = null;

  /* 一、状态行 */

  const statusSection = makeSection('成长状态');
  const nodeCountReadout = makeReadout('记忆节点');
  const daysReadout = makeReadout('一起走过');
  const todayReadout = makeReadout('今天的反思');
  const policyReadout = makeReadout('当前策略');
  const lastErrorReadout = makeReadout('最近错误');
  const dataDirReadout = makeReadout('数据目录');
  const readouts = [nodeCountReadout, daysReadout, todayReadout, policyReadout, lastErrorReadout, dataDirReadout];
  for (const readout of readouts) statusSection.appendChild(readout.row);
  // 数据目录要能选中复制，抵消 body 上的全局 user-select:none
  dataDirReadout.value.classList.add('growth-small');

  const statusLine = el('p', 'growth-status-line'); statusLine.id = 'growth-panel-status';
  statusLine.textContent = '就绪';
  // role=status：失败信息、"让她回忆一下"的结果与"已保存"都会写在这里，读屏软件应当播报
  statusLine.setAttribute('role', 'status');
  const savedLabel = el('span', 'growth-saved'); savedLabel.id = 'growth-saved';
  savedLabel.textContent = '已保存';
  statusSection.append(statusLine, savedLabel);

  /* 二、4.1 记忆宫殿（时间轴）—— 面板的视觉主体 */

  const palaceSection = makeSection('4.1 🧠 宠物记忆宫殿（时间轴）');
  const palaceSummary = el('p', 'growth-palace-summary'); palaceSummary.id = 'growth-palace-summary';
  palaceSummary.textContent = '—';
  const timeline = el('div', 'growth-timeline'); timeline.id = 'growth-timeline';
  // role=list：时间轴是一串经历，读屏软件应当按列表朗读
  timeline.setAttribute('role', 'list');

  const kindSelect = el('select', 'growth-input'); kindSelect.id = 'growth-node-kind';
  kindSelect.setAttribute('aria-label', '这一段经历的种类');
  for (const kind of Object.keys(NODE_KINDS) as MemoryNodeKind[]) {
    const option = el('option');
    option.value = kind;
    // 选项文案用 nodeLabel，和卡片上的 emoji + 标签完全一致
    option.textContent = nodeLabel(kind);
    kindSelect.appendChild(option);
  }

  const nodeTitleInput = makeInput('text', 'growth-node-title', '这一段经历的标题');
  nodeTitleInput.placeholder = '例如：开始研究 AI';
  nodeTitleInput.maxLength = 60;
  const nodeDetailInput = el('textarea', 'growth-textarea'); nodeDetailInput.id = 'growth-node-detail';
  nodeDetailInput.rows = 2;
  nodeDetailInput.maxLength = 400;
  nodeDetailInput.setAttribute('aria-label', '这一段经历的细节（可留空）');

  const palaceOpenButton = makeButton('growth-open-palace', '打开记忆宫殿文件', 'ghost');
  const nodeAddButton = makeButton('growth-node-add', '保存', 'primary');
  const manualTitle = el('p', 'growth-hint growth-manual-title'); manualTitle.textContent = '手动记一笔';

  palaceSection.append(
    palaceSummary,
    timeline,
    manualTitle,
    fieldRow('growth-node-kind', '种类', kindSelect),
    fieldRow('growth-node-title', '标题', nodeTitleInput, '简短一句就好，会显示在时间轴上。'),
    fieldRow('growth-node-detail', '细节', nodeDetailInput, '可留空；她自己的口吻写一两句也行。'),
    actionRow(nodeAddButton, palaceOpenButton),
  );

  /* 三、4.2 AI 自我反思 */

  const reflectionSection = makeSection('4.2 AI 自我反思');
  const palaceSwitch = makeCheckbox('growth-palace', '记忆宫殿');
  const reflectionSwitch = makeCheckbox('growth-reflection', '每天自我反思');
  const policySwitch = makeCheckbox('growth-policy-adapt', '允许反思调整行为策略');
  reflectionSection.append(
    // 每个开关下面都写清"关掉会怎样"：她的行为会因此改变，代价必须一眼可见
    switchItem('记忆宫殿（4.1）', palaceSwitch,
      '关掉后不再自动沉淀新的记忆节点；已经记下的经历仍然留在时间轴上。'),
    switchItem('每天自我反思（4.2）', reflectionSwitch,
      '关掉后她不再写反思，时间轴上也不会出现新的"今天想了什么"。'),
    switchItem('允许反思调整行为策略（4.2）', policySwitch,
      '关掉后她仍然会写反思，但不会改自己的打扰频率 —— 只写感想、不动行为。'),
  );

  const hourInput = makeInput('number', 'growth-reflection-hour', '每天反思的时刻');
  hourInput.min = '0';
  hourInput.max = '23';
  hourInput.step = '1';
  const keepInput = makeInput('number', 'growth-keep-days', '反思保留天数');
  keepInput.min = '0';
  keepInput.max = '3650';
  keepInput.step = '10';
  reflectionSection.append(
    fieldRow('growth-reflection-hour', '反思时刻（0~23）', hourInput, '每天到这个整点自动反思一次；当天已经写过就跳过。'),
    fieldRow('growth-keep-days', '保留天数', keepInput, '超过这个天数的反思会被归档进记忆宫殿，不再进 prompt。'),
  );

  const settingsSave = makeButton('growth-settings-save', '保存反思设置', 'primary');
  const reflectNowButton = makeButton('growth-reflect-now', '立刻反思一次', 'ghost');
  const openLogButton = makeButton('growth-open-reflection-log', '打开反思/策略日志', 'ghost');
  reflectionSection.append(actionRow(settingsSave, reflectNowButton, openLogButton));

  const reflectionMeta = el('p', 'growth-reflection-meta'); reflectionMeta.id = 'growth-reflection-meta';
  reflectionMeta.textContent = '—';
  // 正文是模型产出：<pre> + textContent，绝不当 HTML 解析
  const reflectionBody = el('pre', 'growth-reflection-body'); reflectionBody.id = 'growth-reflection-body';
  reflectionBody.textContent = '';
  const insightTitle = el('p', 'growth-hint growth-sub-title'); insightTitle.textContent = '反思得到的结论';
  const insightList = el('ul', 'growth-insight-list'); insightList.id = 'growth-insight-list';
  const reflectionStats = el('p', 'growth-hint growth-stats'); reflectionStats.id = 'growth-reflection-stats';
  reflectionStats.textContent = '';
  reflectionSection.append(reflectionMeta, reflectionBody, insightTitle, insightList, reflectionStats);

  /* 四、4.2 行为策略（反思的结果） */

  const policySection = makeSection('4.2 行为策略（反思的结果）');
  const policyTable = el('table', 'growth-table'); policyTable.id = 'growth-policy-table';
  const policyTableBody = el('tbody');
  policyTable.appendChild(policyTableBody);
  const policyMeta = el('p', 'growth-hint growth-policy-meta'); policyMeta.id = 'growth-policy-meta';
  policyMeta.textContent = '—';
  const policyBound = el('p', 'growth-hint growth-policy-bound'); policyBound.textContent = '反思只能让她更克制（最多把频率降到四分之一），永远不会比你设定的更频繁。';
  const policyReset = makeButton('growth-policy-reset', '重置策略', 'ghost');
  policySection.append(policyTable, policyMeta, policyBound, actionRow(policyReset));

  /* 五、反馈统计 */

  const statsSection = makeSection('反馈统计');
  const statsTable = el('table', 'growth-table'); statsTable.id = 'growth-response-stats';
  const statsTableBody = el('tbody');
  statsTable.appendChild(statsTableBody);
  const statsHint = el('p', 'growth-hint'); statsHint.textContent = '回应率低的场景她会自己少说话；这是她判断"该不该开口"的唯一依据。';
  statsSection.append(statsTable, statsHint);

  /* 六、最近反思 */

  const recentSection = makeSection('最近反思');
  const recentList = el('ul', 'growth-recent-list'); recentList.id = 'growth-recent-list';
  recentList.setAttribute('role', 'list');
  recentSection.appendChild(recentList);

  panel.append(statusSection, palaceSection, reflectionSection, policySection, statsSection, recentSection);
  /* 面板级提示 */
  function setPanelNote(message: string): void {
    statusLine.textContent = message;
    statusLine.classList.remove('growth-status-error');
  }

  function setPanelError(message: string): void {
    statusLine.textContent = `操作失败：${message}`;
    statusLine.classList.add('growth-status-error');
    // 日志用英文（项目约定），界面文案才是中文
    console.warn('[growth-panel] action failed:', message);
  }
  /** 统一的"来自主进程的失败结果"提示：把错误码翻译成同一种面板口吻。 */
  function setApiFailure(what: string, detail: string): void {
    setPanelError(detail.trim() === '' ? `${what}失败（主进程没有给出原因）` : `${what}失败：${detail.trim()}`);
  }
  /** 短暂的"已保存/已记下"提示（与 settings.ts 的 flashSaved 同一个思路）。 */
  function flashNote(message: string): void {
    savedLabel.textContent = message;
    savedLabel.classList.add('growth-show');
    if (savedTimer !== null) window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => savedLabel.classList.remove('growth-show'), 1100);
    setPanelNote('就绪');
  }

  function flashSaved(): void {
    flashNote(flushing || queued !== null ? '保存中…' : '已保存');
  }
  /** 统一的异步动作包装：飞行中禁用按钮、失败写状态行、finally 一定复位。 */
  function withBusy(control: HTMLButtonElement, run: () => Promise<void>): void {
    if (control.disabled) return;
    control.disabled = true;
    void Promise.resolve()
      .then(run)
      .catch((error: unknown) => setPanelError(errorText(error)))
      .finally(() => {
        control.disabled = false;
      });
  }
  /* setSettings：单飞 + 补最后一帧 */

  let flushing = false;
  let queued: GrowthSettingsPatch | null = null;
  let flushError: string | null = null;
  let drainWaiters: Array<(error: string | null) => void> = [];
  /**
   * 提交一个补丁。⚠️ 这里**不做防抖**：开关拨动必须立刻生效，否则用户看到的是假状态。
   * 与 settings.ts 的 applyScale 一样用"单飞 + 补最后一帧"：同一时刻只允许一个 setSettings
   * 在飞，飞行期间的改动合并进队列，落地后立刻补发。
   */
  function queuePatch(patch: GrowthSettingsPatch): void {
    // 成长设置都是平铺的布尔/数字字段，浅合并即"后者优先"，不需要深合并
    queued = { ...queued, ...patch };
    if (flushing) return;
    flushPatch();
  }

  function flushPatch(): void {
    const patch = queued;
    queued = null;
    if (patch === null) return;
    flushing = true;
    flushError = null;
    void Promise.resolve()
      .then(() => withTimeout(api.setSettings(patch), REQUEST_TIMEOUT_MS, '保存'))
      .then((status) => {
        render(status);
        syncSettingsInputs(status);
        flashSaved();
      })
      .catch((error: unknown) => {
        flushError = errorText(error);
        setPanelError(flushError);
      })
      .finally(() => {
        flushing = false;
        if (queued !== null) {
          flushPatch(); // 期间又有改动：先补发，等队列真空了再放行等待者
          return;
        }
        const waiters = drainWaiters;
        drainWaiters = [];
        for (const waiter of waiters) waiter(flushError);
      });
  }
  /** 等待"当前这一批补丁"落地；返回失败原因（null = 全部成功）。 */
  function patchDrained(): Promise<string | null> {
    if (!flushing && queued === null) return Promise.resolve(flushError);
    return new Promise<string | null>((resolve) => {
      drainWaiters.push(resolve);
    });
  }
  /** 保存按钮的统一入口：校验 → 提交 → 用主进程清洗后的值回填输入框。 */
  function savePatch(control: HTMLButtonElement, build: () => GrowthSettingsPatch | null): void {
    withBusy(control, async () => {
      const patch = build();
      if (patch === null) return; // 校验失败：原因已经在状态行里了
      queuePatch(patch);
      const error = await patchDrained();
      if (error === null) syncSettingsInputs(latest);
    });
  }
  /**
   * 把主进程回传的值写回两个数字输入框与三个复选框。**刻意不从状态推送里调用**：用户可能正
   * 停在某个框里打字。`document.activeElement` 守卫是第二道保险 —— 杜绝任何"正在打字却被覆盖"
   * 的可能（推送与慢回执都可能晚到）。
   */
  function syncSettingsInputs(status: GrowthStatus): void {
    const { settings } = status;
    const editing = (control: HTMLElement): boolean => document.activeElement === control;
    const setValue = (control: HTMLInputElement, value: string): void => {
      if (!editing(control)) control.value = value;
    };
    const setChecked = (control: HTMLInputElement, value: boolean): void => {
      // 复选框也可能被托盘菜单或别处改掉：勾选态必须以主进程回传的值为准
      if (!editing(control)) control.checked = value;
    };
    setChecked(palaceSwitch, settings.palace);
    setChecked(reflectionSwitch, settings.reflection);
    setChecked(policySwitch, settings.policyAdapt);
    setValue(hourInput, String(settings.reflectionHour));
    setValue(keepInput, String(settings.keepReflectionDays));
  }
  /* 渲染：状态行 / 策略 / 统计 / 反思正文 */
  function renderStatusSection(status: GrowthStatus): void {
    const { palace, settings } = status;
    nodeCountReadout.value.textContent = `${palace.stats.total} 段`;
    /*
     * 天数口径与主进程对齐（`daysBetween(since, now)`）：拿 `firstMeetAt`（用户可改）优先、
     * 退化到第一个节点的日期 `since`，两者都没有就老老实实说"还不知道"，绝不猜一个好看的数字。
     * 与主进程的 `daysTogether` 不一致时把它一并显示出来，便于发现口径漂移。
     */
    const since = settings.firstMeetAt !== '' ? settings.firstMeetAt : palace.stats.since;
    const days = since === '' ? null : daysBetween(since, Date.now());
    daysReadout.value.textContent = days === null
      ? '还不知道（她还没记下第一次见面）'
      : `${days} 天${palace.stats.daysTogether === days ? '' : `（主进程记的是 ${palace.stats.daysTogether} 天）`}`;

    const today = status.todayReflection;
    todayReadout.value.textContent = today === null
      ? '还没写（到点会自动写）'
      : `已写 ${today.date}（${sourceLabel(today.source)} · ${today.tokens} token）`;
    todayReadout.value.className = today === null
      ? 'growth-readout-value growth-value-muted' : 'growth-readout-value growth-value-ok';

    policyReadout.value.textContent = status.policyEffect.trim() === ''
      ? describePolicyOverview(status) : status.policyEffect;

    // lastError 非空才标红：空串显示"无"，避免一整条红字吓人
    lastErrorReadout.value.textContent = status.lastError === '' ? '无' : status.lastError;
    lastErrorReadout.value.classList.toggle('growth-error-text', status.lastError !== '');
    dataDirReadout.value.textContent = status.dataDir === '' ? '（未知）' : status.dataDir;
  }
  /**
   * 状态行里"当前策略一句话"的兜底。
   *
   * 刻意**不调用** `describePolicy()`：它的入参是"用户设的感知参数"（`PerceptionSettings`），
   * 而 `GrowthStatus` 里没有这份数据 —— 硬凑一个只会伪造数字。所以优先用主进程算好的
   * `policyEffect`，为空时按同样的口径自己拼一句（至少说清"她有没有变克制"）。
   */
  function describePolicyOverview(status: GrowthStatus): string {
    const { policy } = status;
    if (policy.adjustments === 0) return '还没调整过（保持你的设置）';
    const parts: string[] = [];
    if (policy.minIntervalFactor < 1) parts.push(`开口间隔 ${intervalTimes(policy.minIntervalFactor)}`);
    if (policy.maxPerHourFactor < 1) parts.push(`每小时上限 ×${policy.maxPerHourFactor.toFixed(2)}`);
    const scenes = Object.entries(policy.sceneFactors).filter(([, factor]) => factor < 1);
    if (scenes.length > 0) {
      parts.push(...scenes.map(([scene, factor]) => `${sceneName(scene)} ${intervalTimes(factor)}`));
    }
    return parts.length === 0 ? '还没调整过（保持你的设置）' : `已调整 ${policy.adjustments} 次：${parts.join(' · ')}`;
  }

  function renderPolicy(status: GrowthStatus): void {
    const { policy } = status;
    policyTableBody.textContent = '';
    const rows: Array<readonly [string, string]> = [
      ['最小开口间隔', intervalTimes(policy.minIntervalFactor)],
      ['每小时上限', intervalTimes(policy.maxPerHourFactor)],
    ];
    // 场景倍率按"谁被压得最狠"排序：用户最先想看的是"她什么时候最安静"
    for (const [scene, factor] of Object.entries(policy.sceneFactors).sort((a, b) => a[1] - b[1])) {
      rows.push([`${sceneName(scene)}（${scene}）`, intervalTimes(factor)]);
    }
    for (const [label, value] of rows) policyTableBody.appendChild(tableRow([label, value]));

    if (policy.adjustments === 0) {
      policyMeta.textContent = '还没有调整过：上面全是 ×1，也就是完全按你设定的频率。';
      return;
    }
    const reason = policy.reason.trim() === '' ? '（没有记录原因）' : policy.reason;
    policyMeta.textContent = `累计调整 ${policy.adjustments} 次 · 最近一次 ${formatDate(policy.updatedAt)}：${reason}`;
  }

  function renderResponseStats(status: GrowthStatus): void {
    statsTableBody.textContent = '';
    statsTableBody.appendChild(tableRow(['场景', '打扰', '被回应', '回应率'], true));
    if (status.responseStats.length === 0) {
      const td = el('td');
      td.colSpan = 4;
      td.className = 'growth-empty';
      td.textContent = '还没有打扰记录 —— 她还没主动开口过，或者反馈数据还没积累起来。';
      const tr = el('tr');
      tr.appendChild(td);
      statsTableBody.appendChild(tr);
      return;
    }
    for (const item of status.responseStats) {
      const tr = tableRow([
        `${sceneName(item.scene)}（${item.scene}）`,
        `${item.total} 次`,
        `${item.responded} 次`,
        `${Math.round(item.rate * 100)}%`,
      ]);
      const rate = tr.lastElementChild;
      // 回应率低（她学到的"该闭嘴"信号）标红：这是策略会收紧的直接原因
      if (rate !== null) rate.classList.toggle('growth-error-text', item.total >= 3 && item.rate <= 1 / 3);
      statsTableBody.appendChild(tr);
    }
  }

  function renderReflection(status: GrowthStatus): void {
    const entry = status.todayReflection;
    insightList.textContent = '';
    if (entry === null) {
      reflectionMeta.textContent = '今天还没反思（到点会自动写，也可以现在就来一次）。';
      reflectionBody.textContent = '';
      reflectionStats.textContent = '';
      const empty = el('li', 'growth-empty'); empty.textContent = '还没有结论。';
      insightList.appendChild(empty);
      return;
    }
    reflectionMeta.textContent =
      `${entry.date} · ${sourceLabel(entry.source)} · ${entry.tokens} token · 写于 ${formatDate(entry.createdAt)}`;
    // 正文是模型产出：只进 textContent，绝不当 HTML 解析
    reflectionBody.textContent = entry.body.trim() === '' ? '（这次反思没有写下正文）' : entry.body;

    if (entry.insights.length === 0) {
      const empty = el('li', 'growth-empty'); empty.textContent = '这次没有得出任何结论（她宁可不动策略，也不瞎调）。';
      insightList.appendChild(empty);
    } else {
      for (const insight of entry.insights) {
        const item = el('li', 'growth-insight');
        const action = el('span', 'growth-insight-action');
        const scene = el('span', 'growth-insight-scene');
        const reason = el('span', 'growth-insight-reason'); action.textContent = ACTION_LABELS[insight.action];
        scene.textContent = insight.scene === '' ? '全局' : sceneName(insight.scene);
        reason.textContent = insight.reason;
        item.append(action, scene, reason);
        insightList.appendChild(item);
      }
    }

    const { stats } = entry;
    reflectionStats.textContent = `主动开口 ${stats.interventions} 次 · 被回应 ${stats.responded} 次`
      + ` · 对话 ${stats.turnCount} 轮 · 心情 ${stats.moodStart}→${stats.moodEnd}`;
  }

  function renderRecent(status: GrowthStatus): void {
    recentList.textContent = '';
    // 需求：最多 7 条（主进程已经截断，这里再兜一次，防止将来口径变了把面板撑爆）
    const items = status.recentReflections.slice(0, 7);
    if (items.length === 0) {
      const empty = el('li', 'growth-empty'); empty.textContent = '还没有反思记录。';
      recentList.appendChild(empty);
      return;
    }
    for (const entry of items) {
      const item = el('li', 'growth-recent-item');
      const date = el('span', 'growth-recent-date');
      const text = el('span', 'growth-recent-text'); date.textContent = entry.date;
      // 正文首行截断 60 字：只进 textContent（模型文本永不进 innerHTML）
      text.textContent = firstLine(entry.body);
      item.append(date, text);
      recentList.appendChild(item);
    }
  }
  /* 渲染：记忆宫殿时间轴 */
  /** 一张记忆卡片（emoji + 标题 + 日期 + 细节 + 依据 + 两个动作按钮）。 */
  function memoryCard(node: MemoryNode): HTMLElement {
    const card = el('article', 'growth-memory-card');
    card.setAttribute('role', 'listitem');
    if (node.pinned) card.classList.add('growth-memory-pinned');

    // emoji 单独一格并放大："一眼分辨类型"是时间轴存在的意义
    const emoji = el('span', 'growth-memory-emoji'); emoji.textContent = NODE_KINDS[node.kind]?.emoji ?? '📌';
    // emoji 只是装饰：读屏软件念 nodeLabel 里的文字标签就够了，别念"日历"
    emoji.setAttribute('aria-hidden', 'true');

    const head = el('div', 'growth-memory-head');
    const title = el('h4', 'growth-memory-title'); title.textContent = node.title;
    if (node.pinned) {
      const pin = el('span', 'growth-memory-pin'); pin.textContent = '📌';
      pin.title = '被钉住的记忆';
      pin.setAttribute('aria-label', '已钉住');
      title.appendChild(pin);
    }
    const meta = el('p', 'growth-memory-meta'); meta.textContent = `${formatDate(node.at)} · ${nodeLabel(node.kind)}`;
    if (node.hits > 1) {
      const hits = el('span', 'growth-memory-hits'); hits.textContent = `提过 ${node.hits} 次`;
      meta.appendChild(hits);
    }
    head.append(title, meta);

    // 细节是她自己的口吻（可能是模型产出）：只进 textContent
    const detail = el('p', 'growth-memory-detail'); detail.textContent = node.detail.trim() === '' ? '（没有写下细节）' : node.detail;

    const actions = el('div', 'growth-actions');
    actions.append(recallButton(node), pinButton(node), removeButton(node));

    card.append(emoji, head, detail);
    // 依据最多显示前 2 条：再多就不是"可核查"而是"流水账"了（依据来自对话原文，只进 textContent）
    const evidence = node.evidence.slice(0, 2);
    if (evidence.length > 0) {
      const list = el('ul', 'growth-evidence');
      for (const text of evidence) {
        const item = el('li', 'growth-evidence-item'); item.textContent = text;
        list.appendChild(item);
      }
      card.appendChild(list);
    }
    card.appendChild(actions);
    return card;
  }

  function recallButton(node: MemoryNode): HTMLButtonElement {
    const button = makeButton(`growth-recall-${node.id}`, '让她回忆一下', 'ghost');
    button.addEventListener('click', () => {
      withBusy(button, async () => {
        const result = await withTimeout(api.recallNode(node.id), REQUEST_TIMEOUT_MS, '回忆');
        // 契约是 `{ ok, text }`：失败时 text 里是给她的人话（"还没接上大模型"之类），
        // 而不是给排错看的错误码 —— 直接显示它比显示 `no-llm` 有用
        const text = result.text.trim();
        if (!result.ok || text === '') {
          setApiFailure('回忆', text);
          return;
        }
        setPanelNote(`她想起了「${node.title}」：${text}`);
      });
    });
    return button;
  }

  /**
   * 「钉住 / 取消钉住」。
   *
   * 为什么要有这个按钮：`pinNode` 早就存在，但面板上只显示 📌 而没有入口 ——
   * 想钉住某段经历只能手改 `nodes.json` 或自己调 IPC（文档评审抓到）。
   * 钉住的节点会排在时间轴最前面，也就是"这段对我很重要"。
   */
  function pinButton(node: MemoryNode): HTMLButtonElement {
    const button = makeButton(`growth-pin-${node.id}`, node.pinned ? '取消钉住' : '钉住', 'ghost');
    button.addEventListener('click', () => {
      withBusy(button, async () => {
        const status = await withTimeout(api.pinNode(node.id, !node.pinned), REQUEST_TIMEOUT_MS, '钉住');
        render(status);
        flashNote(node.pinned ? '已取消钉住' : '已钉住（会排在时间轴最前面）');
      });
    });
    return button;
  }

  function removeButton(node: MemoryNode): HTMLButtonElement {
    const button = makeButton(`growth-remove-${node.id}`, '删除', 'ghost');
    button.addEventListener('click', () => {
      // 删掉一段经历不可撤销，必须二次确认（window.confirm 不是 eval，CSP 下可用）
      if (!window.confirm(`确定要删掉「${node.title}」这段记忆吗？删掉以后她就再也不会提起它了，且无法恢复。`)) return;
      withBusy(button, async () => {
        const status = await withTimeout(api.removeNode(node.id), REQUEST_TIMEOUT_MS, '删除');
        render(status);
        syncSettingsInputs(status);
        flashNote('已删掉这段记忆');
      });
    });
    return button;
  }

  function nodeGroup(month: string, nodes: readonly MemoryNode[]): HTMLElement {
    const group = el('div', 'growth-timeline-group');
    const heading = el('h3', 'growth-timeline-month'); heading.textContent = `${monthTitle(month)} · ${nodes.length} 段`;
    const list = el('div', 'growth-timeline-nodes');
    // 顺序完全照搬主进程给的 `palace.nodes`（已经倒序 + 钉住的在前），这里不再排序
    for (const node of nodes) list.appendChild(memoryCard(node));
    group.append(heading, list);
    return group;
  }

  function renderTimeline(status: GrowthStatus): void {
    const { palace } = status;
    const since = status.settings.firstMeetAt !== '' ? status.settings.firstMeetAt : palace.stats.since;
    const days = since === '' ? palace.stats.daysTogether : daysBetween(since, Date.now());
    palaceSummary.textContent = `我们第一次见面 ${since === '' ? '—' : formatDate(since)}`
      + ` · 已经一起走过 ${days} 天 · 记下 ${palace.stats.total} 段经历`;

    // 重建会把滚动位置清零，渲染前后手动接一下 scrollTop：
    // 否则每次刷新都会把正在翻时间轴的用户弹回顶部
    const top = timeline.scrollTop;
    timeline.textContent = '';
    if (palace.nodes.length === 0) {
      const empty = el('p', 'growth-empty growth-timeline-empty'); empty.textContent = '她还什么都没记下 —— 多陪陪她，或者自己记一笔。';
      timeline.appendChild(empty);
    } else {
      const buckets = new Map<string, MemoryNode[]>();
      for (const node of palace.nodes) {
        const key = monthKey(node.at);
        const bucket = buckets.get(key);
        if (bucket === undefined) buckets.set(key, [node]);
        else bucket.push(node);
      }
      // Map 保持插入顺序，而 nodes 已经倒序 -> 分组天然是"新的月份在前"
      for (const [month, nodes] of buckets) timeline.appendChild(nodeGroup(month, nodes));
    }
    timeline.scrollTop = top;
  }
  /* 渲染入口与节流 */
  function render(status: GrowthStatus): void {
    latest = status;
    renderStatusSection(status);
    renderTimeline(status);
    renderReflection(status);
    renderPolicy(status);
    renderResponseStats(status);
    renderRecent(status);
  }
  /**
   * 只读刷新（含时间轴）的节流入口。`force` 的两个来源：`renderKey` 变化（节点增删、反思
   * 落盘、策略被调过），以及用户自己的动作（删/记一笔/立刻反思）—— 必须立刻看到结果。
   */
  function refresh(status: GrowthStatus, force: boolean): void {
    const key = renderKey(status);
    if (key !== lastKey) {
      lastKey = key;
      force = true;
    }
    const now = Date.now();
    if (!force && now - lastRender < RENDER_THROTTLE_MS) return;
    // 焦点在时间轴里（键盘用户正停在某个按钮上）时不重建，别把焦点弹丢；
    // 等下一次推送（或用户自己的动作）再补上。
    if (!force && timeline.contains(document.activeElement)) return;
    lastRender = now;
    render(status);
  }
  /* 补丁构造 */
  function buildReflectionPatch(): GrowthSettingsPatch | null {
    const hour = numberValue(hourInput);
    const keep = numberValue(keepInput);
    if (hour === null || keep === null) {
      setPanelError('「反思时刻」和「保留天数」都必须填数字（时刻取值 0~23）。');
      return null;
    }
    return { reflectionHour: clampInt(hour, 0, 23), keepReflectionDays: clampInt(keep, 0, 3650) };
  }
  /* 事件 */
  /**
   * 立即生效的复选框。
   *
   * 这里用"控件 + 补丁构造函数"的成对表，而不是 `{ [field]: checked }` 计算属性：计算属性在
   * 严格模式下会被推断成索引签名，反而丢掉 GrowthSettingsPatch 的类型约束。
   */
  const immediate: ReadonlyArray<{ control: HTMLInputElement; apply: (checked: boolean) => GrowthSettingsPatch }> = [
    { control: palaceSwitch, apply: (checked) => ({ palace: checked }) },
    { control: reflectionSwitch, apply: (checked) => ({ reflection: checked }) },
    { control: policySwitch, apply: (checked) => ({ policyAdapt: checked }) },
  ];
  for (const { control, apply } of immediate) {
    control.addEventListener('change', () => {
      // 开关是"立即生效"的：不经过保存按钮，失败时由 flushPatch 的错误处理兜底
      queuePatch(apply(control.checked));
      setPanelNote('正在应用…');
    });
  }

  settingsSave.addEventListener('click', () => savePatch(settingsSave, buildReflectionPatch));

  nodeAddButton.addEventListener('click', () => {
    const rawKind = kindSelect.value;
    const kind = (rawKind in NODE_KINDS ? rawKind : 'manual') as MemoryNodeKind;
    const title = nodeTitleInput.value.trim();
    const detail = nodeDetailInput.value.trim();
    if (title === '') {
      setPanelError('先给这一段经历写个标题（她记不住没名字的事）。');
      return;
    }
    withBusy(nodeAddButton, async () => {
      const status = await withTimeout(api.addNode({ kind, title, detail }), REQUEST_TIMEOUT_MS, '记一笔');
      render(status);
      syncSettingsInputs(status);
      // 只有成功才清空：失败时用户的输入必须留着，不然等于白打一遍
      if (document.activeElement !== nodeTitleInput) nodeTitleInput.value = '';
      if (document.activeElement !== nodeDetailInput) nodeDetailInput.value = '';
      flashNote('已记下这一段');
    });
  });

  reflectNowButton.addEventListener('click', () => {
    withBusy(reflectNowButton, async () => {
      const status = await withTimeout(api.reflectNow(), REQUEST_TIMEOUT_MS, '反思');
      render(status);
      syncSettingsInputs(status);
      const entry = status.todayReflection;
      flashNote(entry === null ? '反思完成（主进程没有返回正文）' : `反思完成（${sourceLabel(entry.source)}）`);
    });
  });

  openLogButton.addEventListener('click', () => {
    withBusy(openLogButton, async () => {
      // 契约里只有 `openPolicyLog()`：它打开的是反思与策略调整的审计日志
      // （每次调整都要能被追溯，这是 4.2 "可回退"的前提）
      if (!(await api.openPolicyLog())) {
        setPanelError('打开反思/策略日志失败');
        return;
      }
      setPanelNote('已打开反思/策略日志');
    });
  });

  palaceOpenButton.addEventListener('click', () => {
    withBusy(palaceOpenButton, async () => {
      /*
       * ⚠️ `palace.md` 是 `nodes.json` 的**只读镜像**：想删某段经历必须在时间轴上点删除，
       * 直接编辑 md 不会改变她记住的内容（这条说明早期写反了，文档评审抓到）。
       */
      if (!(await api.openPalace())) {
        setPanelError('打开记忆宫殿文件失败');
        return;
      }
      setPanelNote('已打开记忆宫殿文件（只读镜像；要改内容请在上面的时间轴上操作）');
    });
  });

  policyReset.addEventListener('click', () => {
    // 重置策略会让打扰频率回到用户设定，等于撤销她学到的东西，必须二次确认
    if (!window.confirm('确定要重置行为策略吗？她学到的"什么时候少说话"会被清空，打扰频率回到你设定的值。')) return;
    withBusy(policyReset, async () => {
      const status = await withTimeout(api.resetPolicy(), REQUEST_TIMEOUT_MS, '重置策略');
      render(status);
      syncSettingsInputs(status);
      flashNote('策略已重置');
    });
  });
  /* 初始化与订阅 */

  syncSettingsInputs(initial);
  lastKey = renderKey(initial);
  lastRender = Date.now();
  render(initial);
  /**
   * 状态订阅。
   *
   * 只刷新**只读部分**（状态行、时间轴、反思正文、策略、统计、最近反思）。所有输入框都不在
   * 这里回填：用户可能正停在某个框里打字。`refresh` 内部做节流：`renderKey`（节点总数 /
   * 今天的反思日期 / 策略调整次数）变化说明真的发生了新事情 → 立刻刷；否则最多 3 秒一次兜底。
   */
  api.onStatus((status) => {
    refresh(status, false);
  });

  // bootstrap 快照是窗口打开那一刻读的，顺手校准一次（读不到就沿用手里的 initial）
  void api.status()
    .then((status) => {
      refresh(status, true);
      syncSettingsInputs(status);
    })
    .catch((error: unknown) => {
      console.warn('[growth-panel] initial status refresh failed:', errorText(error));
    });
}
