/**
 * 交互收件箱 —— 她**保存重要事情**的目录（类型与纯逻辑，渲染层/主进程/验收共用）。
 *
 * 定位（需求原文）："小纸条系统是给宠物把重要的事情保存的目录，
 * 比如后续整理的文件等，都放到这个系统里。**用户不再允许主动留言**"。
 * 2026-09 又进一步："把交互式纸条和文件合并，做成类似**邮件**的内容"。
 *
 * 于是模型是**邮件式的**，不是"纸条 + 一个文件列表"：
 *   - 每一条都是一封**消息**：发件人（她 / 某个插件 / 系统）+ 主题（`title`）+
 *     正文（`text`）+ **0..N 个附件**（`files`）+ 时间 + 已读/未读；
 *   - 附件仍然住在 `notes/files/`（独立文件，能被别的程序打开），
 *     删消息时**连同附件一起删**（邮件语义），文件被别的消息引用时则保留；
 *   - 没被任何消息引用的文件（手工放进去的 / 旧数据）归成一封虚拟的
 *     「未归档的文件」，在 `NoteBox.orphans` 里单独给界面，绝不隐藏；
 *   - 用户只能**看**：查看内容、打开、标记看过、删附件、删消息、清空。
 *
 * 日记**不进这里**（需求）：写完只留在 `diary/`。
 *
 * 为什么单独一层纯函数：标题/大小/时间格式化、未读计数、迁移、给模型的提示词都是规则，
 * 放在主进程里就没法逐条断言。副作用（读盘/复制文件/调模型）在 `main/ai/note-service.ts`。
 */

import type { EmotionState, MemoryFact } from './ai-types';
import { moodLabel, satietyLabel } from './emotion';

/**
 * 纸条的来由（决定标题与图标，不影响排序）。
 *
 * - `memory` 她记下的一件重要的事
 * - `manual` 你点了「让她记一件」要来的
 * - `file`   收进收纳夹的一个文件
 * - `diary`  **历史遗留**：早期"写完日记顺手记一条"会产生它。
 *   现在日记只留在 `diary/`，不再进小纸条（需求），但旧数据里还有，
 *   所以类型与标签都保留，否则读盘时会认不出来。
 */
export type NoteKind = 'diary' | 'memory' | 'manual' | 'file';

/** 纸条附带的文件（**都在小纸条目录下**，不会指向任意路径）。 */
export interface NoteFile {
  /** 展示用文件名。 */
  readonly name: string;
  /** 绝对路径（一定位于 `notes/` 之内）。 */
  readonly path: string;
  /** 字节数。 */
  readonly size: number;
}

/**
 * 发件人（邮件模型里的"谁发来的"）。
 *
 * - `pet`    她自己（「让她记一件」/ 收纳文件）
 * - `plugin` 某个插件投递进来的（`context.mail.send`，见 docs/plugins.md）
 * - `system` 程序自己（迁移/兜底）
 */
export type NoteSenderKind = 'pet' | 'plugin' | 'system';

export interface NoteSender {
  readonly kind: NoteSenderKind;
  /** 插件 id（`kind === 'plugin'` 时才有）。 */
  readonly id?: string;
  /** 展示名（插件显示名 / 她的名字）；缺省时界面按 kind 兜底。 */
  readonly name?: string;
}

export interface Note {
  readonly id: string;
  readonly kind: NoteKind;
  /** 列表上一眼看得懂的短标题（邮件模型里的"主题"）。 */
  readonly title: string;
  readonly text: string;
  /** ISO 时间。 */
  readonly at: string;
  /** 用户是否已经看过（未看的会在页签/菜单上标出来）。 */
  readonly read: boolean;
  /** 附件（0..N）。旧数据里的单附件 `file` 会在读盘时迁移成一条。 */
  readonly files: readonly NoteFile[];
  /** 谁发来的。缺省视为她自己（旧数据没有这个字段）。 */
  readonly sender: NoteSender;
  readonly source: 'llm' | 'template' | 'system' | 'plugin';
  readonly tokens: number;
}

