/**
 * DeepSeek 余额接口的**纯解析部分**（shared：渲染层验收脚本也能直接断言）。
 *
 * 官方文档（`GET /user/balance`）返回：
 * ```jsonc
 * {
 *   "is_available": true,
 *   "balance_infos": [
 *     { "currency": "CNY", "total_balance": "110.00", "granted_balance": "10.00", "topped_up_balance": "100.00" }
 *   ]
 * }
 * ```
 *
 * ⚠️ 两个容易踩的点，所以这两件事单独放这里而不是塞在 HTTP 客户端里：
 *   1. **金额是字符串**（`"110.00"`），直接 `Number()` 在有些实现里会得到 NaN；
 *   2. 官方**没有** token 用量接口，只有余额 —— 所以"还剩多少额度"只能以余额为准。
 *
 * 网络请求本身在 `main/ai/llm-client.ts`（只有主进程发请求）。
 */

/** 余额查询结果（解析后的钱数，单位由 `currency` 决定）。 */
export interface LLMBalanceResult {
  /** 当前账户是否有余额可供 API 调用。 */
  readonly isAvailable: boolean;
  readonly currency: string;
  readonly totalBalance: number;
  readonly grantedBalance: number;
  readonly toppedUpBalance: number;
  readonly fetchedAt: string;
}

/**
 * 余额接口地址：把用户填的根地址收敛成 `.../user/balance`。
 *
 * 三种常见填法都要能work：
 *   `https://api.deepseek.com`、`https://api.deepseek.com/v1`、
 *   甚至误填成 `https://api.deepseek.com/v1/chat/completions`。
 */
export function balanceEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const stripped = base
    .replace(/\/chat\/completions$/, '')
    .replace(/\/v1\/messages$/, '')
    .replace(/\/v1$/, '');
  return `${stripped}/user/balance`;
}

/**
 * 这家服务商是否提供"查询余额"接口。
 *
 * 目前只有 DeepSeek 官方有：one-api / Ollama / vLLM 这类兼容网关没有这个接口，
 * 对它们发请求只会得到 404，反而把"最近错误"刷红、让人以为配置坏了。
 */
export function supportsBalanceQuery(baseUrl: string): boolean {
  return /(^|\.)deepseek\.com(\/|$)/i.test(baseUrl.trim());
}

/** 解析余额响应（宽松：字段缺失按 0，金额字符串也能读）。 */
export function parseBalance(parsed: Record<string, unknown>, fetchedAt: string): LLMBalanceResult {
  const infos = Array.isArray(parsed.balance_infos) ? parsed.balance_infos : [];
  const first = (infos[0] ?? {}) as Record<string, unknown>;
  return {
    isAvailable: parsed.is_available === true,
    currency: typeof first.currency === 'string' ? first.currency : 'CNY',
    totalBalance: moneyOr(first.total_balance, 0),
    grantedBalance: moneyOr(first.granted_balance, 0),
    toppedUpBalance: moneyOr(first.topped_up_balance, 0),
    fetchedAt,
  };
}

/** 金额解析：字符串数字（官方就是字符串）、数字、非法值都收敛成有限数。 */
export function moneyOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(/[^0-9.\-]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** 余额的展示文案（面板 / 托盘共用，避免两处格式不一致）。 */
export function formatBalance(balance: {
  readonly currency: string;
  readonly totalBalance: number;
  readonly grantedBalance: number;
  readonly toppedUpBalance: number;
  readonly isAvailable: boolean;
}): string {
  const money = `${balance.totalBalance.toFixed(2)} ${balance.currency}`;
  if (!balance.isAvailable) return `${money}（余额不足，已无法调用）`;
  if (balance.grantedBalance > 0) {
    return `${money}（其中赠金 ${balance.grantedBalance.toFixed(2)}）`;
  }
  return money;
}
