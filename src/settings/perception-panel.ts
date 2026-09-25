/**
 * 「环境与用户感知」设置面板（3.1 屏幕 / 3.2 内容理解 / 3.4 行为 / 3.5 摄像头 / 3.6 习惯）。
 *
 * 与 `ai-panel.ts` 同构：面板是**自包含的挂载函数**，拿到容器 + 桥 + 初始快照就自带
 * 事件与刷新逻辑，设置页面只需要一行接线。这样感知的几十个控件不会淹没"调尺寸"。
 *
 * 四条硬性约束：
 * 1. **全部 DOM 用 createElement + textContent 组装**。观察文本、屏幕摘要、报错信息
 *    都可能是模型产出，任何 innerHTML 都是一条 XSS 通路（CSP 里也没有 'unsafe-eval'）。
 * 2. **图像永不出现在界面里**。这里只展示文本观察记录；截图与摄像头帧只在主进程内存里
 *    存在一次调用（隐私底线见 shared/perception-types.ts 的文件头注释）。
 * 3. **隐私相关的两个控件由 status 驱动**。`privacyMode` 与 `cameraAuthorized` 都可能
 *    被托盘菜单或主进程改掉，本地点击状态不足以作为显示依据 —— 每次推送都要以主进程
 *    回传的值为准（否则会出现"界面说没在采集、实际在采集"这种最不该有的谎报）。
 * 4. **任何 api 调用都不许把面板弄崩**。全部 .catch()，失败原因写进状态行，
 *    按钮在 finally 里复位；任何时刻都不会留下一个转不停的按钮。
 */

import type {
  PerceptionLogItem,
  PerceptionSettingsPatch,
  PerceptionStatus,
  PerceptionViewMode,
  PerceptionViewResult,
  UserState,
} from '../shared/perception-types';
import { isQuietHour, sceneLabel } from '../shared/perception';
import type { PerceptionAPI } from '../shared/ipc';

/* 通用小工具（纯 DOM，不碰业务状态） */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function makeInput(kind: 'text' | 'number', id: string, label: string): HTMLInputElement {
  const node = el('input', 'perception-input');
  node.type = kind;
  node.id = id;
  // aria-label 与 <label for> 双保险：本面板控件全部由脚本动态创建，
  // 只靠 for 关联时个别读屏软件会漏读用途。
  node.setAttribute('aria-label', label);
  return node;
}

function makeCheckbox(id: string, label: string): HTMLInputElement {
  const node = el('input', 'perception-check-input');
  node.type = 'checkbox';
  node.id = id;
  node.setAttribute('aria-label', label);
  return node;
}

function makeButton(id: string, label: string, variant: 'primary' | 'ghost'): HTMLButtonElement {
  // 类名故意不叫 primary/ghost：settings.css 里有同名全局按钮样式，撞上会互相污染
  const node = el('button', variant === 'primary' ? 'perception-btn-primary' : 'perception-btn-ghost');
  node.type = 'button';
  node.id = id;
  node.textContent = label;
  node.setAttribute('aria-label', label);
  return node;
}

/** 一行"标签 + 控件"（可选小字说明，说明横跨两列）。 */
function fieldRow(id: string, labelText: string, control: HTMLElement, hint?: string): HTMLDivElement {
  const row = el('div', 'perception-field');
  const label = el('label', 'perception-field-label');
  label.htmlFor = id;
  label.textContent = labelText;
  row.append(label, control);
  if (hint === undefined) return row;
  const note = el('p', 'perception-hint');
  note.textContent = hint;
  row.appendChild(note);
  return row;
}

/** 复选框行：整行可点（框在左、文字在右）。 */
function checkRow(labelText: string, control: HTMLInputElement): HTMLLabelElement {
  const row = el('label', 'perception-check');
  const span = el('span');
  span.textContent = labelText;
  row.append(control, span);
  return row;
}

/** 开关项：复选框 + 一行"关掉会失去什么"的小字说明（每项独占一个容器，便于整块替换）。 */
function switchItem(labelText: string, control: HTMLInputElement, hint: string): HTMLDivElement {
  const item = el('div', 'perception-switch-item');
  const note = el('p', 'perception-hint perception-switch-hint');
  note.textContent = hint;
  item.append(checkRow(labelText, control), note);
  return item;
}

function makeSection(title: string, extraClass?: string): HTMLElement {
  const node = el('section', extraClass === undefined ? 'perception-section' : `perception-section ${extraClass}`);
  const heading = el('h2');
  heading.textContent = title;
  node.appendChild(heading);
  return node;
}

/** 只读读数行：返回行元素与值元素（值元素后续会被反复覆写）。 */
function makeReadout(labelText: string): { row: HTMLDivElement; value: HTMLSpanElement } {
  const row = el('div', 'perception-readout');
  const label = el('span', 'perception-readout-label');
  label.textContent = labelText;
  const value = el('span', 'perception-readout-value');
  value.textContent = '—';
  row.append(label, value);
  return { row, value };
}

