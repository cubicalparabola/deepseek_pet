/**
 * TrayManager —— 系统托盘与原生菜单（托盘菜单 + 右键上下文菜单）。
 *
 * 设计要点：
 * - 托盘菜单与右键菜单共用同一份菜单构造逻辑，保证行为一致；
 * - 菜单项全部通过回调交给 main.ts，TrayManager 不直接操作业务模块；
 * - 关闭桌宠窗口不退出程序，托盘常驻（见 WindowManager 的 close 处理）。
 *
 * **菜单的边界（2026-09 需求）**：菜单只放**日常动作**
 * （显示/隐藏、收起、看小纸条、和她说句话、看日记、看记忆、选动画测试），
 * 所有**配置项**都搬进设置窗口（调整大小、总是置顶、拖到边缘收起、重载插件、
 * 打开配置目录、感知的全部开关与日志、情绪重置、AI/成长设置…）。
 * 理由：配置项一次调好就不再动，却会把高频动作挤到菜单下半屏；
 * 而"设置…"一个入口就能找到全部配置。
 */

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PetConfig } from '../shared/config';
import type { PluginMenuEntryPayload, TrayStatePayload } from '../shared/ipc';
import type { PluginStatus } from '../shared/plugin-types';
import { isRecognizedScene } from '../shared/perception-types';
import { moodLabel, satietyLabel } from '../shared/emotion';
import { sceneLabel } from '../shared/perception';
import type { Logger } from '../shared/logger';
import { describeError } from '../shared/errors';

export interface TrayManagerCallbacks {
  onShow(): void;
  onHide(): void;
  /** 播放指定动画（菜单里的快捷动作）。 */
  onPlayAnimation(animationId: string): void;
  onOpenSettings(): void;
  onQuit(): void;

  /* --------------------- 交互（她记的事 + 她的日记） --------------------- */
  /**
   * 打开「交互」窗口（小纸条 / 日记 / 文件）。
   *
   * 2026-09 需求删掉了整块 AI 子菜单（和她说句话 / 让她说句话 / 看今天的日记 /
   * 打开日记目录 / 她记住了什么）：说句话在窗口里本来就有按钮，
   * 日记搬进了「交互」窗口，所以菜单只剩"打开它"这一个动作。
   */
  onOpenNotes(): void;
  /** 切换"收起（不打扰）"：收起后不接收点击、情绪下降更快。 */
  onToggleCollapsed(): boolean;

  /* ------------------------- 插件 ------------------------- */
  /**
   * 启用 / 停用某个插件（"插件可随时关闭"的菜单入口）。
   *
   * 与设置窗口的开关同源：都是 `PluginManager.setPluginEnabled`，
   * 所以"菜单里关了、设置里还开着"这种分叉不会发生。
   */
  onTogglePlugin(id: string, enabled: boolean): void;
  /** 点了插件自己注册的菜单项（事件转回渲染层里跑着的插件）。 */
  onPluginMenuItem(pluginId: string, itemId: string): void;
}

export interface TrayManagerOptions {
  readonly config: PetConfig;
  readonly logger: Logger;
  readonly callbacks: TrayManagerCallbacks;
}

const EMPTY_STATE: TrayStatePayload = {};

/**
 * 插件状态的中文说明。
 *
 * 菜单里直接写枚举值（`discovered` / `inactive`）没人看得懂，
 * 而"已关闭 / 运行中 / 出错"是一眼能判的 —— 这也是"可随时关闭"的一部分：
 * 用户得能确认自己真的关掉了。
 */
function pluginStatusLabel(status: PluginStatus): string {
  switch (status) {
    case 'active':
      return '运行中';
    case 'disabled':
      return '已关闭';
    case 'failed':
      return '出错';
    case 'inactive':
      return '已停止';
    case 'activating':
      return '启动中';
    case 'deactivating':
      return '停止中';
    case 'loading':
      return '加载中';
    case 'loaded':
      return '已加载';
    case 'discovered':
      return '已发现';
    default:
      return String(status);
  }
}

export class TrayManager {
  private readonly options: TrayManagerOptions;
  private readonly logger: Logger;
  private tray: Tray | null = null;
  private state: TrayStatePayload = EMPTY_STATE;
  /** 右键菜单打开期间禁止刷新菜单，避免原生菜单闪烁/错位。 */
  private menuOpen = false;

