/**
 * 交互收件箱服务 —— 落盘 + 收附件 + 查看/删除 + 生成她自己的消息 + 收插件投递。
 *
 * 分工：
 * - **本文件**：读写 `notes/notes.json`、把文件收进 `notes/files/`、未看管理、
 *   附件的列目录 / 读预览 / 删除，以及**插件投递**（`deliver`）；
 * - **ai-service**：提供大模型（她怎么说话）与记忆/情绪/时间线（她能记什么）；
 * - **shared/notes.ts**：纯规则（清洗、标题、安全文件名、预览分类、迁移、提示词、兜底）。
 *
 * 落盘（`<数据目录>\notes\`）：
 *   notes.json    全部消息（最新在前，最多 NOTE_MAX_COUNT 条）
 *   files/        附件 —— "后续整理的文件都放到这个系统里"落在这一层
 *
 * 为什么不做成"每条一个文件"：消息是一条时间线，整体读写更简单；
 * 但**附件**是原样复制的独立文件（要能被别的程序打开），所以放在 `files/`。
 *
 * 邮件语义（2026-09 需求）：删一条消息会**连同它的附件一起删**（除非附件被别的消息引用），
 * 清空同理。没被任何消息引用的文件会出现在 `snapshot().orphans` 里，界面单独归类。
 *
 * 日记**不再**记成消息（需求）：`handleDiaryWritten` 不再往这里写，
 * 日记只留在 `diary/`。旧数据里的 `kind: 'diary'` 消息仍然能读、能删。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { Note, NoteBox, NoteFile, NoteFileEntry, NoteKind, NotePreview, NoteSender } from '../../shared/notes';
import {
  NOTE_MAX_ATTACHMENT_BYTES,
  NOTE_MAX_ATTACHMENTS,
  NOTE_PREVIEW_MAX_IMAGE_BYTES,
  NOTE_PREVIEW_MAX_TEXT_CHARS,
  countUnread,
  imageMimeOf,
  migrateNote,
  previewKindOf,
  referencedFileNames,
  safeFileName,
  sanitizeNote,
  sanitizeNoteTitle,
  sortNotes,
  trimNotes,
} from '../../shared/notes';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

/** 一次变更（给外部决定要不要冒泡/记记忆）。 */
export interface NoteChange {
  readonly added: readonly Note[];
}

/** 一封待投递的"邮件"（插件路径用它；附件内容已经在内存里）。 */
export interface MailDelivery {
  readonly sender: NoteSender;
  readonly subject: string;
  readonly body?: string;
  readonly attachments?: readonly { readonly name: string; readonly bytes: Buffer }[];
}

/** 投递结果（界面/插件都要知道"存成了没有、叫什么名字"）。 */
export interface MailDeliveryResult {
  readonly ok: boolean;
  readonly messageId?: string;
  readonly files: readonly { readonly name: string; readonly size: number }[];
  readonly error?: string;
}

export interface NoteServiceOptions {
  /** 数据根目录（`%APPDATA%\DesktopPet`）。 */
  readonly dataDir: string;
  readonly logger: Logger;
  /** 生成一条"她记的"纸条（优先大模型，失败/不可用时返回兜底文案）。 */
  readonly composeDraft: () => Promise<{ title: string; text: string; source: 'llm' | 'template'; tokens: number }>;
  /** 收纳夹变化后通知外部（推 UI / 记记忆）。 */
  readonly onChanged?: (box: NoteBox, change: NoteChange) => void;
  /** 生成 id 的随机源（验收可注入）。 */
  readonly random?: () => number;
  /** 时间源（验收可注入）。 */
  readonly now?: () => number;
}

export class NoteService {
  private readonly options: NoteServiceOptions;
  private readonly logger: Logger;
  private readonly dir: string;
  private readonly filesDir: string;
  private readonly file: string;
  private notes: Note[] = [];
  private counter = 0;

  public constructor(options: NoteServiceOptions) {
    this.options = options;
    this.logger = options.logger;
    this.dir = join(options.dataDir, 'notes');
    this.filesDir = join(this.dir, 'files');
    this.file = join(this.dir, 'notes.json');
  }

  /** 读盘（只读，不建目录）。 */
  public load(): void {
    this.notes = this.read();
    this.logger.info('note service loaded', {
      data: { file: this.file, notes: this.notes.length, unread: countUnread(this.notes) },
    });
  }

  public get dataDir(): string {
    return this.dir;
  }

  public get filesDirectory(): string {
    return this.filesDir;
  }

  public get unread(): number {
    return countUnread(this.notes);
  }