function actionRow(...controls: HTMLElement[]): HTMLDivElement {
  const row = el('div', 'perception-actions');
  row.append(...controls);
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

/** 时间戳 -> HH:MM（日志行足够短才好一屏看完）。 */
function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 一行 "start:00 – end:00"；没学到就用文字占位，绝不显示 null。 */
function hourRange(start: number | null, end: number | null): string {
  return start === null || end === null ? '还没有数据' : `${start}:00 – ${end}:00`;
}

/** 用户状态的中文映射（需求 3.4 的五个档位）。 */
const USER_STATE_LABELS: Readonly<Record<UserState, string>> = {
  deep: '专注', shallow: '频繁切换', idle: '走神', away: '不在', unknown: '未知',
};

/** 感知日志分类的中文映射。 */
const LOG_KIND_LABELS: Readonly<Record<PerceptionLogItem['kind'], string>> = {
  observation: '观察', intervention: '开口', presence: '在场', privacy: '隐私',
  habits: '习惯', camera: '摄像头', system: '系统',
};

/** 在场来源的中文映射（摄像头优先，退化到空闲时间推断）。 */
const PRESENCE_SOURCE_LABELS: Readonly<Record<PerceptionStatus['presence']['source'], string>> = {
  camera: '摄像头', idle: '空闲推断', unknown: '未知',
};

/** 3.2 五个按需动作：按钮文案 + api 模式 + 悬停提示。 */
const VIEW_MODES: ReadonlyArray<{ mode: PerceptionViewMode; label: string; hint: string }> = [
  { mode: 'scene', label: '现在在做什么', hint: '只做场景分类，最省 token。' },
  { mode: 'ocr', label: '读屏幕文字', hint: '把屏幕上的文字读出来。' },
  { mode: 'summarize', label: '总结屏幕内容', hint: '一句话概括当前屏幕。' },
  { mode: 'error', label: '看报错', hint: '只盯着报错信息看。' },
  { mode: 'code', label: '看代码', hint: '读当前编辑器里的代码。' },
];

/** 列表刷新节流窗口：状态推送很密（每次采样后都推），日志不能每次推送都重拉。 */
const LIST_REFRESH_MS = 3000;
/** 日志拉取条数。 */
const LOG_LIMIT = 40;

/** 开关/暂停原因/最近观察时间/开口计数变化 = 真的发生了新事情 → 日志立刻刷。 */
function activityKey(status: PerceptionStatus): string {
  return `${status.capturing}:${status.pausedReason}:${status.lastObservation?.at ?? ''}:${status.interventionsToday}`;
}

/* 面板 */

/** 把「环境与用户感知」面板挂到给定容器里。 */
export function mountPerceptionPanel(root: HTMLElement, api: PerceptionAPI, initial: PerceptionStatus): void {
  const panel = el('div', 'perception-panel');
  root.appendChild(panel);

  /** 最近一次已知状态：保存成功后回填输入框、摄像头按钮判断当前授权都用它。 */
  let latest: PerceptionStatus = initial;
  /** 日志刷新节流时间戳。 */
  let lastListRefresh = 0;
  let activity = activityKey(initial);
  /** "已保存"提示的淡出计时器句柄。 */
  let savedTimer: number | null = null;

  /* 一、状态行 */

  const statusSection = makeSection('感知状态');
  const captureReadout = makeReadout('采集');
  const observationReadout = makeReadout('最近观察');
  const behaviorReadout = makeReadout('行为');
  const userStateReadout = makeReadout('用户状态');
  const presenceReadout = makeReadout('在场');
  const interventionsReadout = makeReadout('今日开口');
  const quietReadout = makeReadout('免打扰');
  const lastErrorReadout = makeReadout('最近错误');
  const dataDirReadout = makeReadout('数据目录');
  for (const readout of [captureReadout, observationReadout, behaviorReadout, userStateReadout,
    presenceReadout, interventionsReadout, quietReadout, lastErrorReadout, dataDirReadout]) {
    statusSection.appendChild(readout.row);
  }
  dataDirReadout.value.classList.add('perception-small');

  const statusLine = el('p', 'perception-status-line');
  statusLine.id = 'perception-panel-status';
  statusLine.textContent = '就绪';
  // role=status：失败信息与"已保存"都会写在这里，读屏软件应当主动播报
  statusLine.setAttribute('role', 'status');
  const savedLabel = el('span', 'perception-saved');
  savedLabel.id = 'perception-saved';
  savedLabel.textContent = '已保存';
  statusSection.append(statusLine, savedLabel);

  /* 二、五个开关（3.1 / 3.2 / 3.4 / 3.5 / 3.6） */

  const switchesSection = makeSection('感知开关');
  const screenInput = makeCheckbox('perception-screen', '屏幕感知');
  const visionInput = makeCheckbox('perception-vision', '内容理解');
  const behaviorInput = makeCheckbox('perception-behavior', '行为观察');
  const cameraInput = makeCheckbox('perception-camera', '摄像头感知');
  const habitsInput = makeCheckbox('perception-habits', '习惯学习');
  switchesSection.append(
    // 每个开关下面都写清"关掉会失去什么"：感知是隐私敏感功能，
    // 用户应当能在不看文档的情况下判断代价。
    switchItem('屏幕感知（3.1）', screenInput, '关掉后她完全不知道你在做什么：没有场景分类，也不会再主动开口。'),
    switchItem('内容理解 / OCR（3.2）', visionInput, '关掉后只能看场景分类，不能读屏幕文字，也不再总结或分析报错。'),
    switchItem('行为观察（3.4）', behaviorInput, '关掉后不再统计空闲、连续使用时长与切换频率，久坐和深夜提醒都会失效。'),
    switchItem('摄像头感知（3.5）', cameraInput, '关掉后不再判断你在不在电脑前，也不看表情；需另外授权才会真的打开摄像头。'),
    switchItem('习惯学习（3.6）', habitsInput, '关掉后不再按小时积累习惯画像，也没有"按你的习惯…"这类时间对比提醒。'),
  );

  /* 三、隐私（重点） */

  const privacySection = makeSection('隐私', 'perception-privacy');
  const privacyInput = makeCheckbox('perception-privacy-mode', '隐私模式');
  const privacyRow = el('div', 'perception-privacy-row');
  privacyRow.append(checkRow('隐私模式：立即停止一切采集（不改其它开关的值，退出后恢复原状）', privacyInput));
  const privacyState = el('p', 'perception-privacy-state');
  privacyState.id = 'perception-privacy-state';
  privacyState.setAttribute('role', 'status');
  privacyState.textContent = '—';
  privacySection.append(privacyRow, privacyState);

  const hideInput = makeCheckbox('perception-hide-from-capture', '让桌宠不出现在截屏/录屏里');
  privacySection.append(checkRow('让桌宠不出现在截屏/录屏里（她不会出现在自己的感知画面里）', hideInput));

  const keywordsInput = el('textarea', 'perception-textarea');
  keywordsInput.id = 'perception-sensitivity-keywords';
  keywordsInput.rows = 4;
  keywordsInput.setAttribute('aria-label', '敏感关键词');
  const keywordsRow = fieldRow('perception-sensitivity-keywords', '敏感关键词', keywordsInput,
    '一行一个关键词。命中「应用名 / 在做什么 / 屏幕摘要」就按私人内容处理（她会捂眼睛躲开）；这是模型之外的第二道确定性闸门。');
  // 多行关键词要能整段复制/粘贴：整行摆放，不塞进两列网格
  keywordsRow.classList.add('perception-field-block');
  privacySection.appendChild(keywordsRow);

  const keywordsSave = makeButton('perception-keywords-save', '保存关键词', 'primary');
  const openLogButton = makeButton('perception-open-log', '打开感知日志', 'ghost');
  const clearDataButton = makeButton('perception-clear-data', '清空感知数据', 'ghost');
  privacySection.appendChild(actionRow(keywordsSave, openLogButton, clearDataButton));

  /*
   * 场景纠正规则（`关键词=场景`）。
   *
   * 由来：用户实测反馈"浏览网页总是被识别成笔记软件记笔记"。
   * 代码里已经按应用名做了一轮确定性纠正（浏览器里的 writing 会被拉回 browsing），
   * 但总会有模型认不出的应用 —— 这里给用户一个"我说了算"的口子：
   * 命中关键词就强制用你指定的场景，优先级高于一切自动判断。
   */
  const fixesInput = el('textarea', 'perception-textarea');
  fixesInput.id = 'perception-scene-fixes';
  fixesInput.rows = 4;
  fixesInput.setAttribute('aria-label', '场景纠正规则');
  const fixesRow = fieldRow('perception-scene-fixes', '场景纠正规则', fixesInput,
    '一行一条：关键词=场景（例如 Chrome=browsing）。命中应用名就强制用你指定的场景，优先级最高；' +
      '可用场景名：coding / reading / video / gaming / meeting / browsing / chatting / writing / terminal / idle / sensitive / other。');
  fixesRow.classList.add('perception-field-block');
  privacySection.appendChild(fixesRow);

  const fixesSave = makeButton('perception-scene-fixes-save', '保存纠正规则', 'primary');
  privacySection.appendChild(actionRow(fixesSave));

  /* 四、采样与频率（控制打扰） */

  const samplingSection = makeSection('采样与频率');
  const intervalInput = makeInput('number', 'perception-capture-interval-ms', '屏幕采样间隔（毫秒）');
  intervalInput.min = '5000';
  intervalInput.step = '1000';
  samplingSection.appendChild(fieldRow('perception-capture-interval-ms', '屏幕采样间隔（毫秒）', intervalInput,
    '默认 30000，越小越费 token。'));

  const widthInput = makeInput('number', 'perception-capture-width', '截图宽度');
  widthInput.min = '160';
  widthInput.max = '1920';
  widthInput.step = '10';
  samplingSection.appendChild(fieldRow('perception-capture-width', '截图宽度（像素）', widthInput,
    '高按屏幕比例缩放；越小越省 token，但字太小会读不出来。'));

  /*
   * 网址线索：单独截一条**放大的地址栏横条**给模型读网址。
   *
   * 为什么值得单独做：整屏缩到 640 宽时地址栏只有几像素，模型读不出来；
   * 而网址是"网页里到底在干什么"最可靠的依据（比像素、窗口标题都准）。
   * 横条只在当次请求里用一次，不落盘；默认只把**域名**写进观察记录。
   */
  const captureUrlInput = makeCheckbox('perception-capture-url', '读取网页地址（地址栏）');
  samplingSection.appendChild(checkRow(
    '读取网页地址（额外截一条放大的地址栏横条给模型，"在浏览什么网站"判得更准）',
    captureUrlInput,
  ));
  const urlWidthInput = makeInput('number', 'perception-url-capture-width', '地址栏截取宽度');
  urlWidthInput.min = '640';
  urlWidthInput.max = '3840';
  urlWidthInput.step = '160';
  samplingSection.appendChild(fieldRow('perception-url-capture-width', '地址栏截取宽度（像素）', urlWidthInput,
    '默认 1280。地址栏看不清就调大；这张小图不落盘，只在当次请求里用一次。'));
  const storeFullUrlInput = makeCheckbox('perception-store-full-url', '记录完整网址');
  samplingSection.appendChild(checkRow(
    '记录完整网址（含路径与查询串）—— 默认关闭，只留域名，避免把搜索词等私人信息写进观察记录',
    storeFullUrlInput,
  ));

  const cameraIntervalInput = makeInput('number', 'perception-camera-interval-ms', '摄像头采样间隔（毫秒）');
  cameraIntervalInput.min = '10000';
  cameraIntervalInput.step = '1000';
  samplingSection.appendChild(fieldRow('perception-camera-interval-ms', '摄像头采样间隔（毫秒）', cameraIntervalInput,
    '比屏幕采样更稀更省电；仅在摄像头已授权时生效。'));

  const proactiveMinInput = makeInput('number', 'perception-proactive-min-interval-ms', '最小打扰间隔（毫秒）');
  proactiveMinInput.min = '60000';
  proactiveMinInput.step = '10000';
  samplingSection.appendChild(fieldRow('perception-proactive-min-interval-ms', '最小打扰间隔（毫秒）', proactiveMinInput,
    '两次主动开口的最小间隔。'));

  const proactiveMaxInput = makeInput('number', 'perception-proactive-max-per-hour', '每小时上限');
  proactiveMaxInput.min = '0';
  proactiveMaxInput.max = '60';
  proactiveMaxInput.step = '1';
  samplingSection.appendChild(fieldRow('perception-proactive-max-per-hour', '每小时最多开口（次）', proactiveMaxInput,
    '超过这个次数她就闭嘴；0 = 完全不主动开口。'));

  const longSessionInput = makeInput('number', 'perception-long-session-minutes', '连续使用提醒（分钟）');
  longSessionInput.min = '10';
  longSessionInput.max = '1440';
  longSessionInput.step = '5';
  samplingSection.appendChild(fieldRow('perception-long-session-minutes', '连续使用提醒（分钟）', longSessionInput,
    '连续坐满这么久就提醒你起来活动一下。'));

  const lateNightInput = makeInput('number', 'perception-late-night-hour', '深夜提醒起点');
  lateNightInput.min = '0';
  lateNightInput.max = '6';
  lateNightInput.step = '1';
  samplingSection.appendChild(fieldRow('perception-late-night-hour', '深夜提醒起点（0~6 点）', lateNightInput,
    '默认 1 点；判定区间是「起点 ~ 凌晨 5 点」。'));

  const quietStartInput = makeInput('number', 'perception-quiet-start', '免打扰开始小时');
  quietStartInput.min = '0';
  quietStartInput.max = '23';
  quietStartInput.step = '1';
  const quietEndInput = makeInput('number', 'perception-quiet-end', '免打扰结束小时');
  quietEndInput.min = '0';
  quietEndInput.max = '23';
  quietEndInput.step = '1';
  const quietPair = el('div', 'perception-pair');
  // 中间放一个箭头 span 而不是用 CSS ::before：<input> 是替换元素，伪元素不会渲染
  const quietArrow = el('span', 'perception-pair-arrow');
  quietArrow.textContent = '→';
  quietPair.append(quietStartInput, quietArrow, quietEndInput);
  samplingSection.appendChild(fieldRow('perception-quiet-start', '免打扰时段（0~23）', quietPair,
    '这个时段内她绝不主动出声；跨零点写「23 → 8」即可（开始 > 结束表示跨天）。'));

  const samplingSave = makeButton('perception-sampling-save', '保存采样与频率', 'primary');
  samplingSection.appendChild(actionRow(samplingSave));

  /* 五、3.5 摄像头授权 */

  const cameraSection = makeSection('摄像头授权（3.5）');
  const cameraStateReadout = makeReadout('授权状态');
  const cameraReadyReadout = makeReadout('设备就绪');
  cameraSection.append(cameraStateReadout.row, cameraReadyReadout.row);
  const cameraNotice = el('p', 'perception-hint');
  cameraNotice.id = 'perception-camera-notice';
  const cameraButton = makeButton('perception-camera-authorize', '授权并使用摄像头', 'primary');
  const cameraHint = el('p', 'perception-hint');
  cameraHint.textContent = '摄像头画面只在内存里分析一次，永不写盘；未授权时不会打开摄像头，也不会发出任何取帧请求。';
  cameraSection.append(cameraNotice, actionRow(cameraButton), cameraHint);

  /* 六、3.6 习惯画像 */

  const habitsSection = makeSection('习惯画像（3.6）');
  const habitsReadout = makeReadout('学到了');
  const habitsTypicalReadout = makeReadout('这个点通常');
  habitsSection.append(habitsReadout.row, habitsTypicalReadout.row);
  const habitsHint = el('p', 'perception-hint');
  habitsHint.textContent = '习惯统计只存文本观察记录，不含任何截图；数据不够时她不会装懂（宁可不提）。';
  habitsSection.appendChild(habitsHint);

  /* 七、3.2 按需看屏幕 */

  const viewSection = makeSection('按需看屏幕（3.2）');
  const viewButtons = VIEW_MODES.map((entry) => {
    const button = makeButton(`perception-view-${entry.mode}`, entry.label, 'ghost');
    button.title = entry.hint;
    return button;
  });
  viewSection.appendChild(actionRow(...viewButtons));
  const viewResult = el('pre', 'perception-view-result');
  viewResult.id = 'perception-view-result';
  viewResult.textContent = '点上面的按钮，她才会看一眼屏幕（不需要周期采样）。';
  viewSection.appendChild(viewResult);

  /* 八、感知日志 */

  const logSection = makeSection('感知日志');
  const logList = el('ul', 'perception-list');
  logList.id = 'perception-log-list';
  logList.setAttribute('role', 'list');
  const logRefresh = makeButton('perception-log-refresh', '刷新日志', 'ghost');
  logSection.append(logList, actionRow(logRefresh));

  panel.append(statusSection, switchesSection, privacySection, samplingSection,
    cameraSection, habitsSection, viewSection, logSection);

  /* 面板级提示 */

  function setPanelNote(message: string): void {
    statusLine.textContent = message;
    statusLine.classList.remove('perception-status-error');
  }

  function setPanelError(message: string): void {
    statusLine.textContent = `操作失败：${message}`;
    statusLine.classList.add('perception-status-error');
    // 日志用英文（项目约定），界面文案才是中文
    console.warn('[perception-panel] action failed:', message);
  }

  /** 短暂的"已保存"提示（与 settings.ts 的 flashSaved 同一个思路）。 */
  function flashNote(message: string): void {
    savedLabel.textContent = message;
    savedLabel.classList.add('perception-show');
    if (savedTimer !== null) window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => savedLabel.classList.remove('perception-show'), 1100);
    setPanelNote('就绪');
  }

  function flashSaved(): void {
    flashNote(flushing || queued !== null ? '保存中…' : '已保存');
  }

  /** 统一的异步动作包装：飞行中禁用按钮、失败写状态行、finally 一定复位。 */
  function withBusy(control: HTMLButtonElement, run: () => Promise<void>): void {
    if (control.disabled) return;
    control.disabled = true;
    void Promise.resolve().then(run)
      .catch((error: unknown) => setPanelError(errorText(error)))
      .finally(() => { control.disabled = false; });
  }

  /* setSettings：单飞 + 补最后一帧 */

  let flushing = false;
  let queued: PerceptionSettingsPatch | null = null;
  let flushError: string | null = null;
  let drainWaiters: Array<(error: string | null) => void> = [];

  /** 合并补丁：顶层后者优先，quietHours 做浅合并（两个字段互不重叠）。 */
  function mergePatch(base: PerceptionSettingsPatch | null, next: PerceptionSettingsPatch): PerceptionSettingsPatch {
    if (base === null) return next;
    const quietHours = { ...base.quietHours, ...next.quietHours };
    return { ...base, ...next, ...(Object.keys(quietHours).length > 0 ? { quietHours } : {}) };
  }

  /**
   * 提交一个补丁。
   *
   * ⚠️ 这里**不做防抖**：开关拨动必须立刻生效，否则用户看到的是假状态
   * （"界面说关了、实际还在截图"是感知模块最不能出现的 bug）。
   * 与 settings.ts 的 applyScale 一样用"单飞 + 补最后一帧"：同一时刻只允许
   * 一个 setSettings 在飞，飞行期间的改动合并进队列，落地后立刻补发。
   */
  function queuePatch(patch: PerceptionSettingsPatch): void {
    queued = mergePatch(queued, patch);
    if (!flushing) flushPatch();
  }

  function flushPatch(): void {
    const patch = queued;
    queued = null;
    if (patch === null) return;
    flushing = true;
    flushError = null;
    void Promise.resolve().then(() => api.setSettings(patch))
      .then((status) => {
        renderStatus(status);
        // 开关/隐私模式是"立即生效"的：以主进程回传的值刷新这两个关键控件
        syncInputs(status, 'privacy');
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
    return new Promise<string | null>((resolve) => { drainWaiters.push(resolve); });
  }

  /** 保存按钮的统一入口：校验 → 提交 → 用主进程清洗后的值回填本区块输入框。 */
  function savePatch(control: HTMLButtonElement, scope: SyncScope, build: () => PerceptionSettingsPatch | null): void {
    withBusy(control, async () => {
      const patch = build();
      if (patch === null) return; // 校验失败：原因已经在状态行里了
      queuePatch(patch);
      const error = await patchDrained();
      if (error === null) syncInputs(latest, scope);
    });
  }

  /* 渲染（只读部分） */

  function renderStatus(status: PerceptionStatus): void {
    latest = status;
    const { settings, behavior, presence } = status;

    captureReadout.value.textContent = status.capturing ? '正在采集' : `已暂停：${status.pausedReason}`;
    captureReadout.value.className = status.capturing
      ? 'perception-readout-value perception-value-ok' : 'perception-readout-value perception-value-muted';

    // 最近观察：场景用受控词表翻译，敏感内容整行标红（用户最需要一眼看到的就是这个）
    const observation = status.lastObservation;
    if (observation === null) {
      observationReadout.value.textContent = '还没有观察记录';
      observationReadout.value.className = 'perception-readout-value perception-value-muted';
    } else {
      const parts = [formatClock(observation.at), sceneLabel(observation.scene), observation.app, observation.activity]
        .filter((part) => part.trim() !== '');
      const text = parts.join(' · ');
      observationReadout.value.textContent = observation.sensitive ? `${text}（私人内容）` : text;
      observationReadout.value.className = observation.sensitive
        ? 'perception-readout-value perception-error-text' : 'perception-readout-value';
    }

    behaviorReadout.value.textContent = `空闲 ${behavior.idleSeconds} 秒 · 本次连续 ${behavior.sessionMinutes} 分钟`
      + ` · 近一小时切换 ${behavior.switchesLastHour} 次`;
    userStateReadout.value.textContent = `${USER_STATE_LABELS[behavior.userState]}（${behavior.userState}）`
      + (behavior.lateNight ? ' · 深夜' : '');

    presenceReadout.value.textContent = `${presence.present ? '在' : '不在'} · 来源 ${PRESENCE_SOURCE_LABELS[presence.source]}`
      + (presence.expression ? ` · 表情 ${presence.expression}` : '')
      + (presence.stranger === true ? ' · 有陌生人' : '');

    interventionsReadout.value.textContent = `${status.interventionsToday} 次`;

    // 免打扰时段是"她为什么不出声"的最常见原因，直接在当前小时上给出结论
    const hour = behavior.hour;
    quietReadout.value.textContent = `${settings.quietHours.start}:00 – ${settings.quietHours.end}:00`
      + (isQuietHour(hour, settings.quietHours) ? `（现在 ${hour} 点，免打扰中）` : '');

    // lastError 非空才标红：空串显示"无"，避免一整条红字吓人
    lastErrorReadout.value.textContent = status.lastError === '' ? '无' : status.lastError;
    lastErrorReadout.value.classList.toggle('perception-error-text', status.lastError !== '');
    dataDirReadout.value.textContent = status.dataDir === '' ? '（未知）' : status.dataDir;

    renderPrivacy(status);
    renderCamera(status);
    renderHabits(status);
  }

  /** 隐私模式：醒目行 + 一句"现在到底在不在采集"的实话（只读，不由本地点击决定）。 */
  function renderPrivacy(status: PerceptionStatus): void {
    const on = status.settings.privacyMode;
    privacyRow.classList.toggle('perception-privacy-on', on);
    // 只认主进程回传的值：这个开关可能被托盘菜单改掉
    if (document.activeElement !== privacyInput) privacyInput.checked = on;
    privacyState.textContent = on
      ? `隐私模式开启中：不截图、不开摄像头、不做行为采样${status.pausedReason === '' ? '' : `（${status.pausedReason}）`}`
      : '隐私模式已关闭：按上面五个开关与采样频率采集。';
    privacyState.classList.toggle('perception-privacy-state-on', on);
  }

  /** 摄像头授权：状态 + 未就绪时的诚实提示（渲染层 getUserMedia 可能失败）。 */
  function renderCamera(status: PerceptionStatus): void {
    const authorized = status.settings.cameraAuthorized;
    cameraStateReadout.value.textContent = authorized ? '已授权' : '未授权';
    cameraStateReadout.value.className = authorized
      ? 'perception-readout-value perception-value-ok' : 'perception-readout-value perception-value-muted';
    cameraButton.textContent = authorized ? '撤销授权' : '授权并使用摄像头';
    cameraButton.setAttribute('aria-label', authorized ? '撤销摄像头授权' : '授权并使用摄像头');

    if (!authorized) {
      cameraReadyReadout.value.textContent = '未授权（不会取帧）';
      cameraReadyReadout.value.className = 'perception-readout-value perception-value-muted';
      cameraNotice.textContent = '摄像头画面只在内存里分析一次，永不写盘；未授权时不会打开摄像头。';
      return;
    }
    cameraReadyReadout.value.textContent = status.cameraReady ? '就绪' : '等待就绪';
    cameraReadyReadout.value.className = status.cameraReady
      ? 'perception-readout-value perception-value-ok' : 'perception-readout-value perception-value-muted';
    cameraNotice.textContent = status.cameraReady
      ? '摄像头已就绪：按上面的采样间隔判断你在不在电脑前（画面只在内存里分析一次，不写盘）。'
      : '等待摄像头就绪（如果设备不可用会在这里提示）。';
  }

  /**
   * 习惯画像。
   *
   * 刻意不直接调 `describeHabits()`：`PerceptionStatus.habits` 是**摘要视图**，
   * 没有 `observedHours` / `hours` 字段，硬凑一个 HabitProfile 传进去等于伪造数据。
   * 这里按 describeHabits 的同样口径拼装，只展示状态里真实存在的量。
   */
  function renderHabits(status: PerceptionStatus): void {
    const { habits } = status;
    habitsReadout.value.textContent = habits.samples === 0
      ? '还没学到东西（打开感知后我会慢慢记）'
      : `采样 ${habits.samples} 次 · 活跃 ${habits.activeDays} 天`
        + ` · 通常 ${hourRange(habits.earliestActiveHour, habits.latestActiveHour)} 在线`;
    habitsTypicalReadout.value.textContent = habits.typicalNow === null
      ? '还看不出来（样本不够）' : sceneLabel(habits.typicalNow);
  }

  /* 输入框回填 */

  type SyncScope = 'privacy' | 'sampling';

  /**
   * 把主进程回传的值写回输入框。
   *
   * 只在**用户刚保存成功后**（以及挂载时）调用。
   * `document.activeElement` 守卫是第二道保险 —— 杜绝任何"正在打字却被覆盖"的可能
   * （推送、慢回执都可能晚到）。
   */
  function syncInputs(status: PerceptionStatus, scope: SyncScope): void {
    const { settings } = status;
    const editing = (control: HTMLElement): boolean => document.activeElement === control;
    const setValue = (control: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
      if (!editing(control)) control.value = value;
    };

    if (scope === 'privacy') {
      if (!editing(hideInput)) hideInput.checked = settings.hideFromCapture;
      setValue(keywordsInput, settings.sensitivityKeywords.join('\n'));
      setValue(fixesInput, settings.sceneFixes.join('\n'));
      // 隐私模式开关可能被托盘菜单改掉：勾选态与提示整块由 status 刷新
      renderPrivacy(status);
      return;
    }

    /*
     * ⚠️ 五个"感知开关"的勾选态**必须也由 status 回填**。
     *
     * 曾经的实现只回填数字输入框，勾选态只信本地点击 —— 于是：
     * 默认全开（主进程 screen=true）时，面板上的复选框是**空的**，
     * 用户看到"屏幕感知没开"，但状态行却写着"正在采集"（截图验收抓到这个自相矛盾的画面）。
     * 开关是"可配置"的门面，回显错了比功能坏了更伤信任。
     */
    for (const item of switchTable) {
      if (!editing(item.control)) item.control.checked = settings[item.field];
    }

    setValue(intervalInput, String(settings.captureIntervalMs));
    setValue(widthInput, String(settings.captureWidth));
    setValue(urlWidthInput, String(settings.urlCaptureWidth));
    if (!editing(captureUrlInput)) captureUrlInput.checked = settings.captureUrl;
    if (!editing(storeFullUrlInput)) storeFullUrlInput.checked = settings.storeFullUrl;
    setValue(cameraIntervalInput, String(settings.cameraIntervalMs));
    setValue(proactiveMinInput, String(settings.proactiveMinIntervalMs));
    setValue(proactiveMaxInput, String(settings.proactiveMaxPerHour));
    setValue(longSessionInput, String(settings.longSessionMinutes));
    setValue(lateNightInput, String(settings.lateNightHour));
    setValue(quietStartInput, String(settings.quietHours.start));
    setValue(quietEndInput, String(settings.quietHours.end));
  }

  /* 日志 / 按需看屏幕 */

  function logItem(item: PerceptionLogItem): HTMLLIElement {
    const node = el('li', 'perception-log-item');
    const time = el('span', 'perception-log-time');
    time.textContent = formatClock(item.at);
    const kind = el('span', 'perception-log-kind');
    kind.textContent = LOG_KIND_LABELS[item.kind];
    const text = el('span', 'perception-log-text');
    // 日志文本来自模型观察与用户输入：只用 textContent，绝不当 HTML 解析
    text.textContent = item.text;
    node.append(time, kind, text);
    return node;
  }

  function renderLog(items: readonly PerceptionLogItem[]): void {
    // 重建列表会把滚动位置清零，渲染前后手动接一下 scrollTop
    const top = logList.scrollTop;
    logList.textContent = '';
    if (items.length === 0) {
      const empty = el('li', 'perception-empty');
      empty.textContent = '还没有日志。';
      logList.appendChild(empty);
    } else {
      for (const item of items) logList.appendChild(logItem(item));
    }
    logList.scrollTop = top;
  }

  function refreshLog(): void {
    void api.log(LOG_LIMIT).then(renderLog).catch((error: unknown) => setPanelError(errorText(error)));
  }

  /** 节流刷新：真的有新活动（开关/暂停原因/新观察/开口次数变化）时立刻刷，否则最多 3 秒一次。 */
  function refreshLogThrottled(force: boolean): void {
    const now = Date.now();
    if (!force && now - lastListRefresh < LIST_REFRESH_MS) return;
    lastListRefresh = now;
    refreshLog();
  }

  function renderViewResult(result: PerceptionViewResult): void {
    if (!result.ok || result.error !== '') {
      viewResult.className = 'perception-view-result perception-error-text';
      /*
       * 优先显示 `result.text`：主进程会给出**人话**（例如"我还没接上大模型，
       * 看不懂屏幕内容"），而 `error` 只是给日志/排错用的错误码（如 `no-llm`）。
       * 早期版本优先显示 error，用户看到的是"看屏幕失败：no-llm" —— 等于没说。
       */
      const message = result.text.trim() !== '' ? result.text.trim() : result.error.trim();
      viewResult.textContent = `看屏幕失败：${message === '' ? '未知原因' : message}`;
      return;
    }
    const parts = [sceneLabel(result.scene), result.text.trim()].filter((part) => part !== '');
    if (result.sensitive) parts.push('（判定为私人内容，她只是分类没细看）');
    if (result.tokens > 0) parts.push(`— ${result.tokens} token`);
    viewResult.className = 'perception-view-result';
    // 模型产出的屏幕文字：只进 textContent
    viewResult.textContent = parts.join('\n');
  }

  /* 补丁构造 */

  /** 敏感关键词：一行一个，去空白、去空行、去重、限长（与主进程清洗口径一致）。 */
  function parseKeywords(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of keywordsInput.value.split(/\r?\n/)) {
      const keyword = line.trim().slice(0, 40);
      if (keyword === '' || seen.has(keyword)) continue;
      seen.add(keyword);
      out.push(keyword);
    }
    return out;
  }

  function buildKeywordsPatch(): PerceptionSettingsPatch {
    // 清空输入框 = 清空关键词列表（而不是"不改动"）：这是唯一能删掉全部关键词的入口
    return { sensitivityKeywords: parseKeywords() };
  }

  /**
   * 场景纠正规则（`关键词=场景`）。
   *
   * 与关键词同理：清空 = 清空列表（也就是"不要任何自定义纠正，全交给自动判断"）。
   * 非法行的过滤在主进程的 `parseSceneFixes` 里做一次，面板不重复实现规则解析。
   */
  function buildFixesPatch(): PerceptionSettingsPatch {
    return {
      sceneFixes: fixesInput.value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    };
  }

  function buildSamplingPatch(): PerceptionSettingsPatch | null {
    // 先读一遍只用来判断"有没有空/非数字"，错误提示要具体到这一步
    const fields = [
      numberValue(intervalInput), numberValue(widthInput), numberValue(urlWidthInput), numberValue(cameraIntervalInput),
      numberValue(proactiveMinInput), numberValue(proactiveMaxInput), numberValue(longSessionInput),
      numberValue(lateNightInput), numberValue(quietStartInput), numberValue(quietEndInput),
    ];
    if (fields.includes(null)) {
      setPanelError('采样与频率的每一项都必须填数字（免打扰时段取值 0~23）。');
      return null;
    }
    // 已确认全部非 null：逐项落到具名常量收窄类型（strict + noUncheckedIndexedAccess 下
    // 数组解构仍会带 undefined，项目约定又不许用非空断言）
    const ms = numberValue(intervalInput) ?? 0;
    const px = numberValue(widthInput) ?? 0;
    const urlPx = numberValue(urlWidthInput) ?? 0;
    const camMs = numberValue(cameraIntervalInput) ?? 0;
    const proactiveMin = numberValue(proactiveMinInput) ?? 0;
    const proactiveMax = numberValue(proactiveMaxInput) ?? 0;
    const longMin = numberValue(longSessionInput) ?? 0;
    const late = numberValue(lateNightInput) ?? 0;
    const qStart = numberValue(quietStartInput) ?? 0;
    const qEnd = numberValue(quietEndInput) ?? 0;
    return {
      captureIntervalMs: clampInt(ms, 5000, 3600000),
      captureWidth: clampInt(px, 160, 1920),
      captureUrl: captureUrlInput.checked,
      urlCaptureWidth: clampInt(urlPx, 640, 3840),
      storeFullUrl: storeFullUrlInput.checked,
      cameraIntervalMs: clampInt(camMs, 10000, 3600000),
      proactiveMinIntervalMs: clampInt(proactiveMin, 60000, 86400000),
      proactiveMaxPerHour: clampInt(proactiveMax, 0, 60),
      longSessionMinutes: clampInt(longMin, 10, 1440),
      lateNightHour: clampInt(late, 0, 6),
      quietHours: { start: clampInt(qStart, 0, 23), end: clampInt(qEnd, 0, 23) },
    };
  }

  /* 事件 */

  /**
   * 立即生效的复选框。
   *
   * 这里用"控件 + 补丁构造函数"的成对表，而不是 `{ [field]: checked }` 计算属性：
   * 计算属性在严格模式下会被推断成索引签名，反而丢掉 PerceptionSettingsPatch 的类型约束。
   */
  const immediate: ReadonlyArray<{ control: HTMLInputElement; apply: (checked: boolean) => PerceptionSettingsPatch }> = [
    { control: screenInput, apply: (checked) => ({ screen: checked }) },
    { control: visionInput, apply: (checked) => ({ vision: checked }) },
    { control: behaviorInput, apply: (checked) => ({ behavior: checked }) },
    { control: cameraInput, apply: (checked) => ({ camera: checked }) },
    { control: habitsInput, apply: (checked) => ({ habits: checked }) },
    { control: privacyInput, apply: (checked) => ({ privacyMode: checked }) },
    { control: hideInput, apply: (checked) => ({ hideFromCapture: checked }) },
  ];

  /**
   * 五个"感知开关"的字段名表 —— 只为**回填勾选态**服务（见 syncInputs 的注释）。
   *
   * 隐私模式与"不出现在截屏里"不在这里：它们由 `renderPrivacy` 统一负责，
   * 因为那两个控件属于"隐私闸门"，勾选态要跟提示文案一起刷新。
   */
  const switchTable: ReadonlyArray<{
    control: HTMLInputElement;
    field: 'screen' | 'vision' | 'behavior' | 'camera' | 'habits';
  }> = [
    { control: screenInput, field: 'screen' },
    { control: visionInput, field: 'vision' },
    { control: behaviorInput, field: 'behavior' },
    { control: cameraInput, field: 'camera' },
    { control: habitsInput, field: 'habits' },
  ];

  for (const { control, apply } of immediate) {
    control.addEventListener('change', () => {
      // 开关是"立即生效"的：不经过保存按钮，失败时由 setSettings 的错误处理兜底
      queuePatch(apply(control.checked));
      // 隐私模式切换后立刻给出反馈（真实的 pausedReason 要等主进程回来）
      setPanelNote(control === privacyInput
        ? (control.checked ? '正在开启隐私模式…' : '正在关闭隐私模式…') : '正在应用…');
    });
  }

  keywordsSave.addEventListener('click', () => savePatch(keywordsSave, 'privacy', buildKeywordsPatch));
  fixesSave.addEventListener('click', () => savePatch(fixesSave, 'privacy', buildFixesPatch));
  samplingSave.addEventListener('click', () => savePatch(samplingSave, 'sampling', buildSamplingPatch));

  openLogButton.addEventListener('click', () => {
    withBusy(openLogButton, async () => {
      if (!(await api.openLog())) {
        setPanelError('打开感知日志失败');
        return;
      }
      setPanelNote('已打开感知日志');
    });
  });

  clearDataButton.addEventListener('click', () => {
    // 清空观察记录与习惯画像不可撤销，必须二次确认（window.confirm 不是 eval，CSP 下可用）
    if (!window.confirm('确定要清空感知数据吗？观察记录与习惯画像都会被删除，且无法恢复（截图从来没有落过盘）。')) return;
    withBusy(clearDataButton, async () => {
      const status = await api.clearData();
      renderStatus(status);
      syncInputs(status, 'sampling');
      flashNote('感知数据已清空');
      refreshLogThrottled(true);
    });
  });

  viewButtons.forEach((button, index) => {
    const entry = VIEW_MODES[index];
    if (entry === undefined) return; // noUncheckedIndexedAccess：理论上不会发生
    button.addEventListener('click', () => {
      withBusy(button, async () => {
        viewResult.className = 'perception-view-result';
        viewResult.textContent = `正在看屏幕（${entry.label}）…`;
        renderViewResult(await api.viewNow(entry.mode));
      });
    });
  });

  logRefresh.addEventListener('click', () => {
    withBusy(logRefresh, async () => {
      renderLog(await api.log(LOG_LIMIT));
      lastListRefresh = Date.now();
      setPanelNote('日志已刷新');
    });
  });

  /**
   * 摄像头授权按钮。
   *
   * 按钮文案与行为都**由 status 驱动**（`cameraAuthorized` 可能被别处改掉），
   * 所以这里读的是 `latest.settings.cameraAuthorized`，而不是某个本地标志位。
   */
  cameraButton.addEventListener('click', () => {
    const next = !latest.settings.cameraAuthorized;
    if (!next && !window.confirm('撤销摄像头授权后她就不再判断你在不在电脑前（随时可以再授权）。')) return;
    withBusy(cameraButton, async () => {
      const status = await api.authorizeCamera(next);
      renderStatus(status);
      syncInputs(status, 'privacy');
      setPanelNote(!next ? '摄像头授权已撤销'
        : (status.cameraReady ? '摄像头已授权并就绪' : '摄像头已授权：等待设备就绪'));
      refreshLogThrottled(true);
    });
  });

  /* 初始化与订阅 */

  syncInputs(initial, 'sampling');
  syncInputs(initial, 'privacy');
  renderStatus(initial);
  refreshLogThrottled(true);

  /**
   * 状态订阅。
   *
   * 只刷新**只读部分**：状态行、习惯读数、摄像头就绪文案、隐私提示与日志列表。
   * 所有输入框都不在这里回填（用户可能正停在某个框里打字），只有保存成功后才由
   * syncInputs 依据主进程返回值回填一次。
   *
   * 日志列表走节流：`activityKey` 变化（开关/暂停原因/新观察/开口计数）说明真的
   * 发生了新事情 → 立刻刷；否则最多 3 秒一次兜底。
   */
  api.onStatus((status) => {
    renderStatus(status);
    const key = activityKey(status);
    const changed = key !== activity;
    activity = key;
    refreshLogThrottled(changed);
  });

  // bootstrap 快照是窗口打开那一刻读的，顺手校准一次（读不到就沿用手里的 initial）
  void api.status()
    .then((status) => {
      renderStatus(status);
      syncInputs(status, 'sampling');
      syncInputs(status, 'privacy');
    })
    .catch((error: unknown) => {
      console.warn('[perception-panel] initial status refresh failed:', errorText(error));
    });
}
