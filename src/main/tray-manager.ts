/**
 * TrayManager —— 系统托盘与原生菜单（托盘菜单 + 右键上下文菜单）。
 *
 * 设计要点：
 * - 托盘菜单与右键菜单共用同一份菜单构造逻辑，保证行为一致；
 * - 菜单项全部通过回调交给 main.ts，TrayManager 不直接操作业务模块；
 * - 关闭桌宠窗口不退出程序，托盘常驻（见 WindowManager 的 close 处理）。
 */

import { Menu, Tray, app, dialog, nativeImage, shell, type MenuItemConstructorOptions } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PetConfig } from '../shared/config';
import type { TrayStatePayload } from '../shared/ipc';
import type { PerceptionViewMode } from '../shared/perception-types';
import {
  PET_BASE_HEIGHT,
  PET_SCALE_DEFAULT,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  formatPetScale,
} from '../shared/pet-size';
import type { Logger } from '../shared/logger';
import { describeError } from '../shared/errors';

export interface TrayManagerCallbacks {
  onToggleVisible(): boolean;
  onShow(): void;
  onHide(): void;
  onToggleBehavior(): boolean;
  onReloadPlugins(): void;
  /** 让桌宠回到兜底动画（默认 idle），由 renderer 的 Action Pipeline 执行。 */
  onResetAnimation(): void;
  /** 播放指定动画（菜单里的快捷动作）。 */
  onPlayAnimation(animationId: string): void;
  /**
   * 显示对话气泡（测试入口）。
   *
   * 目前只做"跑通功能"，因此刻意不接行为/插件/AI 的触发机制，
   * 先用托盘菜单手动验证：气泡是否跟随宠物大小、长文本能否滚动。
   */
  onShowBubble(text: string): void;
  onHideBubble(): void;
  onSetAlwaysOnTop(value: boolean): void;
  onOpenSettings(): void;
  onQuit(): void;

  /* ------------------- AI 认知与人格（2.1~2.4） ------------------- */
  /** 打开聊天窗口（输入口的唯一入口，和桌宠窗口共用同一条链路）。 */
  onOpenChat(): void;
  /** 让她主动说一句话（不用打字也能看人格是否生效）。 */
  onSpeakUp(): void;
  /** 立刻写今天的日记（不等定时器）。 */
  onWriteDiary(): void;
  /** 打开日记目录（看历史日记）。 */
  onOpenDiaryFolder(): void;
  /** 把收集到的事件文本显示在气泡里（"她记住了什么"一眼可见）。 */
  onShowMemoryDigest(text: string): void;
  /** 切换"收起（不打扰）"：收起后不接收点击、情绪下降更快。 */
  onToggleCollapsed(): boolean;
  /** 情绪重置（调试与后悔药用）。 */
  onResetEmotion(): void;
  /** 打开设置窗口的 AI 面板（与「设置…」同一个窗口，只是提示用）。 */
  onOpenAISettings(): void;

  /* ---------------- 环境与用户感知（3.1~3.6） ---------------- */
  /** 3.2 按需"看屏幕"：只剩「看我在做什么（场景）」一个动作。 */
  onLookScreen(mode: PerceptionViewMode): void;
  /** 隐私模式开关：一键停止一切采集（返回切换后的状态）。 */
  onTogglePrivacyMode(): boolean;
  /** 把"她看见了什么"整理出来显示在气泡里。 */
  onShowPerceptionDigest(): void;
  /** 打开感知日志文件。 */
  onOpenPerceptionLog(): void;
  /** 立刻采一次（验证感知是否工作）。 */
  onSamplePerception(): void;
  /** 摄像头授权开关（返回切换后的授权状态）。 */
  onToggleCameraConsent(): boolean;

  /* ---------------- 成长、记忆与反思（4.1 / 4.2） ---------------- */
  /** 把"记忆宫殿"摘要显示在气泡里（她记住了哪些经历）。 */
  onShowPalaceDigest(): void;
  /** 打开记忆宫殿的可读镜像文件（`memory/palace.md`）。 */
  onOpenPalaceFile(): void;
  /** 立刻做一次自我反思（会按结论调整行为策略）。 */
  onReflectNow(): void;
  /** 重置行为策略（回到用户原始设置）。 */
  onResetGrowthPolicy(): void;
  /** 打开设置窗口的成长面板。 */
  onOpenGrowthSettings(): void;
}

