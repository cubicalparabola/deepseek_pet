/**
 * hello-plugin —— 示例插件（用于验证 Plugin API 真的可用）。
 *
 * 行为：
 *   插件加载 -> 监听 pet:click        -> 输出点击区域与次数
 *            -> 监听 animation:end   -> 输出刚刚结束的动画
 *            -> 监听 state:change    -> 输出状态迁移
 *            -> 每 5 次点击请求播放 talk（走 Action Pipeline）
 *
 * 注意：这里没有任何 Node / Electron / DOM 导入。
 * 插件只能通过 activate(context) 拿到的受控 API 与桌宠通信；
 * 播放动画必须用 context.animations.play()，它内部会走 Action Pipeline。
 */

import { definePlugin, type PluginContext } from 'desktop-pet';

/** 每点击多少次让桌宠说一次话。 */
const TALK_EVERY = 5;

export default definePlugin({
  id: 'hello-plugin',
  name: 'Hello 插件',
  version: '0.1.0',
  description: '示例插件：监听事件、统计点击、请求动画',

  async activate(context: PluginContext): Promise<void> {
    const { logger, events, animations, state, storage } = context;

    logger.info(`插件已激活 (${context.plugin.id}@${context.plugin.version})`);
    logger.info(`当前状态=${state.get()}，已注册动画 ${animations.list().length} 个`);

    // StorageAPI：计数持久化（重启后仍在）
    let clickCount = storage.get<number>('clickCount', 0) ?? 0;

    events.on('pet:click', (payload) => {
      clickCount += 1;
      storage.set('clickCount', clickCount);
      logger.info(`被点击（第 ${clickCount} 次）区域=${payload.region}`, {
        data: { nx: Number(payload.nx.toFixed(2)), ny: Number(payload.ny.toFixed(2)) },
      });

      if (clickCount % TALK_EVERY === 0) {
        void animations
          .play('talk', { priority: 40, reason: 'hello-plugin:click-milestone' })
          .then((result) => {
            logger.info('插件请求 talk 的结果', { data: { ...result } });
          });
      }
    });

    events.on('animation:end', (payload) => {
      logger.info(`动画结束: ${payload.animationId}`, { data: { completed: payload.completed } });
    });

    events.on('state:change', (payload) => {
      logger.info(`状态迁移: ${payload.from} -> ${payload.to} (${payload.reason})`);
    });

    events.on('plugin:activated', (payload) => {
      if (payload.pluginId !== context.plugin.id) {
        logger.debug(`另一个插件已激活: ${payload.pluginId}`);
      }
    });

    logger.info('hello-plugin 初始化完成，等待事件…');
  },

  async deactivate(): Promise<void> {
    // 无需手动退订：PluginHost 停用插件时会统一清理该插件的全部订阅
  },
});
