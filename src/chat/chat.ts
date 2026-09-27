/**
 * 聊天窗口页面逻辑（聊天 + 小纸条 + 文件 + 插件面板）。
 *
 * 四个视图，一套桥：
 * 1. **聊天**：把你说的话交给主进程（`chatAPI.send`），把回复渲染出来；
 * 2. **小纸条**：读她记的纸条（未读、已读、删除、清空）；
 * 3. **文件**：看她收在 `notes/files/` 里的东西 —— 查看内容、用系统程序打开、删掉；
 * 4. **插件面板**：TODO / 课程表 / 番茄钟这类插件自己的界面（页签由面板动态生成）。
 * 另有共同的第三件事：渲染"她现在的状态"（心情 / 饿 / token 用量），让回复有解释。
 *
 * **页面本身不发任何网络请求**（CSP 是 `connect-src 'none'`，也拿不到密钥）：
 * 大模型调用全在主进程，密钥永远不进渲染进程。
 * **页面也读不到磁盘**：文件内容由主进程读好再递过来（`previewNoteFile`）。
 * **插件面板也没有脚本**：插件给的 HTML 先净化、交互只走 `data-plugin-action`，
 * 由主进程转交给真正跑在插件宿主里的插件（见 `plugin-panel-html`）。
 */

import type { ChatMessagePush, ChatTurn, DiaryIndexItem, DiarySnapshot } from '../shared/ai-types';
import { moodLabel, satietyLabel } from '../shared/emotion';
import type { ChatView, ChatWindowBridge, PluginPanelTarget } from '../shared/chat-window';
import {
  NOTE_KIND_LABELS,
  formatFileSize,
  formatNoteTime,
  senderLabel,
  totalAttachmentBytes,
  type Note,
  type NoteBox,
  type NoteFileEntry,
} from '../shared/notes';
import {
  PANEL_ACTION_ATTR,
  PANEL_FIELD_ATTR,
  PANEL_OPEN_LINK_ACTION,
  PANEL_VALUE_ATTR,
  sanitizePluginHtml,
} from '../shared/plugin-panel-html';
import type { PluginPanelView } from '../shared/plugin-types';

/**
 * 页面自己的视图名 = 契约里的 `ChatView` + 插件面板。
 *
 * 为什么不直接往 `ChatView` 里加 `'plugin'`：那个类型是主进程 / preload / 页面共用的契约，
 * 而"面板"是**渲染层的动态页签**（有几个面板就有几个页签，随时上下线），
 * 主进程只需要推 `ChatView`（托盘"去哪个视图"），不该知道面板页签的存在。
 */
type LocalView = ChatView | 'plugin';

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少必需的 DOM 元素: #${id}`);
  return element as T;
}

const bridge = (window as unknown as { chatAPI?: ChatWindowBridge }).chatAPI;

const messages = requireElement('messages');
const emptyHint = requireElement('empty-hint');
const input = requireElement<HTMLTextAreaElement>('input');
const sendButton = requireElement<HTMLButtonElement>('send');
const speakUpButton = requireElement<HTMLButtonElement>('speak-up');
const settingsButton = requireElement<HTMLButtonElement>('open-settings');
const closeButton = requireElement<HTMLButtonElement>('close-window');
const petNameLabel = requireElement('pet-name');
const modeBadge = requireElement('mode-badge');
const moodLine = requireElement('mood-line');
const satietyLine = requireElement('hunger-line');
const tokenLine = requireElement('token-line');
const errorBar = requireElement('error-bar');

/* 页签与三个视图（「文件」页已并入「交互」收件箱，见文件头） */
const tabChat = requireElement<HTMLButtonElement>('tab-chat');
const tabNotes = requireElement<HTMLButtonElement>('tab-notes');
const viewChat = requireElement('view-chat');
const viewNotes = requireElement('view-notes');
const notesBadge = requireElement('notes-badge');
const notesList = requireElement('notes-list');
const notesSummary = requireElement('notes-summary');
const notesReadButton = requireElement<HTMLButtonElement>('notes-read');
const notesClearButton = requireElement<HTMLButtonElement>('notes-clear');
const notesOpenDirButton = requireElement<HTMLButtonElement>('notes-open-dir');
const notesRefreshButton = requireElement<HTMLButtonElement>('notes-refresh');
const noteComposeButton = requireElement<HTMLButtonElement>('note-compose');
const fileImportButton = requireElement<HTMLButtonElement>('file-import');

/* 预览浮层（消息附件与未归档文件共用） */
const preview = requireElement('preview');
const previewName = requireElement('preview-name');
const previewMeta = requireElement('preview-meta');
const previewBody = requireElement('preview-body');
const previewOpenButton = requireElement<HTMLButtonElement>('preview-open');
const previewCloseButton = requireElement<HTMLButtonElement>('preview-close');

/* 日记视图（2026-09 从托盘 AI 子菜单搬进来的） */
const tabDiary = requireElement<HTMLButtonElement>('tab-diary');
const viewDiary = requireElement('view-diary');
const diarySummary = requireElement('diary-summary');
const diaryList = requireElement('diary-list');
const diaryWriteButton = requireElement<HTMLButtonElement>('diary-write');
const diaryOpenDirButton = requireElement<HTMLButtonElement>('diary-open-dir');
const diaryDetail = requireElement('diary-detail');
const diaryDetailTitle = requireElement('diary-detail-title');
const diaryDetailMeta = requireElement('diary-detail-meta');
const diaryDetailBody = requireElement('diary-detail-body');
const diaryDetailClose = requireElement<HTMLButtonElement>('diary-detail-close');

/* 插件面板视图（页签本身是动态建的，见 renderPanels） */
const viewPlugin = requireElement('view-plugin');
const pluginTitle = requireElement('plugin-panel-title');
const pluginFrom = requireElement('plugin-panel-from');
const pluginBody = requireElement('plugin-panel-body');
/** 页签栏：插件页签按面板顺序追加在「文件」之后。 */
const tabBar = requireElement('tabs');