  public snapshot(): NoteBox {
    const notes = sortNotes(this.notes);
    /*
     * 未归档 = 磁盘上存在、但没有任何消息引用它。
     * 扫目录而不是只数消息里的附件：手工放进 `files/` 的文件也必须能被看见
     * （合并成邮件之后，"没有归属的文件"是最容易被藏起来的一类）。
     */
    const referenced = referencedFileNames(notes);
    const orphans = this.listFiles().filter((entry) => !referenced.has(entry.name));
    return {
      notes,
      unread: countUnread(this.notes),
      dataDir: this.dir,
      filesDir: this.filesDir,
      orphans,
    };
  }

  /** 某条纸条（界面要"打开这条的文件"时用；**不接受任意路径**）。 */
  public find(id: string): Note | null {
    return this.notes.find((note) => note.id === id) ?? null;
  }

  /**
   * 记一条消息（她自己写的）。
   *
   * @param input.files 可选：要**收进收纳夹**的文件（源路径，0..N 个）。给了就复制到
   *   `notes/files/`，消息上带回新路径与大小 —— 这是"整理好的文件都放到这里"的入口之一
   *   （另一条是插件投递，见 `deliver`）。
   */
  public async record(input: {
    readonly kind: NoteKind;
    readonly title?: string;
    readonly text: string;
    readonly source?: Note['source'];
    readonly tokens?: number;
    readonly files?: readonly { readonly sourcePath: string; readonly name?: string }[];
    readonly sender?: NoteSender;
  }): Promise<NoteBox> {
    const text = sanitizeNote(input.text);
    const files = (input.files ?? [])
      .slice(0, NOTE_MAX_ATTACHMENTS)
      .map((file) => this.intakeFile(file))
      .filter((file): file is NoteFile => file !== null);
    const first = files[0];
    const fallbackTitle = first ? first.name : '一件重要的事';
    const title = sanitizeNoteTitle(input.title ?? '', fallbackTitle);
    if (text === '' && files.length === 0) return this.snapshot();

    const note = this.makeNote({
      kind: input.kind,
      title,
      text: text === '' ? `收好了：${files.map((file) => file.name).join('、')}` : text,
      files,
      sender: input.sender ?? { kind: 'pet' },
      source: input.source ?? 'system',
      tokens: input.tokens ?? 0,
    });
    this.notes.push(note);
    this.persist();
    this.options.onChanged?.(this.snapshot(), { added: [note] });
    return this.snapshot();
  }

  /**
   * 投递一封"邮件"（**插件投递的唯一入口**，权限 `mail`）。
   *
   * 与 `record` 的区别：附件内容直接在内存里（插件拿不到磁盘），
   * 所以这里写的是 **Buffer** 而不是复制源文件。校验（数量/体积/文件名）在
   * `PluginRuntime` 先做一遍（那是权限层），这里再兜一次"绝不写坏目录"。
   */
  public deliver(delivery: MailDelivery): MailDeliveryResult {
    const subject = sanitizeNoteTitle(delivery.subject, '来自插件的消息');
    const body = sanitizeNote(delivery.body ?? '');
    const attachments = (delivery.attachments ?? []).slice(0, NOTE_MAX_ATTACHMENTS);

    const files: NoteFile[] = [];
    const rejected: string[] = [];
    for (const attachment of attachments) {
      const stored = this.storeBuffer(attachment.name, attachment.bytes);
      if (stored) files.push(stored);
      else rejected.push(attachment.name);
    }
    if (body === '' && files.length === 0) {
      return { ok: false, files: [], error: '正文和附件都是空的，没有可投递的内容' };
    }

    const note = this.makeNote({
      kind: files.length > 0 ? 'file' : 'memory',
      title: subject,
      text: body === '' ? `带来了 ${files.length} 个文件：${files.map((file) => file.name).join('、')}` : body,
      files,
      sender: delivery.sender,
      source: 'plugin',
      tokens: 0,
    });
    this.notes.push(note);
    this.persist();
    this.options.onChanged?.(this.snapshot(), { added: [note] });
    this.logger.info('mail delivered', {
      data: { id: note.id, from: delivery.sender.id ?? delivery.sender.kind, files: files.map((file) => file.name).join(',') },
    });
    const result: MailDeliveryResult = { ok: true, messageId: note.id, files: files.map((file) => ({ name: file.name, size: file.size })) };
    return rejected.length > 0
      ? { ...result, error: `有 ${rejected.length} 个附件没能存进来：${rejected.join('、')}` }
      : result;
  }

