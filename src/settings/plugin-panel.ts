/**
 * 「插件」设置面板。
 *
 * 与 `ai-panel.ts` / `perception-panel.ts` / `growth-panel.ts` 同构：面板是**自包含的挂载函数**，
 * 拿到容器 + 插件桥 + 初始快照就自带事件与刷新逻辑，设置页面只要一行接线。三处特别的地方：
 * 1. **打开窗口时清单还没到手**。`SettingsWindowBootstrap` 里没有插件快照（另外四个面板都有），
 *    而 `SettingsPluginAPI.list()` 本来就是异步的 —— 因此 `initial` 只当第一帧用，
 *    面板自己补一次 `list()`，之后靠 `onChanged` 推送。
 * 2. **开关失败必须把复选框拨回去**。用户看到的勾选态就是"这个插件到底开着没有"，
 *    一旦 `setEnabled` 失败还留着勾，界面就在撒谎 —— 所以失败分支一律 `render(latest)`，
 *    用最后一次已知清单重画（代价是丢一次焦点，换"绝不说谎"值得）。
 * 3. **插件名 / 目录 / 错误 / 权限全是外部数据**（来自插件的 `package.json` 与 `plugins.json`）。
 *    CSP 之下这些字符串只进 `textContent`，绝不当 HTML 解析。
 * 4. **安装 / 卸载也归主进程**。设置页面是纯静态页（CSP `connect-src 'none'`、拿不到
 *    `fs`），所以这里既没有路径输入框也没有删除逻辑：`install()` 弹目录选择框并复制，
 *    `uninstall()` 停用 + 删目录 + 从 `plugins.json` 移除，页面只负责按钮、二次确认与重画。
 *    卸载按钮只出现在 `removable === true` 的插件上 —— `plugins/examples/*` 是随包内容，
 *    删掉会破坏发布物，因此那种卡片**根本不渲染**卸载按钮（而不是渲染一个禁用的）。
 */

import type { SettingsPluginAPI } from '../shared/settings-window';
import type { PluginInstallResult, PluginPermission, PluginRecord, PluginStatus } from '../shared/plugin-types';
import { PLUGIN_PERMISSIONS, PLUGIN_PERMISSION_LABELS } from '../shared/plugin-types';

/* 通用小工具（纯 DOM，不碰业务状态）。 */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

/** 空清单的说明：照着做就能把插件装起来，别只回一句"没有"。 */
/*
 * 空状态的说明（照着做就能装上，别只回一句"没有"）。
 *
 * 安装按钮是这个面板的**主要入口**，所以第一句就点它；手装那条路仍然写出来 ——
 * 有人就是喜欢把目录拖进 `plugins/` 再手改清单。
 */
const EMPTY_HINT = '还没有插件：点上面的「安装插件…」挑一个插件文件夹即可（也可以把目录放进 plugins/，再在 assets/config/plugins.json 里登记后点「重新发现插件」）';

/** 插件状态的中文说法（`PluginStatus` 是给日志看的，用户看的是这一列）。 */
const STATUS_LABELS: Readonly<Record<PluginStatus, string>> = {
  discovered: '已发现（还没加载）',
  loading: '加载中',
  loaded: '已加载',
  activating: '启动中',
  active: '运行中',
  deactivating: '停止中',
  inactive: '已停止',
  disabled: '已停用',
  failed: '出错',
};

/** 状态胶囊的配色档位：能用 / 正在动 / 没在跑 / 坏了。 */
type StatusTone = 'ok' | 'busy' | 'muted' | 'danger';
const STATUS_TONES: Readonly<Record<PluginStatus, StatusTone>> = {
  discovered: 'muted',
  loading: 'busy',
  loaded: 'busy',
  activating: 'busy',
  active: 'ok',
  deactivating: 'busy',
  inactive: 'muted',
  disabled: 'muted',
  failed: 'danger',
};

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === '' ? '未知错误' : message;
}

/**
 * `PluginInstallResult` 里的失败原话（主进程已经写成能直接给用户看的话）。
 *
 * 刻意**不加工**：取消目录选择框时主进程回的也是这一路（例如 `已取消`），
 * 在这里包装成"操作失败"会把"你自己点了取消"说成"出错了"。
 */
function resultError(result: PluginInstallResult, fallback: string): string {
  const message = (result.error ?? '').trim();
  return message === '' ? fallback : message;
}

/** 插件声明的权限：老记录没有这个字段时退回生效权限，免得谎报"没申请任何权限"。 */
function declaredPermissions(record: PluginRecord): readonly PluginPermission[] {
  return record.declaredPermissions ?? record.permissions ?? [];
}

/** 权限是否被收窄掉了（`plugins.json` 的额度只减不增：插件想要、用户没给）。 */
function isNarrowed(record: PluginRecord, permission: PluginPermission): boolean {
  const effective = record.permissions ?? [];
  return declaredPermissions(record).includes(permission) && !effective.includes(permission);
}