/**
 * 面板的**全局键**（`pluginId` + `panelId`）。
 *
 * 为什么不能只用 `panelId`：它只在**插件内**唯一 —— TODO 和番茄钟都把自己的面板叫
 * `main` 是很正常的事。而主进程是把所有插件的面板拼成一条列表推过来的，
 * 单看 panelId 的话，点 B 插件的页签会画出 A 插件的面板，动作还会发给 A
 * （主进程按 pluginId 分发动作）。键里带上 pluginId 就没有这个歧义。
 *
 * 参数放宽到结构类型：面板快照（`PluginPanelView`）与"打开我的面板"的请求目标
 * （`PluginPanelTarget`）都要用它算同一把键，才能互相匹配上。
 */
function panelKey(panel: { readonly pluginId: string; readonly panelId: string }): string {
  return `${panel.pluginId}\u0000${panel.panelId}`;
}

let pending = 0;
let typing: HTMLElement | null = null;
/** 当前视图：切页签、以及托盘推来的"去哪个视图"都会更新它。 */
let currentView: LocalView = 'chat';

/*
 * 插件面板快照 + 当前面板。
 * `?? []`：桥由 preload 注入，面板字段是后加的 —— 万一拿到的是旧 preload，
 * 这里退化成"没有面板"，而不是整页在 `panels[0]` 上崩掉。
 */
let panels: readonly PluginPanelView[] = bridge?.initial.panels ?? [];
const firstPanel = panels[0];
/** 当前面板 id：与面板动作一起回传的对外身份（页签文字也用它取名）。 */
let activePanelId: string | null = firstPanel?.panelId ?? null;
/** 当前面板的全局键：查表、比对、画高亮一律用它（见 `panelKey` 的注释）。 */
let activePanelKey: string | null = firstPanel ? panelKey(firstPanel) : null;
/** 页签按钮：面板全局键 -> button（面板上下线时整批重建，见 syncPanelTabs）。 */
const panelTabs = new Map<string, HTMLButtonElement>();
/**
 * 插件"打开我的面板"的请求，但请求到达时那个面板**还没出现在快照里**。
 *
 * 这正是这条通道与 `onPanels` 分开的原因：插件注册面板与它请求打开面板的**先后顺序
 * 不保证**（托盘点一下的时候插件可能刚被激活）。所以先把它记下来，等下一次
 * `onPanels` 里出现同名面板再应用；用户又点了别的面板时，后来的请求直接覆盖它
 * —— 等一个可能永远不来的面板没有意义。
 */
let pendingPanelTarget: PluginPanelTarget | null = null;
let noteBusy = false;
/** 预览浮层当前显示的文件名（「用系统程序打开」用它）。 */
let previewing: string | null = null;

/* -------------------------------------------------------------------------- */
/* 渲染                                                                        */
/* -------------------------------------------------------------------------- */

/** 追加一条消息（role 决定左右与配色）。 */
function appendMessage(role: 'user' | 'pet' | 'system', text: string, at: string, level?: 'info' | 'warn' | 'error'): void {
  const article = document.createElement('article');
  article.className = role === 'user' ? 'msg msg-user' : role === 'pet' ? 'msg msg-pet' : 'msg msg-system';

  const bubble = document.createElement('p');
  bubble.className = 'bubble';
  // 用 textContent：模型输出里可能有尖括号，绝不能当 HTML 解析（XSS 面）
  bubble.textContent = text;
  article.appendChild(bubble);

  const time = document.createElement('time');
  const date = at ? new Date(at) : new Date();
  time.textContent = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  article.appendChild(time);

  if (level === 'warn' || level === 'error') article.classList.add('msg-warn');

  messages.appendChild(article);
  emptyHint.hidden = true;
  scrollToBottom();
}

function scrollToBottom(): void {
  // 新消息进来时贴到底部（聊天窗口的默认预期）
  messages.scrollTop = messages.scrollHeight;
}

/** 「她正在想…」占位。 */
function showTyping(show: boolean): void {
  if (show) {
    if (typing) return;
    typing = document.createElement('p');
    typing.className = 'typing';
    typing.textContent = '她正在想…';
    messages.appendChild(typing);
    scrollToBottom();
    return;
  }
  if (!typing) return;
  typing.remove();
  typing = null;
}

function showError(message: string): void {
  if (message.trim() === '') {
    errorBar.hidden = true;
    errorBar.textContent = '';
    return;
  }
  errorBar.hidden = false;
  errorBar.textContent = message;
}

function renderStatus(): void {
  if (!bridge) return;
  void bridge.status().then((status) => {
    const { settings } = status;
    petNameLabel.textContent = settings.petName || '鲸鱼娘';
    modeBadge.textContent = status.usable ? '已接入大模型' : '本地兜底';
    modeBadge.className = `badge ${status.usable ? 'badge-llm' : 'badge-local'}`;

    const mood = moodLabel(status.emotion.mood);
    const satiety = satietyLabel(status.emotion.satiety);
    moodLine.textContent = `心情 ${status.emotion.mood}（${mood.label}）${mood.face}`;
    satietyLine.textContent = `饱腹 ${status.emotion.satiety}（${satiety.label}）`;
    tokenLine.textContent = settings.budget.budget > 0
      ? `token ${settings.budget.used}/${settings.budget.budget}`
      : `token ${settings.budget.used}`;
  });
}

/* -------------------------------------------------------------------------- */
/* 发送                                                                        */
/* -------------------------------------------------------------------------- */

