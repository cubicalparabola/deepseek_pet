/**
 * todo-plugin —— 待办清单（第一个真插件）。
 *
 * 需求（用户原话）："用户可以输入时间和事件，如果到时间，宠物会提醒该做什么事了。
 * 用户也可以自己随时打勾删掉。"
 *
 * 因此它做四件事：
 *   1. **输入**：面板上写"要做什么"+"什么时候"（原生 `datetime-local`），
 *      外加「15 分钟后 / 1 小时后 / 3 小时后 / 不设提醒」几个快捷键；
 *   2. **到点提醒**：`context.timers`（**主进程计时**，窗口隐藏也不会被降频）
 *      -> 桌宠冒泡说"到时间啦：…" + 系统通知 + 演 `remind` 动画；
 *   3. **打勾 / 删除**：每条一行，`完成 / 恢复`、`+10 分钟`、`删除`；
 *   4. **持久化**：`context.storage`（按插件命名空间隔离的 JSON）。
 *
 * ── 为什么这些都不需要主程序改动 ──────────────────────────────────
 * 全部走已有接口：`storage`（存清单）、`ui.registerPanel`（声明式面板：输入框 +
 * `data-plugin-action` 按钮）、`ui.say`（气泡）、`notify.send/onClick`（系统通知）、
 * `animations.play`（remind 动画）、`timers`（主进程计时）、
 * `ui.registerMenuItem / updateMenuItem`（托盘「插件」子菜单入口）、
 * `mail.send`（把清单导出到「交互」收件箱）。主程序一行没改。
 *
 * ── 已知边界（都是宿主/平台的取舍，不是"缺接口"）──────────────────
 * - 面板是**声明式 HTML，没有脚本**：每次重画都按插件给的 HTML 重建，
 *   所以"没提交的输入框草稿"会在重画时丢（本插件每次动作后重画，属于预期）；
 * - 桌宠**没在运行**时到点不会响：只能在运行期间提醒，并在下次启动时把
 *   "早就过点、还没提醒过"的补提醒一次；
 * - 点系统通知会打开待办面板（`notify.onClick` -> `ui.openPanel`）。
 */

import { definePlugin, type PluginContext, type PluginTimerHandle } from 'desktop-pet';

/* -------------------------------------------------------------------------- */
/* 数据                                                                        */
/* -------------------------------------------------------------------------- */

interface TodoItem {
  readonly id: string;
  /** 要做的事（用户输入，渲染前一定转义）。 */
  readonly text: string;
  /** 到点时间（epoch ms）；null = 只要一条清单，不提醒。 */
  readonly dueAt: number | null;
  readonly createdAt: number;
  /** 已经提醒过（防止同一条反复响）。 */
  readonly reminded: boolean;
  readonly done: boolean;
  readonly doneAt: number | null;
}

const STORAGE_KEY = 'todos';
/** 最多留多少条（防止 localStorage 无限长大）。 */
const MAX_ITEMS = 200;
const TEXT_MAX = 120;
/** 「+10 分钟」那个按钮的量。 */
const SNOOZE_MS = 10 * 60 * 1000;
/**
 * 定时器一次最多睡 6 小时。
 *
 * 主进程的定时器本身允许到 24 小时，但"睡一小段、醒来再排下一次"更稳：
 * 系统休眠或用户改过系统时间之后，长定时器的绝对时刻会失准；
 * 每次醒来都按 `dueAt - now` 重算，就自动跟上了。
 */
const WAKE_CAP_MS = 6 * 60 * 60 * 1000;
const MIN_WAKE_MS = 1000;
/** 超过这个时长才算"早就过点了"（提醒文案不同）。 */
const LATE_MS = 90 * 1000;

/* -------------------------------------------------------------------------- */
/* 纯函数（格式化与渲染）                                                        */
/* -------------------------------------------------------------------------- */