/** 收纳夹快照（给界面用：已排序 + 未看条数 + 目录 + 未归档文件）。 */
export interface NoteBox {
  /** 最新在前。 */
  readonly notes: readonly Note[];
  /** 还没看过的条数。 */
  readonly unread: number;
  /** 纸条数据目录（`…/notes`）—— "打开文件夹"用它。 */
  readonly dataDir: string;
  /** 收纳文件的目录（`…/notes/files`）。 */
  readonly filesDir: string;
  /**
   * **没被任何消息引用**的文件（手工放进去的 / 消息被清空后剩下的）。
   *
   * 界面把它们归成一封虚拟的「未归档的文件」：合并成邮件之后，
   * 一个躺在磁盘上的文件如果没有归属就再也看不见了 —— 那等于把用户的东西藏起来。
   */
  readonly orphans: readonly NoteFileEntry[];
}

/** 一条纸条的正文上限（邮件可以比纸条长一点，但仍然不该是一篇文章；文件走附件）。 */
export const NOTE_MAX_CHARS = 2000;
/** 标题上限。 */
export const NOTE_TITLE_MAX_CHARS = 60;
/** 最多保留多少条（超出丢最旧的）—— 防止文件无限长大。 */
export const NOTE_MAX_COUNT = 500;
/** 一封"邮件"最多带几个附件、单个多大（插件投递时也按这个卡）。 */
export const NOTE_MAX_ATTACHMENTS = 5;
export const NOTE_MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export const NOTE_KIND_LABELS: Readonly<Record<NoteKind, string>> = {
  diary: '日记',
  memory: '记得的事',
  manual: '她记的',
  file: '收好的文件',
};

/** 发件人的展示名（列表上那一列）：她自己 / 某个插件 / 系统。 */
export function senderLabel(sender: NoteSender | undefined, petName = '她'): string {
  if (!sender || sender.kind === 'pet') return petName;
  if (sender.kind === 'system') return '系统';
  const name = typeof sender.name === 'string' ? sender.name.trim() : '';
  return name === '' ? (sender.id ?? '插件') : name;
}

/* -------------------------------------------------------------------------- */
/* 「文件」视图：查看 / 删除收纳夹里的文件                                        */
/* -------------------------------------------------------------------------- */

/** 一个文件能被怎么"看"。 */
export type NotePreviewKind = 'text' | 'image' | 'other';

/** `notes/files/` 里的一项（扫目录得到）。 */
export interface NoteFileEntry {
  /** 文件名（收纳夹内唯一，就是 `notes/files/` 里的名字）。 */
  readonly name: string;
  /** 绝对路径（一定在 `notes/files/` 内）。 */
  readonly path: string;
  readonly size: number;
  /** 最后修改时间（ISO）。 */
  readonly modifiedAt: string;
  /** 点「查看」时会怎么渲染。 */
  readonly preview: NotePreviewKind;
}

/** 一次预览的结果（内容由主进程读出来，渲染层只负责显示）。 */
export interface NotePreview {
  readonly ok: boolean;
  readonly name: string;
  readonly size: number;
  readonly preview: NotePreviewKind;
  /** 文本内容（`preview === 'text'` 且 `ok`）。 */
  readonly text?: string;
  /** 文本被截断了（超过了 `NOTE_PREVIEW_MAX_TEXT_CHARS`）。 */
  readonly truncated?: boolean;
  /** 图片的 data URL（`preview === 'image'` 且 `ok`）。 */
  readonly dataUrl?: string;
  /** 失败原因：给界面直接显示的中文短句。 */
  readonly reason?: string;
}

/** 能当文本直接显示的扩展名（其余一律走"用系统程序打开"）。 */
export const PREVIEW_TEXT_EXTENSIONS: readonly string[] = [
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.log', '.csv', '.tsv', '.yml', '.yaml',
  '.ini', '.cfg', '.conf', '.toml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.sh', '.ps1', '.bat', '.sql',
];

/** 能直接显示的图片扩展名 → MIME。 */
export const PREVIEW_IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/** 文本预览上限（字符）—— 再大就只给前一段，避免 IPC 塞爆内存。 */
export const NOTE_PREVIEW_MAX_TEXT_CHARS = 200_000;
/** 图片预览上限（字节）—— 转成 data URL 会膨胀 4/3。 */
export const NOTE_PREVIEW_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 取小写扩展名（不依赖 node:path，渲染层也要用）。 */
export function fileExtension(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const dot = raw.lastIndexOf('.');
  // 开头的点是隐藏文件（`.gitignore`），不是扩展名
  return dot > 0 ? raw.slice(dot).toLowerCase() : '';
}

