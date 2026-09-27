/**
 * LLM 客户端（2.1）—— 只用 `fetch` 直接调 HTTP，不引入任何 SDK。
 *
 * 为什么不用 openai / @anthropic-ai/sdk：
 * 1. 本模块要求"可配置"，用户可能指向 one-api、vLLM、Ollama、DeepSeek 等
 *    任意 OpenAI **兼容**网关；手写一层 HTTP 反而比 SDK 更好适配；
 * 2. 少一个依赖 = 少一处打包（asar）与版本兼容风险，桌宠不该为此背风险。
 *
 * 安全：请求只从**主进程**发出（渲染层 CSP 是 `connect-src 'none'`，
 * 拿不到也不该拿到这个能力）；错误信息里绝不回显 API Key。
 */

import type { AIProviderConfig } from '../../shared/ai-types';
import { balanceEndpoint, parseBalance, type LLMBalanceResult } from '../../shared/balance';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export interface LLMMessage {
  readonly role: 'system' | 'user' | 'assistant';
  /**
   * 文本，或**多模态分片**（3.1/3.2/3.5 要把屏幕截图/摄像头帧交给视觉模型）。
   *
   * 保持 `string` 这个常见形态不变，多模态只在真正需要时用数组 ——
   * 这样已有的纯文本调用一行都不用改。
   */
  readonly content: string | readonly LLMContentPart[];
  /**
   * assistant 这一轮**请求调用工具**（工具调用是"她自己去查"，见 `tools.ts`）。
   *
   * 为什么把工具写成消息上的可选字段而不是另开一种消息类型：
   * 两家服务商的表达方式不同（OpenAI 是并排的 `tool_calls` + `role:'tool'`；
   * Anthropic 是 content 数组里的 `tool_use` / `tool_result` 块），
   * 这里只描述**语义**，翻译交给各自的纯函数（`toOpenAIRequest` / `toAnthropicRequest`）。
   */
  readonly toolCalls?: readonly LLMToolCall[];
  /** user 这一轮回传**工具结果**（与 `toolCalls` 的 id 一一对应）。 */
  readonly toolResults?: readonly LLMToolResult[];
}

/** 一次工具调用请求（模型发起）。 */
export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  /** 原始 JSON 字符串（各家都给字符串，保留原样便于排查）。 */
  readonly arguments: string;
}

/** 一次工具执行结果（本地执行后回传给模型）。 */
export interface LLMToolResult {
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly ok: boolean;
}

/** 工具定义（JSON Schema，OpenAI 与 Anthropic 的写法在这个层面是等价的）。 */
export interface LLMToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema（`type: 'object'` + `properties`）。 */
  readonly parameters: Record<string, unknown>;
}

export interface LLMCompletionRequest {
  readonly messages: readonly LLMMessage[];
  /** 覆盖配置里的采样温度。 */
  readonly temperature?: number;
  /** 覆盖配置里的最大 token。 */
  readonly maxTokens?: number;
  /** 覆盖配置里的超时。 */
  readonly timeoutMs?: number;
  /**
   * 推理强度（`reasoning_effort`，OpenAI 兼容端点）。
   *
   * 为什么必须有这个开关：**推理模型会先把 max_tokens 花在思考上**。
   * 实测（`api.deepseek.com` + `deepseek-flash`，见 build/vision-probe*.mjs）：
   * 一次场景分析会先写 300~1000 字的 reasoning，而视觉那条请求只给了
   * `max_tokens: 360` —— 于是 content 被截断（`finish_reason: length`）
   * 或整段为空（`EMPTY`），渲染层拿不到观察，**时间线就出现空洞**。
   * 设成 `'none'` 后同一张图：completion 从 169~341 token 降到 53~57、
   * 延迟从 1.6~2.4s 降到 0.75s，JSON 反而更完整。
   *
   * 桌宠的每次调用都是"短输出 + 结构化"，所以默认在调用点显式传 `'none'`；
   * 不传 = 不写这个字段 = 由服务商决定（老网关不认识它，见 `complete()` 的兼容重试）。
   */
  readonly reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /** 这一轮允许模型调用的工具（省略 = 纯对话，不带工具）。 */
  readonly tools?: readonly LLMToolDefinition[];
  /**
   * 这次调用**是干什么用的**（`chat` / `diary` / `vision` / `reflection` / …）。
   *
   * 只用于**用量统计与排查**，不影响请求内容。为什么要它：
   * "她这个月花了多少 token"必须能回答"花在哪"，否则用户只看到一个总数，
   * 没法判断是聊天花的还是每分钟一次的视觉理解花的。
   */
  readonly purpose?: LLMPurpose;
}