  /** 你点了「让她记一件」：让她自己挑一件重要的事记下来。 */
  public async composeDraft(): Promise<NoteBox> {
    let title = '';
    let text = '';
    let source: Note['source'] = 'template';
    let tokens = 0;
    try {
      const draft = await this.options.composeDraft();
      title = draft.title;
      text = draft.text;
      source = draft.source;
      tokens = draft.tokens;
    } catch (error) {
      this.logger.warn('composing note draft failed', { error: describeError(error) });
      return this.snapshot();
    }
    if (sanitizeNote(text) === '') return this.snapshot();
    return this.record({ kind: 'manual', title, text, source, tokens });
  }

  /** 全部标记为看过。 */
  public markAllRead(): NoteBox {
    let changed = false;
    this.notes = this.notes.map((note) => {
      if (note.read) return note;
      changed = true;
      return { ...note, read: true };
    });
    if (changed) {
      this.persist();
      this.options.onChanged?.(this.snapshot(), { added: [] });
    }
    return this.snapshot();
  }

  /**
   * 删掉一条消息（需求："增加删除功能"）。
   *
   * **邮件语义**：连同它的附件一起删（`withAttachments`，默认开）——
   * "删掉一封邮件，附件还留在磁盘上"是没人期待的。两条保护：
   *   1. 附件被**别的消息**引用时不删（那是共享的同一个文件）；
   *   2. 传 `withAttachments: false` 可以只删消息（留给将来的"仅移除记录"入口）。
   *
   * @returns 删除后的收件箱；id 不存在时原样返回（幂等，不报错）
   */
  public remove(id: string, options: { readonly withAttachments?: boolean } = {}): NoteBox {
    const index = this.notes.findIndex((note) => note.id === id);
    if (index < 0) return this.snapshot();
    const [removed] = this.notes.splice(index, 1);
    const withAttachments = options.withAttachments !== false;
    const deletedFiles: string[] = [];
    if (withAttachments && removed) {
      const referenced = referencedFileNames(this.notes);
      for (const file of removed.files) {
        if (referenced.has(file.name)) continue;
        if (this.deleteFile(file.name).ok) deletedFiles.push(file.name);
      }
    }
    this.persist();
    this.logger.info('note removed', {
      data: { id, kind: removed?.kind ?? '', attachments: deletedFiles.join(',') },
    });
    this.options.onChanged?.(this.snapshot(), { added: [] });
    return this.snapshot();
  }

  /**
   * 清空收件箱。
   *
   * 同样按邮件语义：**连同附件一起清掉**（没被别的消息引用的那些），
   * 否则"清空"之后磁盘上会留下一堆再也看不到的文件。
   */
  public clear(options: { readonly withAttachments?: boolean } = {}): NoteBox {
    if (this.notes.length === 0) return this.snapshot();
    const withAttachments = options.withAttachments !== false;
    const names = withAttachments
      ? [...referencedFileNames(this.notes)]
      : [];
    this.notes = [];
    if (withAttachments) {
      for (const name of names) this.deleteFile(name);
    }
    this.persist();
    this.options.onChanged?.(this.snapshot(), { added: [] });
    return this.snapshot();
  }

  /* ------------------------------------------------------------------ */
  /* 「文件」视图：列目录 / 读预览 / 删除                                   */
  /* ------------------------------------------------------------------ */