/** 这个文件该怎么看。 */
export function previewKindOf(name: unknown): NotePreviewKind {
  const extension = fileExtension(name);
  if (PREVIEW_IMAGE_MIME[extension]) return 'image';
  if (PREVIEW_TEXT_EXTENSIONS.includes(extension)) return 'text';
  return 'other';
}

/** 图片扩展名对应的 MIME；不是图片返回 null。 */
export function imageMimeOf(name: unknown): string | null {
  return PREVIEW_IMAGE_MIME[fileExtension(name)] ?? null;
}

/** 清洗正文：去控制字符、压掉多余空行、限长。 */
export function sanitizeNote(text: unknown): string {
  return (typeof text === 'string' ? text : '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim()
    .slice(0, NOTE_MAX_CHARS);
}

/** 清洗标题：压成一行。 */
export function sanitizeNoteTitle(text: unknown, fallback = '一件重要的事'): string {
  const one = (typeof text === 'string' ? text : '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_TITLE_MAX_CHARS);
  return one === '' ? fallback : one;
}

/**
 * 把任意名字收敛成**安全文件名**：去掉路径分隔符与 Windows 保留字符。
 *
 * 为什么要它：文件名可能来自她整理的外部文件（含 `..`、`:`、`/`），
 * 直接拼进目录会写到别的地方去。
 */
export function safeFileName(name: unknown, fallback = 'file'): string {
  const raw = (typeof name === 'string' ? name : '').replace(/[\\/]+/g, '_');
  const cleaned = raw
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 80);
  return cleaned === '' ? fallback : cleaned;
}

/** 人类可读的文件大小。 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 宽松校验一条记录（文件被手改过也尽量救回来）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把**任意版本**的纸条记录收敛成当前 `Note`（读盘时用）。
 *
 * 为什么必须宽容：小纸条换过两次模型 ——
 *   1. 最早是"邮箱"（有 `author: 'user' | 'pet'`、没有 `title`）；
 *   2. 之后是"她的收纳夹"（有 `title`、**单个** `file`）;
 *   3. 现在又回到邮件式（`sender` + `files` 数组）—— 需求："把交互式纸条和文件合并，
 *      做成类似邮件的内容"。
 * 如果只认最新字段，**旧文件里的记录会被静默丢掉**（实测：用户真实数据里已有一条
 * 2026-09-26 的日记纸条，下一次写盘就会永久消失）。
 *
 * 所以这里做**向下兼容的迁移**：缺 `title` 就从类别与正文推一个；
 * `file`（单个）包成 `files`（数组）；老邮箱模型的 `author: 'user'` 记为系统/用户侧、
 * `'pet'` 记为她自己。
 *
 * @returns 迁移后的记录；完全无法识别时返回 null（调用方会记一条日志）
 */
export function migrateNote(raw: unknown): Note | null {
  if (!isPlainObject(raw)) return null;
  const text = sanitizeNote(raw.text);
  const at = typeof raw.at === 'string' ? raw.at : '';
  if (text === '' || at === '' || !Number.isFinite(Date.parse(at))) return null;

  const kindRaw = typeof raw.kind === 'string' ? raw.kind : '';
  // 旧模型里的 kind：'note' | 'reply' | 'manual' | 'diary' → 新模型：diary/memory/manual/file
  const kind: NoteKind = kindRaw === 'diary'
    ? 'diary'
    : kindRaw === 'manual'
      ? 'manual'
      : kindRaw === 'file'
        ? 'file'
        : 'memory';

  const title = sanitizeNoteTitle(raw.title ?? '', deriveNoteTitle(kind, text));
  const files = readFileRefs(raw.files, raw.file);
  const source: Note['source'] =
    raw.source === 'llm' || raw.source === 'template' || raw.source === 'system' || raw.source === 'plugin'
      ? raw.source
      : 'system';

  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `migrated-${at}`,
    kind,
    title,
    text,
    at,
    read: raw.read === true,
    files,
    sender: readSender(raw.sender, raw.author),
    source,
    tokens: typeof raw.tokens === 'number' && Number.isFinite(raw.tokens) ? Math.max(0, Math.round(raw.tokens)) : 0,
  };
}