  public constructor(options: TrayManagerOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  public create(): void {
    if (this.tray) return;
    const icon = this.resolveIcon();
    if (!icon) {
      this.logger.warn('tray icon not found, tray disabled');
      return;
    }
    try {
      this.tray = new Tray(icon);
      this.tray.setToolTip('鲸鱼娘桌宠');
      /*
       * **单击托盘 = 弹出菜单**（需求："点击系统托盘时显示饱腹值心情值以及token等属性信息"）。
       *
       * 菜单最上面那几行就是这些属性（见 `buildStatusItems()`）。
       * 以前左键是"切换显示/隐藏"，那个动作现在完整地留在菜单里
       * （「显示桌宠」/「隐藏桌宠」两项，且带启用状态）——
       * 一处收口，用户找不到"她去哪了"的入口反而更多了。
       */
      this.tray.on('click', () => {
        if (!this.tray) return;
        this.tray.popUpContextMenu(this.buildTrayMenu());
      });
      this.tray.on('right-click', () => {
        // Windows 上右键由 setContextMenu 自动处理，这里仅在未设置时兜底
        if (!this.tray) return;
        this.tray.popUpContextMenu(this.buildTrayMenu());
      });
      this.applyMenu();
      this.logger.info('tray created');
    } catch (error) {
      // 托盘创建失败（例如无桌面环境）不能让主进程崩溃
      this.logger.error('tray creation failed', { error: describeError(error) });
      this.tray = null;
    }
  }

  /** 更新托盘与菜单展示的状态（可见性/暂停/当前动画/插件列表）。 */
  public updateState(payload: TrayStatePayload): void {
    this.state = { ...this.state, ...payload };
    this.applyMenu();
  }

  private applyMenu(): void {
    if (!this.tray || this.menuOpen) return;
    try {
      this.tray.setContextMenu(this.buildTrayMenu());
    } catch (error) {
      this.logger.error('failed to update tray menu', { error: describeError(error) });
    }
  }

  /** 「播放动画」菜单暴露给用户前的可观测性：让日志能确认菜单里到底有多少个动画。 */
  private logAnimationMenu(count: number, current: string | null): void {
    if (this.lastMenuLogCount === count && this.lastMenuLogCurrent === current) return;
    this.lastMenuLogCount = count;
    this.lastMenuLogCurrent = current;
    this.logger.info('animation menu updated', {
      data: {
        count,
        current: current ?? '(none)',
        ids: (this.state.animations ?? []).map((a) => a.id).join(','),
      },
    });
  }

  private lastMenuLogCount = -1;
  private lastMenuLogCurrent: string | null = null;

  /**
   * 「播放动画」子菜单：列出**全部**已注册动画，方便手动测试。
   *
   * 这是菜单里唯一保留的调试入口（用户明确要求把菜单收窄成"日常动作 + 动画测试"）：
   * 点任意一条都会通过 `onPlayAnimation(id)` -> IPC -> Action Pipeline 播放，
   * 与插件/AI 走的是同一条路径。
   *
   * 显示格式：`标签 (id) [优先级]`，循环动画额外标注。
   */
  private buildAnimationSubmenu(): MenuItemConstructorOptions[] {
    const animations = this.state.animations ?? [];
    const callbacks = this.options.callbacks;
    const current = this.state.currentAnimation ?? null;
    this.logAnimationMenu(animations.length, current);

    if (animations.length === 0) return [{ label: '（动画清单未加载）', enabled: false }];

    const items: MenuItemConstructorOptions[] = animations.map((animation) => {
      const marks: string[] = [`${animation.priority}`];
      if (animation.loop) marks.push('循环');
      if (animation.type !== 'video') marks.push(animation.type);
      const suffix = marks.length > 0 ? `　[${marks.join(' · ')}]` : '';
      return {
        label: `${animation.label} (${animation.id})${suffix}`,
        // 用 radio 让"当前正在播的动画"一目了然
        type: 'radio',
        checked: current === animation.id,
        click: () => callbacks.onPlayAnimation(animation.id),
      };
    });

    items.push({ type: 'separator' });
    items.push({
      label: `共 ${animations.length} 个动画（按优先级排序）`,
      enabled: false,
    });
    return items;
  }

  /**
   * **主菜单的唯一模板** —— 托盘菜单与桌宠右键菜单都从它构建。
   *
   * 需求："托盘菜单和宠物右键菜单应该一致"。
   * 一致不是靠两边照着写一遍，而是**只有这一处模板**：
   * 加/删一项就两个菜单同时变，将来不可能再走偏（早先两份菜单各写一套，
   * 于是右键里多出"点击区域/当前动画"、托盘里多出"收起/置顶"，两边越来越不像）。
   */
  /**
   * 菜单顶部的**属性信息**（需求："点击系统托盘时显示饱腹值心情值以及token等属性信息"）。
   *
   * 设计取舍：
   * - 全部 `enabled: false`：它们是**读数**不是开关，点上去不该有任何副作用；
   * - 只有**状态变化**才重建菜单（上层 `refreshTray` 的推送节奏决定），所以这里读的是
   *   缓存快照而不是现算；
   * - 缺数据的项直接不出现（例如感知没起来时就不显示场景），而不是显示"—"，
   *   免得用户以为坏了。
   */
  private buildStatusItems(): MenuItemConstructorOptions[] {
    const ai = this.state.ai;
    const items: MenuItemConstructorOptions[] = [];
    if (!ai) return items;

    const petName = ai.settings.petName.trim() === '' ? '鲸鱼娘' : ai.settings.petName.trim();
    items.push({
      label: `🐋 ${petName} · ${ai.usable ? '已接入大模型' : '本地兜底'}`,
      enabled: false,
    });

    const mood = moodLabel(ai.emotion.mood);
    const satiety = satietyLabel(ai.emotion.satiety);
    /*
     * 心情与饱腹**各占一行**（需求）。
     *
     * 挤在一行里时（"心情 83/100（很开心） · 饱腹 100/100（很饱）"）在 125% 缩放下
     * 会顶到菜单宽度上限、后半截读起来像另一条属性；两个数各有各的表情与说法，
     * 分开写才扫得清。
     */
    items.push({
      label: `心情 ${ai.emotion.mood}/100 ${mood.face}（${mood.label}）`,
      enabled: false,
    });
    items.push({
      label: `饱腹 ${ai.emotion.satiety}/100（${satiety.label}）`,
      enabled: false,
    });

    /*
     * token 分两栏：**本次运行**是"这次开着花了多少"，**累计**是用户预算的依据。
     * 两者都要有 —— 只看累计看不出"刚刚发生了什么"，只看本次又没法判断还剩多少额度。
     */
    const budget = ai.settings.budget.budget;
    const used = budget > 0 ? `${ai.tokensUsed}/${budget}` : String(ai.tokensUsed);
    items.push({
      label: `token 本次 ${ai.sessionTokens} · 累计 ${used}`,
      enabled: false,
    });

    const perception = this.state.perception;
    if (perception) {
      const scene = perception.lastObservation?.scene;
      const sceneText = scene !== undefined && isRecognizedScene(scene) ? sceneLabel(scene) : '没认出来';
      const presence = perception.presence.present ? '在电脑前' : '不在';
      const parts = [`感知：${sceneText} · ${presence}`];
      if (perception.settings.privacyMode) parts.push('隐私模式');
      items.push({ label: parts.join(' · '), enabled: false });
    }

    const growth = this.state.growth;
    if (growth && growth.palace.stats.total > 0) {
      items.push({
        label: `记得的经历 ${growth.palace.stats.total} 段 · 一起 ${growth.palace.stats.daysTogether} 天`,
        enabled: false,
      });
    }

    const unread = this.state.noteUnread ?? 0;
    if (unread > 0) items.push({ label: `小纸条还有 ${unread} 条没看`, enabled: false });

    items.push({ type: 'separator' });
    return items;
  }

  /**
   * 「插件」子菜单。
   *
   * 两层结构，顺序是刻意的：
   * 1. **插件自己的动作**（`context.ui.registerMenuItem` 注册的）排在前面 ——
   *    它们是"用这个插件"的入口（番茄钟开始/暂停、TODO 打开面板…）；
   * 2. 下面才是**开关**：一行一个插件，点一下就启停并立刻写盘。
   *
   * 为什么开关做成可点的 checkbox、而不是"去设置窗口里关"：需求是"插件可随时关闭"，
   * 关掉一个正在骚扰你的插件不该需要先打开另一个窗口再找一遍。
   */
  private buildPluginSubmenu(): MenuItemConstructorOptions[] {
    const callbacks = this.options.callbacks;
    const items: MenuItemConstructorOptions[] = [];

    const grouped = new Map<string, { name: string; entries: PluginMenuEntryPayload[] }>();
    for (const entry of this.state.pluginMenu ?? []) {
      const bucket = grouped.get(entry.pluginId) ?? { name: entry.pluginName, entries: [] };
      bucket.entries.push(entry);
      grouped.set(entry.pluginId, bucket);
    }
    for (const [pluginId, bucket] of grouped) {
      items.push({
        label: bucket.name,
        submenu: bucket.entries.map((entry) => ({
          label: entry.label,
          ...(entry.hint ? { sublabel: entry.hint } : {}),
          ...(entry.checked !== undefined ? { type: 'checkbox' as const, checked: entry.checked } : {}),
          click: () => callbacks.onPluginMenuItem(pluginId, entry.id),
        })),
      });
    }
    if (items.length > 0) items.push({ type: 'separator' });

    for (const plugin of this.state.plugins ?? []) {
      const parts: string[] = [pluginStatusLabel(plugin.status)];
      if (plugin.error) parts.push(plugin.error);
      if (plugin.permissions && plugin.permissions.length > 0) parts.push(`权限：${plugin.permissions.join('/')}`);
      items.push({
        label: `${plugin.enabled ? '●' : '○'} ${plugin.name} (${plugin.version})`,
        sublabel: parts.join(' · '),
        type: 'checkbox',
        checked: plugin.enabled,
        click: () => callbacks.onTogglePlugin(plugin.id, !plugin.enabled),
      });
    }

    if (items.length === 0) items.push({ label: '（无插件）', enabled: false });
    return items;
  }

  /**
   * 菜单主体。
   *
   * 托盘菜单与桌宠右键菜单用的是**同一个函数** —— 需求明确要求"两个菜单一致"，
   * 而只要有人各写一份，早晚会漂移（以前就漂过：托盘有"点击区域"、右键没有）。
   *
   * 结构（从上到下）：
   * 1. 属性读数（心情/饱腹/token/感知/记忆）；
   * 2. 显示与收起（她此刻在不在、贴不贴边）；
   * 3. **交互**（她记的事 + 她的日记，比配置常用，放在最显眼处）；
   * 4. 日常动作：动画测试、插件；
   * 5. 「设置…」与「退出」。
   * 所有配置项都在「设置…」里，菜单里**不再重复**（见文件头注释）。
   *
   * 2026-09 又删了两块（需求）：**AI 子菜单**（其中的日记搬进「交互」窗口）
   * 与**「查看记忆宫殿」**（它只在设置窗口的「成长、记忆与反思」面板里保留）。
   */
  private buildMainTemplate(): MenuItemConstructorOptions[] {
    const visible = this.state.visible ?? true;
    const callbacks = this.options.callbacks;
    const docked = (this.state.display?.dock ?? 'free') !== 'free';
    const dockText = this.state.display?.dock === 'right' ? '右侧收起' : this.state.display?.dock === 'bottom' ? '下方收起' : '正常';
    const unread = this.state.noteUnread ?? 0;

    return [
      // 顶部属性信息：点开托盘第一眼就是"她现在怎么样"（需求）
      ...this.buildStatusItems(),
      { label: '显示桌宠', enabled: !visible, click: () => callbacks.onShow() },
      { label: '隐藏桌宠', enabled: visible, click: () => callbacks.onHide() },
      /*
       * 收起（贴边）与隐藏是两件不同的事（用户明确要求）：
       *   收起 = 挪到最近的边缘、换成 sleep/watch 姿势待着，仍然能点、点一下就展开；
       *   隐藏 = 完全看不见（窗口藏起来），恢复靠上面的「显示桌宠」。
       * 这两条以前都叫"收起"，导致"点了一下她就彻底消失了"—— 现在分开。
       */
      {
        label: docked ? `展开（恢复互动）· 当前${dockText}` : '收起（贴边）',
        type: 'checkbox',
        checked: docked,
        click: () => callbacks.onToggleCollapsed(),
      },
      { type: 'separator' },
      /*
       * 「交互」= 她的内容：她记的事（小纸条）、她的日记、她收着的文件。
       * 未看条数直接写在菜单里 —— 她记了东西，不打开窗口也该知道。
       * （原名「小纸条…」，2026-09 需求改名为「交互」：这个窗口现在不只是纸条，
       * 日记也搬进来了；同时菜单里的 AI 子菜单被删掉，日常动作集中到这一项。）
       */
      {
        label: unread > 0 ? `交互…（${unread} 条新的）` : '交互…',
        click: () => callbacks.onOpenNotes(),
      },
      { type: 'separator' },
      { label: '播放动画（测试）', submenu: this.buildAnimationSubmenu() },
      { label: '插件', submenu: this.buildPluginSubmenu() },
      { type: 'separator' },
      { label: '设置…', click: () => callbacks.onOpenSettings() },
      { type: 'separator' },
      { label: '退出', click: () => callbacks.onQuit() },
    ];
  }

  /** 托盘菜单（与桌宠右键菜单**同一份模板**）。 */
  private buildTrayMenu(): Menu {
    return Menu.buildFromTemplate(this.buildMainTemplate());
  }

  /**
   * 桌宠右键上下文菜单 —— 与托盘菜单**完全一致**（同一份模板，需求）。
   *
   * 不再显示"点击区域 / 当前动画"这类信息行（需求：这些条目删掉）——
   * 因此也不需要 renderer 上报上下文，接口保持无参。
   */
  public showContextMenu(): void {
    const menu = Menu.buildFromTemplate(this.buildMainTemplate());
    this.menuOpen = true;
    /*
     * 两条释放路径，缺一不可：
     * - `popup` 的 callback：正常关闭时给；
     * - `menu-will-close`：Electron 明确支持 popup 被关闭时触发的事件。
     *
     * 为什么必须两条：`menuOpen` 一旦永远停在 true，`applyMenu()` 就再也不会重建托盘菜单
     * —— 表现为"托盘菜单再也不更新"，而且**没有任何报错**。
     * 自动化里实测到过 callback 一直不来的情况（没人去关那个弹出来的菜单），
     * 于是验收里"托盘菜单与右键菜单一致"这条偶发拿不到托盘模板。
     */
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.menuOpen = false;
      this.applyMenu();
    };
    menu.once('menu-will-close', release);
    menu.popup({
      callback: release,
    });
  }

