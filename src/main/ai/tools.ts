/**
 * 她能调用的工具（function calling）。
 *
 * 需求原文："7.3 改成：**若用户提及相关内容，模型会调用相关工具，再把记忆宫殿的内容传回去**"。
 *
 * 也就是说：记忆宫殿（她的"经历记忆"）**不再每轮都塞进提示词**，
 * 而是把它做成一个工具 —— 平时不占上下文，只有用户真的提到相关的事时，
 * 模型才会去"查一下"，我们执行本地检索并把内容回传给它。
 *
 * 三个设计约束：
 * 1. **提示词要教会她"有工具可用"**，否则模型不会主动调（见 `TOOL_HINT`）；
 * 2. 工具执行**只读**、纯本地（不联网、不写盘），失败也只回一句"没查到"，
 *    绝不让工具把一次聊天搞崩（`executeTool` 永不抛）；
 * 3. 参数解析要宽容：模型经常把 `query` 写成对象或漏字段，一律兜底成空串。
 */

import type { LLMToolDefinition, LLMToolResult } from './llm-client';
import type { MemoryNode } from '../../shared/growth-types';
import { formatPalaceRecall, selectPalaceMatches } from '../../shared/memory-recall';

/** 工具名（写死在提示词里，改名字要同时改 `TOOL_HINT`）。 */
export const RECALL_MEMORY_TOOL = 'recall_memory';

/**
 * 工具清单。
 *
 * `description` 用中文：她的人格与上下文全是中文，模型对"什么时候该查"的判断也更准。
 * 参数用 JSON Schema（OpenAI 与 Anthropic 在这一层是同一个写法）。
 */
export const MEMORY_TOOLS: readonly LLMToolDefinition[] = [
  {
    name: RECALL_MEMORY_TOOL,
    description:
      '在她自己的记忆宫殿里检索与查询相关的经历（一起做过的事、里程碑、熬夜赶工、出门旅行、'
      + '她记下的重要时刻）。**只在她需要回忆过去的事实时调用**，例如主人提到"上次""之前"'
      + '"我们说过"或者某个项目/事件的名字。日常寒暄、打招呼、回答当下的事情时不要调用。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要回忆的关键词或那句话（例如"论文""上次熬夜""健身计划"）。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];

/**
 * 追加到 system prompt 的一句话：告诉模型它有工具可用。
 *
 * 为什么必须显式写：不是所有模型看到 `tools` 就会用；而"她从来不查记忆"
 * 与"她查得太频繁"都会毁掉体验，所以提示词要给出**调用时机**。
 */
export const TOOL_HINT = [
  '【可用的工具】',
  `你有一个工具 \`${RECALL_MEMORY_TOOL}(query)\`，可以在你自己的记忆宫殿里查"过去一起经历的事"。`,
  '当主人提到过去的事（"上次""之前""我们说好的""那个项目"）或者你不确定细节时，**先调用它**，再回答；',
  '日常寒暄、回答眼下的事、或者你已经确定答案时，**不要调用**。',
].join('\n');

export interface ToolRunDeps {
  /** 当前的记忆宫殿节点（由 growth 模块提供）。 */
  readonly getPalaceNodes: () => readonly MemoryNode[];
  /** 记账/审计用（她查了什么，写进记忆事件）。 */
  readonly onToolRun?: (info: { readonly name: string; readonly query: string; readonly hits: number }) => void;
}

/** 从模型给的参数里取 `query`（对象/字符串都容忍，取不到就是空串）。 */
export function readQuery(args: unknown): string {
  if (typeof args === 'string') return args.trim().slice(0, 200);
  if (typeof args === 'object' && args !== null) {
    const value = (args as Record<string, unknown>).query;
    if (typeof value === 'string') return value.trim().slice(0, 200);
  }
  return '';
}

/**
 * 执行一次工具调用。**永不抛异常**：任何问题都变成一句可读的工具结果。
 *
 * 未知工具名也返回 ok:false 的结果 —— 有些模型会"发明"工具名，
 * 与其让整轮聊天失败，不如让它知道"这个工具不存在"并改用别的说法。
 */
export function executeTool(
  call: { readonly id: string; readonly name: string; readonly arguments: string },
  deps: ToolRunDeps,
): LLMToolResult {
  if (call.name !== RECALL_MEMORY_TOOL) {
    return {
      toolCallId: call.id,
      name: call.name,
      ok: false,
      content: `没有名为 ${call.name} 的工具。可以用的只有 ${RECALL_MEMORY_TOOL}。`,
    };
  }

  let parsed: unknown = {};
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    parsed = {};
  }
  const query = readQuery(parsed);
  if (query === '') {
    return {
      toolCallId: call.id,
      name: call.name,
      ok: false,
      content: '查询词是空的，什么也没查到。请直接回答，或者换一个更具体的说法再查。',
    };
  }

  try {
    const matches = selectPalaceMatches(deps.getPalaceNodes(), query);
    deps.onToolRun?.({ name: call.name, query, hits: matches.length });
    return { toolCallId: call.id, name: call.name, ok: true, content: formatPalaceRecall(matches) };
  } catch (error) {
    return {
      toolCallId: call.id,
      name: call.name,
      ok: false,
      content: `查记忆的时候出错了（${error instanceof Error ? error.message : '未知原因'}），这次先不查了。`,
    };
  }
}