/** 调用用途（写入用量统计的标签；新增调用点时**必须**挑一个或加一个）。 */
export type LLMPurpose =
  | 'chat'
  | 'chat-tools'
  | 'speak-up'
  | 'diary'
  | 'note'
  | 'summary'
  | 'facts'
  | 'vision'
  | 'camera'
  | 'view-screen'
  | 'reflection'
  | 'timeline'
  | 'habit-model'
  | 'other';

/** 一次调用的用量（回调给上层记账）。 */
export interface LLMUsageEvent {
  readonly tokens: number;
  readonly purpose: LLMPurpose;
  readonly kind: AIProviderConfig['kind'];
  readonly model: string;
  readonly latencyMs: number;
}

export interface LLMCompletionResult {
  readonly text: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly model: string;
  readonly latencyMs: number;
  /** 模型想调用的工具（空数组 = 这一轮直接给了答案）。 */
  readonly toolCalls: readonly LLMToolCall[];
  /**
   * 结束原因（OpenAI 的 `finish_reason` / Anthropic 的 `stop_reason`）。
   *
   * 用途：`'length'` 说明**输出被 max_tokens 截断**（推理模型最常见的翻车方式），
   * 排查"她怎么又没说话/时间线怎么又断了"时，这一条一眼就能定性。
   */
  readonly finishReason: string;
  /** 其中有多少 token 花在推理（`completion_tokens_details.reasoning_tokens`）。 */
  readonly reasoningTokens: number;
}

/** 多模态分片（目前只有文本与图片两种）。 */
export type LLMContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly dataBase64: string };

export type LLMErrorCode = 'NO_KEY' | 'HTTP' | 'TIMEOUT' | 'NETWORK' | 'PARSE' | 'EMPTY';

/** 结构化错误：上层据此决定"降级成本地兜底"还是"提示用户去改配置"。 */
export class LLMError extends Error {
  public readonly code: LLMErrorCode;
  public readonly status: number;

  public constructor(code: LLMErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 空内容的错误文案：把**结束原因**与**推理 token**写进去。
 *
 * 为什么要这么啰嗦：这句文案会原样出现在感知日志与 AI 面板的"最近错误"里。
 * 早期只写"模型返回了空内容"，用户与排查者都看不出"是模型不愿意答，
 * 还是推理把 max_tokens 花光了" —— 而这两者的修法完全不同
 * （前者换模型/改提示词，后者加预算或关推理）。
 */
function emptyContentMessage(result: { readonly finishReason: string; readonly reasoningTokens: number }): string {
  const parts = ['模型返回了空内容'];
  if (result.finishReason === 'length') parts.push('（max_tokens 被推理过程用光，正文被截断）');
  else if (result.finishReason !== '') parts.push(`（finish_reason=${result.finishReason}）`);
  if (result.reasoningTokens > 0) parts.push(`· 其中推理 ${result.reasoningTokens} token`);
  return parts.join('');
}

/** 每家服务商的默认路径（只用于拼接，用户填的是根地址）。 */
const PATHS = {
  openai: '/chat/completions',
  anthropic: '/v1/messages',
} as const;

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 拼接最终请求地址。
 *
 * 容错两种常见填法：
 * - `https://api.openai.com/v1`（推荐，根地址不含路径）
 * - `https://api.openai.com/v1/`（多余的尾斜杠）
 * 若用户已经把完整路径写进来了（以 `/chat/completions` 结尾），则原样使用。
 */
function endpoint(baseUrl: string, kind: AIProviderConfig['kind']): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = PATHS[kind];
  if (base.endsWith(path)) return base;
  return `${base}${path}`;
}

export interface LLMClientOptions {
  readonly logger: Logger;
  /**
   * 每次**成功**调用后回报 token 用量。
   *
   * 为什么把记账放在客户端里、而不是让每个调用点自己记：
   * 这个模块是**所有**大模型请求的唯一出口（聊天/日记/视觉/反思/习惯建模…），
   * 在这里挂一次就再也不可能漏记 —— 事实上以前就是漏的：
   * 视觉理解与每日反思的 token 从来没进过预算，面板上的数字一直是偏乐观的。
   */
  readonly onUsage?: (usage: LLMUsageEvent) => void;
}

export class LLMClient {
  private config: AIProviderConfig;
  private readonly logger: Logger;
  private readonly onUsage: ((usage: LLMUsageEvent) => void) | undefined;