/**
 * 读发件人：新格式看 `sender`，最早那版邮箱模型看 `author`。
 *
 * `author: 'user'` 不能当成"用户留言"（需求明确不允许用户留言）——
 * 那是早期数据里由界面代填的，记成 `system` 更诚实。
 */
function readSender(rawSender: unknown, rawAuthor: unknown): NoteSender {
  if (isPlainObject(rawSender)) {
    const kind = rawSender.kind === 'plugin' || rawSender.kind === 'system' ? rawSender.kind : 'pet';
    const id = typeof rawSender.id === 'string' && rawSender.id !== '' ? rawSender.id : undefined;
    const name = typeof rawSender.name === 'string' && rawSender.name !== '' ? rawSender.name : undefined;
    return { kind, ...(id ? { id } : {}), ...(name ? { name } : {}) };
  }
  if (rawAuthor === 'pet') return { kind: 'pet' };
  if (typeof rawAuthor === 'string' && rawAuthor !== '') return { kind: 'system' };
  return { kind: 'pet' };
}

/** 老记录没有标题时，从类别与正文推一个（正文首句，最长 24 字）。 */
function deriveNoteTitle(kind: NoteKind, text: string): string {
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
  const clipped = firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
  if (clipped !== '') return clipped;
  return NOTE_KIND_LABELS[kind] ?? '一件重要的事';
}

/**
 * 读取附件引用：新格式是 `files` 数组，旧格式是单个 `file`。
 *
 * 路径必须在 `notes/` 之内才认（避免手改文件后指向任意位置）；
 * 数组上限按 `NOTE_MAX_ATTACHMENTS` 截断，坏条目直接丢掉。
 */
function readFileRefs(rawFiles: unknown, rawFile: unknown): NoteFile[] {
  const candidates: unknown[] = Array.isArray(rawFiles) ? rawFiles : [];
  if (candidates.length === 0 && rawFile !== undefined) candidates.push(rawFile);
  const files: NoteFile[] = [];
  for (const candidate of candidates.slice(0, NOTE_MAX_ATTACHMENTS)) {
    const file = readFileRef(candidate);
    if (file) files.push(file);
  }
  return files;
}

/** 读取单个附件引用。 */
function readFileRef(raw: unknown): NoteFile | null {
  if (!isPlainObject(raw)) return null;
  const path = typeof raw.path === 'string' ? raw.path : '';
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (path === '' || name === '') return null;
  const size = typeof raw.size === 'number' && Number.isFinite(raw.size) ? Math.max(0, Math.round(raw.size)) : 0;
  return { name, path, size };
}

/** 最新在前（同一时刻按 id 兜底，保证顺序稳定可断言）。 */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => {
    const diff = Date.parse(b.at) - Date.parse(a.at);
    return diff !== 0 ? diff : b.id.localeCompare(a.id);
  });
}

/** 未看过的条数。 */
export function countUnread(notes: readonly Note[]): number {
  return notes.filter((note) => !note.read).length;
}

/** 被消息引用到的附件文件名（算"未归档文件"要用它，纯函数便于断言）。 */
export function referencedFileNames(notes: readonly Note[]): Set<string> {
  const names = new Set<string>();
  for (const note of notes) {
    for (const file of note.files) names.add(file.name);
  }
  return names;
}

/** 一条消息的全部附件体积（列表上显示"📎 2 · 1.2 MB"）。 */
export function totalAttachmentBytes(note: Note): number {
  return note.files.reduce((sum, file) => sum + (Number.isFinite(file.size) ? file.size : 0), 0);
}

/** 超出上限时保留最新的 N 条。 */
export function trimNotes(notes: readonly Note[]): Note[] {
  const sorted = sortNotes(notes);
  return sorted.length > NOTE_MAX_COUNT ? sorted.slice(0, NOTE_MAX_COUNT) : sorted;
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** 相对时间（列表上那一行小字）。 */
export function formatNoteTime(at: string, now: number = Date.now()): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return '';
  const diff = now - parsed;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
  const then = new Date(parsed);
  const today = new Date(now);
  const clock = `${two(then.getHours())}:${two(then.getMinutes())}`;
  const sameDay = then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  if (sameDay) return `今天 ${clock}`;
  const yesterday = new Date(now - 86_400_000);
  const isYesterday = then.getFullYear() === yesterday.getFullYear() &&
    then.getMonth() === yesterday.getMonth() &&
    then.getDate() === yesterday.getDate();
  if (isYesterday) return `昨天 ${clock}`;
  return `${then.getMonth() + 1} 月 ${then.getDate()} 日 ${clock}`;
}