/** 权限行：胶囊按 `PLUGIN_PERMISSIONS` 的顺序排（与配置文件里的展示顺序一致）。 */
function permissionRow(record: PluginRecord): HTMLElement {
  const row = el('div', 'plugin-perms');
  const declared = declaredPermissions(record);
  const effective = record.permissions ?? [];
  /*
   * 两个集合都要看：正常情况 declared ⊇ effective，但配置被手改过时可能出现只生效、未声明的项，
   * 那种权限也得显示出来（藏起来等于瞒着用户"这插件现在能联网"）。
   */
  const shown = PLUGIN_PERMISSIONS.filter((permission) => declared.includes(permission) || effective.includes(permission));
  if (shown.length === 0) {
    const none = el('span', 'plugin-perms-none');
    none.textContent = '没有申请任何系统权限';
    row.appendChild(none);
    return row;
  }
  const label = el('span', 'plugin-perms-label');
  label.textContent = '权限';
  row.appendChild(label);
  for (const permission of shown) {
    const narrowed = isNarrowed(record, permission);
    const chip = el('span', narrowed ? 'plugin-chip plugin-perm-narrowed' : 'plugin-chip');
    const permissionLabel = PLUGIN_PERMISSION_LABELS[permission];
    chip.textContent = narrowed ? `${permissionLabel}（已被你收窄）` : permissionLabel;
    chip.title = narrowed
      ? '插件声明了这一项，但 assets/config/plugins.json 里没给它 —— 主进程会拒绝相关调用。'
      : permissionLabel;
    row.appendChild(chip);
  }
  return row;
}

/** 状态胶囊（失败或带错误的插件标红，一眼能从一列里挑出来）。 */
function statusChip(record: PluginRecord): HTMLSpanElement {
  const failed = record.status === 'failed' || (record.error ?? '').trim() !== '';
  const tone: StatusTone = failed ? 'danger' : STATUS_TONES[record.status];
  const chip = el('span', `plugin-chip plugin-status-${tone}`);
  chip.textContent = STATUS_LABELS[record.status];
  return chip;
}

/**
 * 「启用」开关。
 *
 * 勾选态是整个面板唯一的"真相显示器"：一律以主进程回传的 `record.enabled` 为准，
 * 点击只负责把意图交出去（`onToggle`），不在这里自己改状态。
 */
function enabledSwitch(
  record: PluginRecord,
  onToggle: (control: HTMLInputElement, next: boolean) => void,
): HTMLLabelElement {
  const row = el('label', 'plugin-switch');
  const input = el('input', 'plugin-switch-input');
  input.type = 'checkbox';
  input.checked = record.enabled;
  input.id = `plugin-enabled-${record.id}`;
  input.setAttribute('aria-label', `启用插件 ${record.name}`);
  input.addEventListener('change', () => onToggle(input, input.checked));
  const text = el('span');
  text.textContent = '启用';
  row.append(input, text);
  return row;
}