  public constructor(config: AIProviderConfig, options: LLMClientOptions) {
    this.config = config;
    this.logger = options.logger;
    this.onUsage = options.onUsage;
  }

  /** 配置热更新（设置界面改完立刻生效，不需要重启）。 */
  public updateConfig(config: AIProviderConfig): void {
    this.config = config;
  }

  public getConfig(): AIProviderConfig {
    return this.config;
  }

  /**
   * 发一次对话补全。
   *
   * 只做一次尝试、不做重试：桌宠的回复是"锦上添花"，失败立刻降级成本地兜底，
   * 重试会把用户等待时间成倍拉长（而且往往重试也没用）。
   *
   * **两个例外**（都是"换个请求形状就能救回来"的情况，各自只重试一次）：
   * 1. 带了工具（`request.tools`）的请求被网关以 400/404 拒掉时，去掉工具再试 ——
   *    有些 OpenAI 兼容网关（老 vLLM / one-api 的某些版本）不认识 `tools` 字段；
   * 2. 请求带了 `reasoningEffort` 却被拒（400/404）时，去掉它再试 ——
   *    同理，不是所有网关都认识 `reasoning_effort`（DeepSeek 官方认得）；
   * 3. 返回了**空内容**（`EMPTY`）时，把 `max_tokens` 放大到 3 倍（至少 900）再试一次 ——
   *    这是推理模型最典型的翻车：思考把预算吃光，正文一个字都没剩下。
   *    不重试的话，一次视觉采样就白花钱且时间线多一个空洞（实测约 1/3 的采样）。
   */
  public async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const config = this.config;
    if (config.apiKey.trim() === '') {
      throw new LLMError('NO_KEY', '未配置 API Key');
    }

    try {
      return await this.attempt(request);
    } catch (error) {
      const rejected =
        error instanceof LLMError && error.code === 'HTTP' && (error.status === 400 || error.status === 404);
      if (rejected && (request.tools?.length ?? 0) > 0) {
        this.logger.warn('provider rejected the tools field; retrying without tools', {
          data: { status: (error as LLMError).status, kind: config.kind },
        });
        return this.completeWithout(error, { ...request, tools: undefined });
      }
      if (rejected && request.reasoningEffort !== undefined) {
        this.logger.warn('provider rejected reasoning_effort; retrying without it', {
          data: { status: (error as LLMError).status, kind: config.kind },
        });
        return this.completeWithout(error, { ...request, reasoningEffort: undefined });
      }
      if (error instanceof LLMError && error.code === 'EMPTY') {
        const bigger = Math.max((request.maxTokens ?? config.maxTokens) * 3, 900);
        this.logger.warn('model returned no content; retrying with a larger max_tokens', {
          data: { purpose: request.purpose ?? 'other', from: request.maxTokens ?? config.maxTokens, to: bigger },
        });
        return this.completeWithout(error, { ...request, maxTokens: bigger });
      }
      throw error;
    }
  }

  /**
   * 兼容重试的统一入口：**只重试一次**（重试里再失败就直接抛）。
   *
   * 为什么不用 `this.complete(...)`（那样是递归、可能连环重试）：
   * 上面每个例外都只是"换个请求形状"，第二次还不行就说明真的不行了，
   * 继续重试只会让用户等更久、花更多 token。
   */
  private async completeWithout(cause: unknown, request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    try {
      return await this.attempt(request);
    } catch (retryError) {
      this.logger.debug('retry after a rejected request shape also failed', {
        data: { first: describeError(cause), second: describeError(retryError) },
      });
      throw retryError;
    }
  }

