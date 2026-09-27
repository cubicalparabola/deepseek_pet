/**
 * PluginRuntime —— 插件系统在 Main 进程侧的"能力提供者"。
 *
 * 为什么这些能力必须住在 Main：
 * - 桌宠渲染层的 CSP 是 `connect-src 'none'`（而且这个 CSP 本身是一道安全边界），
 *   所以插件不可能自己联网；模板里也读不到磁盘、起不了进程；
 * - 系统通知、打开浏览器、计时器、"停用即回收"都需要一个比渲染层更可靠的持有者
 *   —— 渲染层被隐藏时 Chromium 会把定时器降频，而**停用插件**时最需要确定性的回收。
 *
 * 设计要点：
 * 1. **执法点在这里**：每个能力入口先查 `getPermissions(pluginId)`（来自
 *    `PluginManager`，已按 `plugins.json` 收窄）。没权限一律拒绝并记日志，
 *    不存在"渲染层说自己有权限"这种可伪造的路径。
 * 2. **停用即回收**（`revoke`）：清掉该插件的全部定时器、杀掉它起的所有子进程、
 *    下线它的菜单项与面板 —— 这是"插件可随时关闭"这句承诺的实际兑现处。
 * 3. **面板/菜单只是数据**：Main 不执行任何插件代码，只保存快照并转交点击事件。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Notification, shell } from 'electron';
import type { PetConfig } from '../shared/config';
import { safeJoin } from '../shared/config';
import { describeError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import { MAX_PANEL_HTML_BYTES } from '../shared/plugin-panel-html';
import type {
  PluginMailRequest,
  PluginMailResult,
  PluginMenuItem,
  PluginNetRequest,
  PluginNetResponse,
  PluginNotificationRequest,
  PluginPanelView,
  PluginPermission,
  PluginProcessRequest,
  PluginProcessResult,
  PluginPythonInfo,
  PluginPythonRequest,
  PluginUIEvent,
} from '../shared/plugin-types';
import type { MailDelivery, MailDeliveryResult } from './ai/note-service';
/* 传输层负载与 IPC 契约放在一起（shared/ipc.ts），这里只借用类型 */
import type {
  PluginMenuEntryPayload,
  PluginPanelActionPayload,
  PluginTimerPayload,
  PluginTimerTickPayload,
  PluginUIContributionPayload,
} from '../shared/ipc';

export interface PluginRuntimeOptions {
  readonly config: PetConfig;
  readonly logger: Logger;
  /** 权限执法依据（PluginManager 持有，已按 plugins.json 收窄）。 */
  readonly permissionsOf: (pluginId: string) => readonly PluginPermission[];
  /** 插件的绝对目录（同时充当"这个插件存在且在启用状态"的判据）。 */
  readonly dirOf: (pluginId: string) => string | null;
  /** 插件显示名（面板/菜单要显示"这是谁的"）。 */
  readonly nameOf: (pluginId: string) => string;
  /** 把界面事件（菜单点击 / 通知点击 / 面板动作）送回桌宠渲染层。 */
  readonly emitUIEvent: (event: PluginUIEvent) => void;
  /** 定时器到点（送回桌宠渲染层执行 handler）。 */
  readonly emitTimer: (payload: PluginTimerTickPayload) => void;
  /** 界面贡献变化：托盘要重建菜单、聊天窗口要刷新面板页签。 */
  readonly onUIContributionChanged: () => void;
  /**
   * 把一封邮件交给收件箱落盘（`mail` 权限的最后一公里）。
   *
   * 由 main.ts 接到 AIService 的收件箱上：插件运行时只管"能不能、合不合法"，
   * 内容存哪、长什么样是认知层的事。
   */
  readonly deliverMail?: (delivery: MailDelivery) => MailDeliveryResult;
}

interface TimerEntry {
  readonly pluginId: string;
  readonly kind: 'after' | 'every';
  readonly handle: NodeJS.Timeout;
}

interface Contribution {
  readonly pluginName: string;
  readonly menuItems: readonly PluginMenuItem[];
  readonly panels: readonly PluginPanelView[];
}

