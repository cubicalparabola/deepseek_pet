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
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export interface LLMMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LLMCompletionRequest {
  readonly messages: readonly LLMMessage[];
  /** 覆盖配置里的采样温度。 */
  readonly temperature?: number;
  /** 覆盖配置里的最大 token。 */
  readonly maxTokens?: number;
  /** 覆盖配置里的超时。 */
  readonly timeoutMs?: number;
}

export interface LLMCompletionResult {
  readonly text: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly model: string;
  readonly latencyMs: number;
}

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

export class LLMClient {
  private config: AIProviderConfig;
  private readonly logger: Logger;

  public constructor(config: AIProviderConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
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
   */
  public async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const config = this.config;
    if (config.apiKey.trim() === '') {
      throw new LLMError('NO_KEY', '未配置 API Key');
    }

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
        },
      });
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
    const body = {
      model: this.config.model,
      messages: request.messages,
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxTokens ?? this.config.maxTokens,
      stream: false,
    };

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

    const content = extractOpenAIContent(parsed);
    if (content === '') throw new LLMError('EMPTY', '模型返回了空内容');
    const usage = (parsed.usage ?? {}) as Record<string, unknown>;
    const promptTokens = numberOr(usage.prompt_tokens, 0);
    const completionTokens = numberOr(usage.completion_tokens, 0);
    return {
      text: content,
      promptTokens,
      completionTokens,
      totalTokens: numberOr(usage.total_tokens, promptTokens + completionTokens),
      model: typeof parsed.model === 'string' ? parsed.model : this.config.model,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Anthropic（/v1/messages）                                            */
  /* ------------------------------------------------------------------ */

  private async callAnthropic(
    url: string,
    request: LLMCompletionRequest,
    controller: AbortController,
  ): Promise<Omit<LLMCompletionResult, 'latencyMs'>> {
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const chat = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));

    const body = {
      model: this.config.model,
      system,
      messages: chat,
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxTokens ?? this.config.maxTokens,
    };

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

    const content = extractAnthropicContent(parsed);
    if (content === '') throw new LLMError('EMPTY', '模型返回了空内容');
    const usage = (parsed.usage ?? {}) as Record<string, unknown>;
    const promptTokens = numberOr(usage.input_tokens, 0);
    const completionTokens = numberOr(usage.output_tokens, 0);
    return {
      text: content,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      model: typeof parsed.model === 'string' ? parsed.model : this.config.model,
    };
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
/* 解析辅助（各家返回结构略有差异，这里做宽松解析）                                */
/* -------------------------------------------------------------------------- */

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