  public destroy(): void {
    if (!this.tray) return;
    this.tray.destroy();
    this.tray = null;
    this.logger.info('tray destroyed');
  }

  /**
   * 托盘图标。
   *
   * 打包注意：图标必须位于 asar **之外**，否则 nativeImage 读不到。
   * `config.appRoot` 在打包模式已被解析为 `resources/`，开发模式是仓库根，
   * 两种情况下 `<appRoot>/build/*` 都能命中（见 main.ts 的路径解析）。
   *
   * 尺寸策略（用户反馈"图标太小"后的处理）：
   * - 托盘槽位只有 16 逻辑像素，Windows 还会再留一圈空白 —— 因此图标素材
   *   必须**铺满画布**（生成时不加内边距，见 tools/make-icons.mjs）；
   * - 本机显示缩放是 125%，32px 的图会被放大显示而发糊、显得更小，
   *   因此优先加载 `tray@2x.png`（64×64），让 Windows 直接挑合适的一档；
   * - 找不到时逐级回退到 32px / 应用图标，绝不让托盘因缺图而消失。
   */
  private resolveIcon(): Electron.NativeImage | null {
    const candidates = [
      join(this.options.config.appRoot, 'build', 'tray@2x.png'),
      join(this.options.config.appRoot, 'build', 'tray.png'),
      join(this.options.config.appRoot, 'build', 'icon.png'),
      join(this.options.config.appRoot, 'build', 'icon.ico'),
    ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const image = nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) return image;
      } catch (error) {
        this.logger.warn('failed to load tray icon', { error: describeError(error), data: { candidate } });
      }
    }
    this.logger.warn('tray icon not found; tray disabled', { data: { searched: candidates.join(' | ') } });
    return null;
  }
}