/* -------------------------------------------------------------------------- */
/* 写给她自己的提示词（"让她记一件"）                                            */
/* -------------------------------------------------------------------------- */

/** 组装"记一件"时她能看到的上下文（全部来自真实数据）。 */
export interface NoteContext {
  readonly userName: string;
  readonly petName: string;
  readonly emotion: EmotionState;
  readonly facts: readonly MemoryFact[];
  /** 「今天在做什么」的时间线文本（可能为空）。 */
  readonly timeline: string;
  /** 已经记过的最近几条（避免重复记同一件事）。 */
  readonly recentNotes: readonly { readonly title: string; readonly text: string }[];
  readonly hour: number;
}

/** 给模型的提示词：让她挑一件**重要的事**记下来（纯函数，验收可断言）。 */
export function buildNoteMessages(context: NoteContext): { system: string; user: string } {
  const { emotion, facts, timeline, userName, petName, recentNotes } = context;
  const name = userName.trim() === '' ? '主人' : userName.trim();
  const factLines = facts.slice(0, 6).map((fact) => `- ${fact.key}：${fact.value}`);
  const recentLines = recentNotes.slice(0, 5).map((note) => `- ${note.title}：${note.text.slice(0, 60)}`);

  const system = [
    `你是「${petName}」，住在 ${name} 的 Windows 桌面上的鲸鱼娘桌宠。`,
    '你要在自己的**小纸条**里记下一件**重要的事**（这是你自己的收纳夹，用来保存值得记住的东西）。',
    '要求：',
    '- 第一行是一个短标题（不超过 15 字，不要标点结尾）；第二行起是正文，1~2 句中文；',
    '- 像写给自己的备忘，口语化，可以有颜文字；不要 Markdown、不要分点、不要提"AI"；',
    '- 只写你**确实观察到或记住**的事，不要编造；不要重复下面"已经记过的"里的内容。',
    '',
    `你现在的状态：${moodLabel(emotion.mood).label}（心情 ${emotion.mood}）、${satietyLabel(emotion.satiety)}`,
    ...(factLines.length > 0 ? ['', '你记得关于他的事：', ...factLines] : []),
    ...(timeline.trim() === '' ? [] : ['', '你今天观察到他：', timeline.trim()]),
    ...(recentLines.length > 0 ? ['', '已经记过的（不要重复）：', ...recentLines] : []),
  ].join('\n');

  return { system, user: '现在挑一件重要的事，记进你的小纸条里。' };
}

/** 把模型输出切成"标题 + 正文"（第一行当标题）。 */
export function splitNoteOutput(raw: string, fallbackTitle: string): { title: string; text: string } {
  const lines = (typeof raw === 'string' ? raw : '')
    .replace(/^```[\s\S]*?\n/, '')
    .replace(/```$/, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line !== '' || (index > 0 && index < all.length - 1));
  if (lines.length === 0) return { title: fallbackTitle, text: '' };
  const [first, ...rest] = lines;
  const body = rest.join('\n').trim();
  if (body === '') {
    // 只写了一行：标题兜底，正文用这一行
    return { title: fallbackTitle, text: sanitizeNote(first ?? '') };
  }
  return { title: sanitizeNoteTitle(first, fallbackTitle), text: sanitizeNote(body) };
}

/* -------------------------------------------------------------------------- */
/* 兜底：没有大模型时的"记一件"                                                  */
/* -------------------------------------------------------------------------- */

const FALLBACK_TITLES: readonly string[] = [
  '今天也一起慢慢来',
  '想跟你说的一句话',
  '日子过得不快也不慢',
  '记一小笔',
];

/** 兜底纸条（确定性挑选，避免每次都一样）。 */
export function localNoteDraft(seed: string): { title: string; text: string } {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const title = FALLBACK_TITLES[Math.abs(hash) % FALLBACK_TITLES.length] ?? FALLBACK_TITLES[0] ?? '记一小笔';
  return {
    title,
    text: '今天没什么特别的大事，但我还在这儿，你也还在，就够了。',
  };
}
