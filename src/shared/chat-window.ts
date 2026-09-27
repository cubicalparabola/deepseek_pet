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

import type { AIStatusView, ChatMessagePush, ChatTurn, DiaryEntry, DiarySnapshot } from './ai-types';
import type { NoteBox, NoteFileEntry, NotePreview } from './notes';
import type { PluginPanelAction, PluginPanelView } from './plugin-types';

/** preload 命令行参数的 key 与值。 */
export const CHAT_WINDOW_FLAG = '--pet-window=chat';
export const CHAT_BOOTSTRAP_FLAG = '--pet-chat-bootstrap=';

/**
 * 窗口里的视图。
 *
 * 为什么把"小纸条""日记""文件"都放进这个窗口而不是各开一个：它们都是"和她有关的内容"，
 * 而且都需要**列表 + 滚动 + 打开文件**——正是这个窗口已经具备的东西。
 * 顶部页签切换，不额外多窗口、也不多一套 preload/构建产物。
 *
 * 2026-09 调整：**日记从菜单的 AI 子菜单搬到了这里**（那一整块子菜单被删掉），
 * 因此多出 `diary` 这一页；「小纸条」页签也随菜单改名成「交互」——
 * 这个窗口现在承载的是"她记的事 + 她的日记 + 她收的文件"。
 */
export type ChatView = 'chat' | 'notes' | 'diary' | 'files';

/** "切到某个插件面板"的目标（Main -> 聊天窗口）。 */
export interface PluginPanelTarget {
  readonly pluginId: string;
  readonly panelId: string;
}

/** 聊天窗口 preload 通过 `additionalArguments` 注入的启动数据。 */
export interface ChatWindowBootstrap {
  /** 打开窗口时的历史消息（倒序 -> 页面自己反转）。 */
  readonly history: readonly ChatTurn[];
  /** 打开窗口时的 AI 状态（决定顶部提示"本地兜底/已接入大模型"）。 */
  readonly status: AIStatusView;
  /** 打开窗口时的收纳夹。 */
  readonly notes: NoteBox;
  /**
   * 打开窗口时的日记清单（「交互」窗口的日记页）。
   *
   * 日记原来是托盘 AI 子菜单里的两项（看今天的日记 / 打开日记目录），
   * 2026-09 需求把那一整块子菜单删掉，日记改从这里进。
   */
  readonly diary: DiarySnapshot;
  /** 打开时显示哪个视图（托盘「小纸条…」直接进 notes）。 */
  readonly view: ChatView;
  /**
   * 打开窗口时已注册的插件面板。
   *
   * 为什么插件面板渲染在**聊天窗口**里：它需要"列表 + 滚动 + 打字"，
   * 正是这个窗口已经具备的东西；桌宠窗口是透明、点击穿透、跟着缩放的小图层，
   * 放不下 TODO 列表与课程表。面板内容是一段**被净化的 HTML**（没有脚本），
   * 交互只走 `data-plugin-action`，由主进程转交给插件处理。
   */
  readonly panels: readonly PluginPanelView[];
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
  /** 当前状态（模式、心情、饱腹）。 */
  status(): Promise<AIStatusView>;
  /** 读收纳夹。 */
  notes(): Promise<NoteBox>;
  /** 让她自己记一件重要的事。 */
  composeNote(): Promise<NoteBox>;
  /** 全部标记为看过。 */
  markNotesRead(): Promise<NoteBox>;
  /** 删掉一条纸条（只删记录；收纳夹里的文件不动）。 */
  deleteNote(id: string): Promise<NoteBox>;
  /** 清空纸条记录（`files/` 里的文件不动）。 */
  clearNotes(): Promise<NoteBox>;
  /** 打开某条纸条附带的文件（传纸条 id，主进程自己解析路径）。 */
  openNoteFile(id: string): Promise<boolean>;
  /** 在文件管理器里打开收纳夹目录。 */
  openNotesDir(): Promise<boolean>;
  /** 收纳夹里的文件清单（扫 `notes/files/`）。 */
  noteFiles(): Promise<readonly NoteFileEntry[]>;
  /** 读一个文件的内容（文本 / 图片 / 只能交给系统程序）给界面看。 */
  previewNoteFile(name: string): Promise<NotePreview>;
  /** 用系统默认程序打开收纳夹里的文件。 */
  openNoteFileByName(name: string): Promise<boolean>;
  /** 删掉收纳夹里的文件（不可撤销）。 */
  deleteNoteFile(name: string): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  /** 弹系统文件选择框，把选中的文件收进收纳夹；null = 用户取消。 */
  importNoteFile(): Promise<NoteBox | null>;
  /**
   * 日记（从菜单的 AI 子菜单搬进来的三项动作）。
   *
   * 读清单 / 读某一篇 / 立刻写今天的日记 / 打开日记目录 —— 与设置窗口的
   * AI 面板共用同一批 IPC（`AIDiaryList` / `AIDiaryGet` / `AIDiaryWriteNow` / `AIDiaryOpenDir`），
   * 因此两边看到的永远是同一份日记。
   */
  diary(): Promise<DiarySnapshot>;
  /** 读某一篇日记（date = YYYY-MM-DD）；不存在返回 null。 */
  diaryGet(date: string): Promise<DiaryEntry | null>;
  /** 立刻写今天的日记（已写过则覆盖）。 */
  writeDiary(): Promise<DiaryEntry>;
  /** 在文件管理器里打开日记目录。 */
  openDiaryDir(): Promise<boolean>;
  /** 订阅日记清单变化（写完新的一篇后主进程会推一次）。 */
  onDiary(handler: (snapshot: DiarySnapshot) => void): () => void;
  /** 订阅宠物主动说话 / 系统提示。 */
  onMessage(handler: (message: ChatMessagePush) => void): () => void;
  /** 订阅状态变化（心情心跳）。 */
  onStatus(handler: (status: AIStatusView) => void): () => void;
  /** 订阅留言箱变化。 */
  onNotes(handler: (box: NoteBox) => void): () => void;
  /** 订阅"切到哪个视图"（托盘打开小纸条时会推）。 */
  onView(handler: (view: ChatView) => void): () => void;
  /** 打开设置窗口（顶部「设置」按钮）。 */
  openSettings(): Promise<boolean>;
  /** 关闭聊天窗口（隐藏，不销毁）。 */
  close(): Promise<void>;
  /**
   * 插件面板（TODO / 课程表 / 番茄钟…都渲染在这里）。
   *
   * 面板是**声明式**的：一段净化后的 HTML + `data-plugin-action="id"` 按钮 +
   * `data-plugin-field="name"` 输入控件。点一下就把 actionId 与全部字段值
   * 交给主进程，转给桌宠渲染层里真正跑着的插件；插件回一段新 HTML 即刷新。
   */
  panels(): Promise<readonly PluginPanelView[]>;
  panelAction(action: PluginPanelAction): void;
  onPanels(handler: (panels: readonly PluginPanelView[]) => void): () => void;
  /**
   * 主进程要求切到某个插件面板（桌宠里的插件调 `ui.openPanel()`，
   * 或用户点了托盘「插件」子菜单里的动作）。
   *
   * 与 `onPanels` 分开：那条是"有什么面板"，这条是"看哪一个" ——
   * 面板可能刚注册（快照还在路上），所以切换必须能独立到达。
   */
  onPanelRequest(handler: (target: PluginPanelTarget) => void): () => void;
}
