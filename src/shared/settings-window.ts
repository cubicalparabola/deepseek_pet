/**
 * 设置窗口的跨进程契约（Main / Settings preload / 设置页面共用）。
 *
 * 为什么单独开一个窗口，而不是塞进桌宠窗口：
 * - 桌宠窗口是 `transparent + frame:false + alwaysOnTop` 的"活体图层"，
 *   往里面放滚动条既会被透明背景吃掉，也会跟随桌宠缩放；
 * - 设置窗口是一个**普通窗口**，可以正常获得焦点、键盘操作与鼠标拖拽。
 *
 * 安全设计：设置窗口的 preload 是**独立且更小**的一份桥，
 * `window.settingsAPI` 只有下面这几个方法，拿不到桌宠的 IPC 面。
 */

import type { PetSettingsState } from './pet-size';
import type { AIAPI, GrowthAPI, PerceptionAPI } from './ipc';
import type { AIStatusView } from './ai-types';
import type { PerceptionStatus } from './perception-types';
import type { GrowthStatus } from './growth-types';
import type { PluginInstallResult, PluginRecord } from './plugin-types';

/** 设置窗口 preload 通过 `additionalArguments` 注入的启动数据。 */
export interface SettingsWindowBootstrap {
  /** 初始设置快照（尺寸 + 置顶）。 */
  readonly state: PetSettingsState;
  /** 配置目录绝对路径（「打开配置目录」按钮用）。 */
  readonly configPath: string;
  /** AI 状态快照（打开设置窗口时读一次，之后靠推送更新）。 */
  readonly ai: AIStatusView;
  /** 感知状态快照（同上）。 */
  readonly perception: PerceptionStatus;
  /** 成长与反思状态快照（同上）。 */
  readonly growth: GrowthStatus;
  /**
   * 插件清单快照（**含被关掉的插件**）。
   *
   * 关掉的插件必须也出现在这里：否则用户关掉一个插件之后，界面上就再也
   * 找不到它，也就没法再打开 —— 那是"能关不能开"，不是"可随时关闭"。
   */
  readonly plugins: readonly PluginRecord[];
}

/** preload 命令行参数的 key 与值。 */
export const SETTINGS_WINDOW_FLAG = '--pet-window=settings';
export const SETTINGS_BOOTSTRAP_FLAG = '--pet-settings-bootstrap=';

/**
 * 插件管理面（设置窗口专用）。
 *
 * 设置窗口是**插件开关的主入口**：一列插件、每行一个开关、旁边写清楚
 * 它声明了哪些权限（`net` / `process` / `python` / `notify` / `ui`）。
 * 关掉一个插件 = 立刻回收它的一切（事件、定时器、子进程、菜单项、面板），
 * 并写回 `assets/config/plugins.json` —— 重启后依然是关的。
 */
export interface SettingsPluginAPI {
  /** 全部插件记录（含**被关掉的**：它们也要显示出来，否则没法再打开）。 */
  list(): Promise<readonly PluginRecord[]>;
  /** 启用 / 停用单个插件，返回更新后的清单。 */
  setEnabled(id: string, enabled: boolean): Promise<readonly PluginRecord[]>;
  /** 重新发现 + 重读代码（整体重载），返回发现到的插件个数。 */
  reload(): Promise<number>;
  /** 订阅清单变化（托盘菜单或桌宠窗口里改了开关也会推过来）。 */
  onChanged(handler: (records: readonly PluginRecord[]) => void): () => void;
  /**
   * 安装插件：弹目录选择框，把选中的插件文件夹复制进 `plugins/` 并登记。
   *
   * `directory` 可以显式给路径（自动化用）；正常界面不传，由主进程弹框。
   */
  install(directory?: string): Promise<PluginInstallResult>;
  /**
   * 卸载插件：停用 -> 删除它的目录 -> 从 `plugins.json` 移除。
   *
   * 只对**用户安装的**插件开放（`record.removable === true`）：
   * `plugins/examples/*` 是随程序发布的内置示例，删了会破坏随包内容。
   */
  uninstall(id: string): Promise<PluginInstallResult>;
}

/** `window.settingsAPI` 的形状。 */
export interface SettingsWindowBridge {
  /** 初始快照（与注入的 bootstrap 同源，便于页面做类型收窄）。 */
  readonly initial: SettingsWindowBootstrap;
  /**
   * 调整桌宠大小。
   *
   * 每一次滑动都会**立即生效并写入磁盘**（settings.json），
   * 因此没有"预览/保存"两套状态，也就不存在关闭窗口后设置丢失的情况。
   * 返回值为应用后的真实尺寸信息（含显示器收敛结果）。
   */
  setScale(scale: number): Promise<PetSettingsState>;
  setAlwaysOnTop(value: boolean): Promise<PetSettingsState>;
  /**
   * 拖到屏幕边缘是否自动收起（`shared/dock.ts` 的 `dockOnEdge`）。
   *
   * 这个开关以前只在托盘菜单里（"拖到边缘自动收起"）。菜单留给日常动作之后，
   * 它属于"配置"，于是搬进设置窗口 —— 与 `setAlwaysOnTop` 一样即改即存。
   */
  setDockOnEdge(value: boolean): Promise<PetSettingsState>;
  /**
   * 重载插件（重新发现 + 让渲染层重读插件代码），返回发现到的插件个数。
   *
   * 同样是从菜单搬来的：调试插件时才点一次，属于配置侧的动作。
   */
  reloadPlugins(): Promise<number>;
  /** 在系统文件管理器里打开配置目录。 */
  openConfigFolder(): Promise<boolean>;
  /** 关闭设置窗口（隐藏，不销毁）。 */
  close(): Promise<void>;
  /** 主进程推送的设置变化（例如托盘菜单改了尺寸）。 */
  onChanged(handler: (state: PetSettingsState) => void): () => void;
  /**
   * AI 认知与人格（2.1~2.4）。
   *
   * 与桌宠窗口的 `petAPI.ai` 是**同一个 API 面**（见 shared/ipc.ts 的 AIAPI）：
   * 设置窗口是配置这些开关的主入口，日记与记忆也在这里查看。
   */
  readonly ai: AIAPI;
  /**
   * 环境与用户感知（3.1~3.6）。
   *
   * 设置窗口是这些"可配置开关"的主入口：屏幕/行为/摄像头/习惯
   * 四个开关、隐私模式、采样间隔、主动打扰频率、敏感词黑名单都在这里。
   */
  readonly perception: PerceptionAPI;
  /**
   * 成长、记忆与反思（4.1 / 4.2）。
   *
   * 设置窗口是"记忆宫殿"的主界面：时间轴、手动记一笔、看她今天的反思、
   * 以及那个最重要的安全阀 —— 「重置策略」。
   */
  readonly growth: GrowthAPI;
  /**
   * 插件管理。
   *
   * 这里是"插件可随时关闭"的界面入口：开关即写盘、即回收，
   * 不需要重启、也不需要用户去手改 `plugins.json`。
   */
  readonly plugins: SettingsPluginAPI;
}