export interface TrayManagerOptions {
  readonly config: PetConfig;
  readonly logger: Logger;
  readonly callbacks: TrayManagerCallbacks;
}

const EMPTY_STATE: TrayStatePayload = {};

/** 气泡测试样本：短句（验证排版）。 */
const BUBBLE_SAMPLE_SHORT = '今天也一起加油吧！';

/**
 * 气泡测试样本：长文本（**专门用来验证滚动**）。
 *
 * 刻意写得超过气泡一屏能放下的量，这样一眼就能看出滚动条是否出现、
 * 文字有没有溢出气泡的描边。
 */
const BUBBLE_SAMPLE_LONG = [
  '欢迎回来～我是鲸鱼娘。',
  '',
  '这是一段用来测试对话气泡的长文本。气泡会随着桌宠的大小一起缩放：把设置里的滚动条拖大或拖小，气泡和文字都会按比例跟着变。',
  '',
  '当文字超过一屏时，气泡内部会出现滚动条，可以用鼠标滚轮或拖动滚动条查看后面的内容，文字不会溢出气泡的描边。',
  '',
  '下面是一些占位内容，用来把文本撑长：',
  '一、气泡的尾巴指向桌宠的头顶；',
  '二、气泡在桌宠上方，窗口会向上扩展，宠物的脚不会移动；',
  '三、气泡宽度是宠物宽度的 1.25 倍；',
  '四、文字区避开了气泡底部的尾巴位置。',
  '',
  '如果你能看到这一段，说明滚动已经到底了。谢谢测试！',
].join('\n');

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
      this.tray.on('click', () => {
        this.options.callbacks.onToggleVisible();
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
   * 尺寸相关菜单项（托盘与右键菜单共用）。
   *
   * 按需求「点击桌宠大小直接弹窗口，中间不必多点一次」：
   * 这里**不再有「桌宠大小」子菜单**，而是一个直接打开设置窗口的菜单项，
   * 标签上顺带把当前尺寸与可调范围显示出来（既当入口又当读数）。
   */
  private buildSizeItems(): MenuItemConstructorOptions[] {
    const size = this.state.size;
    const currentScale = size?.scale ?? PET_SCALE_DEFAULT;
    const callbacks = this.options.callbacks;

    const items: MenuItemConstructorOptions[] = [
      {
        label: size
          ? `调整大小…（当前 ${formatPetScale(currentScale)} · ${size.width}×${size.height}）`
          : '调整大小…',
        click: () => callbacks.onOpenSettings(),
      },
      {
        label: `可调范围 ${formatPetScale(PET_SCALE_MIN)} – ${formatPetScale(PET_SCALE_MAX)}（基准高 ${PET_BASE_HEIGHT}px）`,
        enabled: false,
      },
    ];
    if (size?.clampedByDisplay) {
      items.push({ label: '（已按屏幕高度自动收敛）', enabled: false });
    }
    return items;
  }

  /**
   * 「播放动画」子菜单：列出**全部**已注册动画，方便手动测试。
   *
   * 第一版没有设置界面，这个菜单就是最直接的动画试放入口：
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
   * 对话气泡测试子菜单。
   *
   * 第一版只跑通"显示/尺寸跟随/长文本滚动"，不做触发机制，
   * 因此这里给两条固定样本（短文本、长文本）加一条隐藏：
   * 长文本那条专门用来验证滚动条。
   */
  private buildBubbleSubmenu(): MenuItemConstructorOptions[] {
    const callbacks = this.options.callbacks;
    return [
      { label: '显示短句', click: () => callbacks.onShowBubble(BUBBLE_SAMPLE_SHORT) },
      { label: '显示长文（测滚动）', click: () => callbacks.onShowBubble(BUBBLE_SAMPLE_LONG) },
      { type: 'separator' },
      { label: '隐藏气泡', click: () => callbacks.onHideBubble() },
    ];
  }

  /**
   * AI 认知与人格子菜单。
   *
   * 为什么把入口放在托盘/右键而不是塞进设置窗口：
   * "和她说句话""看今天的日记"是**高频日常动作**，
   * 让用户为了说一句话先开设置窗口、翻到 AI 面板，体验会很差。
   * 设置窗口只负责配置（开关、密钥、人格），日常动作都在这里。
   */
  private buildAISubmenu(): MenuItemConstructorOptions[] {
    const callbacks = this.options.callbacks;
    const ai = this.state.ai;
    const collapsed = this.state.presence === 'collapsed';
    const statusLine = ai
      ? `${ai.usable ? '已接入大模型' : '本地兜底'} · 心情 ${ai.emotion.mood} · 饿 ${ai.emotion.hunger}`
      : '状态未就绪';
    const enabled = ai?.settings.enabled === true;

    return [
      { label: statusLine, enabled: false },
      ...(enabled
        ? []
        : [{ label: '（AI 未开启：设置 → AI 认知与人格）', enabled: false } as MenuItemConstructorOptions]),
      { type: 'separator' },
      { label: '和她说句话…', click: () => callbacks.onOpenChat() },
      { label: '让她说句话', enabled: enabled, click: () => callbacks.onSpeakUp() },
      { type: 'separator' },
      { label: '看今天的日记', click: () => callbacks.onWriteDiary() },
      { label: '打开日记目录', click: () => callbacks.onOpenDiaryFolder() },
      { label: '她记住了什么？', click: () => callbacks.onShowMemoryDigest('') },
      { type: 'separator' },
      {
        label: collapsed ? '展开（恢复互动）' : '收起（不打扰）',
        type: 'checkbox',
        checked: collapsed,
        click: () => callbacks.onToggleCollapsed(),
      },
      { label: '重置情绪', click: () => callbacks.onResetEmotion() },
      { label: 'AI 设置…', click: () => callbacks.onOpenAISettings() },
    ];
  }

  /**
   * 环境与用户感知子菜单（3.1~3.6）。
   *
   * 隐私模式的入口**必须在菜单里**（不能只藏在设置窗口深处）：
   * 用户觉得"被看着"不舒服时，应该两次点击就能停掉一切采集。
   */
  private buildPerceptionSubmenu(): MenuItemConstructorOptions[] {
    const callbacks = this.options.callbacks;
    const perception = this.state.perception;
    const privacy = perception?.settings.privacyMode === true;
    const cameraOn = perception?.settings.camera === true && perception?.settings.cameraAuthorized === true;
    const statusLine = perception
      ? `${perception.capturing ? '感知中' : `已暂停（${perception.pausedReason || '未开启'}）`}` +
        `${perception.lastObservation ? ` · ${perception.lastObservation.scene}` : ''}` +
        ` · 打扰 ${perception.interventionsToday} 次`
      : '状态未就绪';

    return [
      { label: statusLine, enabled: false },
      {
        label: privacy ? '关闭隐私模式（恢复感知）' : '隐私模式（停止一切采集）',
        type: 'checkbox',
        checked: privacy,
        click: () => callbacks.onTogglePrivacyMode(),
      },
      { type: 'separator' },
      { label: '看我在做什么（场景）', enabled: !privacy, click: () => callbacks.onLookScreen('scene') },
      { type: 'separator' },
      { label: '她看见了什么？', click: () => callbacks.onShowPerceptionDigest() },
      { label: '立刻感知一次', enabled: !privacy, click: () => callbacks.onSamplePerception() },
      { label: '打开感知日志', click: () => callbacks.onOpenPerceptionLog() },
      {
        label: cameraOn ? '摄像头：已授权（点击撤销）' : '摄像头：未授权（点击授权）',
        click: () => callbacks.onToggleCameraConsent(),
      },
      { label: '感知设置…', click: () => callbacks.onOpenAISettings() },
    ];
  }

  /**
   * 成长与记忆子菜单（4.1 / 4.2）。
   *
   * 两个入口最常用：**看一眼记忆宫殿**（情绪价值）与**重置策略**（安全阀）。
   * 后者放在这里而不是只藏在设置窗口：用户一旦觉得"她最近太安静/太吵"，
   * 应该两次点击就能回到自己设的原始行为。
   */
  private buildGrowthSubmenu(): MenuItemConstructorOptions[] {
    const callbacks = this.options.callbacks;
    const growth = this.state.growth;
    const nodes = growth?.palace.stats.total ?? 0;
    const days = growth?.palace.stats.daysTogether ?? 0;
    const adjustments = growth?.policy.adjustments ?? 0;
    const today = growth?.todayReflection;
    const statusLine = growth
      ? `记忆 ${nodes} 段 · 一起 ${days} 天 · 今天反思${today ? '已写' : '未写'}`
      : '状态未就绪';

    return [
      { label: statusLine, enabled: false },
      ...(growth ? [{ label: `策略：${growth.policyEffect}`, enabled: false } as MenuItemConstructorOptions] : []),
      { type: 'separator' },
      { label: '看看我们的记忆宫殿', click: () => callbacks.onShowPalaceDigest() },
      { label: '打开记忆宫殿文件', click: () => callbacks.onOpenPalaceFile() },
      { type: 'separator' },
      { label: '让她现在反思一次', click: () => callbacks.onReflectNow() },
      {
        label: adjustments > 0 ? `重置行为策略（已调整 ${adjustments} 次）` : '重置行为策略（还没调整过）',
        enabled: adjustments > 0,
        click: () => callbacks.onResetGrowthPolicy(),
      },
      { label: '成长与记忆设置…', click: () => callbacks.onOpenGrowthSettings() },
    ];
  }

  /** 托盘菜单（显示/隐藏、行为、尺寸、动画试放、插件、设置、退出）。 */
  private buildTrayMenu(): Menu {
    const visible = this.state.visible ?? true;
    const paused = this.state.behaviorPaused ?? false;
    const alwaysOnTop = this.state.alwaysOnTop ?? true;
    const callbacks = this.options.callbacks;

    const stateLabel = this.state.currentState ? `状态：${this.state.currentState}` : '状态：未知';
    const animationLabel = this.state.currentAnimation
      ? `动画：${this.state.currentAnimation}`
      : '动画：（未播放）';

    const template: MenuItemConstructorOptions[] = [
      { label: '鲸鱼娘', enabled: false },
      { label: stateLabel, enabled: false },
      { label: animationLabel, enabled: false },
      { type: 'separator' },
      { label: '显示桌宠', enabled: !visible, click: () => callbacks.onShow() },
      { label: '隐藏桌宠', enabled: visible, click: () => callbacks.onHide() },
      { type: 'separator' },
      ...this.buildSizeItems(),
      {
        label: '总是置顶',
        type: 'checkbox',
        checked: alwaysOnTop,
        click: (item) => callbacks.onSetAlwaysOnTop(item.checked),
      },
      { type: 'separator' },
      { label: '播放动画（测试）', submenu: this.buildAnimationSubmenu() },
      { label: '恢复默认动画', click: () => callbacks.onResetAnimation() },
      { label: '对话气泡（测试）', submenu: this.buildBubbleSubmenu() },
      { label: 'AI（认知与人格）', submenu: this.buildAISubmenu() },
      { label: '感知（环境与用户）', submenu: this.buildPerceptionSubmenu() },
      { label: '成长与记忆', submenu: this.buildGrowthSubmenu() },
      { type: 'separator' },
      { label: '暂停行为', enabled: !paused, click: () => callbacks.onToggleBehavior() },
      { label: '恢复行为', enabled: paused, click: () => callbacks.onToggleBehavior() },
      { type: 'separator' },
      { label: '重载插件', click: () => callbacks.onReloadPlugins() },
      { label: '设置…', click: () => callbacks.onOpenSettings() },
      { type: 'separator' },
      { label: '退出', click: () => callbacks.onQuit() },
    ];

    return Menu.buildFromTemplate(template);
  }

  /**
   * 桌宠右键上下文菜单。
   * @param context 由 renderer 提供的当前状态（命中区域 / 当前动画）。
   */
  public showContextMenu(context: { region?: string; animationId?: string | null } = {}): void {
    const visible = this.state.visible ?? true;
    const paused = this.state.behaviorPaused ?? false;
    const callbacks = this.options.callbacks;
    const plugins = this.state.plugins ?? [];

    const pluginItems: MenuItemConstructorOptions[] = plugins.length > 0
      ? plugins.map((plugin) => ({
          label: `${plugin.enabled ? '●' : '○'} ${plugin.name} (${plugin.version})`,
          sublabel: `${plugin.status}${plugin.error ? ` · ${plugin.error}` : ''}`,
          enabled: false,
        }))
      : [{ label: '（无插件）', enabled: false }];

    const template: MenuItemConstructorOptions[] = [
      { label: '鲸鱼娘', enabled: false },
      {
        label: context.region ? `点击区域：${context.region}` : '点击区域：-',
        enabled: false,
      },
      {
        label: context.animationId ? `当前动画：${context.animationId}` : '当前动画：（未播放）',
        enabled: false,
      },
      { type: 'separator' },
      { label: '插件', submenu: pluginItems },
      { label: '播放动画（测试）', submenu: this.buildAnimationSubmenu() },
      { label: '恢复默认动画', click: () => callbacks.onResetAnimation() },
      { label: '对话气泡（测试）', submenu: this.buildBubbleSubmenu() },
      { label: 'AI（认知与人格）', submenu: this.buildAISubmenu() },
      { label: '感知（环境与用户）', submenu: this.buildPerceptionSubmenu() },
      { label: '成长与记忆', submenu: this.buildGrowthSubmenu() },
      { type: 'separator' },
      ...this.buildSizeItems(),
      { label: '显示桌宠', enabled: !visible, click: () => callbacks.onShow() },
      { label: '隐藏桌宠', enabled: visible, click: () => callbacks.onHide() },
      { label: paused ? '恢复行为' : '暂停行为', click: () => callbacks.onToggleBehavior() },
      { type: 'separator' },
      { label: '重载全部插件', click: () => callbacks.onReloadPlugins() },
      { label: '打开配置目录', click: () => this.openConfigDirectory() },
      { label: '设置…', click: () => callbacks.onOpenSettings() },
      { type: 'separator' },
      { label: '退出', click: () => callbacks.onQuit() },
    ];

    const menu = Menu.buildFromTemplate(template);
    this.menuOpen = true;
    menu.popup({
      callback: () => {
        this.menuOpen = false;
        this.applyMenu();
      },
    });
  }

  /**
   * 兜底信息框（正常路径不再经过这里）。
   *
   * 「设置…」现在打开的是**真正的设置窗口**（`main/settings-window-manager.ts`，
   * 用滚动条连续调尺寸，拖动即生效并写入 settings.json）。
   * 原生对话框做不出滑块，因此这里只保留一个"设置窗口打不开时"的信息出口。
   */
  public showSettingsDialog(): void {
    const configPath = this.options.config.configPath;
    const size = this.state.size;
    const current = size ? Math.round(size.scale * 100) : 100;
    const alwaysOnTop = this.state.alwaysOnTop ?? true;

    dialog.showMessageBoxSync({
      type: 'info',
      title: '桌宠设置',
      message: `当前尺寸：${size ? `${size.width}×${size.height}` : '未知'}（${current}%）`,
      detail: [
        '大小请用「设置…」窗口里的滚动条调整（拖动即生效并自动保存）。',
        '',
        `当前：${current}%　置顶：${alwaysOnTop ? '开' : '关'}　基准高度：${PET_BASE_HEIGHT}px`,
        size?.clampedByDisplay ? '注意：当前尺寸已按屏幕高度自动收敛。' : '',
        '',
        '其他配置仍通过 JSON 编辑：',
        '  • assets/config/animations.json —— 动画 Manifest',
        '  • assets/config/plugins.json    —— 插件开关',
        '  • assets/config/settings.json   —— 尺寸与置顶（设置窗口会自动写入）',
        '',
        `配置目录：${configPath}`,
      ].filter(Boolean).join('\n'),
      buttons: ['好'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  }

  private openConfigDirectory(): void {
    const target = this.options.config.configPath;
    try {
      void shell.openPath(target);
    } catch (error) {
      this.logger.error('failed to open config directory', { error: describeError(error) });
    }
  }

  public showAboutDialog(): void {
    dialog.showMessageBoxSync({
      type: 'info',
      title: '关于',
      message: '鲸鱼娘桌宠',
      detail: `版本 ${app.getVersion()}\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}`,
      buttons: ['好'],
      noLink: true,
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
