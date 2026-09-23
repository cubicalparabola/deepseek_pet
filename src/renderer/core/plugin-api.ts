/**
 * 插件沙箱虚拟模块 `desktop-pet` 的实现。
 *
 * 插件里可以写：
 *     import { definePlugin } from 'desktop-pet';
 * 但 esbuild 打包时把该模块标记为 external，因此这里的实现是**唯一**能被 require 到的内容。
 *
 * 安全意义：虚拟模块只提供类型友好的一次性包装函数，
 * 不暴露 require / process / fs / electron 等任何系统能力。
 */

import type { PetPlugin } from '../../shared/plugin-types';

/**
 * 定义一个插件（本质是恒等函数 + 类型收窄）。
 * 使用它的好处：插件入口能被主进程的 PluginHost 稳定识别为 CommonJS 导出。
 */
export function definePlugin(plugin: PetPlugin): PetPlugin {
  return plugin;
}

export default { definePlugin };