  /** 一次请求（含超时与错误归一化）。 */
  private async attempt(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const config = this.config;
    const timeoutMs = request.timeoutMs ?? config.timeoutMs;
    const url = endpoint(config.baseUrl, config.kind);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response =
        config.kind === 'anthropic'
          ? await this.callAnthropic(url, request, controller)
          : await this.callOpenAI(url, request, controller);
      const latencyMs = Date.now() - startedAt;
      this.logger.debug('llm completion ok', {
        data: {
          kind: config.kind,
          model: response.model || config.model,
          latencyMs,
          tokens: response.totalTokens,
          toolCalls: response.toolCalls.length,
          purpose: request.purpose ?? 'other',
          /*
           * `finish=length`（被截断）与"推理吃掉多少 token"是排查
           * "她怎么又哑了 / 时间线怎么又断了"的两个关键数字，一律带上。
           */
          finish: response.finishReason === '' ? '(none)' : response.finishReason,
          reasoningTokens: response.reasoningTokens,
        },
      });
      /*
       * 记账：**所有**调用都从这里出去，所以这一处就够。
       * 回调本身不允许抛（否则会把一次成功的调用变成失败）——
       * 记账失败不该让她的回复消失。
       */
      try {
        this.onUsage?.({
          tokens: response.totalTokens,
          purpose: request.purpose ?? 'other',
          kind: config.kind,
          model: response.model || config.model,
          latencyMs,
        });
      } catch (error) {
        this.logger.warn('recording llm usage failed', { error: describeError(error) });
      }
      return { ...response, latencyMs };
    } catch (error) {
      throw this.normalizeError(error, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* OpenAI 兼容（/chat/completions）                                     */
  /* ------------------------------------------------------------------ */

  private async callOpenAI(
    url: string,
    request: LLMCompletionRequest,
    controller: AbortController,
  ): Promise<Omit<LLMCompletionResult, 'latencyMs'>> {
    const body = toOpenAIRequest(this.config, request);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) throw this.httpError(response.status, text);

    const parsed = safeParse(text);
    if (parsed === null) throw new LLMError('PARSE', '模型返回的不是合法 JSON');

    const parsedResponse = parseOpenAIResponse(parsed, this.config.model);
    // 只调工具、没给文字是**正常**的（模型在"先去查一下"），不能当空回复
    if (parsedResponse.text === '' && parsedResponse.toolCalls.length === 0) {
      throw new LLMError('EMPTY', emptyContentMessage(parsedResponse));
    }
    return parsedResponse;
  }

  /* ------------------------------------------------------------------ */
  /* Anthropic（/v1/messages）                                            */
  /* ------------------------------------------------------------------ */

  private async callAnthropic(
    url: string,
    request: LLMCompletionRequest,
    controller: AbortController,
  ): Promise<Omit<LLMCompletionResult, 'latencyMs'>> {
    const body = toAnthropicRequest(this.config, request);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) throw this.httpError(response.status, text);

    const parsed = safeParse(text);
    if (parsed === null) throw new LLMError('PARSE', '模型返回的不是合法 JSON');

    const parsedResponse = parseAnthropicResponse(parsed, this.config.model);
    if (parsedResponse.text === '' && parsedResponse.toolCalls.length === 0) {
      throw new LLMError('EMPTY', emptyContentMessage(parsedResponse));
    }
    return parsedResponse;
  }

  /* ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ */
  /* 余额查询（DeepSeek 官方只有这一个"用量/额度"接口）                     */
  /* ------------------------------------------------------------------ */

