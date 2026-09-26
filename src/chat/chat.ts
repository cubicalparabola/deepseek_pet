/**
 * 聊天窗口页面逻辑（2.1）。
 *
 * 只做三件事：
 * 1. 把你说的话交给主进程（`chatAPI.send`），把回复渲染出来；
 * 2. 渲染"她现在的状态"（心情 / 饿 / token 用量），让回复有解释；
 * 3. 接收主进程推送（她主动说话、日记写好、系统提示）。
 *
 * **页面本身不发任何网络请求**（CSP 是 `connect-src 'none'`，也拿不到密钥）：
 * 大模型调用全在主进程，密钥永远不进渲染进程。
 */

import type { ChatMessagePush, ChatTurn } from '../shared/ai-types';
import { moodLabel, satietyLabel } from '../shared/emotion';
import type { ChatWindowBridge } from '../shared/chat-window';

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

let pending = 0;
let typing: HTMLElement | null = null;

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
/* 事件                                                                        */
/* -------------------------------------------------------------------------- */

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

  bridge.onMessage((message: ChatMessagePush) => {
    showTyping(false);
    appendMessage(message.role, message.text, message.at, message.level);
    // 她说话/系统提示往往伴随情绪与 token 变化：顺手刷新状态条
    renderStatus();
  });
  bridge.onStatus(() => renderStatus());
}

renderStatus();