  /**
   * 列出收纳夹里的文件（最新修改在前）。
   *
   * 为什么要**扫目录**而不是"从纸条里收集"：`files/` 是真正存放内容的地方 ——
   * 纸条可能被清空、也可能有文件是手工放进去的，扫目录才是完整的答案。
   */
  public listFiles(): NoteFileEntry[] {
    if (!existsSync(this.filesDir)) return [];
    try {
      const entries: NoteFileEntry[] = [];
      for (const dirent of readdirSync(this.filesDir, { withFileTypes: true })) {
        if (!dirent.isFile()) continue;
        const path = join(this.filesDir, dirent.name);
        try {
          const stat = statSync(path);
          entries.push({
            name: dirent.name,
            path,
            size: stat.size,
            modifiedAt: new Date(stat.mtimeMs).toISOString(),
            preview: previewKindOf(dirent.name),
          });
        } catch (error) {
          this.logger.warn('stat note file failed', { error: describeError(error), data: { path } });
        }
      }
      return entries.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt) || a.name.localeCompare(b.name));
    } catch (error) {
      this.logger.warn('listing note files failed', { error: describeError(error), data: { dir: this.filesDir } });
      return [];
    }
  }

  /**
   * 读一个文件给界面看（文本 / 图片 / 只能交给系统程序）。
   *
   * 三种结果，渲染层照着 `preview` 分支渲染：
   * - `text`  → `text`（超过 `NOTE_PREVIEW_MAX_TEXT_CHARS` 会截断并置 `truncated`）
   * - `image` → `dataUrl`（超过上限拒绝，避免几 MB 的 base64 走 IPC）
   * - `other` → 只有元信息，界面提示"用系统程序打开"
   *
   * 失败一律返回 `ok: false` + 中文 `reason`（不抛错，不把异常丢给渲染层）。
   */
  public readFilePreview(name: string): NotePreview {
    const preview = previewKindOf(name);
    const resolved = this.resolveFile(name);
    if (!resolved) {
      return { ok: false, name: typeof name === 'string' ? name : '', size: 0, preview, reason: '这个文件不在收纳夹里（可能已经被删掉了）。' };
    }
    const { path, displayName } = resolved;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch (error) {
      this.logger.warn('preview stat failed', { error: describeError(error), data: { path } });
      return { ok: false, name: displayName, size: 0, preview, reason: '读取失败：文件不可访问。' };
    }

    if (preview === 'image') {
      if (size > NOTE_PREVIEW_MAX_IMAGE_BYTES) {
        return {
          ok: false,
          name: displayName,
          size,
          preview,
          reason: '图片太大了，预览会占很多内存 —— 用系统程序打开吧。',
        };
      }
      try {
        const mime = imageMimeOf(displayName) ?? 'application/octet-stream';
        const dataUrl = `data:${mime};base64,${readFileSync(path).toString('base64')}`;
        return { ok: true, name: displayName, size, preview, dataUrl };
      } catch (error) {
        this.logger.warn('preview image failed', { error: describeError(error), data: { path } });
        return { ok: false, name: displayName, size, preview, reason: '读取失败：图片读不出来。' };
      }
    }

    if (preview === 'text') {
      try {
        const raw = readFileSync(path, 'utf8');
        const truncated = raw.length > NOTE_PREVIEW_MAX_TEXT_CHARS;
        return {
          ok: true,
          name: displayName,
          size,
          preview,
          text: truncated ? raw.slice(0, NOTE_PREVIEW_MAX_TEXT_CHARS) : raw,
          truncated,
        };
      } catch (error) {
        this.logger.warn('preview text failed', { error: describeError(error), data: { path } });
        return { ok: false, name: displayName, size, preview, reason: '读取失败：这个文件不像文本。' };
      }
    }

    return { ok: true, name: displayName, size, preview };
  }

  /** 删掉收纳夹里的一个文件（不可撤销）。纸条记录不动（它只是描述）。 */
  public deleteFile(name: string): { readonly ok: boolean; readonly reason?: string } {
    const resolved = this.resolveFile(name);
    if (!resolved) return { ok: false, reason: '这个文件不在收纳夹里。' };
    try {
      unlinkSync(resolved.path);
      this.logger.info('note file deleted', { data: { name: resolved.displayName } });
      return { ok: true };
    } catch (error) {
      this.logger.warn('deleting note file failed', { error: describeError(error), data: { path: resolved.path } });
      return { ok: false, reason: '删除失败：文件可能正被别的程序占用。' };
    }
  }

  /** 文件在不在收纳夹里（界面用它判断附件是否还在）。 */
  public existsFile(name: string): boolean {
    return this.resolveFile(name) !== null;
  }

  /**
   * 把"渲染层给的文件名"变成**收纳夹内的绝对路径**。
   *
   * 安全边界：名字里不许出现路径分隔符，解析后必须在 `notes/files/` 内。
   * 这里**不能**用 `safeFileName` 清洗（那会把真实文件名改掉导致找不到），
   * 而是**校验并拒绝**——名字来自 `listFiles()` 的扫描结果，本来就该是干净的。
   */
  private resolveFile(name: string): { readonly path: string; readonly displayName: string } | null {
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === '.' || trimmed === '..') return null;
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\u0000')) return null;
    const root = resolve(this.filesDir);
    const path = resolve(root, trimmed);
    // 解析后必须**正好落在 files/ 这一层**（`..`、绝对路径、分隔符都在上面被挡掉了）
    if (dirname(path).toLowerCase() !== root.toLowerCase()) {
      this.logger.warn('note file path rejected', { data: { name: trimmed } });
      return null;
    }
    if (!existsSync(path)) return null;
    try {
      if (!statSync(path).isFile()) return null;
    } catch {
      return null;
    }
    return { path, displayName: trimmed };
  }

  /* ------------------------------------------------------------------ */

  /**
   * 把一个文件收进 `notes/files/`。
   *
   * - 同名**覆盖**（重复收同一个名字不会堆积副本）；
   * - 文件名经 `safeFileName` 收敛，绝不会因为 `../` 写到目录外；
   * - 源文件不存在时返回 null（调用方据此退化成"只有文字的纸条"）。
   */
  private intakeFile(input: { readonly sourcePath: string; readonly name?: string }): NoteFile | null {
    try {
      if (!existsSync(input.sourcePath)) {
        this.logger.warn('note file missing; skipped', { data: { source: input.sourcePath } });
        return null;
      }
      const name = safeFileName(input.name ?? basename(input.sourcePath), 'file');
      mkdirSync(this.filesDir, { recursive: true });
      const target = join(this.filesDir, name);
      // 源与目标同一个文件时不要复制（Windows 上 copyFileSync 会抛）
      if (input.sourcePath !== target) copyFileSync(input.sourcePath, target);
      const size = statSync(target).size;
      this.logger.info('note file stored', { data: { name, size } });
      return { name, path: target, size };
    } catch (error) {
      this.logger.warn('storing note file failed', {
        error: describeError(error),
        data: { source: input.sourcePath },
      });
      return null;
    }
  }

  /**
   * 把**内存里的一段内容**存成附件（插件投递走这条）。
   *
   * 与 `intakeFile` 同一套命名与目录规则，只是内容来自 Buffer 而不是磁盘上的源文件。
   * 同名仍然覆盖（插件重发同一份文件不会堆积副本）—— 覆盖会让**旧消息的附件指向新内容**，
   * 这是有意的：附件名就是它的身份，重复投递同一份东西应当更新而不是长出第 N 份。
   */
  private storeBuffer(rawName: string, bytes: Buffer): NoteFile | null {
    try {
      if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) return null;
      if (bytes.byteLength > NOTE_MAX_ATTACHMENT_BYTES) {
        this.logger.warn('plugin attachment too large; rejected', {
          data: { name: rawName, size: bytes.byteLength, limit: NOTE_MAX_ATTACHMENT_BYTES },
        });
        return null;
      }
      const name = safeFileName(rawName, 'attachment');
      mkdirSync(this.filesDir, { recursive: true });
      const target = join(this.filesDir, name);
      writeFileSync(target, bytes);
      const size = statSync(target).size;
      this.logger.info('plugin attachment stored', { data: { name, size } });
      return { name, path: target, size };
    } catch (error) {
      this.logger.warn('storing plugin attachment failed', {
        error: describeError(error),
        data: { name: rawName },
      });
      return null;
    }
  }

  private makeNote(input: {
    readonly kind: NoteKind;
    readonly title: string;
    readonly text: string;
    readonly files: readonly NoteFile[];
    readonly sender: NoteSender;
    readonly source: Note['source'];
    readonly tokens: number;
  }): Note {
    this.counter += 1;
    const at = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const random = this.options.random ?? Math.random;
    const suffix = Math.floor(random() * 1e6).toString(36);
    return {
      id: `n${Date.parse(at).toString(36)}${this.counter.toString(36)}${suffix}`,
      kind: input.kind,
      title: input.title,
      text: input.text,
      at,
      read: false,
      files: [...input.files],
      sender: input.sender,
      source: input.source,
      tokens: input.tokens,
    };
  }

  private read(): Note[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      /*
       * 逐条**迁移**而不是"只认新格式"：小纸条换过模型（邮箱 -> 收纳夹），
       * 严格校验会把旧记录静默丢掉（已实锤过一次）。这里统计一下，
       * 万一有读不出来的，日志里能看见，不至于无声无息。
       */
      const notes: Note[] = [];
      let dropped = 0;
      for (const item of parsed) {
        const note = migrateNote(item);
        if (note) notes.push(note);
        else dropped += 1;
      }
      if (dropped > 0) {
        this.logger.warn('some note entries were unreadable and skipped', {
          data: { file: this.file, dropped, kept: notes.length },
        });
      }
      return trimNotes(notes);
    } catch (error) {
      this.logger.warn('reading notes failed; starting empty', {
        error: describeError(error),
        data: { file: this.file },
      });
      return [];
    }
  }

  private persist(): void {
    this.notes = trimNotes(this.notes);
    const target = this.file;
    const temp = `${target}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(temp, JSON.stringify(this.notes, null, 1), 'utf8');
      renameSync(temp, target);
    } catch (error) {
      this.logger.error('writing notes failed', { error: describeError(error), data: { file: target } });
    }
  }
}
