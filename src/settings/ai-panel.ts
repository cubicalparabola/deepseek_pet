/**
 * 「AI 认知与人格」设置面板（2.1 对话 / 2.2 记忆 / 2.3 情绪 / 2.4 日记）。
 *
 * 为什么做成"自包含的挂载函数"而不是又一页脚本：
 * 设置页面的骨架（index.html + settings.ts）已经有自己的职责，面板只要给一块容器
 * 就能挂上去，页面不必知道里面有多少控件；将来桌宠窗口想复用同一份面板，
 * 也只是换一个 root 而已。
 *
 * 三条硬性约束（与项目基线一致）：
 * 1. **全部 DOM 用 createElement + textContent 组装**。模型产出（日记正文、
 *    记忆事实、错误信息）会直接进界面，任何 innerHTML 都是一条 XSS 通路。
 * 2. **密钥单向流动**。界面只显示掩码；只有用户真的往输入框里打了字，
 *    补丁里才会带 `apiKey`（主进程把 `''` 当作"不改动"，但显式省略更不容易出错）。
 * 3. **任何 api 调用都不许把面板弄崩**。全部 .catch()，失败原因写进面板状态行，
 *    按钮在 finally 里复位 —— 任何时刻都不会留下一个转不停的按钮。
 */

import type {
  AISettingsPatch,
  AIStatusView,
  ChatTurn,
  DiaryEntry,
  DiaryIndexItem,
  DiarySnapshot,
  MemoryFact,
  MemoryFactKey,
  MemorySnapshot,
  PetPresence,
} from '../shared/ai-types';
import { hungerLabel, moodLabel } from '../shared/emotion';
import type { AIAPI } from '../shared/ipc';

/* -------------------------------------------------------------------------- */
/* 通用小工具（纯 DOM，不碰业务状态）                                            */
/* -------------------------------------------------------------------------- */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function makeInput(kind: 'text' | 'password' | 'number', id: string, label: string): HTMLInputElement {
  const node = el('input', 'ai-input');
  node.type = kind;
  node.id = id;
  // aria-label 与下面的 <label for> 双保险：本面板控件全部由脚本动态创建，
  // 只靠 for 关联时个别读屏软件会漏读用途。
  node.setAttribute('aria-label', label);
  return node;
}

function makeCheckbox(id: string, label: string): HTMLInputElement {
  const node = el('input', 'ai-check-input');
  node.type = 'checkbox';
  node.id = id;
  node.setAttribute('aria-label', label);
  return node;
}

function makeButton(id: string, label: string, variant: 'primary' | 'ghost'): HTMLButtonElement {
  // 类名故意不叫 primary/ghost：settings.css 里有同名全局按钮样式，撞上会互相污染
  const node = el('button', variant === 'primary' ? 'ai-btn-primary' : 'ai-btn-ghost');
  node.type = 'button';
  node.id = id;
  node.textContent = label;
  node.setAttribute('aria-label', label);
  return node;
}

/** 一行"标签 + 控件"（可选小字说明，说明横跨两列）。 */
function fieldRow(id: string, labelText: string, control: HTMLElement, hint?: string): HTMLDivElement {
  const row = el('div', 'ai-field');
  const label = el('label', 'ai-field-label');
  label.htmlFor = id;
  label.textContent = labelText;
  row.append(label, control);
  if (hint !== undefined) {
    const note = el('p', 'ai-hint');
    note.textContent = hint;
    row.appendChild(note);
  }
  return row;
}

/** 复选框行：整行可点（框在左、文字在右）。 */
function checkRow(labelText: string, control: HTMLInputElement): HTMLLabelElement {
  const row = el('label', 'ai-check');
  const span = el('span');
  span.textContent = labelText;
  row.append(control, span);
  return row;
}

function makeSection(title: string): HTMLElement {
  const node = el('section', 'ai-section');
  const heading = el('h2');
  heading.textContent = title;
  node.appendChild(heading);
  return node;
}

/** 只读读数行：返回行元素与值元素（值元素后续会被反复覆写）。 */
function makeReadout(labelText: string): { row: HTMLDivElement; value: HTMLSpanElement } {
  const row = el('div', 'ai-readout');
  const label = el('span', 'ai-readout-label');
  label.textContent = labelText;
  const value = el('span', 'ai-readout-value');
  value.textContent = '—';
  row.append(label, value);
  return { row, value };
}

interface BarHandle {
  readonly bar: HTMLDivElement;
  readonly fill: HTMLDivElement;
}

/** 情绪/饥饿条：纯 div 宽度，不用 canvas（缩放窗口时不需要重绘）。 */
function makeBar(id: string, labelText: string, warm: boolean): BarHandle {
  const bar = el('div', warm ? 'ai-bar ai-bar-warm' : 'ai-bar');
  bar.id = id;
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', labelText);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', '0');
  const fill = el('div', 'ai-bar-fill');
  bar.appendChild(fill);
  return { bar, fill };
}