async function send(): Promise<void> {
  if (!bridge) return;
  const text = input.value.trim();
  if (text === '' || pending > 0) return;

  input.value = '';
  showError('');
  appendMessage('user', text, new Date().toISOString());
  pending += 1;
  sendButton.disabled = true;
  speakUpButton.disabled = true;
  showTyping(true);

  try {
    const result = await bridge.send(text);
    showTyping(false);
    // 回复由主进程通过 onMessage 推回来（桌宠窗口也要显示同一条），
    // 这里只处理失败信息与状态刷新，避免出现两条一样的消息。
    if (!result.ok) showError(result.error ?? '她没能回答你。');
    if (result.error && result.mode === 'local' && result.error !== '') showError(`降级为本地回复：${result.error}`);
  } catch (error) {
    showTyping(false);
    showError(`发送失败：${String(error)}`);
  } finally {
    pending -= 1;
    sendButton.disabled = false;
    speakUpButton.disabled = false;
    renderStatus();
    input.focus();
  }
}

/* -------------------------------------------------------------------------- */
/* 页签与视图                                                                  */
/* -------------------------------------------------------------------------- */

function setView(requested: LocalView): void {
  /*
   * 两个归一化：
   * - 面板全下线时没有"插件视图"可进（页签都没了）→ 退回聊天；
   * - 契约里的 `'files'` 现在**没有独立视图**了（文件已并进「交互」收件箱），
   *   任何残留的"去文件页"请求都落到收件箱，而不是停在一个不存在的视图上。
   */
  const normalized: LocalView = requested === 'files' ? 'notes' : requested;
  const view: LocalView = normalized === 'plugin' && panels.length === 0 ? 'chat' : normalized;
  currentView = view;
  viewChat.hidden = view !== 'chat';
  viewNotes.hidden = view !== 'notes';
  viewDiary.hidden = view !== 'diary';
  viewPlugin.hidden = view !== 'plugin';
  syncTabHighlight(view);
  if (view === 'notes') {
    // 打开「交互」= 看过了：标记已读（"新的"徽标随之消失）
    void markNotesRead();
    notesList.focus();
  } else if (view === 'diary') {
    // 切过来时拉一次清单：日记可能是在设置窗口里写的（那边也会写）
    void refreshDiary();
    diaryList.focus();
  } else if (view === 'plugin') {
    // 切页签就重画一次：插件可能在上次离开后更新了 HTML（updatedAt 变过）
    renderActivePanel();
    pluginBody.focus();
  } else {
    scrollToBottom();
  }
}

/** 高亮当前页签（三个固定页签 + 动态插件页签）。切视图与重建页签后都要调。 */
function syncTabHighlight(view: LocalView): void {
  tabChat.classList.toggle('tab-active', view === 'chat');
  tabNotes.classList.toggle('tab-active', view === 'notes');
  tabDiary.classList.toggle('tab-active', view === 'diary');
  for (const [key, tab] of panelTabs) {
    tab.classList.toggle('tab-active', view === 'plugin' && key === activePanelKey);
  }
}

/* -------------------------------------------------------------------------- */
/* 日记（从托盘的 AI 子菜单搬进来）                                             */
/* -------------------------------------------------------------------------- */

/** 当前日记清单（bootstrap 给一份，之后靠 `onDiary` 推送 + 自己拉）。 */
let diarySnapshot: DiarySnapshot | null = bridge?.initial.diary ?? null;
/** 正在展开的那一篇（null = 没展开）。 */
let openDiaryDate: string | null = null;

/** 日记列表的一行：日期 + 标题 + 摘要 + 情绪/来源标签；点它读正文。 */
function renderDiaryItem(item: DiaryIndexItem): HTMLElement {
  const card = document.createElement('article');
  card.className = 'note diary-item';
  card.id = `diary-item-${item.date}`;

  const meta = document.createElement('div');
  meta.className = 'note-meta';
  const date = document.createElement('time');
  date.textContent = item.date;
  const source = document.createElement('span');
  source.className = 'note-kind';
  // 大模型写的还是本地模板拼的：用户有权知道这一篇是怎么来的
  source.textContent = item.source === 'llm' ? '大模型' : '本地模板';
  const mood = document.createElement('span');
  mood.className = 'note-kind';
  mood.textContent = `心情 ${item.mood.start}→${item.mood.end}（最低 ${item.mood.low}）`;
  meta.append(date, source, mood);

  const title = document.createElement('p');
  title.className = 'note-title';
  title.textContent = item.title;

  const preview = document.createElement('p');
  preview.className = 'note-text';
  // 一律 textContent：日记正文里可能有尖括号，绝不能当 HTML 解析
  preview.textContent = item.preview;

  const actions = document.createElement('div');
  actions.className = 'note-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ghost note-delete diary-open';
  open.textContent = openDiaryDate === item.date ? '收起' : '看正文';
  open.addEventListener('click', () => {
    void toggleDiary(item.date);
  });
  actions.appendChild(open);

  card.append(meta, title, preview, actions);
  return card;
}

function renderDiary(): void {
  const snapshot = diarySnapshot;
  diaryList.textContent = '';
  const items = snapshot?.items ?? [];
  if (items.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'notes-empty';
    hint.textContent = '还没有写过日记。每天到点她会自己写一篇，也可以点上面的「写今天的日记」。';
    diaryList.appendChild(hint);
  } else {
    // 最新的在前（日记是"回顾"用的，和纸条"往下翻"的直觉不同）
    for (const item of items) diaryList.appendChild(renderDiaryItem(item));
  }
  diarySummary.textContent = items.length === 0
    ? '还没有写过日记。'
    : `共 ${items.length} 篇${snapshot?.todayWritten ? ' · 今天的已经写好了' : ''}`
      + (snapshot && snapshot.diaryHour >= 0 ? ` · 每天 ${snapshot.diaryHour} 点自动写` : '');
}

/** 展开/收起某一篇的正文（正文按需向主进程要，不在清单里传）。 */
async function toggleDiary(date: string): Promise<void> {
  if (openDiaryDate === date) {
    closeDiaryDetail();
    return;
  }
  if (!bridge) return;
  try {
    const entry = await bridge.diaryGet(date);
    if (!entry) {
      showError(`读不到 ${date} 的日记（文件可能被删了）`);
      return;
    }
    openDiaryDate = date;
    diaryDetail.hidden = false;
    diaryDetailTitle.textContent = `${entry.date} · ${entry.title}`;
    diaryDetailMeta.textContent = `${entry.source === 'llm' ? '大模型' : '本地模板'} · ${entry.tokens} token`;
    // textContent：模型输出绝不进 innerHTML
    diaryDetailBody.textContent = entry.body;
    renderDiary();
  } catch (error) {
    showError(`读日记失败：${String(error)}`);
  }
}