  /**
   * 查询账号余额：`GET /user/balance`。
   *
   * 为什么是"余额"而不是"token 用量"：DeepSeek 官方文档只提供
   * `GET /user/balance`（返回 `is_available` 与 `balance_infos[]`，
   * 每项含 `currency` / `total_balance` / `granted_balance` / `topped_up_balance`），
   * **没有**公开的 token 用量查询接口 —— 累计 token 只能自己统计
   * （我们已经按 `usage.total_tokens` 累加在预算里）。
   * 因此"还剩多少额度"以余额为准，本地累计 token 只在查不到余额时兜底。
   *
   * 只在 DeepSeek 的官方域名下调用：one-api / Ollama 这类兼容网关没有这个接口，
   * 对它们发请求只会得到 404 噪音。
   */
  public async fetchBalance(): Promise<LLMBalanceResult> {
    const config = this.config;
    const key = config.apiKey.trim();
    if (key === '') throw new LLMError('NO_KEY', '未配置 API Key');

    const url = balanceEndpoint(config.baseUrl);
    const timeoutMs = Math.min(config.timeoutMs, 15000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${key}`,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw this.httpError(response.status, text);
      const parsed = safeParse(text);
      if (parsed === null) throw new LLMError('PARSE', '余额接口返回的不是合法 JSON');
      return parseBalance(parsed, new Date().toISOString());
    } catch (error) {
      throw this.normalizeError(error, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 错误处理                                                            */
  /* ------------------------------------------------------------------ */

  private httpError(status: number, body: string): LLMError {
    // 服务端偶尔会在错误里回显请求头，这里只取前 300 字并去掉疑似密钥串
    const detail = body.replace(/sk-[A-Za-z0-9\-_]{8,}/g, 'sk-***').slice(0, 300);
    const hint =
      status === 401 || status === 403
        ? '（API Key 无效或没有权限）'
        : status === 404
          ? '（接口地址不对：注意是否少了 /v1）'
          : status === 429
            ? '（触发限流或余额不足）'
            : '';
    return new LLMError('HTTP', `HTTP ${status}${hint} ${detail}`.trim(), status);
  }

  private normalizeError(error: unknown, timeoutMs: number): LLMError {
    if (error instanceof LLMError) return error;
    const name = (error as { name?: string } | null)?.name;
    if (name === 'AbortError') {
      return new LLMError('TIMEOUT', `请求超时（${timeoutMs}ms）`);
    }
    return new LLMError('NETWORK', `网络请求失败：${describeError(error)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 请求体构造（纯函数：两家服务商的差异只在这里，验收可以直接断言）                  */
/* -------------------------------------------------------------------------- */

/**
 * OpenAI 兼容的请求体。
 *
 * 工具调用的两处翻译：
 * - assistant 的 `toolCalls` → 并排的 `tool_calls`（`function.arguments` 是**字符串**）；
 * - user 的 `toolResults` → 每个结果一条 `role: 'tool'` 消息（OpenAI 的约定）。
 */
export function toOpenAIRequest(config: AIProviderConfig, request: LLMCompletionRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.toolResults && message.toolResults.length > 0) {
      for (const result of message.toolResults) {
        messages.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content });
      }
      continue;
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        // 只调工具时可以没有正文，OpenAI 允许 content 为 null
        content: toOpenAIContent(message.content) === '' ? null : toOpenAIContent(message.content),
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      continue;
    }
    messages.push({ role: message.role, content: toOpenAIContent(message.content) });
  }

  return {
    model: config.model,
    messages,
    temperature: request.temperature ?? config.temperature,
    max_tokens: request.maxTokens ?? config.maxTokens,
    // 只在调用点显式要求时才写：老网关不认识这个字段，写了会被 400（`complete()` 会去掉它重试一次）
    ...(request.reasoningEffort !== undefined ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          tool_choice: 'auto',
        }
      : {}),
    stream: false,
  };
}