/** "标签 + 数值 + 进度条"的可视行（情绪区块用；条形独占第二行）。 */
function barRow(labelText: string, value: HTMLSpanElement, bar: HTMLDivElement): HTMLDivElement {
  const row = el('div', 'ai-bar-row');
  const label = el('span', 'ai-bar-label');
  label.textContent = labelText;
  row.append(label, value, bar);
  return row;
}

function actionRow(...controls: HTMLElement[]): HTMLDivElement {
  const row = el('div', 'ai-actions');
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

function formatTime(iso: string): string {
  if (iso.trim() === '') return '—';
  const date = new Date(iso);
  // 坏时间戳原样显示：总比界面上出现 "Invalid Date" 强
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** 在场状态的中文标签（与托盘菜单的三档一一对应）。 */
const PRESENCE_LABELS: Record<PetPresence, string> = {
  visible: '在场',
  collapsed: '收起',
  hidden: '隐藏',
};

/** 记忆事实 key 的中文标签。 */
const FACT_LABELS: Record<MemoryFactKey, string> = {
  name: '名字',
  interest: '兴趣',
  routine: '作息',
  activity: '常做的事',
  project: '在做的项目',
  preference: '偏好',
  relation: '提到的人',
  note: '其它',
};

function sourceLabel(source: 'llm' | 'template'): string {
  return source === 'llm' ? '大模型' : '本地模板';
}

/** "调用指纹"：只有它变化才说明真的发生过大模型调用（情绪心跳不会改它）。 */
function activityKey(status: AIStatusView): string {
  return `${status.calls}:${status.tokensUsed}`;
}

/* -------------------------------------------------------------------------- */
/* 面板                                                                        */
/* -------------------------------------------------------------------------- */

/** 把「AI 认知与人格」面板挂到给定容器里。 */
export function mountAIPanel(root: HTMLElement, api: AIAPI, initial: AIStatusView): void {
  const panel = el('div', 'ai-panel');
  root.appendChild(panel);

  /** 最近一次已知状态：保存成功后回填输入框用它（拿到的是主进程清洗过的值）。 */
  let latest: AIStatusView = initial;
  /** 列表刷新节流时间戳：状态推送很密（情绪心跳），日记/记忆不能每次推送都重拉。 */
  let lastListRefresh = Date.now();
  let activity = activityKey(initial);
  let savedTimer: number | null = null;

  /* ------------------------------------------------------------------------ */
  /* 一、总开关 + 状态                                                          */
  /* ------------------------------------------------------------------------ */

  const overview = makeSection('AI 认知与人格');
  const enabledInput = makeCheckbox('ai-enabled', '启用 AI');
  overview.appendChild(checkRow('启用 AI（总开关；关掉时下面四个子系统全部不生效）', enabledInput));

  const modeReadout = makeReadout('模式');
  const presenceReadout = makeReadout('在场');
  const moodReadout = makeReadout('心情');
  const hungerReadout = makeReadout('饿');
  const callsReadout = makeReadout('调用次数');
  const tokensReadout = makeReadout('累计 token');
  const lastErrorReadout = makeReadout('最近错误');
  const dataDirReadout = makeReadout('数据目录');
  for (const readout of [modeReadout, presenceReadout, moodReadout, hungerReadout, callsReadout, tokensReadout, lastErrorReadout, dataDirReadout]) {
    overview.appendChild(readout.row);
  }
  dataDirReadout.value.classList.add('ai-small');

  const statusLine = el('p', 'ai-status-line');
  statusLine.id = 'ai-panel-status';
  statusLine.textContent = '就绪';
  // role=status：失败信息与"已保存"都会写在这里，读屏软件应当主动播报
  statusLine.setAttribute('role', 'status');
  const savedLabel = el('span', 'ai-saved');
  savedLabel.id = 'ai-saved';
  savedLabel.textContent = '已保存';
  overview.append(statusLine, savedLabel);

  /* ------------------------------------------------------------------------ */
  /* 二、四个子系统开关                                                         */
  /* ------------------------------------------------------------------------ */

  const switches = makeSection('子系统开关');
  const chatInput = makeCheckbox('ai-chat', '大模型对话');
  const memoryInput = makeCheckbox('ai-memory', '用户记忆');
  const emotionInput = makeCheckbox('ai-emotion', '情绪系统');
  const diaryInput = makeCheckbox('ai-diary', '日记系统');
  switches.append(
    checkRow('大模型对话（2.1）', chatInput),
    checkRow('用户记忆（2.2）', memoryInput),
    checkRow('情绪系统（2.3）', emotionInput),
    checkRow('日记系统（2.4）', diaryInput),
  );

  const diaryHourInput = makeInput('number', 'ai-diary-hour', '写日记时刻');
  diaryHourInput.min = '0';
  diaryHourInput.max = '23';
  diaryHourInput.step = '1';
  switches.appendChild(
    fieldRow('ai-diary-hour', '写日记时刻（0~23）', diaryHourInput, '每天到这个整点自动写一篇；当天已经写过就跳过。'),
  );

  const consolidateInput = makeInput('number', 'ai-consolidate-every', '记忆整理间隔');
  consolidateInput.min = '0';
  consolidateInput.max = '100';
  consolidateInput.step = '1';
  switches.appendChild(
    fieldRow(
      'ai-consolidate-every',
      '整理间隔（轮）',
      consolidateInput,
      '每 N 轮对话让模型整理一次长期记忆；0 = 不自动整理，只在写日记时整理。',
    ),
  );

  const switchesSave = makeButton('ai-subsystems-save', '保存子系统设置', 'primary');
  switches.appendChild(actionRow(switchesSave));

  /* ------------------------------------------------------------------------ */
  /* 三、服务商配置                                                             */
  /* ------------------------------------------------------------------------ */

  const providerSection = makeSection('服务商配置');
  const providerKind = el('select', 'ai-input');
  providerKind.id = 'ai-provider-kind';
  providerKind.setAttribute('aria-label', '服务商类型');
  for (const [value, text] of [['openai', 'OpenAI 兼容'], ['anthropic', 'Anthropic']] as const) {
    const option = el('option');
    option.value = value;
    option.textContent = text;
    providerKind.appendChild(option);
  }
  providerSection.appendChild(fieldRow('ai-provider-kind', '类型', providerKind));

  const providerBaseUrl = makeInput('text', 'ai-provider-base-url', '接口地址');
  providerBaseUrl.placeholder = 'https://api.openai.com/v1';
  providerSection.appendChild(
    fieldRow(
      'ai-provider-base-url',
      '接口地址',
      providerBaseUrl,
      'OpenAI 兼容网关填到 /v1 为止（one-api / vLLM / Ollama / DeepSeek 都行）；Anthropic 填 https://api.anthropic.com，具体路径由程序补。',
    ),
  );

  const providerModel = makeInput('text', 'ai-provider-model', '模型名');
  providerModel.placeholder = 'gpt-4o-mini';
  providerSection.appendChild(fieldRow('ai-provider-model', '模型名', providerModel));

  const providerApiKey = makeInput('password', 'ai-provider-api-key', 'API Key');
  providerApiKey.autocomplete = 'off';
  providerSection.appendChild(
    fieldRow(
      'ai-provider-api-key',
      'API Key',
      providerApiKey,
      '留空表示不修改已保存的密钥：界面只能看到掩码，明文只在主进程里存在。',
    ),
  );

  const providerTemperature = makeInput('number', 'ai-provider-temperature', '采样温度');
  providerTemperature.min = '0';
  providerTemperature.max = '2';
  providerTemperature.step = '0.1';
  providerSection.appendChild(fieldRow('ai-provider-temperature', '温度（0~2）', providerTemperature));

  const providerMaxTokens = makeInput('number', 'ai-provider-max-tokens', '单次最大 token');
  providerMaxTokens.min = '16';
  providerMaxTokens.max = '8192';
  providerMaxTokens.step = '1';
  providerSection.appendChild(fieldRow('ai-provider-max-tokens', '单次最大 token', providerMaxTokens));

  const providerTimeout = makeInput('number', 'ai-provider-timeout-ms', '请求超时（毫秒）');
  providerTimeout.min = '1000';
  providerTimeout.max = '120000';
  providerTimeout.step = '500';
  providerSection.appendChild(fieldRow('ai-provider-timeout-ms', '超时（ms）', providerTimeout));

  const providerSave = makeButton('ai-provider-save', '保存服务商配置', 'primary');
  const providerClearKey = makeButton('ai-provider-clear-key', '清除密钥', 'ghost');
  providerSection.appendChild(actionRow(providerSave, providerClearKey));

  const testButton = makeButton('ai-test', '测试连接', 'ghost');
  const testResult = el('p', 'ai-test-result');
  testResult.id = 'ai-test-result';
  testResult.hidden = true;
  testResult.setAttribute('role', 'status');
  providerSection.append(actionRow(testButton), testResult);

  /* ------------------------------------------------------------------------ */
  /* 四、人格设定                                                               */
  /* ------------------------------------------------------------------------ */

  const personaSection = makeSection('人格设定');
  const personaInput = el('textarea', 'ai-textarea');
  personaInput.id = 'ai-persona';
  personaInput.rows = 6;
  personaInput.setAttribute('aria-label', '人格设定（system prompt 主体）');
  personaSection.appendChild(fieldRow('ai-persona', '人格设定', personaInput, '这段文字会作为 system prompt 的主体；行数不限。'));

  const petNameInput = makeInput('text', 'ai-pet-name', '宠物自称');
  petNameInput.placeholder = '鲸鱼娘';
  personaSection.appendChild(fieldRow('ai-pet-name', '她的名字', petNameInput));

  const userNameInput = makeInput('text', 'ai-user-name', '主人称呼');
  userNameInput.placeholder = '留空则由记忆自动补全';
  personaSection.appendChild(fieldRow('ai-user-name', '对你的称呼', userNameInput));

  const personaSave = makeButton('ai-persona-save', '保存人格设定', 'primary');
  personaSection.appendChild(actionRow(personaSave));

  /* ------------------------------------------------------------------------ */
  /* 五、Token 预算                                                             */
  /* ------------------------------------------------------------------------ */

  const budgetSection = makeSection('Token 预算');
  const budgetInput = makeInput('number', 'ai-budget', 'Token 预算');
  budgetInput.min = '0';
  budgetInput.step = '1000';
  budgetSection.appendChild(
    fieldRow('ai-budget', '预算（token）', budgetInput, '0 = 不限额；限额时"饿"由剩余比例推导，用完她会说不动话。'),
  );

  const budgetUsedReadout = makeReadout('已用');
  const budgetResetReadout = makeReadout('重置时间');
  budgetSection.append(budgetUsedReadout.row, budgetResetReadout.row);

  const budgetSave = makeButton('ai-budget-save', '保存预算', 'primary');
  const budgetReset = makeButton('ai-budget-reset', '重置用量', 'ghost');
  budgetSection.appendChild(actionRow(budgetSave, budgetReset));

  /* ------------------------------------------------------------------------ */
  /* 六、情绪（2.3）                                                            */
  /* ------------------------------------------------------------------------ */

  const emotionSection = makeSection('情绪（2.3）');
  const moodValue = el('span', 'ai-readout-value');
  moodValue.id = 'ai-mood-value';
  moodValue.textContent = '—';
  const hungerValue = el('span', 'ai-readout-value');
  hungerValue.id = 'ai-hunger-value';
  hungerValue.textContent = '—';
  const moodBar = makeBar('ai-mood-bar', '心情', false);
  const hungerBar = makeBar('ai-hunger-bar', '饿', true);
  emotionSection.append(
    barRow('心情', moodValue, moodBar.bar),
    barRow('饿', hungerValue, hungerBar.bar),
  );
  const emotionReset = makeButton('ai-emotion-reset', '重置情绪', 'ghost');
  emotionSection.appendChild(actionRow(emotionReset));
  const emotionHint = el('p', 'ai-hint');
  emotionHint.textContent = '情绪开关关掉时这里显示的是中性值，不会被后台结算改动。';
  emotionSection.appendChild(emotionHint);

  /* ------------------------------------------------------------------------ */
  /* 七、日记（2.4）                                                            */
  /* ------------------------------------------------------------------------ */

  const diarySection = makeSection('日记（2.4）');
  const diaryWrite = makeButton('ai-diary-write', '立即写今天的日记', 'primary');
  const diaryOpenDir = makeButton('ai-diary-open-dir', '打开日记目录', 'ghost');
  const diaryToday = el('span', 'ai-diary-today');
  diaryToday.id = 'ai-diary-today';
  diaryToday.hidden = true;
  diarySection.appendChild(actionRow(diaryWrite, diaryOpenDir, diaryToday));

  const diaryList = el('div', 'ai-diary-list');
  diaryList.id = 'ai-diary-list';
  diaryList.setAttribute('role', 'list');
  const diaryCaption = el('p', 'ai-diary-caption');
  diaryCaption.id = 'ai-diary-caption';
  diaryCaption.textContent = '点上面的任意一篇查看正文。';
  const diaryBody = el('pre', 'ai-diary-body');
  diaryBody.id = 'ai-diary-body';
  diaryBody.textContent = '';
  diarySection.append(diaryList, diaryCaption, diaryBody);

  /* ------------------------------------------------------------------------ */
  /* 八、记忆（2.2）                                                            */
  /* ------------------------------------------------------------------------ */

  const memorySection = makeSection('记忆（2.2）');
  const memoryStats = el('p', 'ai-readout-value');
  memoryStats.id = 'ai-memory-stats';
  memoryStats.textContent = '—';
  const memoryFacts = el('ul', 'ai-list ai-fact-list');
  memoryFacts.id = 'ai-memory-facts';
  const memoryChat = el('ul', 'ai-list ai-chat-list');
  memoryChat.id = 'ai-memory-chat';
  const factsTitle = el('p', 'ai-hint');
  factsTitle.textContent = '记住的事实';
  const chatTitle = el('p', 'ai-hint');
  chatTitle.textContent = '最近几轮对话';

  const memoryOpenLog = makeButton('ai-memory-open-log', '打开记忆日志', 'ghost');
  const memoryClear = makeButton('ai-memory-clear', '清空记忆', 'ghost');
  memorySection.append(
    memoryStats,
    actionRow(memoryOpenLog, memoryClear),
    factsTitle,
    memoryFacts,
    chatTitle,
    memoryChat,
  );

  panel.append(overview, switches, providerSection, personaSection, budgetSection, emotionSection, diarySection, memorySection);

  /* ------------------------------------------------------------------------ */
  /* 面板级提示                                                                 */
  /* ------------------------------------------------------------------------ */

  function setPanelNote(message: string): void {
    statusLine.textContent = message;
    statusLine.classList.remove('ai-status-error');
  }

  function setPanelError(message: string): void {
    statusLine.textContent = `操作失败：${message}`;
    statusLine.classList.add('ai-status-error');
    // 日志用英文（项目约定），界面文案才是中文
    console.warn('[ai-panel] action failed:', message);
  }

  /** 短暂的"已保存/已重置"提示（与 settings.ts 的 flashSaved 同一个思路）。 */
  function flashNote(message: string): void {
    savedLabel.textContent = message;
    savedLabel.classList.add('ai-show');
    if (savedTimer !== null) window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => savedLabel.classList.remove('ai-show'), 1100);
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

  /* ------------------------------------------------------------------------ */
  /* setSettings：单飞 + 补最后一帧                                             */
  /* ------------------------------------------------------------------------ */

  let flushing = false;
  let queued: AISettingsPatch | null = null;
  let flushError: string | null = null;
  let drainWaiters: Array<(error: string | null) => void> = [];

  /** 合并补丁：顶层后者优先，provider/budget 做浅合并（内部是互不重叠的字段）。 */
  function mergePatch(base: AISettingsPatch | null, next: AISettingsPatch): AISettingsPatch {
    if (base === null) return next;
    const provider = { ...base.provider, ...next.provider };
    const budget = { ...base.budget, ...next.budget };
    return {
      ...base,
      ...next,
      ...(Object.keys(provider).length > 0 ? { provider } : {}),
      ...(Object.keys(budget).length > 0 ? { budget } : {}),
    };
  }

  /**
   * 提交一个补丁。
   *
   * ⚠️ 这里**不做防抖**：开关拨动必须立刻生效，否则用户看到的是假状态。
   * 与 settings.ts 的 applyScale 一样用"单飞 + 补最后一帧"：同一时刻只允许
   * 一个 setSettings 在飞，飞行期间的改动合并进队列，落地后立刻补发。
   */
  function queuePatch(patch: AISettingsPatch): void {
    queued = mergePatch(queued, patch);
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
      .then(() => api.setSettings(patch))
      .then((status) => {
        renderStatus(status);
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

  /** 保存按钮的统一入口：校验 → 提交 → 用主进程清洗后的值回填本区块输入框。 */
  function savePatch(control: HTMLButtonElement, scope: SyncScope, build: () => AISettingsPatch | null): void {
    withBusy(control, async () => {
      const patch = build();
      if (patch === null) return; // 校验失败：原因已经在状态行里了
      queuePatch(patch);
      const error = await patchDrained();
      if (error !== null) return;
      syncInputs(latest, scope);
    });
  }

  /* ------------------------------------------------------------------------ */
  /* 渲染（只读部分）                                                           */
  /* ------------------------------------------------------------------------ */

  function setBar(target: BarHandle, value: number): void {
    const clamped = Math.min(100, Math.max(0, value));
    target.fill.style.width = `${clamped}%`;
    target.bar.setAttribute('aria-valuenow', String(Math.round(clamped)));
  }

  function renderEmotion(status: AIStatusView): void {
    const mood = moodLabel(status.emotion.mood);
    const hunger = hungerLabel(status.emotion.hunger);
    moodValue.textContent = `${status.emotion.mood} / 100 · ${mood.label} ${mood.face}`;
    hungerValue.textContent = `${status.emotion.hunger} / 100 · ${hunger.label}`;
    setBar(moodBar, status.emotion.mood);
    setBar(hungerBar, status.emotion.hunger);
  }

  function renderBudget(status: AIStatusView): void {
    const { budget } = status.settings;
    budgetUsedReadout.value.textContent = budget.budget > 0
      ? `${budget.used} / ${budget.budget} token`
      : `${budget.used} token（不限额）`;
    budgetResetReadout.value.textContent = budget.resetAt === '' ? '从未重置' : formatTime(budget.resetAt);
  }

  function renderStatus(status: AIStatusView): void {
    latest = status;
    const { settings } = status;

    modeReadout.value.textContent = status.usable ? '可用大模型' : '本地兜底';
    modeReadout.value.className = status.usable ? 'ai-readout-value ai-value-ok' : 'ai-readout-value ai-value-muted';
    presenceReadout.value.textContent = PRESENCE_LABELS[status.presence];

    const mood = moodLabel(status.emotion.mood);
    const hunger = hungerLabel(status.emotion.hunger);
    moodReadout.value.textContent = `${status.emotion.mood} / 100 · ${mood.label}`;
    hungerReadout.value.textContent = `${status.emotion.hunger} / 100 · ${hunger.label}`;
    callsReadout.value.textContent = String(status.calls);
    tokensReadout.value.textContent = settings.budget.budget > 0
      ? `${status.tokensUsed} / ${settings.budget.budget}`
      : String(status.tokensUsed);

    // lastError 非空才标红：空串显示"无"，避免一整条红字吓人
    lastErrorReadout.value.textContent = status.lastError === '' ? '无' : status.lastError;
    lastErrorReadout.value.classList.toggle('ai-error-text', status.lastError !== '');
    dataDirReadout.value.textContent = status.dataDir === '' ? '（未知）' : status.dataDir;

    renderEmotion(status);
    renderBudget(status);
  }

  /* ------------------------------------------------------------------------ */
  /* 输入框回填                                                                 */
  /* ------------------------------------------------------------------------ */

  type SyncScope = 'switches' | 'provider' | 'persona' | 'budget';

  /**
   * 把主进程回传的值写回输入框。
   *
   * 只在两个时机调用：**挂载时**与**用户刚保存成功**。`document.activeElement`
   * 守卫是第二道保险 —— 杜绝任何"正在打字却被覆盖"的可能（推送、慢回执都可能晚到）。
   */
  function syncInputs(status: AIStatusView, scope: SyncScope): void {
    const { settings } = status;
    const editing = (control: HTMLElement): boolean => document.activeElement === control;
    const setValue = (control: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
      if (editing(control)) return;
      control.value = value;
    };
    const setChecked = (control: HTMLInputElement, value: boolean): void => {
      if (editing(control)) return;
      control.checked = value;
    };

    if (scope === 'switches') {
      setChecked(enabledInput, settings.enabled);
      setChecked(chatInput, settings.chat);
      setChecked(memoryInput, settings.memory);
      setChecked(emotionInput, settings.emotion);
      setChecked(diaryInput, settings.diary);
      setValue(diaryHourInput, String(settings.diaryHour));
      setValue(consolidateInput, String(settings.consolidateEvery));
      return;
    }

    if (scope === 'provider') {
      if (!editing(providerKind)) providerKind.value = settings.provider.kind;
      setValue(providerBaseUrl, settings.provider.baseUrl);
      setValue(providerModel, settings.provider.model);
      setValue(providerTemperature, String(settings.provider.temperature));
      setValue(providerMaxTokens, String(settings.provider.maxTokens));
      setValue(providerTimeout, String(settings.provider.timeoutMs));
      // 输入框本身永远是空的：明文不回显，只把掩码放进 placeholder
      if (!editing(providerApiKey)) {
        providerApiKey.value = '';
        providerApiKey.placeholder = settings.provider.apiKeySet
          ? `已配置：${settings.provider.apiKeyMasked}`
          : '未配置（sk-…）';
      }
      return;
    }

    if (scope === 'persona') {
      setValue(personaInput, settings.persona);
      setValue(petNameInput, settings.petName);
      setValue(userNameInput, settings.userName);
      return;
    }

    setValue(budgetInput, String(settings.budget.budget));
  }

  /* ------------------------------------------------------------------------ */
  /* 日记 / 记忆：读取与渲染                                                    */
  /* ------------------------------------------------------------------------ */

  function showDiaryEntry(entry: DiaryEntry): void {
    const title = entry.title === '' ? '（无标题）' : entry.title;
    diaryCaption.textContent =
      `${entry.date} · ${title} · ${sourceLabel(entry.source)} · ${entry.tokens} token · ` +
      `心情 ${entry.mood.start} → ${entry.mood.end}（最低 ${entry.mood.low}）`;
    // 正文是模型产出：只用 textContent，绝不当 HTML 解析
    diaryBody.textContent = entry.body;
  }

  function diaryItem(item: DiaryIndexItem): HTMLButtonElement {
    const node = el('button', 'ai-diary-item');
    node.type = 'button';
    node.setAttribute('aria-label', `${item.date} ${item.title === '' ? '无标题' : item.title}，${sourceLabel(item.source)}`);
    const date = el('span', 'ai-diary-date');
    date.textContent = item.date;
    const title = el('span', 'ai-diary-title');
    title.textContent = item.title === '' ? '（无标题）' : item.title;
    const preview = el('span', 'ai-diary-preview');
    preview.textContent = item.preview;
    const meta = el('span', 'ai-diary-meta');
    meta.textContent = `${sourceLabel(item.source)} · 心情 ${item.mood.start} → ${item.mood.end}`;
    node.append(date, title, preview, meta);

    node.addEventListener('click', () => {
      withBusy(node, async () => {
        const entry = await api.diaryGet(item.date);
        if (entry === null) {
          setPanelError(`没有找到 ${item.date} 的日记`);
          return;
        }
        showDiaryEntry(entry);
      });
    });
    return node;
  }

  function renderDiary(snapshot: DiarySnapshot): void {
    diaryList.textContent = '';
    if (snapshot.items.length === 0) {
      const empty = el('p', 'ai-empty');
      empty.textContent = '还没有日记。点「立即写今天的日记」让她写下第一篇。';
      diaryList.appendChild(empty);
    } else {
      for (const item of snapshot.items) diaryList.appendChild(diaryItem(item));
    }
    diaryToday.hidden = !snapshot.todayWritten;
    diaryToday.textContent = snapshot.todayWritten ? '今天已写过' : '';
  }

  function factItem(fact: MemoryFact): HTMLLIElement {
    const node = el('li', 'ai-fact');
    const key = el('span', 'ai-fact-key');
    key.textContent = FACT_LABELS[fact.key];
    const value = el('span', 'ai-fact-value');
    value.textContent = fact.value;
    const hits = el('span', 'ai-fact-hits');
    hits.textContent = `×${fact.hits}`;
    node.append(key, value, hits);
    return node;
  }

  function chatItem(turn: ChatTurn): HTMLLIElement {
    const node = el('li', 'ai-chat');
    const role = el('span', 'ai-chat-role');
    role.textContent = turn.role === 'user' ? '主人' : '她';
    const text = el('span', 'ai-chat-text');
    text.textContent = turn.text;
    node.append(role, text);
    return node;
  }

  function renderMemory(snapshot: MemorySnapshot): void {
    const { stats } = snapshot;
    memoryStats.textContent = `事件 ${stats.events} · 对话轮 ${stats.turns} · 事实 ${stats.facts}`;

    memoryFacts.textContent = '';
    if (snapshot.profile.facts.length === 0) {
      const empty = el('li', 'ai-empty');
      empty.textContent = '还没有记住任何事实。';
      memoryFacts.appendChild(empty);
    } else {
      for (const fact of snapshot.profile.facts) memoryFacts.appendChild(factItem(fact));
    }

    memoryChat.textContent = '';
    if (snapshot.recentChat.length === 0) {
      const empty = el('li', 'ai-empty');
      empty.textContent = '还没有对话记录。';
      memoryChat.appendChild(empty);
    } else {
      for (const turn of snapshot.recentChat) memoryChat.appendChild(chatItem(turn));
    }
  }

  /**
   * 重拉日记/记忆。
   *
   * 重建列表会把滚动位置清零，所以渲染前后手动接一下 scrollTop ——
   * 否则每次推送（最长 4 秒一次）都会把正在翻日记的用户弹回列表顶部。
   */
  function renderDiaryKeepingScroll(snapshot: DiarySnapshot): void {
    const top = diaryList.scrollTop;
    renderDiary(snapshot);
    diaryList.scrollTop = top;
  }

  function renderMemoryKeepingScroll(snapshot: MemorySnapshot): void {
    const factsTop = memoryFacts.scrollTop;
    const chatTop = memoryChat.scrollTop;
    renderMemory(snapshot);
    memoryFacts.scrollTop = factsTop;
    memoryChat.scrollTop = chatTop;
  }

  function refreshDiary(): void {
    void api
      .diary()
      .then(renderDiaryKeepingScroll)
      .catch((error: unknown) => setPanelError(errorText(error)));
  }

  function refreshMemory(): void {
    void api
      .memory()
      .then(renderMemoryKeepingScroll)
      .catch((error: unknown) => setPanelError(errorText(error)));
  }

  /** 列表刷新限流：指纹变化立刻刷，其余情况最多 4 秒一次。 */
  const LIST_REFRESH_MS = 4000;

  function refreshLists(force: boolean): void {
    const now = Date.now();
    if (!force && now - lastListRefresh < LIST_REFRESH_MS) return;
    lastListRefresh = now;
    // 焦点在日记列表里（键盘用户在翻）时不重建，别把焦点弹丢
    if (!diaryList.contains(document.activeElement)) refreshDiary();
    refreshMemory();
  }

  /* ------------------------------------------------------------------------ */
  /* 补丁构造                                                                   */
  /* ------------------------------------------------------------------------ */

  function buildSwitchesPatch(): AISettingsPatch | null {
    const hour = numberValue(diaryHourInput);
    const every = numberValue(consolidateInput);
    if (hour === null || every === null) {
      setPanelError('「写日记时刻」和「整理间隔」都必须填数字。');
      return null;
    }
    return { diaryHour: clampInt(hour, 0, 23), consolidateEvery: clampInt(every, 0, 100) };
  }

  function buildProviderPatch(): AISettingsPatch | null {
    const temperature = numberValue(providerTemperature);
    const maxTokens = numberValue(providerMaxTokens);
    const timeoutMs = numberValue(providerTimeout);
    if (temperature === null || maxTokens === null || timeoutMs === null) {
      setPanelError('温度 / 单次最大 token / 超时都必须填数字。');
      return null;
    }
    const key = providerApiKey.value.trim();
    return {
      provider: {
        kind: providerKind.value === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: providerBaseUrl.value.trim(),
        model: providerModel.value.trim(),
        temperature: Math.min(2, Math.max(0, temperature)),
        maxTokens: clampInt(maxTokens, 16, 8192),
        timeoutMs: clampInt(timeoutMs, 1000, 120000),
        // 只有用户真的打了字才带上密钥：省略 = 不改动已存的那把
        ...(key === '' ? {} : { apiKey: key }),
      },
    };
  }

  /* ------------------------------------------------------------------------ */
  /* 事件                                                                       */
  /* ------------------------------------------------------------------------ */

  /**
   * 立即生效的复选框。
   *
   * 这里用"控件 + 补丁构造函数"的成对表，而不是 `{ [field]: checked }` 计算属性：
   * 计算属性在严格模式下会被推断成索引签名，反而丢掉 AISettingsPatch 的类型约束。
   */
  const immediate: ReadonlyArray<{ control: HTMLInputElement; apply: (checked: boolean) => AISettingsPatch }> = [
    { control: enabledInput, apply: (checked) => ({ enabled: checked }) },
    { control: chatInput, apply: (checked) => ({ chat: checked }) },
    { control: memoryInput, apply: (checked) => ({ memory: checked }) },
    { control: emotionInput, apply: (checked) => ({ emotion: checked }) },
    { control: diaryInput, apply: (checked) => ({ diary: checked }) },
  ];
  for (const { control, apply } of immediate) {
    control.addEventListener('change', () => {
      // 开关是"立即生效"的：不经过保存按钮，失败时由 setSettings 的错误处理兜底
      queuePatch(apply(control.checked));
    });
  }

  switchesSave.addEventListener('click', () => savePatch(switchesSave, 'switches', buildSwitchesPatch));

  providerSave.addEventListener('click', () => savePatch(providerSave, 'provider', buildProviderPatch));

  providerClearKey.addEventListener('click', () => {
    withBusy(providerClearKey, async () => {
      queuePatch({ clearApiKey: true });
      if (document.activeElement !== providerApiKey) providerApiKey.value = '';
      const error = await patchDrained();
      if (error === null) syncInputs(latest, 'provider');
    });
  });

  testButton.addEventListener('click', () => {
    withBusy(testButton, async () => {
      const result = await api.testConnection();
      testResult.hidden = false;
      if (result.ok) {
        const modeText = result.mode === 'llm' ? '' : '（走了本地兜底）';
        testResult.className = 'ai-test-result ai-value-ok';
        testResult.textContent = `连接成功${modeText} · ${result.latencyMs}ms · 模型回复：${result.sample}`;
      } else {
        testResult.className = 'ai-test-result ai-error-text';
        testResult.textContent = `连接失败：${result.error === '' ? '未知原因' : result.error}`;
      }
    });
  });

  personaSave.addEventListener('click', () => {
    savePatch(personaSave, 'persona', () => ({
      persona: personaInput.value,
      petName: petNameInput.value.trim(),
      userName: userNameInput.value.trim(),
    }));
  });

  budgetSave.addEventListener('click', () => {
    savePatch(budgetSave, 'budget', () => {
      const value = numberValue(budgetInput);
      if (value === null || value < 0) {
        setPanelError('Token 预算必须是不小于 0 的数字（0 = 不限额）。');
        return null;
      }
      return { budget: { budget: Math.round(value) } };
    });
  });

  budgetReset.addEventListener('click', () => {
    withBusy(budgetReset, async () => {
      queuePatch({ resetUsage: true });
      const error = await patchDrained();
      if (error === null) {
        syncInputs(latest, 'budget');
        flashNote('用量已重置');
      }
    });
  });

  emotionReset.addEventListener('click', () => {
    withBusy(emotionReset, async () => {
      renderStatus(await api.resetEmotion());
      flashNote('情绪已重置');
    });
  });

  diaryWrite.addEventListener('click', () => {
    withBusy(diaryWrite, async () => {
      showDiaryEntry(await api.writeDiary());
      diaryToday.hidden = false;
      diaryToday.textContent = '今天已写过';
      flashNote('日记已写好');
      refreshDiary();
    });
  });

  diaryOpenDir.addEventListener('click', () => {
    withBusy(diaryOpenDir, async () => {
      if (!(await api.openDiaryDir())) {
        setPanelError('打开日记目录失败');
        return;
      }
      setPanelNote('已在文件管理器中打开日记目录');
    });
  });

  memoryOpenLog.addEventListener('click', () => {
    withBusy(memoryOpenLog, async () => {
      if (!(await api.openMemoryLog())) {
        setPanelError('打开记忆日志失败');
        return;
      }
      setPanelNote('已打开记忆日志');
    });
  });

  memoryClear.addEventListener('click', () => {
    // 清空记忆不可撤销，必须二次确认（window.confirm 不是 eval，CSP 下可用）
    if (!window.confirm('确定要清空全部记忆吗？事实、对话与流水都会被删除，且无法恢复。')) return;
    withBusy(memoryClear, async () => {
      renderMemory(await api.clearMemory());
      flashNote('记忆已清空');
    });
  });

  /* ------------------------------------------------------------------------ */
  /* 初始化与订阅                                                               */
  /* ------------------------------------------------------------------------ */

  syncInputs(initial, 'switches');
  syncInputs(initial, 'provider');
  syncInputs(initial, 'persona');
  syncInputs(initial, 'budget');
  renderStatus(initial);
  refreshDiary();
  refreshMemory();

  api.onStatus((status) => {
    renderStatus(status);

    // 只刷新只读部分与两个列表，绝不碰任何输入框（用户可能正在里面打字）。
    // "调用指纹"变化说明真的调过大模型 → 立刻刷；否则最多 4 秒刷一次兜底
    // （本地模板写的日记不增加调用次数，只能靠这个兜底发现）。
    const key = activityKey(status);
    const changed = key !== activity;
    activity = key;
    refreshLists(changed);
  });

  // bootstrap 快照是窗口打开那一刻读的，顺手校准一次（读不到就沿用手里的 initial）
  void api
    .status()
    .then(renderStatus)
    .catch((error: unknown) => {
      console.warn('[ai-panel] initial status refresh failed:', errorText(error));
    });
}
