/**
 * 设置窗口的跨进程契约（Main / Settings preload / 设置页面共用）。
 *
 * 为什么单独开一个窗口，而不是塞进桌宠窗口：
 * - 桌宠窗口是 `transparent + frame:false + alwaysOnTop` 的"活体图层"，
 *   往里面放滚动条既会被透明背景吃掉，也会跟随桌宠缩放；
 * - 设置窗口是一个**普通窗口**，可以正常获得焦点、键盘操作与鼠标拖拽。
 *
 * 安全设计：设置窗口的 preload 是**独立且更小**的一份桥，
 * `window.settingsAPI` 只有下面 4 个方法，拿不到桌宠的 IPC 面。
 */

import type { PetSettingsState } from './pet-size';

/** 设置窗口 preload 通过 `additionalArguments` 注入的启动数据。 */
export interface SettingsWindowBootstrap {
  /** 初始设置快照（尺寸 + 置顶）。 */
  readonly state: PetSettingsState;
  /** 配置目录绝对路径（「打开配置目录」按钮用）。 */
  readonly configPath: string;
}

/** preload 命令行参数的 key 与值。 */
export const SETTINGS_WINDOW_FLAG = '--pet-window=settings';
export const SETTINGS_BOOTSTRAP_FLAG = '--pet-settings-bootstrap=';

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
  /** 在系统文件管理器里打开配置目录。 */
  openConfigFolder(): Promise<boolean>;
  /** 关闭设置窗口（隐藏，不销毁）。 */
  close(): Promise<void>;
  /** 主进程推送的设置变化（例如托盘菜单改了尺寸）。 */
  onChanged(handler: (state: PetSettingsState) => void): () => void;
}