function closeDiaryDetail(): void {
  openDiaryDate = null;
  diaryDetail.hidden = true;
  diaryDetailBody.textContent = '';
  renderDiary();
}

/** 重新拉一次清单（切到日记页、写完一篇、主进程推送时都会调）。 */
async function refreshDiary(): Promise<void> {
  if (!bridge) return;
  try {
    diarySnapshot = await bridge.diary();
    renderDiary();
  } catch (error) {
    showError(`读日记清单失败：${String(error)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 插件面板（TODO / 课程表 / 番茄钟…）                                          */
/* -------------------------------------------------------------------------- */

/** 选定当前面板：全局键与对外 id 必须始终指同一个面板。 */
function selectPanel(panel: PluginPanelView | null): void {
  activePanelKey = panel === null ? null : panelKey(panel);
  activePanelId = panel?.panelId ?? null;
}

/** 当前正在显示的面板（没有面板、或它刚被插件下线时为 null）。 */
function activePanel(): PluginPanelView | null {
  const panel = panels.find((item) => panelKey(item) === activePanelKey) ?? null;
  // 两个身份必须一致；不一致说明状态没同步好，宁可当作"没有面板"也不要画错插件的东西
  return panel !== null && panel.panelId === activePanelId ? panel : null;
}

/**
 * 插件请求"打开我的面板"（托盘菜单 / 桌宠窗口点过来的）。
 *
 * 面板已经在快照里就直接切过去；**还没注册**时只记下目标，等 `onPanels` 送到再应用
 * （两边的先后顺序不保证）。后来的请求覆盖先前的待办 —— 用户点的是最新那一次。
 */
function requestPanel(target: PluginPanelTarget): void {
  const panel = findPanel(target);
  if (panel === null) {
    pendingPanelTarget = target;
    return;
  }
  // 这个请求已经满足了：之前等着的那个目标没有意义了
  pendingPanelTarget = null;
  selectPanel(panel);
  setView('plugin');
}

/** 在最近的快照里按全局键找面板（找不到 = 插件还没把它注册上来）。 */
function findPanel(target: PluginPanelTarget): PluginPanelView | null {
  const key = panelKey(target);
  return panels.find((panel) => panelKey(panel) === key) ?? null;
}

/**
 * 应用"还在等着"的请求（每次 `onPanels` 之后调）。
 * 面板没出现就继续等下一个快照：插件注册面板与请求打开面板的先后顺序不保证，
 * 等它出现比"点一下没反应"要合理得多。
 */
function applyPendingPanelTarget(): void {
  if (pendingPanelTarget === null) return;
  const panel = findPanel(pendingPanelTarget);
  if (panel === null) return;
  pendingPanelTarget = null;
  selectPanel(panel);
  setView('plugin');
}

/**
 * 重画面板页签与当前面板。
 *
 * **必须幂等**：启动、每次 `onPanels`、每次切视图之后都会调它，
 * 所以它不能依赖"只跑一次"（例如绝不能在这里累加事件监听）。
 */
function renderPanels(): void {
  // 正在看的面板没了（插件被停用 / 面板注销）：退到第一个还活着的面板
  selectPanel(activePanel() ?? panels[0] ?? null);
  syncPanelTabs();
  syncTabHighlight(currentView);
  if (activePanelId === null) clearPanel();
  else if (currentView === 'plugin') renderActivePanel();
}

/**
 * 按面板顺序重建插件页签：一个面板一个页签，追加在「文件」之后。
 *
 * 页签文字一律 `textContent` —— 插件名与面板名都是插件给的字符串，绝不拼 HTML。
 * 没有面板时这里一个都不建，插件页签就整块消失（页签栏只剩原本三个）。
 */
function syncPanelTabs(): void {
  for (const tab of panelTabs.values()) tab.remove();
  panelTabs.clear();

  for (const panel of panels) {
    const label = `${panel.pluginName} · ${panel.title}`;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab plugin-tab';
    tab.setAttribute('role', 'tab');
    tab.textContent = label;
    tab.title = label;
    tab.addEventListener('click', () => {
      selectPanel(panel);
      // 切到本面板：setView 会顺手 renderActivePanel()，拿到的永远是最新 HTML
      setView('plugin');
    });
    panelTabs.set(panelKey(panel), tab);
    // 追加在末尾 = 排在「文件」之后（插件页签始终是页签栏的尾巴）
    tabBar.appendChild(tab);
  }
}

/** 画当前面板：标题 + 「来自插件：x」+ 净化后的 HTML。 */
function renderActivePanel(): void {
  const panel = activePanel();
  if (!panel) {
    clearPanel();
    return;
  }

  pluginTitle.textContent = panel.title;
  pluginFrom.textContent = `来自插件：${panel.pluginName}`;
  /*
   * 本文件**唯一**一处 innerHTML（其余全部走 textContent）。
   *
   * 这里非用不可：面板本身就是一段声明式 HTML。敢用是因为它有两道锁：
   * 1) `sanitizePluginHtml` 只留展示型标签与 data-plugin-* 交互属性 ——
   *    `<script>` / 全部 `on*=` / 非 data: 的图片 / 非 http(s) 的链接都被剔除；
   * 2) 页面 CSP 是 `script-src 'self'`，注入的 `<script>` 与 `onclick=` 没有执行机会。
   * 于是面板里能发生的事只剩"显示"和"点 data-plugin-action"（走下面的点击委托）。
   */
  pluginBody.innerHTML = sanitizePluginHtml(panel.html);
  pluginBody.scrollTop = 0;
}

/** 清空面板体：面板被下线后不能把上一个插件的界面留在窗口里。 */
function clearPanel(): void {
  pluginTitle.textContent = '插件面板';
  pluginFrom.textContent = '';
  pluginBody.textContent = '';
}

/** 一个输入控件的当前值：勾选框给 '1'/'0'，其余给 value。 */
function fieldValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') return element.checked ? '1' : '0';
    return element.value;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
  // 净化后 `data-plugin-field` 只会落在 input/textarea/select 上，这条是兜底
  return element.textContent ?? '';
}

/**
 * 收整面板的字段快照（不只是触发按钮旁边那个）。
 *
 * 为什么给全量：插件是"动作进来 → 用新值重画整段 HTML"，它不该去猜用户改过哪些框；
 * 一次动作带上所有 `data-plugin-field` 的当前值，插件照着重画就行。
 */
function collectFields(trigger: Element): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const element of pluginBody.querySelectorAll<HTMLElement>(`[${PANEL_FIELD_ATTR}]`)) {
    const name = element.getAttribute(PANEL_FIELD_ATTR);
    if (name === null || name === '') continue;
    fields[name] = fieldValue(element);
  }
  // 按钮随身带的值（`data-plugin-value`）：省掉一个隐藏输入框。
  // 不覆盖同名输入框 —— 用户刚在框里敲的字才是他真正的意思。
  const own = trigger.getAttribute(PANEL_VALUE_ATTR);
  if (own !== null && fields.value === undefined) fields.value = own;
  return fields;
}

/** 把一个面板动作交回主进程（桥没注入时静默忽略，与其它按钮一致）。 */
function sendPanelAction(panel: PluginPanelView, actionId: string, fields: Readonly<Record<string, string>>): void {
  bridge?.panelAction({ pluginId: panel.pluginId, panelId: panel.panelId, actionId, fields });
}

/* -------------------------------------------------------------------------- */
/* 小纸条                                                                      */
/* -------------------------------------------------------------------------- */

/** 画一条纸条（她的收纳条目）。 */
/**
 * 一行附件（**消息附件与未归档文件共用**）。
 *
 * 「查看」与「打开」都只把**文件名**交给主进程 —— 路径由主进程自己解析并校验，
 * 渲染层拿不到"打开任意路径"的能力。
 */
function renderAttachmentRow(
  file: { readonly name: string; readonly size: number },
  options: {
    /** 额外的一行小字（未归档文件用"最后修改时间"）。 */
    readonly meta?: string;
    /** 这个附件能不能单独删。 */
    readonly onDelete?: (button: HTMLButtonElement) => void;
  } = {},
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'note-file';

  const name = document.createElement('span');
  name.className = 'note-file-name';
  name.textContent = `📎 ${file.name} · ${formatFileSize(file.size)}${options.meta ? ` · ${options.meta}` : ''}`;
  name.title = file.name;

  const view = document.createElement('button');
  view.type = 'button';
  view.className = 'ghost note-file-open';
  view.textContent = '查看';
  view.addEventListener('click', () => {
    void openPreview(file.name);
  });

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'ghost note-file-open';
  open.textContent = '打开';
  open.addEventListener('click', () => {
    void bridge?.openNoteFileByName(file.name);
  });

  row.append(name, view, open);

  if (options.onDelete) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost note-file-open note-file-delete';
    remove.textContent = '删除';
    remove.addEventListener('click', () => options.onDelete?.(remove));
    row.appendChild(remove);
  }
  return row;
}

/** 一条消息（邮件式：发件人 + 主题 + 正文 + 0..N 个附件）。 */
function renderNote(note: Note): HTMLElement {
  const card = document.createElement('article');
  // `note-message` 是**真实消息**的钩子（`.note` 也被"未归档"那封虚拟邮件复用）
  card.className = 'note note-message';
  card.id = `note-${note.id}`;
  if (!note.read) card.classList.add('note-unread');

  const meta = document.createElement('div');
  meta.className = 'note-meta';
  const from = document.createElement('span');
  from.className = 'note-from';
  // 发件人一眼可见：她 / 某个插件 / 系统 —— 合并成邮件后这是最重要的一列
  from.textContent = senderLabel(note.sender, petNameLabel.textContent ?? '她');
  const kind = document.createElement('span');
  kind.className = 'note-kind';
  kind.textContent = NOTE_KIND_LABELS[note.kind] ?? '';
  const time = document.createElement('time');
  time.textContent = formatNoteTime(note.at);
  meta.append(from, kind, time);
  if (note.files.length > 0) {
    const clip = document.createElement('span');
    clip.className = 'note-kind';
    clip.textContent = `📎 ${note.files.length} · ${formatFileSize(totalAttachmentBytes(note))}`;
    meta.appendChild(clip);
  }

  const title = document.createElement('p');
  title.className = 'note-title';
  title.textContent = note.title;

  const body = document.createElement('p');
  body.className = 'note-text';
  // 一律 textContent：模型/插件给的文本里可能有尖括号，绝不能当 HTML 解析（XSS 面）
  body.textContent = note.text;

  card.append(meta, title, body);

  /*
   * 附件行：文件就在 `notes/files/` 里。一条消息可以带多个附件（邮件模型），
   * 每个都能单独删（删的只是收纳夹里这份副本）。
   */
  for (const file of note.files) {
    card.appendChild(
      renderAttachmentRow(file, {
        onDelete: (button) => {
          void deleteAttachment(file, button);
        },
      }),
    );
  }

  /*
   * 「删除」：删掉这条消息本身。**邮件语义**：连同它的附件一起删
   * （主进程会跳过仍被别的消息引用的附件），所以确认文案要说清楚。
   */
  const actions = document.createElement('div');
  actions.className = 'note-actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'ghost note-delete';
  remove.textContent = '删除';
  const attachmentNote = note.files.length > 0 ? `（连同 ${note.files.length} 个附件一起删）` : '';
  remove.addEventListener('click', () => {
    if (!bridge || noteBusy) return;
    if (!window.confirm(`删掉「${note.title}」这条消息吗？${attachmentNote}`)) return;
    void runNoteAction(remove, () => bridge!.deleteNote(note.id), '删除中…');
  });
  actions.appendChild(remove);
  card.appendChild(actions);

  return card;
}

/**
 * 「未归档的文件」：磁盘上存在、但没有任何消息引用它们的文件。
 *
 * 合并成邮件之后这是必须的一块 —— 否则手工放进 `files/` 的文件（或消息被清空后
 * 剩下的文件）就再也看不见了。
 */
function renderOrphans(entries: readonly NoteFileEntry[]): HTMLElement {
  const card = document.createElement('article');
  card.className = 'note note-orphans';
  card.id = 'note-orphans';

  const meta = document.createElement('div');
  meta.className = 'note-meta';
  const from = document.createElement('span');
  from.className = 'note-from';
  from.textContent = '未归档';
  const count = document.createElement('span');
  count.className = 'note-kind';
  count.textContent = `${entries.length} 个文件`;
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const size = document.createElement('span');
  size.className = 'note-kind';
  size.textContent = formatFileSize(total);
  meta.append(from, count, size);

  const title = document.createElement('p');
  title.className = 'note-title';
  title.textContent = '未归档的文件';

  const body = document.createElement('p');
  body.className = 'note-text';
  body.textContent = '这些文件在收纳夹里，但没有挂到任何一条消息上（手工放进来的、或消息被清空后剩下的）。';

  card.append(meta, title, body);
  for (const entry of entries) {
    card.appendChild(
      renderAttachmentRow(entry, {
        meta: formatNoteTime(entry.modifiedAt),
        onDelete: (button) => {
          void deleteAttachment(entry, button);
        },
      }),
    );
  }
  return card;
}

function renderNotes(box: NoteBox): void {
  notesList.textContent = '';
  const list = box.notes;
  const orphans = box.orphans ?? [];

  if (list.length === 0 && orphans.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'notes-empty';
    hint.textContent = '收件箱还是空的。她想起什么重要的事、或者插件交出文件时，就会出现在这里（日记在「日记」页）。';
    notesList.appendChild(hint);
  } else {
    // 最新在前（邮件列表的默认顺序）；未归档固定在最下面，不跟消息抢位置
    for (const note of list) notesList.appendChild(renderNote(note));
    if (orphans.length > 0) notesList.appendChild(renderOrphans(orphans));
  }

  const attachments = list.reduce((sum, note) => sum + note.files.length, 0);
  const parts = [`共 ${list.length} 条`];
  if (attachments > 0) parts.push(`附件 ${attachments} 个`);
  if (orphans.length > 0) parts.push(`未归档 ${orphans.length} 个`);
  if (box.unread > 0) parts.push(`${box.unread} 条新的`);
  notesSummary.textContent = list.length === 0 && orphans.length === 0 ? '收件箱还是空的。' : parts.join(' · ');
  notesReadButton.disabled = box.unread === 0;
  notesClearButton.disabled = list.length === 0;

  if (box.unread > 0) {
    notesBadge.hidden = false;
    notesBadge.textContent = String(box.unread);
  } else {
    notesBadge.hidden = true;
    notesBadge.textContent = '0';
  }

  // 新的在最上面：列表贴回顶部（"翻邮件"的直觉是从上往下看）
  notesList.scrollTop = 0;
}

/** 重新拉一遍收件箱（刷新按钮 / 切到该页时）。 */
async function refreshNotes(): Promise<void> {
  if (!bridge) return;
  try {
    renderNotes(await bridge.notes());
  } catch (error) {
    showError(`读取收件箱失败：${String(error)}`);
  }
}

/** 删掉一个附件（不可撤销，先确认；只删收纳夹里这份副本）。 */
async function deleteAttachment(
  file: { readonly name: string },
  button: HTMLButtonElement,
): Promise<void> {
  if (!bridge || noteBusy) return;
  if (!window.confirm(`删掉附件「${file.name}」吗？\n（只是收纳夹里的副本，不可撤销）`)) return;
  noteBusy = true;
  button.disabled = true;
  try {
    const result = await bridge.deleteNoteFile(file.name);
    if (!result.ok) showError(result.reason ?? '删除失败。');
    else showError('');
    if (previewing === file.name) closePreview();
    await refreshNotes();
  } catch (error) {
    showError(`删除失败：${String(error)}`);
  } finally {
    noteBusy = false;
    button.disabled = false;
  }
}

/** 标记看过（切到交互页、或点「全部已读」时）。 */
async function markNotesRead(): Promise<void> {
  if (!bridge) return;
  try {
    renderNotes(await bridge.markNotesRead());
  } catch (error) {
    showError(`标记失败：${String(error)}`);
  }
}

/** 统一的"收件箱操作"：按钮禁用 + 结果落渲染 + 错误提示。 */
async function runNoteAction(
  button: HTMLButtonElement,
  action: () => Promise<NoteBox>,
  busyText: string,
): Promise<void> {
  if (!bridge || noteBusy) return;
  noteBusy = true;
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = busyText;
  try {
    renderNotes(await action());
  } catch (error) {
    showError(`收件箱操作失败：${String(error)}`);
  } finally {
    noteBusy = false;
    button.disabled = false;
    button.textContent = previous;
  }
}

/* -------------------------------------------------------------------------- */
/* 文件预览浮层（消息附件与未归档文件共用）                                       */
/* -------------------------------------------------------------------------- */

function closePreview(): void {
  previewing = null;
  preview.hidden = true;
  previewBody.textContent = '';
}

/**
 * 打开预览：内容全部由主进程读好递过来。
 * - 文本 → `<pre>`（`textContent`，绝不解析 HTML）
 * - 图片 → `<img src="data:…">`（CSP 里 `img-src data:` 就是为它开的）
 * - 其它 → 一句说明 + 「用系统程序打开」
 */
async function openPreview(name: string): Promise<void> {
  if (!bridge || name === '') return;
  try {
    const result = await bridge.previewNoteFile(name);
    previewing = name;
    previewName.textContent = result.name || name;
    previewMeta.textContent = `${formatFileSize(result.size)}${
      result.preview === 'text' ? ' · 文本' : result.preview === 'image' ? ' · 图片' : ' · 需要系统程序'
    }`;
    previewBody.textContent = '';

    if (!result.ok) {
      const note = document.createElement('p');
      note.className = 'preview-note';
      note.textContent = result.reason ?? '读不出来。';
      previewBody.appendChild(note);
    } else if (result.preview === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'preview-text';
      pre.textContent = result.text ?? '';
      previewBody.appendChild(pre);
      if (result.truncated) {
        const note = document.createElement('p');
        note.className = 'preview-note muted';
        note.textContent = '文件很长，这里只显示开头一段；完整内容请用系统程序打开。';
        previewBody.appendChild(note);
      }
    } else if (result.preview === 'image') {
      const img = document.createElement('img');
      img.className = 'preview-image';
      img.alt = result.name;
      img.src = result.dataUrl ?? '';
      previewBody.appendChild(img);
    } else {
      const note = document.createElement('p');
      note.className = 'preview-note';
      note.textContent = '这个类型没法在窗口里显示，用系统程序打开吧。';
      previewBody.appendChild(note);
    }

    preview.hidden = false;
    previewCloseButton.focus();
  } catch (error) {
    showError(`预览失败：${String(error)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 事件                                                                        */
/* -------------------------------------------------------------------------- */

tabChat.addEventListener('click', () => setView('chat'));
tabNotes.addEventListener('click', () => setView('notes'));
tabDiary.addEventListener('click', () => setView('diary'));

/*
 * 插件面板的交互：整个面板体上**一次**点击委托，不给面板里的元素逐个挂监听。
 * 两个原因：面板 HTML 每来一个动作就被整段替换（监听器会跟着没），
 * 而且那等于让插件的内容决定宿主注册多少回调（插件一多就漏）。
 */
pluginBody.addEventListener('click', (event) => {
  const panel = activePanel();
  const target = event.target;
  if (!panel || !(target instanceof Element)) return;

  /*
   * 1) `<a href>`：页面自己不许联网（CSP `connect-src 'none'`），
   *    所以链接不导航，而是把 href 交回主进程用系统浏览器打开
   *    （保留动作 `@open-external`，插件不用为此写代码）。
   *    带 `data-plugin-action` 的"按钮样式的链接"要跳过这条，走下面的动作分支。
   */
  const link = target.closest('a[href]');
  if (link && !target.closest(`[${PANEL_ACTION_ATTR}]`)) {
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href === '') return;
    sendPanelAction(panel, PANEL_OPEN_LINK_ACTION, { href });
    return;
  }

  /* 2) 声明式动作：动作 id + 面板字段快照 */
  const trigger = target.closest(`[${PANEL_ACTION_ATTR}]`);
  if (!trigger) return;
  const actionId = trigger.getAttribute(PANEL_ACTION_ATTR) ?? '';
  if (actionId === '') return;
  sendPanelAction(panel, actionId, collectFields(trigger));
});

/*
 * 回车 = 点第一个动作按钮（TODO 那种"输一行 + 添加"不必先用鼠标）。
 * 只在"焦点在字段输入框里 + 面板里确实有动作按钮"时这么解释；
 * 否则回车没有任何含义，交回浏览器默认行为（例如文本域换行）。
 */
pluginBody.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  // 勾选框/单选框用空格切换，回车不该顺手提交整个面板
  if (target.type === 'checkbox' || target.type === 'radio') return;
  if (!target.closest(`[${PANEL_FIELD_ATTR}]`)) return;

  const trigger = pluginBody.querySelector<HTMLElement>(`[${PANEL_ACTION_ATTR}]`);
  if (!trigger) return;
  event.preventDefault();
  // 派发一次点击，走上面同一条委托（一次动作只有一处实现）
  trigger.click();
});

sendButton.addEventListener('click', () => {
  void send();
});

speakUpButton.addEventListener('click', () => {
  if (!bridge || pending > 0) return;
  pending += 1;
  speakUpButton.disabled = true;
  showTyping(true);
  void bridge
    .speakUp()
    .then((result) => {
      if (!result.ok) showError(result.error ?? '她好像不想说话。');
    })
    .catch((error: unknown) => showError(`失败：${String(error)}`))
    .finally(() => {
      showTyping(false);
      pending -= 1;
      speakUpButton.disabled = false;
      renderStatus();
    });
});

input.addEventListener('keydown', (event) => {
  // Enter 发送、Shift+Enter 换行（聊天窗口的通用约定）
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
});

settingsButton.addEventListener('click', () => {
  void bridge?.openSettings();
});

closeButton.addEventListener('click', () => {
  void bridge?.close();
});

noteComposeButton.addEventListener('click', () => {
  if (!bridge) return;
  void runNoteAction(noteComposeButton, () => bridge.composeNote(), '她正在记…');
});

notesReadButton.addEventListener('click', () => {
  void markNotesRead();
});

notesOpenDirButton.addEventListener('click', () => {
  void bridge?.openNotesDir();
});

notesClearButton.addEventListener('click', () => {
  if (!bridge || noteBusy) return;
  // 清空不可撤销，必须二次确认（window.confirm 不是 eval，CSP 下可用）
  // 邮件语义：附件也跟着清（没被别的消息引用的那些），所以文案要说清楚
  if (!window.confirm('确定清空收件箱吗？（每条消息连同它的附件一起删除，不可撤销）')) return;
  void runNoteAction(notesClearButton, () => bridge.clearNotes(), '清理中…');
});

notesRefreshButton.addEventListener('click', () => {
  void refreshNotes();
});

/* 收纳文件…：选一个文件复制进收纳夹，并作为一条新消息的附件（原来在「文件」页签里） */
fileImportButton.addEventListener('click', () => {
  if (!bridge || noteBusy) return;
  noteBusy = true;
  fileImportButton.disabled = true;
  const previous = fileImportButton.textContent;
  fileImportButton.textContent = '收纳中…';
  void bridge
    .importNoteFile()
    .then((box) => {
      // null = 用户取消了选择框，什么都不做
      if (!box) return;
      renderNotes(box);
      showError('');
    })
    .catch((error: unknown) => showError(`收纳文件失败：${String(error)}`))
    .finally(() => {
      noteBusy = false;
      fileImportButton.disabled = false;
      fileImportButton.textContent = previous;
    });
});

/* 预览浮层 */
previewCloseButton.addEventListener('click', () => closePreview());

/* 日记：写一篇 / 打开目录 / 收起正文 */
diaryWriteButton.addEventListener('click', () => {
  if (!bridge || noteBusy) return;
  noteBusy = true;
  diaryWriteButton.disabled = true;
  const previous = diaryWriteButton.textContent;
  diaryWriteButton.textContent = '正在写…';
  void bridge
    .writeDiary()
    .then((entry) => {
      showError('');
      openDiaryDate = null;
      diaryDetail.hidden = false;
      diaryDetailTitle.textContent = `${entry.date} · ${entry.title}`;
      diaryDetailMeta.textContent = `${entry.source === 'llm' ? '大模型' : '本地模板'} · ${entry.tokens} token`;
      diaryDetailBody.textContent = entry.body;
      openDiaryDate = entry.date;
      return refreshDiary();
    })
    .catch((error: unknown) => showError(`写日记失败：${String(error)}`))
    .finally(() => {
      noteBusy = false;
      diaryWriteButton.disabled = false;
      diaryWriteButton.textContent = previous;
    });
});

diaryOpenDirButton.addEventListener('click', () => {
  void bridge?.openDiaryDir();
});

diaryDetailClose.addEventListener('click', () => closeDiaryDetail);
previewOpenButton.addEventListener('click', () => {
  if (previewing !== null) void bridge?.openNoteFileByName(previewing);
});
preview.addEventListener('click', (event) => {
  // 点浮层背景（而不是内容框）也关闭 —— 弹层的通用习惯
  if (event.target === preview) closePreview();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !preview.hidden) closePreview();
});

