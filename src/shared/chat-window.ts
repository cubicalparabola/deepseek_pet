/**
 * 聊天窗口的跨进程契约（Main / Preload / 聊天页面共用）。
 *
 * 为什么要单独开一个窗口跟桌宠说话：
 * - 桌宠窗口是透明、无边框、点击穿透的"活体图层"，里面放输入框既看不见
 *   （透明背景）也会跟着桌宠缩放，还会被 `setIgnoreMouseEvents` 吃掉键盘焦点；
 * - 聊天是**有历史、要滚动、要打字**的交互，天然属于普通窗口。
 *
 * 于是分成三个窗口，各司其职：
 *   桌宠窗口   —— 动画与气泡（她"说"给你听的地方）
 *   聊天窗口   —— 你打字的地方（本文件）
 *   设置窗口   —— 开关、密钥、日记、记忆的查看与配置
 *
 * 安全：与设置窗口同一套基线 —— 复用同一份 preload 产物，
 * 靠命令行参数 `--pet-window=chat` 只暴露 `window.chatAPI`。
 */

import type { AIStatusView, ChatMessagePush, ChatTurn } from './ai-types';

/** preload 命令行参数的 key 与值。 */
export const CHAT_WINDOW_FLAG = '--pet-window=chat';
export const CHAT_BOOTSTRAP_FLAG = '--pet-chat-bootstrap=';

/** 聊天窗口 preload 通过 `additionalArguments` 注入的启动数据。 */
export interface ChatWindowBootstrap {
  /** 打开窗口时的历史消息（倒序 -> 页面自己反转）。 */
  readonly history: readonly ChatTurn[];
  /** 打开窗口时的 AI 状态（决定顶部提示"本地兜底/已接入大模型"）。 */
  readonly status: AIStatusView;
}

/** `window.chatAPI` 的形状。 */
export interface ChatWindowBridge {
  readonly initial: ChatWindowBootstrap;
  /** 发一句话，返回宠物这一轮的回复。 */
  send(text: string): Promise<{ ok: boolean; reply: string; mode: 'llm' | 'local'; tokens: number; error?: string }>;
  /** 让她主动说一句话（心情低的时候语气会不一样）。 */
  speakUp(): Promise<{ ok: boolean; reply: string; mode: 'llm' | 'local'; tokens: number; error?: string }>;
  /** 重新拉取历史（窗口复用时用）。 */
  history(): Promise<readonly ChatTurn[]>;
  /** 当前状态（模式、心情、饥饿）。 */
  status(): Promise<AIStatusView>;
  /** 订阅宠物主动说话 / 系统提示。 */
  onMessage(handler: (message: ChatMessagePush) => void): () => void;
  /** 订阅状态变化（心情心跳）。 */
  onStatus(handler: (status: AIStatusView) => void): () => void;
  /** 打开设置窗口（顶部「设置」按钮）。 */
  openSettings(): Promise<boolean>;
  /** 关闭聊天窗口（隐藏，不销毁）。 */
  close(): Promise<void>;
}
