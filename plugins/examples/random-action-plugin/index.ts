/**
 * random-action-plugin —— 示例插件：定时请求随机动画。
 *
 * 用途：验证「插件 -> Action Pipeline -> StateMachine -> AnimationManager」这条链路，
 * 以及优先级 / 冷却 / 不可打断规则确实由核心统一裁决（插件拿不到任何视频控制权）。
 *
 * 设计要点：
 * - 用 context.actions.execute() 投递 Action（与未来 AI Agent 完全同一条路径）；
 * - 只在桌宠空闲（state=IDLE 且没有动画在播）时插话，不打断用户正在看的内容；
 * - 被核心拒绝（冷却 / 优先级不足）属于正常结果，只记日志，不重试、不报错。
 */

import { definePlugin, type PluginContext } from 'desktop-pet';

/** 候选动画：优先级直接写进 Action，由 AnimationManager 统一裁决。 */
const CANDIDATES: readonly { readonly animationId: string; readonly priority: number; readonly weight: number }[] = [
  { animationId: 'cute', priority: 50, weight: 4 },
  { animationId: 'fawning', priority: 50, weight: 3 },
  { animationId: 'talk', priority: 40, weight: 3 },
  { animationId: 'sing', priority: 30, weight: 2 },
  { animationId: 'work', priority: 30, weight: 2 },
  { animationId: 'read', priority: 30, weight: 2 },
  { animationId: 'play', priority: 45, weight: 2 },
  { animationId: 'hungry', priority: 30, weight: 1 },
  { animationId: 'lie', priority: 10, weight: 1 },
];

const TICK_INTERVAL_MS = 18_000;
const MIN_GAP_MS = 25_000;

/** 定时器句柄放在插件模块作用域内，deactivate 时清理。 */
let timer: number | null = null;

export default definePlugin({
  id: 'random-action-plugin',
  name: '随机动作插件',
  version: '0.1.0',
  description: '每隔一段时间随机请求一个动画，验证 Action Pipeline',

  activate(context: PluginContext): void {
    const { logger, actions, state, animations, events } = context;

    let lastTriggeredAt = 0;
    let paused = false;

    const pickCandidate = (): (typeof CANDIDATES)[number] | null => {
      const available = CANDIDATES.filter(
        (candidate) => animations.getDefinition(candidate.animationId) !== null,
      );
      if (available.length === 0) return null;
      const total = available.reduce((sum, candidate) => sum + candidate.weight, 0);
      let roll = Math.random() * total;
      for (const candidate of available) {
        roll -= candidate.weight;
        if (roll <= 0) return candidate;
      }
      return available[available.length - 1] ?? null;
    };

    const tick = (): void => {
      if (paused) return;
      const now = Date.now();
      if (now - lastTriggeredAt < MIN_GAP_MS) return;

      if (state.get() !== 'IDLE' || animations.isPlaying()) {
        logger.debug('跳过本次随机动作（桌宠正忙）', { data: { state: state.get() } });
        return;
      }

      const candidate = pickCandidate();
      if (!candidate) {
        logger.warn('没有可用的候选动画，随机动作插件将空转');
        return;
      }

      lastTriggeredAt = now;
      logger.info(`随机请求动画: ${candidate.animationId}`, { data: { priority: candidate.priority } });

      void actions
        .execute({
          type: 'animation',
          animationId: candidate.animationId,
          priority: candidate.priority,
          reason: 'random-action-plugin:tick',
        })
        .then((result) => {
          if (!result.accepted) {
            logger.debug(`动画请求未被接受: ${candidate.animationId}`, {
              data: { rejection: String(result.rejection ?? 'unknown') },
            });
          }
        });
    };

    // 托盘「暂停行为」时插件同步安静下来
    events.on('behavior:paused', (payload) => {
      paused = payload.paused;
      logger.info(paused ? '随机动作已暂停' : '随机动作已恢复');
    });

    timer = setInterval(tick, TICK_INTERVAL_MS);
    logger.info('随机动作插件已启动', {
      data: { intervalMs: TICK_INTERVAL_MS, candidates: CANDIDATES.length },
    });
  },

  deactivate(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  },
});