/* -------------------------------------------------------------------------- */
/* 初始化                                                                      */
/* -------------------------------------------------------------------------- */

function renderHistory(turns: readonly ChatTurn[]): void {
  messages.textContent = '';
  typing = null;
  if (turns.length === 0) {
    emptyHint.hidden = false;
    return;
  }
  emptyHint.hidden = true;
  // 历史是倒序给的：反过来按时间正序渲染
  for (const turn of [...turns].reverse()) {
    appendMessage(turn.role === 'user' ? 'user' : 'pet', turn.text, turn.at);
  }
}

if (!bridge) {
  showError('聊天桥未注入（preload 失败）');
  sendButton.disabled = true;
} else {
  renderHistory(bridge.initial.history);
  renderStatus();
  renderNotes(bridge.initial.notes);
  renderDiary();
  // 先把插件页签建好，再进视图 —— 这样 setView 一上来就能把高亮画对
  renderPanels();
  setView(
    bridge.initial.view === 'notes' || bridge.initial.view === 'diary' || bridge.initial.view === 'files'
      ? bridge.initial.view
      : 'chat',
  );

  bridge.onMessage((message: ChatMessagePush) => {
    showTyping(false);
    appendMessage(message.role, message.text, message.at, message.level);
    // 她说话/系统提示往往伴随情绪与 token 变化：顺手刷新状态条
    renderStatus();
  });
  bridge.onStatus(() => renderStatus());
  /*
   * 她刚写来的纸条：如果你正看着留言箱，就顺手标成已读
   * （人已经在看了，"未读"没有意义；不在这个视图时才留徽标提醒）。
   */
  bridge.onNotes((box) => {
    renderNotes(box);
    if (currentView === 'notes' && box.unread > 0) void markNotesRead();
  });
  /*
   * 日记写完（设置窗口里点的、或者每天自动写的那一篇）：刷新清单。
   * 正开着日记页时顺手把刚写的那篇展开 —— 用户点「写今天的日记」就是想看内容。
   */
  bridge.onDiary((snapshot) => {
    diarySnapshot = snapshot;
    renderDiary();
  });
  // 托盘「交互…」会推一条"去哪个视图"（窗口已经开着时 bootstrap 用不上了）
  bridge.onView((view) => setView(view));
  /*
   * 面板上下线（插件被启用/停用、面板注销）：整批重画页签。
   * `vanished` 只看"我正在看的那个面板还在不在" —— 只有这样才需要退回聊天，
   * 免得停在一个已经不存在、也点不动的面板上。0 → N（插件刚起来）绝不改视图：
   * 用户可能正在聊天框里打字，抢焦点是很讨厌的事。
   */
  bridge.onPanels((next) => {
    const vanished = activePanelKey !== null && !next.some((panel) => panelKey(panel) === activePanelKey);
    panels = next;
    renderPanels();
    if (vanished) {
      clearPanel();
      if (currentView === 'plugin') setView('chat');
    }
    /*
     * 最后才处理"插件要打开自己的面板"：它可能正好在这一批里出现，
     * 那就以它为准 —— 插件明确点名的面板，优先于"刚才看的那个没了，退回去吧"。
     */
    applyPendingPanelTarget();
  });
  /*
   * 托盘「插件 → 打开面板…」/ 桌宠窗口推来的"打开某个插件的某个面板"。
   * 与 `onPanels` 分开是有意的：请求可能早于面板注册到达（插件刚被激活），
   * 所以这条通道允许"先记住目标，等面板出现再切过去"（见 requestPanel）。
   */
  bridge.onPanelRequest((target) => requestPanel(target));
}

renderStatus();