const DEFAULT_NET_TIMEOUT_MS = 15_000;
const MAX_NET_TIMEOUT_MS = 60_000;
const DEFAULT_NET_MAX_BYTES = 2 * 1024 * 1024;
const MAX_NET_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 20_000;
const MAX_PROCESS_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MIN_TIMER_MS = 200;
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
const MAX_MENU_ITEMS = 20;
const MAX_PANELS = 8;
/** 一封插件邮件的附件上限（与 `shared/notes.ts` 的规则同值）。 */
const MAX_MAIL_ATTACHMENTS = 5;
const MAX_MAIL_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export class PluginRuntime {
  private readonly options: PluginRuntimeOptions;
  private readonly logger: Logger;
  /** 定时器：key = pluginId + '\u0000' + timerId（同一插件不能用同一个 id 起两个）。 */
  private readonly timers = new Map<string, TimerEntry>();
  /** 每个插件起过的子进程（停用时全部杀掉）。 */
  private readonly children = new Map<string, Set<ChildProcess>>();
  /** 界面贡献（菜单项 + 面板），停用时整条删掉。 */
  private readonly contributions = new Map<string, Contribution>();
  /** 通知对象要留引用，否则可能被 GC 掉导致点了没反应。 */
  private readonly notifications = new Set<Notification>();
  /** Python 解释器探测结果（进程内只探一次）。 */
  private pythonProbe: Promise<PluginPythonInfo> | null = null;

  public constructor(options: PluginRuntimeOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /* ------------------------------------------------------------------ */
  /* 网络（权限 net）                                                     */
  /* ------------------------------------------------------------------ */

  public async net(pluginId: string, request: PluginNetRequest): Promise<PluginNetResponse> {
    const denial = this.ensure(pluginId, 'net');
    if (denial) return netFailure(denial);

    const rawUrl = typeof request?.url === 'string' ? request.url.trim() : '';
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return netFailure('url 非法');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return netFailure(`只允许 http/https（收到 ${url.protocol}）`);
    }

    const method = (request.method ?? 'GET').toUpperCase();
    const timeoutMs = clamp(request.timeoutMs ?? DEFAULT_NET_TIMEOUT_MS, 1000, MAX_NET_TIMEOUT_MS);
    const maxBytes = clamp(request.maxBytes ?? DEFAULT_NET_MAX_BYTES, 1024, MAX_NET_MAX_BYTES);
    const hasBody = typeof request.body === 'string' && method !== 'GET' && method !== 'HEAD';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: sanitizeHeaders(request.headers),
        ...(hasBody ? { body: request.body } : {}),
        signal: controller.signal,
        redirect: 'follow',
      });
      const { text, truncated } = await readCapped(response, maxBytes);
      return {
        ok: response.ok,
        status: response.status,
        headers: collectHeaders(response.headers),
        body: text,
        truncated,
      };
    } catch (error) {
      return netFailure(describeError(error));
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 本机命令（权限 process）                                             */
  /* ------------------------------------------------------------------ */

  public async runProcess(pluginId: string, request: PluginProcessRequest): Promise<PluginProcessResult> {
    const denial = this.ensure(pluginId, 'process');
    if (denial) return processFailure(denial);

    const command = typeof request?.command === 'string' ? request.command.trim() : '';
    if (command === '') return processFailure('command 不能为空');

    const cwd = this.resolveCwd(pluginId, request.cwd);
    if (cwd instanceof Error) return processFailure(cwd.message);

    return this.spawnOnce(pluginId, command, normalizeArgs(request.args), {
      ...(cwd !== null ? { cwd } : {}),
      stdin: typeof request.stdin === 'string' ? request.stdin : undefined,
      timeoutMs: clamp(request.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS, 500, MAX_PROCESS_TIMEOUT_MS),
      maxOutputBytes: clamp(request.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES),
      env: sanitizeEnv(request.env),
    });
  }

  public async which(pluginId: string, command: string): Promise<string | null> {
    const denial = this.ensure(pluginId, 'process');
    if (denial) return null;
    const target = typeof command === 'string' ? command.trim() : '';
    if (target === '') return null;

    const finder = process.platform === 'win32' ? 'where' : 'which';
    const result = await this.spawnOnce(pluginId, finder, [target], {
      timeoutMs: 5000,
      maxOutputBytes: 16 * 1024,
    });
    if (!result.ok) return null;
    const first = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '');
    return first ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Python（权限 python）                                                */
  /* ------------------------------------------------------------------ */

  public async pythonInfo(pluginId: string): Promise<PluginPythonInfo> {
    const denial = this.ensure(pluginId, 'python');
    if (denial) return { ok: false, interpreter: null, version: null, error: denial };
    if (!this.pythonProbe) {
      this.pythonProbe = this.probePython(pluginId).catch((error: unknown) => ({
        ok: false,
        interpreter: null,
        version: null,
        error: describeError(error),
      }));
    }
    return this.pythonProbe;
  }

  /** 按 `python3` -> `python` -> `py -3` 的顺序探测（Windows 上 `py` 是官方启动器）。 */
  private async probePython(pluginId: string): Promise<PluginPythonInfo> {
    const candidates: readonly (readonly string[])[] = [['python3'], ['python'], ['py', '-3']];
    for (const candidate of candidates) {
      const [command, ...preset] = candidate;
      if (!command) continue;
      const result = await this.spawnOnce(pluginId, command, [...preset, '--version'], {
        timeoutMs: 8000,
        maxOutputBytes: 16 * 1024,
      });
      if (!result.ok) continue;
      const versionLine = `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== '');
      const interpreter = [command, ...preset].join(' ');
      this.logger.info('python interpreter found', { data: { interpreter, version: versionLine ?? '' } });
      return { ok: true, interpreter, version: versionLine ?? null };
    }
    this.logger.warn('no python interpreter found (tried python3 / python / py -3)');
    return {
      ok: false,
      interpreter: null,
      version: null,
      error: '没找到可用的 Python（试过 python3 / python / py -3）',
    };
  }

  public async pythonRun(pluginId: string, request: PluginPythonRequest): Promise<PluginProcessResult> {
    const denial = this.ensure(pluginId, 'python');
    if (denial) return processFailure(denial);

    const info = await this.pythonInfo(pluginId);
    if (!info.ok || !info.interpreter) return processFailure(info.error ?? 'Python 不可用');

    const parts = info.interpreter.split(' ');
    const command = parts[0] ?? '';
    const preset = parts.slice(1);

    let scriptArgs: string[];
    const script = typeof request?.script === 'string' ? request.script : '';
    const pluginDir = this.options.dirOf(pluginId);
    if (script.trim() !== '') {
      scriptArgs = ['-c', script];
    } else if (typeof request?.file === 'string' && request.file.trim() !== '') {
      if (!pluginDir) return processFailure('找不到插件目录');
      // 只允许插件目录内的 .py：插件不该借 Python 读到别处去
      const file = safeJoin(pluginDir, request.file.trim());
      if (!file || !file.toLowerCase().endsWith('.py') || !existsSync(file)) {
        return processFailure('脚本文件不存在，或不在插件目录内（只接受插件目录里的 .py）');
      }
      scriptArgs = [file];
    } else {
      return processFailure('必须给 script（代码）或 file（插件目录里的 .py）');
    }

    return this.spawnOnce(pluginId, command, [...preset, ...scriptArgs, ...normalizeArgs(request.args)], {
      ...(pluginDir ? { cwd: pluginDir } : {}),
      stdin: typeof request.stdin === 'string' ? request.stdin : undefined,
      timeoutMs: clamp(request.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS, 500, MAX_PROCESS_TIMEOUT_MS),
      maxOutputBytes: clamp(request.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, 1024, MAX_OUTPUT_BYTES),
    });
  }

  /* ------------------------------------------------------------------ */
  /* 收件箱投递（权限 mail）                                              */
  /* ------------------------------------------------------------------ */

  /**
   * 把一封"邮件"（主题 + 正文 + 0..N 个附件）投递到「交互」收件箱。
   *
   * 两条边界都在这里落地：
   * 1. **权限**：没声明 `mail` 一律拒绝（和联网/起进程同一条执法路径）；
   * 2. **形状**：主题/正文截断、附件数量与体积上限、base64 解码失败即拒绝 ——
   *    插件交上来的是**内容**，写盘那一层（NoteService）不该再操心"这是不是合法输入"。
   *
   * 写盘与落库交给注入的 `deliverMail`（main.ts 把它接在 AIService 的收件箱上），
   * 因为"收件箱"是 AI 认知层的东西，插件运行时只负责"能不能、合不合法"。
   */
  public sendMail(pluginId: string, request: PluginMailRequest): PluginMailResult {
    const denial = this.ensure(pluginId, 'mail');
    if (denial) return { ok: false, files: [], error: denial };

    const subject = String(request?.subject ?? '').trim().slice(0, 60);
    if (subject === '') return { ok: false, files: [], error: 'subject（主题）不能为空' };
    const body = typeof request?.body === 'string' ? request.body.slice(0, 4000) : '';

    const rawAttachments = Array.isArray(request?.attachments) ? request.attachments : [];
    if (rawAttachments.length > MAX_MAIL_ATTACHMENTS) {
      return {
        ok: false,
        files: [],
        error: `附件太多了（最多 ${MAX_MAIL_ATTACHMENTS} 个，收到 ${rawAttachments.length} 个）`,
      };
    }

    const attachments: { name: string; bytes: Buffer }[] = [];
    for (const attachment of rawAttachments) {
      const name = String(attachment?.name ?? '').trim();
      const content = typeof attachment?.content === 'string' ? attachment.content : '';
      if (name === '' || content === '') continue;
      let bytes: Buffer;
      try {
        bytes = attachment.encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      } catch (error) {
        this.logger.warn('plugin attachment decode failed', { error: describeError(error), data: { pluginId, name } });
        continue;
      }
      if (bytes.byteLength === 0) continue;
      if (bytes.byteLength > MAX_MAIL_ATTACHMENT_BYTES) {
        this.logger.warn('plugin attachment too large', {
          data: { pluginId, name, size: bytes.byteLength, limit: MAX_MAIL_ATTACHMENT_BYTES },
        });
        continue;
      }
      attachments.push({ name, bytes });
    }

    if (body.trim() === '' && attachments.length === 0) {
      return { ok: false, files: [], error: '正文和附件都是空的，没有可投递的内容' };
    }

    const deliver = this.options.deliverMail;
    if (!deliver) return { ok: false, files: [], error: '收件箱未就绪（AI 模块还没起来）' };

    const result = deliver({
      sender: { kind: 'plugin', id: pluginId, name: this.options.nameOf(pluginId) },
      subject,
      ...(body === '' ? {} : { body }),
      attachments,
    });
    return {
      ok: result.ok,
      ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
      files: result.files,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 通知 / 打开浏览器（权限 notify / ui）                                 */
  /* ------------------------------------------------------------------ */

  public notify(pluginId: string, request: PluginNotificationRequest): boolean {
    const denial = this.ensure(pluginId, 'notify');
    if (denial) return false;

    const title = String(request?.title ?? '').trim().slice(0, 120) || '桌宠插件';
    const body = String(request?.body ?? '').slice(0, 600);
    if (!Notification.isSupported()) {
      this.logger.warn('system notification not supported on this platform');
      return false;
    }

    const notification = new Notification({ title, body, silent: request?.silent === true });
    const notificationId = request?.id;
    notification.on('click', () => {
      this.options.emitUIEvent({
        kind: 'notification',
        pluginId,
        ...(notificationId !== undefined ? { notificationId } : {}),
      });
    });
    notification.on('close', () => this.notifications.delete(notification));
    this.notifications.add(notification);
    notification.show();
    this.logger.info('plugin notification shown', { data: { pluginId, title } });
    return true;
  }

  public async openExternal(pluginId: string, url: string): Promise<boolean> {
    const denial = this.ensure(pluginId, 'ui');
    if (denial) return false;
    const target = typeof url === 'string' ? url.trim() : '';
    if (!/^https?:\/\//i.test(target)) {
      this.logger.warn('plugin openExternal rejected (only http/https)', { data: { pluginId } });
      return false;
    }
    try {
      await shell.openExternal(target);
      return true;
    } catch (error) {
      this.logger.warn('plugin openExternal failed', { error: describeError(error), data: { pluginId } });
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 定时器（由主进程持有，停用即清表）                                     */
  /* ------------------------------------------------------------------ */

  public startTimer(payload: PluginTimerPayload): boolean {
    if (!this.options.dirOf(payload.pluginId)) return false;
    const intervalMs = clamp(payload.intervalMs, MIN_TIMER_MS, MAX_TIMER_MS);
    const key = timerKey(payload.pluginId, payload.timerId);
    this.cancelTimer(payload.pluginId, payload.timerId);

    const tick = (): void => {
      this.options.emitTimer({
        pluginId: payload.pluginId,
        timerId: payload.timerId,
        kind: payload.kind,
      });
    };
    const handle = payload.kind === 'every'
      ? setInterval(tick, intervalMs)
      : setTimeout(() => {
          this.timers.delete(key);
          tick();
        }, intervalMs);
    // 插件的定时器不该把应用吊在进程里（`before-quit` 会统一 `dispose`）
    handle.unref?.();
    this.timers.set(key, { pluginId: payload.pluginId, kind: payload.kind, handle });
    return true;
  }

  public cancelTimer(pluginId: string, timerId: string): boolean {
    const key = timerKey(pluginId, timerId);
    const entry = this.timers.get(key);
    if (!entry) return false;
    if (entry.kind === 'every') clearInterval(entry.handle);
    else clearTimeout(entry.handle);
    this.timers.delete(key);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 界面贡献：菜单项 + 面板                                              */
  /* ------------------------------------------------------------------ */

  public setUIContribution(pluginId: string, contribution: PluginUIContributionPayload): void {
    const pluginName = this.options.nameOf(pluginId);
    // 声明成具体元素类型：`Array.isArray` 会把类型收窄成 any[]，后面 map 出来的元素就没人管了
    const rawMenuItems: readonly PluginMenuItem[] = Array.isArray(contribution?.menuItems)
      ? contribution.menuItems
      : [];
    const rawPanels: readonly PluginPanelView[] = Array.isArray(contribution?.panels) ? contribution.panels : [];

    const menuItems = rawMenuItems
      .slice(0, MAX_MENU_ITEMS)
      .map((item) => ({
        id: String(item.id ?? '').slice(0, 60),
        label: String(item.label ?? '').slice(0, 80),
        ...(item.hint !== undefined ? { hint: String(item.hint).slice(0, 120) } : {}),
        ...(item.checked !== undefined ? { checked: item.checked === true } : {}),
      }))
      .filter((item) => item.id !== '' && item.label !== '');

    // 面板 HTML 的长度上限在这里再兜一次（渲染前还有一道净化，见 shared/plugin-panel-html.ts）
    const panels = rawPanels
      .slice(0, MAX_PANELS)
      .map((panel) => ({
        pluginId,
        pluginName,
        panelId: String(panel.panelId ?? '').slice(0, 60),
        title: String(panel.title ?? '插件面板').slice(0, 60),
        html: String(panel.html ?? '').slice(0, MAX_PANEL_HTML_BYTES),
        updatedAt: Date.now(),
      }))
      .filter((panel) => panel.panelId !== '');

    this.contributions.set(pluginId, { pluginName, menuItems, panels });
    this.options.onUIContributionChanged();
  }

  public getMenuEntries(): readonly PluginMenuEntryPayload[] {
    const entries: PluginMenuEntryPayload[] = [];
    for (const [pluginId, contribution] of this.contributions) {
      for (const item of contribution.menuItems) {
        entries.push({ ...item, pluginId, pluginName: contribution.pluginName });
      }
    }
    return entries;
  }

  public getPanelViews(): readonly PluginPanelView[] {
    const panels: PluginPanelView[] = [];
    for (const contribution of this.contributions.values()) panels.push(...contribution.panels);
    return panels;
  }

  /** 托盘菜单点了某个插件的菜单项 -> 转给渲染层里真正跑着的插件。 */
  public handleMenuClick(pluginId: string, itemId: string): boolean {
    const contribution = this.contributions.get(pluginId);
    if (!contribution?.menuItems.some((item) => item.id === itemId)) return false;
    this.options.emitUIEvent({ kind: 'menu', pluginId, itemId });
    return true;
  }

  /** 聊天窗口点了面板里的动作 -> 转给渲染层里真正跑着的插件。 */
  public handlePanelAction(payload: PluginPanelActionPayload): boolean {
    const pluginId = String(payload?.pluginId ?? '');
    const panelId = String(payload?.panelId ?? '');
    const actionId = String(payload?.actionId ?? '');
    const contribution = this.contributions.get(pluginId);
    if (!contribution?.panels.some((panel) => panel.panelId === panelId)) return false;
    if (actionId === '') return false;
    this.options.emitUIEvent({
      kind: 'panel-action',
      pluginId,
      panelId,
      actionId,
      fields: sanitizeFields(payload?.fields),
    });
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 回收：停用一个插件 = 把它在这里留下的一切都收掉                        */
  /* ------------------------------------------------------------------ */

  public revoke(pluginId: string): void {
    let timers = 0;
    for (const [key, entry] of [...this.timers]) {
      if (entry.pluginId !== pluginId) continue;
      if (entry.kind === 'every') clearInterval(entry.handle);
      else clearTimeout(entry.handle);
      this.timers.delete(key);
      timers += 1;
    }

    const children = this.children.get(pluginId);
    let killed = 0;
    if (children) {
      for (const child of [...children]) {
        killChild(child);
        killed += 1;
      }
      children.clear();
    }

    const hadContribution = this.contributions.delete(pluginId);
    if (hadContribution) this.options.onUIContributionChanged();
    this.logger.info('plugin runtime revoked', { data: { pluginId, timers, killed } });
  }

  /** 退出前清理（`before-quit`）：不留孤儿进程与定时器。 */
  public dispose(): void {
    for (const [key, entry] of [...this.timers]) {
      if (entry.kind === 'every') clearInterval(entry.handle);
      else clearTimeout(entry.handle);
      this.timers.delete(key);
    }
    for (const children of this.children.values()) {
      for (const child of [...children]) killChild(child);
      children.clear();
    }
    for (const notification of [...this.notifications]) {
      try {
        notification.close();
      } catch {
        // 关闭失败无所谓：进程要退了
      }
    }
    this.notifications.clear();
  }

  /* ------------------------------------------------------------------ */
  /* 内部工具                                                            */
  /* ------------------------------------------------------------------ */

  /** 权限执法：返回拒绝原因（null = 放行）。 */
  private ensure(pluginId: string, permission: PluginPermission): string | null {
    const id = typeof pluginId === 'string' ? pluginId : '';
    if (id === '') return '插件 id 缺失';
    if (!this.options.permissionsOf(id).includes(permission)) {
      this.logger.warn('plugin capability denied (missing permission)', { data: { pluginId: id, permission } });
      return `插件 ${id} 没有 ${permission} 权限（需要在它的 package.json 里声明，且没被 plugins.json 收窄）`;
    }
    return null;
  }

  private resolveCwd(pluginId: string, cwd: string | undefined): string | null | Error {
    if (typeof cwd !== 'string' || cwd.trim() === '') return null;
    const dir = this.options.dirOf(pluginId);
    if (!dir) return new Error('找不到插件目录');
    const target = safeJoin(dir, cwd.trim());
    if (!target) return new Error('cwd 必须落在插件目录内');
    return target;
  }

  private track(pluginId: string, child: ChildProcess): void {
    let set = this.children.get(pluginId);
    if (!set) {
      set = new Set<ChildProcess>();
      this.children.set(pluginId, set);
    }
    set.add(child);
  }

  private untrack(pluginId: string, child: ChildProcess): void {
    const set = this.children.get(pluginId);
    if (!set) return;
    set.delete(child);
    if (set.size === 0) this.children.delete(pluginId);
  }

  /**
   * 跑一个子进程并把结果收敛成结构化数据。
   *
   * 三条硬约束（都是"不能让插件的子进程拖垮桌宠"）：
   * 1. `shell: false`：参数按数组传，不经过命令行解析（没有引号/转义注入）；
   * 2. 超时必杀：默认 20s，上限 5 分钟；
   * 3. 输出截断：默认单路 256KB，超出部分丢弃并置 `truncated`。
   */
  private spawnOnce(
    pluginId: string,
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly stdin?: string | undefined;
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly env?: Readonly<Record<string, string>>;
    },
  ): Promise<PluginProcessResult> {
    return new Promise<PluginProcessResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command, [...args], {
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          shell: false,
          windowsHide: true,
          env: options.env ? { ...process.env, ...options.env } : process.env,
        });
      } catch (error) {
        resolve(processFailure(describeError(error)));
        return;
      }

      this.track(pluginId, child);
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer): void => {
        const current = target === 'stdout' ? stdout : stderr;
        if (Buffer.byteLength(current, 'utf8') >= options.maxOutputBytes) {
          truncated = true;
          return;
        }
        const text = chunk.toString('utf8');
        if (target === 'stdout') stdout += text;
        else stderr += text;
      };
      child.stdout?.on('data', collect('stdout'));
      child.stderr?.on('data', collect('stderr'));

      const finish = (code: number | null, error?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.untrack(pluginId, child);
        resolve({
          ok: code === 0 && error === undefined && !timedOut,
          code,
          stdout,
          stderr,
          timedOut,
          truncated,
          ...(error !== undefined ? { error } : {}),
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killChild(child);
        // 兜底：极端情况下 close 不来（句柄未释放）也不能让 Promise 永远挂着
        setTimeout(() => finish(null, `超时（${options.timeoutMs}ms）`), 1500).unref?.();
      }, options.timeoutMs);

      child.on('error', (error) => finish(null, describeError(error)));
      child.on('close', (code) => {
        if (timedOut) finish(code, `超时（${options.timeoutMs}ms）`);
        else finish(code);
      });

      try {
        if (options.stdin !== undefined) child.stdin?.end(options.stdin, 'utf8');
        else child.stdin?.end();
      } catch {
        // 子进程可能已经退出：写 stdin 失败不影响结果
      }
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 纯工具                                                                      */
/* -------------------------------------------------------------------------- */

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function timerKey(pluginId: string, timerId: string): string {
  return `${pluginId}\u0000${timerId}`;
}

function killChild(child: ChildProcess): void {
  try {
    if (process.platform === 'win32') child.kill();
    else child.kill('SIGKILL');
  } catch {
    // 已经退出的进程 kill 会抛，忽略
  }
}

function normalizeArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  return args.slice(0, 200).map((arg) => String(arg));
}

function sanitizeHeaders(headers: PluginNetRequest['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') return result;
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key).trim();
    if (name === '' || typeof value !== 'string') continue;
    // 禁止覆盖 Host / Content-Length 这类由运行时决定的头
    if (/^(host|content-length|connection|transfer-encoding)$/i.test(name)) continue;
    result[name] = value;
  }
  return result;
}

function sanitizeEnv(env: PluginProcessRequest['env']): Record<string, string> | undefined {
  if (!env || typeof env !== 'object') return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string') result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeFields(fields: PluginPanelActionPayload['fields']): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fields || typeof fields !== 'object') return result;
  let count = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (count >= 50) break;
    result[String(key).slice(0, 60)] = String(value).slice(0, 4000);
    count += 1;
  }
  return result;
}

function collectHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/** 按上限读取响应体（不把 1GB 的响应整个读进内存）。 */
async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: '', truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, maxBytes - total)));
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        // 取消失败无所谓：我们已经拿到要的那一段
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function netFailure(error: string): PluginNetResponse {
  return { ok: false, status: 0, headers: {}, body: '', truncated: false, error };
}

function processFailure(error: string): PluginProcessResult {
  return { ok: false, code: null, stdout: '', stderr: '', timedOut: false, truncated: false, error };
}