/** HTML 转义：面板里的文本全部来自用户，必须转义（净化器只挡脚本，挡不住结构被改写）。 */
function escapeHtml(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** epoch ms -> `<input type="datetime-local">` 要的 `YYYY-MM-DDTHH:mm`（**本地时间**）。 */
function toInputValue(dueAt: number | null): string {
  if (dueAt === null || !Number.isFinite(dueAt)) return '';
  const date = new Date(dueAt);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
    + `T${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** `YYYY-MM-DDTHH:mm`（本地时间）-> epoch ms；解析不出来返回 null。 */
function parseLocalInput(value: unknown): number | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return null;
  // `new Date('2026-09-28T14:30')` 按**本地时间**解析（带 Z 才是 UTC），正是我们要的
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(hours / 24)} 天`;
}

/** 时间列的人话："已过 12 分钟（已提醒）" / "18:30 · 还有 3 分钟" / "今天 18:00" / "明天 09:00"。 */
function formatDue(dueAt: number | null, now: number, reminded: boolean, done: boolean): string {
  if (dueAt === null) return '不提醒';
  const diff = dueAt - now;
  const date = new Date(dueAt);
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}`;
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  const tomorrow = new Date(now + 86_400_000);
  const isTomorrow = date.getFullYear() === tomorrow.getFullYear()
    && date.getMonth() === tomorrow.getMonth()
    && date.getDate() === tomorrow.getDate();

  if (done) return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock}`;
  if (diff <= 0) {
    // 已经过点：提醒过就标"已提醒"，还没提醒过（程序刚起来）才是"马上提醒"
    const late = `已过 ${minutesLabel(-diff)}`;
    return reminded ? `${late}（已提醒）` : `${late}（待提醒）`;
  }
  if (diff <= 60 * 60 * 1000) return `${clock} · 还有 ${minutesLabel(diff)}`;
  if (sameDay) return `今天 ${clock}`;
  if (isTomorrow) return `明天 ${clock}`;
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock}`;
}

/** 未完成在前（按到点时间升序，"不提醒"排最后），已完成沉底（按完成时间倒序）。 */
function sortItems(items: readonly TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done && b.done) return (b.doneAt ?? 0) - (a.doneAt ?? 0);
    const aDue = a.dueAt ?? Number.POSITIVE_INFINITY;
    const bDue = b.dueAt ?? Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return a.createdAt - b.createdAt;
  });
}

/** 下一个"该醒来"的时刻（未完成 + 没提醒过 + 有时间）。 */
function nextWakeAt(items: readonly TodoItem[]): number | null {
  let next: number | null = null;
  for (const item of items) {
    if (item.done || item.reminded || item.dueAt === null) continue;
    if (next === null || item.dueAt < next) next = item.dueAt;
  }
  return next;
}

function pendingCount(items: readonly TodoItem[]): number {
  return items.filter((item) => !item.done).length;
}

/**
 * 面板 HTML（声明式：只有展示标签 + `data-plugin-action` 按钮 / `data-plugin-field` 输入框）。
 *
 * 样式尽量蹭宿主的 `.plugin-body` 规则（表格 / 输入框 / 按钮都已经有配色），
 * 只在"完成态"和"状态字"上用一点内联样式（净化器允许 style，但会剔掉 url()）。
 */
function renderPanelHtml(items: readonly TodoItem[], notice: string, now: number): string {
  const sorted = sortItems(items);
  const pending = pendingCount(items);
  const next = nextWakeAt(items);
  const nextText = next === null ? '没有待提醒的事' : `下一条：${formatDue(next, now, false, false)}`;

  const rows = sorted.map((item) => {
    const mark = item.done ? '✅' : '☐';
    const state = item.done
      ? '<span style="opacity:.6">已完成</span>'
      : item.reminded
        ? '<span style="color:#e0b050">已提醒</span>'
        : '';
    const textStyle = item.done ? ' style="text-decoration:line-through;opacity:.6"' : '';
    return [
      '<tr>',
      `<td style="white-space:nowrap">${mark}</td>`,
      `<td${textStyle}>${escapeHtml(item.text)}</td>`,
      `<td style="white-space:nowrap">${escapeHtml(formatDue(item.dueAt, now, item.reminded, item.done))} ${state}</td>`,
      '<td style="white-space:nowrap">',
      `<button data-plugin-action="toggle" data-plugin-value="${escapeHtml(item.id)}">${item.done ? '恢复' : '完成'}</button> `,
      item.done ? '' : `<button data-plugin-action="snooze" data-plugin-value="${escapeHtml(item.id)}">+10 分钟</button> `,
      `<button data-plugin-action="remove" data-plugin-value="${escapeHtml(item.id)}">删除</button>`,
      '</td>',
      '</tr>',
    ].join('');
  });

  const table = sorted.length === 0
    ? '<p class="plugin-hint">还没有待办。上面写一件事、选个时间，点「按上面的时间添加」就行。</p>'
    : [
      '<table>',
      '<thead><tr><th></th><th>要做的事</th><th>什么时候</th><th>操作</th></tr></thead>',
      '<tbody>',
      ...rows,
      '</tbody>',
      '</table>',
    ].join('');

  return [
    '<div class="plugin-todo">',
    `<p><strong>待办清单</strong> · 未完成 ${pending} 条 · ${escapeHtml(nextText)}</p>`,
    notice === '' ? '' : `<p style="color:#e0b050">${escapeHtml(notice)}</p>`,
    '<p>要做什么：<input data-plugin-field="text" maxlength="120" placeholder="比如：交周报" /></p>',
    `<p>什么时候：<input type="datetime-local" data-plugin-field="due" value="${escapeHtml(toInputValue(now + 60 * 60 * 1000))}" /></p>`,
    '<p>',
    '<button data-plugin-action="add">按上面的时间添加</button> ',
    '<button data-plugin-action="addIn" data-plugin-value="15">15 分钟后</button> ',
    '<button data-plugin-action="addIn" data-plugin-value="60">1 小时后</button> ',
    '<button data-plugin-action="addIn" data-plugin-value="180">3 小时后</button> ',
    '<button data-plugin-action="addNoTime">不设提醒</button>',
    '</p>',
    '<hr />',
    table,
    '<hr />',
    '<p>',
    '<button data-plugin-action="clearDone">清除已完成</button> ',
    '<button data-plugin-action="export">导出到「交互」</button>',
    '</p>',
    '<p class="plugin-hint">到点她会冒泡说话 + 发系统通知 + 演一个提醒动作；点通知会打开这个面板。</p>',
    '</div>',
  ].join('');
}

/* -------------------------------------------------------------------------- */
/* 插件                                                                        */
/* -------------------------------------------------------------------------- */

export default definePlugin({
  id: 'todo-plugin',
  name: '待办清单',
  version: '1.0.0',
  description: '输入时间与事件，到点由桌宠提醒；随时打勾或删除',

  activate(context: PluginContext): void {
    const { storage, ui, timers, notify, animations, logger, lifecycle } = context;

    let items: TodoItem[] = readItems();
    let counter = 0;
    let wake: PluginTimerHandle | null = null;
    /** 面板顶部那句提示（不落盘：它只是"上一次操作的结果"）。 */
    let notice = '';

    /* ------------------------------ 读写 ------------------------------ */

    function readItems(): TodoItem[] {
      const raw = storage.get<unknown>(STORAGE_KEY, []);
      if (!Array.isArray(raw)) return [];
      const parsed: TodoItem[] = [];
      for (const entry of raw.slice(0, MAX_ITEMS)) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const text = typeof record.text === 'string' ? record.text.slice(0, TEXT_MAX) : '';
        if (text.trim() === '') continue;
        const dueAt = typeof record.dueAt === 'number' && Number.isFinite(record.dueAt) ? record.dueAt : null;
        parsed.push({
          id: typeof record.id === 'string' && record.id !== '' ? record.id : `t${parsed.length}`,
          text,
          dueAt,
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
          reminded: record.reminded === true,
          done: record.done === true,
          doneAt: typeof record.doneAt === 'number' ? record.doneAt : null,
        });
      }
      return parsed;
    }

    function persist(): void {
      items = sortItems(items).slice(0, MAX_ITEMS);
      storage.set(STORAGE_KEY, items);
    }

    /* ---------------------------- 面板与菜单 ---------------------------- */

    function html(): string {
      return renderPanelHtml(items, notice, Date.now());
    }

    /** 面板重画 + 菜单标签跟着更新（定时器那条路径没有"返回值"，必须显式推）。 */
    function pushPanel(): void {
      ui.updatePanel('todo', { html: html() });
      refreshMenu();
    }

    /** 托盘「插件」子菜单里的一条：未完成条数直接写在标签上。 */
    ui.registerMenuItem({ id: 'open', label: '看待办清单…', hint: '打开聊天窗口里的待办面板' }, () => {
      void ui.openPanel('todo');
    });

    function refreshMenu(): void {
      const pending = pendingCount(items);
      ui.updateMenuItem('open', {
        label: pending === 0 ? '看待办清单…（没有未完成）' : `看待办清单…（${pending} 条未完成）`,
      });
    }

    /* ------------------------------ 定时器 ------------------------------ */

    function armWake(): void {
      if (wake !== null) {
        wake.cancel();
        wake = null;
      }
      const next = nextWakeAt(items);
      if (next === null) return;
      const delay = Math.min(Math.max(next - Date.now(), MIN_WAKE_MS), WAKE_CAP_MS);
      wake = timers.after(delay, () => {
        wake = null;
        void onWake();
      });
    }

    /** 醒来：把到点还没提醒过的都标成已提醒，并**只提醒一次**（最近的那条先说）。 */
    function onWake(): void {
      const now = Date.now();
      const due = items.filter(
        (item) => !item.done && !item.reminded && item.dueAt !== null && item.dueAt <= now,
      );
      if (due.length > 0) {
        const ids = new Set(due.map((item) => item.id));
        items = items.map((item) => (ids.has(item.id) ? { ...item, reminded: true } : item));
        persist();
        const first = due[0] as TodoItem;
        remind(first, due.length);
        pushPanel();
      }
      armWake();
    }

    /**
     * 提醒一次：动画（尽力而为）+ 气泡 + 系统通知。
     *
     * 动画可能被核心拒绝（她正在播不可打断的点击反应）—— 那是**正确**的仲裁，
     * 所以这里不重试、不报错：气泡与通知照发，提醒不能因为动画没插上就消失。
     */
    function remind(item: TodoItem, batch: number): void {
      const late = item.dueAt !== null && Date.now() - item.dueAt > LATE_MS;
      const head = late ? '该做的事早该开始啦' : '到时间啦';
      const extra = batch > 1 ? `（另外还有 ${batch - 1} 件也到点了）` : '';
      const line = `${head}：${item.text}${extra}`;
      logger.info(`提醒：${item.text}`, { data: { id: item.id, dueAt: item.dueAt, batch } });

      void animations
        .play('remind', { priority: 60, reason: `todo:${item.id}` })
        .then((result) => {
          if (!result.accepted) {
            logger.debug('提醒动画未被接受（不影响气泡与通知）', { data: { reason: String(result.reason ?? '') } });
          }
        })
        .catch((error: unknown) => logger.warn('提醒动画失败', { error: String(error) }));

      void ui.say(line).catch((error: unknown) => logger.warn('提醒气泡失败', { error: String(error) }));
      void notify
        .send({ title: late ? '待办（已过点）' : '待办提醒', body: line, id: item.id })
        .catch((error: unknown) => logger.warn('系统通知失败', { error: String(error) }));
    }

    /* ------------------------------ 动作 ------------------------------ */
    /* 每个动作只改状态 + 写盘 + 更新菜单；面板重画由调用方负责（`onAction` 返回 HTML / 定时器走 pushPanel）。 */

    /** 加一条：`dueAt` 给了就用它；文字为空只提示、不落盘。 */
    function add(text: unknown, dueAt: number | null, whenLabel: string): void {
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
      if (clean === '') {
        notice = '先写「要做什么」，再选时间。';
        refreshMenu();
        return;
      }
      counter += 1;
      const now = Date.now();
      items.push({
        id: `t${now.toString(36)}${counter.toString(36)}`,
        text: clean,
        dueAt,
        createdAt: now,
        reminded: false,
        done: false,
        doneAt: null,
      });
      persist();
      notice = dueAt === null ? `已记下：${clean}（不提醒）` : `已记下：${clean} · ${whenLabel}`;
      logger.info(`新增待办：${clean}`, { data: { dueAt } });
      refreshMenu();
      armWake();
    }

    function toggle(id: string): void {
      items = items.map((item) =>
        item.id === id ? { ...item, done: !item.done, doneAt: item.done ? null : Date.now() } : item,
      );
      persist();
      const target = items.find((item) => item.id === id);
      notice = target?.done === true ? `完成啦：${target.text}` : '又回到未完成。';
      refreshMenu();
      armWake();
    }

    function remove(id: string): void {
      const target = items.find((item) => item.id === id);
      items = items.filter((item) => item.id !== id);
      persist();
      notice = target ? `删掉了：${target.text}` : '那条已经不在了。';
      refreshMenu();
      armWake();
    }

    /** 往后推 10 分钟（顺手清掉"已提醒"，到点会再响一次）。 */
    function snooze(id: string): void {
      const now = Date.now();
      items = items.map((item) =>
        item.id === id ? { ...item, dueAt: now + SNOOZE_MS, reminded: false, done: false, doneAt: null } : item,
      );
      persist();
      const target = items.find((item) => item.id === id);
      notice = target ? `「${target.text}」推迟到 ${toInputValue(target.dueAt).replace('T', ' ')}` : '那条已经不在了。';
      refreshMenu();
      armWake();
    }

    function clearDone(): void {
      const done = items.filter((item) => item.done).length;
      items = items.filter((item) => !item.done);
      persist();
      notice = done === 0 ? '还没有已完成的事。' : `清掉了 ${done} 条已完成。`;
      refreshMenu();
      armWake();
    }

    /** 导出到「交互」收件箱（权限 mail）：清单以 Markdown 附件的形式交出去。 */
    async function exportToInbox(): Promise<void> {
      const lines = sortItems(items).map((item) => {
        const box = item.done ? '[x]' : '[ ]';
        const when = item.dueAt === null ? '' : ` · ${toInputValue(item.dueAt).replace('T', ' ')}`;
        return `- ${box} ${item.text}${when}`;
      });
      const markdown = ['# 待办清单', '', ...(lines.length > 0 ? lines : ['（空）']), ''].join('\n');
      try {
        const result = await context.mail.send({
          subject: `待办清单导出（${pendingCount(items)} 条未完成）`,
          body: '这是从待办插件导出的清单，点下面的附件可以查看。',
          attachments: [{ name: 'todo.md', content: markdown }],
        });
        notice = result.ok ? '已导出到「交互」收件箱（附件 todo.md）。' : `导出失败：${result.error ?? '未知原因'}`;
        logger.info('导出待办清单', { data: { ok: result.ok, files: result.files?.length ?? 0 } });
      } catch (error) {
        notice = '导出失败：插件桥不可用。';
        logger.warn('导出待办清单失败', { error: String(error) });
      }
      pushPanel();
    }

    /* ------------------------------ 面板 ------------------------------ */

    ui.registerPanel({
      id: 'todo',
      title: '待办清单',
      html: html(),
      onAction(action) {
        const fields = action.fields;
        const target = typeof fields.value === 'string' ? fields.value : '';
        switch (action.actionId) {
          case 'add':
            add(fields.text, parseLocalInput(fields.due), String(fields.due ?? '').replace('T', ' '));
            break;
          case 'addIn': {
            const minutes = Number(target);
            const safe = Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60 ? Math.round(minutes) : 60;
            add(fields.text, Date.now() + safe * 60 * 1000, `${safe} 分钟后`);
            break;
          }
          case 'addNoTime':
            add(fields.text, null, '');
            break;
          case 'toggle':
            toggle(target);
            break;
          case 'remove':
            remove(target);
            break;
          case 'snooze':
            snooze(target);
            break;
          case 'clearDone':
            clearDone();
            break;
          case 'export':
            void exportToInbox();
            break;
          default:
            logger.debug('未知的面板动作', { data: { actionId: action.actionId } });
            return undefined;
        }
        // 返回新 HTML：聊天窗口立刻重画（面板是"插件给什么就画什么"）
        return html();
      },
    });

    /* ------------------------------ 启动 ------------------------------ */

    // 点系统通知 -> 打开待办面板（"到点了" 到 "看清单" 是一条自然的路径）
    notify.onClick(() => {
      void ui.openPanel('todo');
    });

    refreshMenu();

    // 启动时把"早就过点、还没提醒过"的补提醒一次（程序没开的那段时间欠下的）
    const overdue = items.filter(
      (item) => !item.done && !item.reminded && item.dueAt !== null && item.dueAt <= Date.now(),
    );
    if (overdue.length > 0) {
      logger.info(`启动补提醒 ${overdue.length} 条`, { data: { ids: overdue.map((item) => item.id).join(',') } });
      timers.after(2000, () => {
        onWake();
      });
    }
    armWake();

    logger.info('待办清单已就绪', {
      data: {
        items: items.length,
        pending: pendingCount(items),
        next: nextWakeAt(items) ?? '(none)',
        permissions: lifecycle.permissions.join(',') || '(none)',
      },
    });
  },

  deactivate(): void {
    /*
     * 停用/卸载时宿主会自动收掉：定时器（`timers`）、面板与菜单项、通知点击回调。
     * 清单本身留在 `storage` 里 —— 关掉插件不该把用户记的事弄丢，重新启用就还在。
     */
  },
});