/** 把「插件」面板挂到给定容器里。 */
export function mountPluginPanel(root: HTMLElement, api: SettingsPluginAPI, initial: readonly PluginRecord[]): void {
  const panel = el('div', 'plugin-panel');
  root.appendChild(panel);

  /** 最后一次已知清单：开关失败时要靠它把界面拨回真实状态。 */
  let latest: readonly PluginRecord[] = initial;

  const section = el('section', 'plugin-section');
  const heading = el('h2');
  heading.textContent = '插件';
  const intro = el('p', 'plugin-intro');
  // 一句话说清"关掉"的代价，以及"关了不会自己回来"：这是本面板存在的理由
  intro.textContent = '关掉一个插件会立刻回收它的一切：事件订阅、定时器、子进程、菜单项与面板，'
    + '并写回 assets/config/plugins.json —— 重启后它仍然是关的。';

  const actions = el('div', 'plugin-actions');
  const reloadButton = el('button', 'plugin-btn-ghost');
  reloadButton.type = 'button';
  reloadButton.id = 'plugin-reload';
  reloadButton.textContent = '重新发现插件';
  reloadButton.setAttribute('aria-label', '重新发现插件');
  /*
   * 安装**没有路径输入框**：目录选择框与"复制进 plugins/"都在主进程手里，
   * 设置页面看不到也用不到文件系统（纯静态页）。让用户手打路径只会多一条出错的路；
   * `install(directory?)` 的那个参数是留给自动化/验收的，界面永远不传。
   */
  const installButton = el('button', 'plugin-btn-ghost');
  installButton.type = 'button';
  installButton.id = 'plugin-install';
  installButton.textContent = '安装插件…';
  installButton.setAttribute('aria-label', '安装插件');
  // 动作回话行（DOM id 沿用 plugin-reload-result）：重新发现 / 安装的结果都写这里，
  // "点了没反应"会被当成坏了，读屏软件也应当播报
  const actionResult = el('span', 'plugin-reload-result');
  actionResult.id = 'plugin-reload-result';
  actionResult.setAttribute('role', 'status');
  actions.append(reloadButton, installButton, actionResult);

  const statusLine = el('p', 'plugin-status-line');
  statusLine.id = 'plugin-panel-status';
  statusLine.setAttribute('role', 'status');
  statusLine.textContent = '';

  const list = el('div', 'plugin-list');
  list.id = 'plugin-list';
  // role=list：一列插件，读屏软件按列表朗读（每张卡片是 listitem）
  list.setAttribute('role', 'list');

  section.append(heading, intro, actions, statusLine, list);
  panel.appendChild(section);

  function setPanelError(message: string): void {
    statusLine.textContent = message;
    statusLine.classList.add('plugin-status-error');
    // 日志用英文（项目约定），界面文案才是中文
    console.warn('[plugin-panel] action failed:', message);
  }

  function clearPanelError(): void {
    statusLine.textContent = '';
    statusLine.classList.remove('plugin-status-error');
  }

  /** 动作回话行（按钮右边那一格）：重新发现 / 安装成功的"有回音"都走这里。 */
  function showActionResult(message: string): void {
    actionResult.textContent = message;
  }

  /**
   * 状态行里的**原话**：卸载成功、安装被取消/失败都用它。
   *
   * 刻意不标红：`ok:false` 可能只是用户自己在目录选择框里点了取消，
   * 把"已取消"涂成红色等于把用户的选择说成故障。
   */
  function setPanelStatus(message: string): void {
    statusLine.textContent = message;
    statusLine.classList.remove('plugin-status-error');
  }

  /** 开关一次：成功用主进程回传的清单重画，失败用最后已知清单把复选框拨回去。 */
  function toggleEnabled(record: PluginRecord, control: HTMLInputElement, next: boolean): void {
    if (control.disabled) return;
    // 飞行中禁用它：同一张卡上连点两下不该产生两条互相追尾的写盘
    control.disabled = true;
    clearPanelError();
    void api
      .setEnabled(record.id, next)
      .then((records) => {
        render(records);
      })
      .catch((error: unknown) => {
        setPanelError(`${next ? '启用' : '停用'}「${record.name}」失败：${errorText(error)}`);
        // 关键：从最后已知清单重画 —— 勾选态绝不能停在"看起来改了、其实没改"
        render(latest);
      });
  }

  /**
   * 卸载一个插件。
   *
   * 二次确认是硬要求：这一步会**从磁盘上删掉 `plugins/<id>/`**，不可撤销。
   * 失败时和开关失败同一条规矩 —— 从最后已知清单重画，界面绝不显示"看起来卸掉了"。
   */
  function uninstallPlugin(record: PluginRecord, control: HTMLButtonElement): void {
    if (control.disabled) return;
    if (!window.confirm(`卸载「${record.name}」？会删掉 plugins/${record.id}/ 目录，并停止它的所有能力。`)) return;
    control.disabled = true;
    clearPanelError();
    void api
      .uninstall(record.id)
      .then((result) => {
        if (!result.ok) {
          // 卸载走到这里说明用户已经确认过，不存在"取消"：失败就是真失败，标红 + 记日志
          setPanelError(resultError(result, `卸载「${record.name}」失败（主进程没有给出原因）`));
          render(latest);
          return;
        }
        render(result.records);
        setPanelStatus(`已卸载「${record.name}」`);
      })
      .catch((error: unknown) => {
        setPanelError(`卸载「${record.name}」失败：${errorText(error)}`);
        render(latest);
      });
  }

  /** 一张插件卡片：名字 + 目录 + 状态 + 权限 + 开关（+ 可卸载时的「卸载」）；错误单独一行。 */
  function pluginCard(record: PluginRecord): HTMLElement {
    const card = el('article', 'plugin-card');
    card.setAttribute('role', 'listitem');
    // 停用的插件整卡压暗：一列里"哪些还活着"要一眼扫得出来
    if (!record.enabled) card.classList.add('plugin-card-off');

    const head = el('div', 'plugin-card-head');
    const headText = el('div', 'plugin-head-text');
    const name = el('h3', 'plugin-name');
    // name / version / dir 都来自插件的 package.json：只进 textContent
    name.textContent = `${record.name} (${record.version})`;
    const dir = el('p', 'plugin-dir');
    dir.textContent = record.dir.trim() === '' ? '（未知目录）' : record.dir;
    // 目录可能很长：悬停给出全文，同时抵消 body 上的全局 user-select:none 以便复制
    dir.title = dir.textContent;
    headText.append(name, dir);
    head.append(headText, enabledSwitch(record, (control, next) => toggleEnabled(record, control, next)));

    const chips = el('div', 'plugin-chips');
    chips.appendChild(statusChip(record));
    // 明确标出"不可卸载"的是内置示例：否则用户只会觉得"这卡怎么没有卸载按钮"
    if (record.removable === false) {
      const builtin = el('span', 'plugin-builtin');
      builtin.textContent = '内置示例（不可卸载）';
      chips.appendChild(builtin);
    }

    card.append(head, chips, permissionRow(record));

    const message = (record.error ?? '').trim();
    if (message !== '') {
      // 插件报的错是外部字符串：只进 textContent
      const error = el('p', 'plugin-error');
      error.textContent = message;
      card.appendChild(error);
    }
    // 不可卸载的插件**不渲染**按钮（渲染一个禁用按钮只会让人反复去点它）
    if (record.removable === true) {
      const actions = el('div', 'plugin-card-actions');
      const uninstall = el('button', 'plugin-btn-danger plugin-uninstall');
      uninstall.type = 'button';
      uninstall.id = `plugin-uninstall-${record.id}`;
      uninstall.textContent = '卸载';
      uninstall.setAttribute('aria-label', `卸载插件 ${record.name}`);
      uninstall.addEventListener('click', () => uninstallPlugin(record, uninstall));
      actions.appendChild(uninstall);
      card.appendChild(actions);
    }
    return card;
  }

  /** 渲染（唯一入口：初始帧、list() 结果、开关回传、推送都走这里）。 */
  function render(records: readonly PluginRecord[]): void {
    latest = records;
    list.textContent = '';
    if (records.length === 0) {
      const empty = el('p', 'plugin-empty');
      empty.textContent = EMPTY_HINT;
      list.appendChild(empty);
      return;
    }
    // 顺序照搬主进程给的清单：这里不排序，免得界面顺序和 plugins.json 对不上
    for (const record of records) list.appendChild(pluginCard(record));
  }

  /* -------------------------------- 事件 -------------------------------- */

  reloadButton.addEventListener('click', () => {
    if (reloadButton.disabled) return;
    reloadButton.disabled = true;
    showActionResult('正在重新发现…');
    clearPanelError();
    void (async () => {
      try {
        const count = await api.reload();
        // 有结果就立刻回话：磁盘上没有插件时"点了没反应"会被当成坏了
        showActionResult(count > 0 ? `已重新发现 ${count} 个插件` : `没有发现插件（${EMPTY_HINT}）`);
        // 重新发现后清单可能已经变了：主进程也会推 onChanged，这里主动拉一次，
        // 让"刚放进 plugins/ 的插件"不必等推送就出现在列表里
        void api
          .list()
          .then(render)
          .catch((error: unknown) => {
            // 刷新失败不算重载失败：推送会补上这一帧
            console.warn('[plugin-panel] refresh after reload failed:', errorText(error));
          });
      } catch (error: unknown) {
        setPanelError(`重新发现插件失败：${errorText(error)}`);
      } finally {
        reloadButton.disabled = false;
      }
    })();
  });

  /*
   * 安装：`install()` 自己弹目录选择框（见文件头第 4 条），页面不等路径、也不碰文件系统。
   *
   * 结果只信 `PluginInstallResult.records`：主进程已经回了安装后的完整清单，
   * 再 `list()` 一次纯属多余，还多一次"界面与磁盘不一致"的机会。
   */
  installButton.addEventListener('click', () => {
    if (installButton.disabled) return;
    installButton.disabled = true;
    showActionResult('等待选择插件目录…');
    clearPanelError();
    void api
      .install()
      .then((result) => {
        if (!result.ok) {
          // 取消选择框也走这一路：把主进程的原话（如"已取消"）如实放进状态行，不标红、不记 warn
          setPanelStatus(resultError(result, '安装失败（主进程没有给出原因）'));
          return;
        }
        render(result.records);
        const id = (result.id ?? '').trim();
        showActionResult(id === '' ? '已安装插件，已启用' : `已安装「${id}」，已启用`);
      })
      .catch((error: unknown) => {
        setPanelError(`安装插件失败：${errorText(error)}`);
      })
      .finally(() => {
        installButton.disabled = false;
      });
  });

  /* ----------------------------- 初始化与订阅 ----------------------------- */

  // 第一帧用 initial（可能只是空清单，见文件头第 1 条），随后补一次真实清单
  render(latest);
  void api
    .list()
    .then(render)
    .catch((error: unknown) => setPanelError(`读取插件清单失败：${errorText(error)}`));

  // 托盘菜单 / 桌宠窗口里改了开关也会推过来：这里必须跟着变，否则两个入口互相打脸
  api.onChanged((records) => render(records));
}
