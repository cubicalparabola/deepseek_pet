// @ts-check
/**
 * 单实例锁护栏 —— 给"会产出结果文件"的验收/诊断/探针脚本用。
 *
 * ## 为什么必须有
 *
 * 桌宠本体在 `src/main/main.ts` 里拿了 `app.requestSingleInstanceLock()`：
 * 一旦已有实例在跑（用户自己开着桌宠、或者上一次诊断的进程没退干净），
 * `require('dist/main/main.js')` 会**立刻 `app.quit()`**。此时脚本不会报错、
 * 不会打印任何东西，**退出码还是 0**，结果文件保持上一次的内容 ——
 * 也就是说"这次到底跑没跑"变成一个假象。
 *
 * 这条踩过一次：背景任务里跑感知面板诊断，进程被单实例锁挡掉、静默退出 0，
 * 而 `build/perception-ui.json` 还是上一轮的那份（`steps.length` 都是旧的），
 * 差点把陈旧结果当成新证据（验收脚本更危险：会直接读到上一次的 `acceptance.json`）。
 *
 * ## 用法
 *
 * 在 `require(dist/main/main.js)` **之前**调用（顺序不能反）：
 *
 * ```js
 * const { guardSingleInstance } = require('./lib/instance-guard.cjs');
 * guardSingleInstance(app, {
 *   onBlocked: (message) => writeFileSync(outFile, JSON.stringify({ fatal: message, checks: [] }, null, 1), 'utf8'),
 * });
 * ```
 *
 * `onBlocked` 用来把"没跑成"写进结果文件（调用方各自知道自己的文件名），
 * 这样即使有人只看 JSON 也不会被陈旧结果骗到。
 *
 * @param {import('electron').App} app
 * @param {{ onBlocked?: (message: string) => void }} [options]
 */
function guardSingleInstance(app, options = {}) {
  // 先自己探一次锁：拿到就**立刻释放**，真正的锁仍由 dist/main/main.js 去拿
  // （我们只是想知道"现在有没有别的实例"）
  const got = app.requestSingleInstanceLock();
  if (got) {
    app.releaseSingleInstanceLock();
    return;
  }
  const message =
    '已有另一个桌宠实例在运行（用户开着桌宠，或上一次的验收/诊断/探针没退干净）：' +
    'require(main.js) 会被单实例锁直接 app.quit()，脚本静默退出、结果文件保持上一次内容。请先退出它再跑本脚本。';
  if (typeof options.onBlocked === 'function') {
    try {
      options.onBlocked(message);
    } catch (error) {
      console.error('[instance-guard] 写结果文件失败', error);
    }
  }
  console.error(`[instance-guard] ${message}`);
  // 3 = "没跑成"（不是断言失败，也不是崩溃），与验收的 0/1 区分开
  process.exit(3);
}

module.exports = { guardSingleInstance };
