/**
 * 主进程的终端输出。
 *
 * ## 为什么这么简单
 *
 * 历史上这里做过一系列"修复 Windows 终端中文乱码"的尝试：探测控制台代码页、
 * 按 GBK 编码、按 `isTTY` 分流、用子进程继承控制台做中继、直接写 `CONOUT$`……
 * **全部被实测否定**（过程与结论见 README §17）。
 *
 * 最终方案最简单：**日志消息一律用英文**（见 `shared/logging.ts` 的说明）。
 * 英文是 ASCII，任何终端编码下都能正确显示，问题从根上消失。
 * 界面上给用户看的文本仍是中文 —— 那是 HTML 渲染，不受终端编码影响。
 *
 * 因此本模块只做一件事：把日志按 UTF-8 字节写到 stdout / stderr。
 *
 * 为什么坚持用 `Buffer` 字节写入而不是 `console.log`：
 * 让"终端输出"这一层在代码里**显式可见、可替换**（Logger 通过 `writeLine` 注入），
 * 将来若要改成写窗口、写管道或加前缀，只需要换这一个函数。
 */

let toConsoleEnabled = true;
let attached = false;

/**
 * 启用终端输出（幂等）。必须在第一条日志之前调用。
 * @param toConsole 是否向终端输出（与 Logger 的 `toConsole` 语义一致）。
 */
export function attachUtf8Console(toConsole: boolean): void {
  if (attached) return;
  attached = true;
  toConsoleEnabled = toConsole;
}

/**
 * 主进程 Logger 的 `writeLine` 实现：按 UTF-8 字节写一行。
 * @param level 只有 `error` / `warn` 走 stderr，其余走 stdout。
 */
export function writeUtf8(level: string, line: string): void {
  if (!toConsoleEnabled) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  try {
    stream.write(Buffer.from(`${line}\n`, 'utf8'));
  } catch {
    /* 终端不可写（例如 stdout 已关闭）时静默，绝不影响桌宠运行 */
  }
}