/** Anthropic 的请求体（`tool_use` / `tool_result` 是 content 数组里的块）。 */
export function toAnthropicRequest(config: AIProviderConfig, request: LLMCompletionRequest): Record<string, unknown> {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => toPlainText(message.content))
    .join('\n\n');

  const messages: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === 'system') continue;
    if (message.toolResults && message.toolResults.length > 0) {
      messages.push({
        role: 'user',
        content: message.toolResults.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: result.content,
        })),
      });
      continue;
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: [
          ...(toPlainText(message.content).trim() === ''
            ? []
            : [{ type: 'text', text: toPlainText(message.content) }]),
          ...message.toolCalls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: safeParseArguments(call.arguments),
          })),
        ],
      });
      continue;
    }
    messages.push({ role: message.role, content: toAnthropicContent(message.content) });
  }

  return {
    model: config.model,
    system,
    messages,
    temperature: request.temperature ?? config.temperature,
    max_tokens: request.maxTokens ?? config.maxTokens,
    ...(request.tools && request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }
      : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* 响应解析（纯函数）                                                           */
/* -------------------------------------------------------------------------- */

/** OpenAI：`choices[0].message` 的 `content` 与 `tool_calls`。 */
export function parseOpenAIResponse(
  parsed: Record<string, unknown>,
  fallbackModel: string,
): Omit<LLMCompletionResult, 'latencyMs'> {
  const usage = (parsed.usage ?? {}) as Record<string, unknown>;
  const promptTokens = numberOr(usage.prompt_tokens, 0);
  const completionTokens = numberOr(usage.completion_tokens, 0);
  const completionDetails = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  return {
    text: extractOpenAIContent(parsed),
    toolCalls: extractOpenAIToolCalls(parsed),
    promptTokens,
    completionTokens,
    totalTokens: numberOr(usage.total_tokens, promptTokens + completionTokens),
    model: typeof parsed.model === 'string' ? parsed.model : fallbackModel,
    finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : '',
    reasoningTokens: numberOr(completionDetails.reasoning_tokens, 0),
  };
}

/** Anthropic：content 数组里的 `text` 与 `tool_use` 块。 */
export function parseAnthropicResponse(
  parsed: Record<string, unknown>,
  fallbackModel: string,
): Omit<LLMCompletionResult, 'latencyMs'> {
  const usage = (parsed.usage ?? {}) as Record<string, unknown>;
  const promptTokens = numberOr(usage.input_tokens, 0);
  const completionTokens = numberOr(usage.output_tokens, 0);
  return {
    text: extractAnthropicContent(parsed),
    toolCalls: extractAnthropicToolCalls(parsed),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    model: typeof parsed.model === 'string' ? parsed.model : fallbackModel,
    finishReason: typeof parsed.stop_reason === 'string' ? parsed.stop_reason : '',
    reasoningTokens: 0,
  };
}

/** 从字符串里解析工具参数（拿不准就给空对象：工具自己会兜底）。 */
function safeParseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function extractOpenAIToolCalls(parsed: Record<string, unknown>): LLMToolCall[] {
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const message = (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined;
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: LLMToolCall[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const fn = record.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === 'string' ? fn.name : '';
    if (name === '') continue;
    calls.push({
      id: typeof record.id === 'string' && record.id !== '' ? record.id : `call-${calls.length}`,
      name,
      arguments: typeof fn?.arguments === 'string' ? fn.arguments : '{}',
    });
  }
  return calls;
}

function extractAnthropicToolCalls(parsed: Record<string, unknown>): LLMToolCall[] {
  const content = parsed.content;
  if (!Array.isArray(content)) return [];
  const calls: LLMToolCall[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const item = block as Record<string, unknown>;
    if (item.type !== 'tool_use') continue;
    const name = typeof item.name === 'string' ? item.name : '';
    if (name === '') continue;
    calls.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `call-${calls.length}`,
      name,
      arguments: JSON.stringify(item.input ?? {}),
    });
  }
  return calls;
}

/* -------------------------------------------------------------------------- */
/* 解析辅助（各家返回结构略有差异，这里做宽松解析）                                */
/* -------------------------------------------------------------------------- */

/** 把多模态分片拍平成纯文本（Anthropic 的 system 只能是字符串）。 */
function toPlainText(content: string | readonly LLMContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : '[图片]'))
    .join('\n');
}

/** OpenAI 兼容：图片走 `image_url` + data URL。 */
function toOpenAIContent(content: string | readonly LLMContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` } },
  );
}

/** Anthropic：图片走 `source: {type:'base64', media_type, data}`。 */
function toAnthropicContent(content: string | readonly LLMContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.dataBase64 } },
  );
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** OpenAI：`choices[0].message.content`（兼容推理模型的 `reasoning_content` 缺失）。 */
function extractOpenAIContent(parsed: Record<string, unknown>): string {
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as Record<string, unknown>;
  const message = first.message as Record<string, unknown> | undefined;
  const direct = typeof message?.content === 'string' ? message.content : '';
  if (direct.trim() !== '') return direct.trim();
  // 某些兼容网关把内容放在 text 字段（老的 completions 风格）
  if (typeof first.text === 'string') return first.text.trim();
  return '';
}

/** Anthropic：`content: [{type:'text', text}]`。 */
function extractAnthropicContent(parsed: Record<string, unknown>): string {
  const content = parsed.content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        const item = block as Record<string, unknown>;
        return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
      })
      .join('')
      .trim();
    if (text !== '') return text;
  }
  if (typeof parsed.completion === 'string') return parsed.completion.trim();
  return '';
}
