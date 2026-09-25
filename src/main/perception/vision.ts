/**
 * 视觉理解（3.1 屏幕感知 / 3.2 OCR 与内容理解 / 3.5 摄像头）。
 *
 * 三件事共用同一条"图像 -> 模型 -> 结构化结果"的链路：
 *
 *   1. `analyzeScene`    周期采样：判断在写代码/读论文/看视频… + 是否私人内容
 *   2. `view`            按需"看屏幕"：OCR / 总结 / 分析报错（3.2 的四个动作）
 *   3. `analyzeCamera`   摄像头一帧：在不在、什么表情、有没有陌生人（3.5）
 *
 * 两条设计原则：
 * - **受控 JSON 输出**：模型只允许从固定词表里选场景（`normalizeScene` 还会兜一层），
 *   否则习惯统计会被自由文本污染；
 * - **宁可保守**：解析失败时返回"other/unknown"，绝不让脏数据进入行为决策。
 *
 * 提示词全部中文：本项目的人格与素材都是中文语境，模型的判断也更稳。
 */

import type { CameraFrameResult, PerceptionViewMode, PerceptionViewResult, SceneKind, ScreenObservation } from '../../shared/perception-types';
import { SCENE_LABELS, isUrlLike, matchesSensitiveKeywords, normalizeScene, normalizeWindowTitle, refineScene, safeHost } from '../../shared/perception';
import type { LLMContentPart } from '../ai/llm-client';
import type { LLMClient } from '../ai/llm-client';
import { LLMError } from '../ai/llm-client';
import type { Logger } from '../../shared/logger';
import { describeError } from '../../shared/errors';

export interface VisionAnalyzerOptions {
  /** 每次调用时取当前的 LLM 客户端（配置热更新后立刻生效）。 */
  readonly getClient: () => LLMClient | null;
  readonly logger: Logger;
  /** 敏感词（第二道闸）。 */
  readonly getSensitiveKeywords: () => readonly string[];
  /** 用户自定义的场景纠正规则（每行 `关键词=场景`）。 */
  readonly getSceneFixes: () => readonly string[];
  /** 是否把完整网址写进观察记录（默认 false = 只存域名）。 */
  readonly storeFullUrl: () => boolean;
  /** 当前最上层窗口（进程名 + 标题）——用于确定性纠正与写进观察记录。 */
  readonly getForegroundWindow: () => { readonly process: string; readonly title: string } | null;
  /** 是否允许做"内容理解"（3.2 的开关）。 */
  readonly isVisionEnabled: () => boolean;
}

export interface SceneAnalysis {
  readonly observation: ScreenObservation;
  /** 模型原样返回的原始文本（调试用，最多 300 字）。 */
  readonly raw: string;
}

const SCENE_LIST = Object.entries(SCENE_LABELS)
  .map(([key, label]) => `${key}(${label})`)
  .join('、');

/** 场景分析的 system prompt（受控词表 + 受控 JSON）。 */
const SCENE_SYSTEM = [
  '你是一个桌面场景分析器。你会看到用户当前的屏幕截图（可能包含代码、文档、网页、视频、游戏）。',
  '请只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码围栏。',
  '字段：',
  `- scene: 只能是这些值之一：${SCENE_LIST}`,
  '- app: 你判断当前正在使用的应用名（尽量短，例如 "VS Code"、"Chrome"、"PDF 阅读器"；判断不出就写 ""）',
  '- activity: 一句话说明用户在做什么（不超过 20 字，中文）',
  '- url: **如果这是一张网页，且你能看清地址栏里的网址，就把它填在这里**（可以只填域名，例如 "github.com"）；看不到、看不清、或者不是网页就填空字符串 ""。**绝对不要猜**。',
  '- browserChrome: 布尔值。画面上是否能看到**浏览器界面**（地址栏、标签页、书签栏、前进后退按钮）',
  '- editorChrome: 布尔值。画面上是否能看到**编辑器界面**（闪烁的文本光标、行号、笔记列表侧栏、格式工具栏）',
  '- sensitive: 布尔值。**如果画面包含明显的私人内容（密码、银行/支付、私信、身份信息、私密照片等）必须为 true**',
  '- focus: "deep"（专注做一件事）或 "shallow"（看起来在频繁切换/分心），不确定写 "unknown"',
  '- suggestion: 如果画面里有明显的报错/失败信息且你能给出简短建议，就用一句话给出（中文，不超过 30 字）；否则为空字符串',
  '',
  '⚠️ 判断 scene 的判据（很重要，请严格按此，不要凭页面内容多不多猜）：',
  '- **在浏览器里看文章、文档、论坛、维基、新闻、GitHub 网页，都是 browsing（浏览网页）**，',
  '  即使页面上有很多文字、看起来像一份文档 —— 只要看不到编辑器界面，就**不是** writing。',
  '- 只有看到**编辑器/笔记软件的界面**（光标、行号、笔记侧栏、格式工具栏），或者明确是 Word/Notion/Obsidian 这类应用，才是 writing。',
  '- 在浏览器里看论文 PDF 属于 reading；看视频/直播属于 video；玩游戏属于 gaming。',
  '- 拿不准时，先用 browserChrome / editorChrome 两个字段描述你**确实看到**的界面，再据此选 scene。',
  '',
  '注意：只描述你**确实看到**的内容，不要猜测用户身份，不要复述敏感信息的具体内容。',
].join('\n');

/** 3.2 的四个按需动作，各自一句话指令。 */
const VIEW_INSTRUCTIONS: Readonly<Record<PerceptionViewMode, string>> = {
  scene: '用一句话说明我现在在做什么（中文，不超过 25 字）。',
  ocr: '把屏幕上的**主要文字**读出来（尽量完整、按原顺序，最多 400 字；不要翻译、不要总结）。',
  summarize: '用 3~5 句中文总结屏幕上的内容要点（如果是论文/文档，就说清主题与结论）。',
  error: '找出屏幕上的报错/异常信息，先用一句话说明是什么错，再给出一句最可能的修复方向（中文，不超过 120 字）。',
  code: '用 3~5 句中文说明这段代码在做什么，并指出任何明显的问题（如果没有问题就说"看起来没问题"）。',
};

export class VisionAnalyzer {
  private readonly options: VisionAnalyzerOptions;
  private readonly logger: Logger;

  public constructor(options: VisionAnalyzerOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /* ------------------------------------------------------------------ */
  /* 3.1 周期场景分析                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * 分析一帧屏幕。
   *
   * @param imageBase64 JPEG 的 base64（不带 data URL 前缀）
   * @param mimeType 整屏图的 MIME
   * @param addressBar 可选的**地址栏横条**（高分辨率小图）——用来让模型读出网址；
   *   传了就作为额外的一张图附在同一次请求里（多几十 token，但换来最可靠的网页线索）
   * @param windowContext 可选的**窗口上下文文本**（最上层窗口 + 打开的窗口列表）——
   *   这是比像素更具体的证据，直接以文本形式给出
   */
  public async analyzeScene(
    imageBase64: string,
    mimeType = 'image/jpeg',
    addressBar?: { readonly dataBase64: string; readonly mimeType: string } | null,
    windowContext?: string | null,
  ): Promise<SceneAnalysis | null> {
    const client = this.options.getClient();
    if (!client) return null;
    const startedAt = Date.now();
    try {
      const parts: LLMContentPart[] = [
        { type: 'text', text: '这是我当前的屏幕，请按约定输出 JSON。' },
        { type: 'image', mimeType, dataBase64: imageBase64 },
      ];
      if (addressBar && addressBar.dataBase64 !== '') {
        parts.push({
          type: 'text',
          text: '刚才那张是整屏。这张是屏幕顶部的地址栏区域（放大了）：如果你能在里面看清网址，请填进 url 字段；看不清就留空，不要猜。',
        });
        parts.push({ type: 'image', mimeType: addressBar.mimeType, dataBase64: addressBar.dataBase64 });
      }
      if (typeof windowContext === 'string' && windowContext.trim() !== '') {
        parts.push({
          type: 'text',
          text: `另外，这是系统层面的窗口信息（比你从像素里猜的更可靠，请优先参考它来判断 app 与 scene）：\n${windowContext}`,
        });
      }
      const result = await client.complete({
        messages: [
          { role: 'system', content: SCENE_SYSTEM },
          { role: 'user', content: parts },
        ],
        temperature: 0.2,
        maxTokens: 360,
      });
      const parsed = parseJsonObject(result.text);
      const keywords = this.options.getSensitiveKeywords();
      const app = stringOr(parsed?.app, '');
      const activity = stringOr(parsed?.activity, '');
      const modelSensitive = parsed?.sensitive === true;
      /*
       * 场景纠正：模型给的 scene 先过一遍确定性规则（纯函数，见 shared/perception.ts 的
       * refineScene）—— 用户实测"浏览网页总被认成笔记软件"，只靠提示词说服模型不稳，
       * 这里按**网址域名 > 应用名 > 界面线索**再纠一次，并允许用户自定义规则兜底。
       */
      const rawUrl = stringOr(parsed?.url, '');
      const urlLike = isUrlLike(rawUrl) ? rawUrl : '';
      const refined = refineScene({
        scene: normalizeScene(parsed?.scene),
        app,
        browserChrome: parsed?.browserChrome === true,
        editorChrome: parsed?.editorChrome === true,
        url: urlLike,
        window: this.options.getForegroundWindow(),
        fixes: this.options.getSceneFixes(),
      });
      if (refined.reason !== '') {
        this.logger.info('scene corrected', {
          data: { from: normalizeScene(parsed?.scene), to: refined.scene, app, url: safeHost(urlLike), reason: refined.reason },
        });
      }
      /*
       * 网址的存储策略：默认**只留域名**（`storeFullUrl` 打开才存完整地址）。
       * 查询串里常有搜索词等私人信息，而分类只需要域名。
       */
      const storedUrl = urlLike === '' ? '' : this.options.storeFullUrl() ? urlLike.slice(0, 300) : safeHost(urlLike);
      const foreground = this.options.getForegroundWindow();
      const observation: ScreenObservation = {
        at: new Date().toISOString(),
        scene: refined.scene,
        app: app.slice(0, 60),
        ...(storedUrl !== '' ? { url: storedUrl } : {}),
        // 只把"最上层窗口"存进观察记录（整份窗口列表只进提示词，不落盘）
        ...(foreground && foreground.title !== '' ? { windowTitle: normalizeWindowTitle(foreground.title).slice(0, 120) } : {}),
        activity: activity.slice(0, 120),
        // 两道闸：模型判定 + 关键词命中。
        // 关键词要扫 **app / activity / 网址 / 最上层窗口标题** —— 窗口标题恰恰是
        // 文档名出现的地方（"工资表.xlsx"），漏掉它就等于漏掉最该拦的一路。
        sensitive:
          modelSensitive ||
          matchesSensitiveKeywords(`${app} ${activity} ${storedUrl} ${foreground?.title ?? ''}`, keywords),
        focus: parsed?.focus === 'deep' || parsed?.focus === 'shallow' ? parsed.focus : 'unknown',
        summary: '',
        suggestion: stringOr(parsed?.suggestion, '').slice(0, 120),
        mode: 'llm',
        tokens: result.totalTokens,
      };
      this.logger.debug('scene analyzed', {
        data: {
          scene: observation.scene,
          app: observation.app,
          sensitive: observation.sensitive,
          elapsedMs: Date.now() - startedAt,
          tokens: result.totalTokens,
        },
      });
      return { observation, raw: result.text.slice(0, 300) };
    } catch (error) {
      const message = error instanceof LLMError ? error.message : describeError(error);
      this.logger.warn('scene analysis failed', { error: message });
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 3.2 按需看屏幕                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * 按需"看屏幕"（3.2 的四个动作）。
   *
   * @param addressBar 可选的地址栏横条：网页上的问题（报错、总结）有了网址会答得更准，
   *   例如"这是 GitHub issue 里的报错"。与整屏一样，用完即弃。
   * @param windowContext 可选的窗口上下文文本（最上层窗口 + 打开的窗口列表）。
   */
  public async view(
    mode: PerceptionViewMode,
    imageBase64: string,
    mimeType = 'image/jpeg',
    addressBar?: { readonly dataBase64: string; readonly mimeType: string } | null,
    windowContext?: string | null,
  ): Promise<PerceptionViewResult> {
    const client = this.options.getClient();
    if (!this.options.isVisionEnabled()) {
      return { ok: false, mode, text: '内容理解开关没打开（设置 → 环境与用户感知 → 内容理解）。', scene: 'other', sensitive: false, tokens: 0, error: 'vision-disabled' };
    }
    if (!client) {
      return { ok: false, mode, text: '我还没接上大模型，看不懂屏幕内容（可以去设置里填密钥）。', scene: 'other', sensitive: false, tokens: 0, error: 'no-llm' };
    }
    try {
      /*
       * ⚠️ parts 的顺序必须与文案一致：**整屏在前、地址栏横条在后**。
       * 早期版本把横条 push 到了整屏之前，而提示词写着"第二张图是地址栏区域"——
       * 模型会把整屏当成地址栏看（文档评审抓到这个不自洽）。
       */
      const parts: LLMContentPart[] = [{ type: 'text', text: VIEW_INSTRUCTIONS[mode] }];
      parts.push({ type: 'image', mimeType, dataBase64: imageBase64 });
      if (addressBar && addressBar.dataBase64 !== '') {
        parts.push({
          type: 'text',
          text: '刚才那张是整屏。这张是屏幕顶部的地址栏区域（放大了）：如果是网页，请结合里面的网址理解这些内容（例如说明是在哪个网站、什么页面）。',
        });
        parts.push({ type: 'image', mimeType: addressBar.mimeType, dataBase64: addressBar.dataBase64 });
      }
      if (typeof windowContext === 'string' && windowContext.trim() !== '') {
        parts.push({ type: 'text', text: `系统层面的窗口信息（比你从像素里猜的更可靠）：\n${windowContext}` });
      }
      const result = await client.complete({
        messages: [
          {
            role: 'system',
            content: [
              '你是一只住在 Windows 桌面上的鲸鱼娘桌宠，正在看主人的屏幕。',
              '用中文回答，语气自然、简短，不要提"作为一个 AI"。',
              '如果画面里包含明显的私人内容（密码/银行/私信/身份信息等），只回复一句"这个是私人的，我不看"，不要复述任何细节。',
            ].join('\n'),
          },
          { role: 'user', content: parts },
        ],
        temperature: 0.3,
        maxTokens: mode === 'ocr' || mode === 'summarize' ? 700 : 400,
      });
      const text = result.text.trim();
      const privateHit = /私人的，我不看/.test(text);
      const scene = await this.quickScene(result.text);
      return {
        ok: true,
        mode,
        text: text.slice(0, 1200),
        scene,
        sensitive: privateHit,
        tokens: result.totalTokens,
        error: '',
      };
    } catch (error) {
      const message = error instanceof LLMError ? error.message : describeError(error);
      this.logger.warn('screen view failed', { error: message, data: { mode } });
      return { ok: false, mode, text: `看屏幕失败了：${message}`, scene: 'other', sensitive: false, tokens: 0, error: message };
    }
  }

  /** 从回答里粗判场景（按需动作没有单独的场景字段，用关键词兜一下）。 */
  private async quickScene(text: string): Promise<SceneKind> {
    const lower = text.toLowerCase();
    if (/报错|error|exception|failed|traceback/.test(lower)) return 'coding';
    if (/论文|参考文献|abstract|pdf/.test(lower)) return 'reading';
    if (/代码|函数|class|import|编译/.test(lower)) return 'coding';
    return 'other';
  }

  /* ------------------------------------------------------------------ */
  /* 3.5 摄像头帧                                                         */
  /* ------------------------------------------------------------------ */

  public async analyzeCamera(imageBase64: string, mimeType = 'image/jpeg'): Promise<CameraFrameResult> {
    const client = this.options.getClient();
    if (!client) {
      // 没有模型时退化为"收到了帧 = 人大概率在"（真正判断交给上层做差分）
      return { ok: false, present: true, expression: '', stranger: false, posture: '', mode: 'local', error: 'no-llm' };
    }
    try {
      const result = await client.complete({
        messages: [
          {
            role: 'system',
            content: [
              '你在看摄像头的一帧画面，用于桌面宠物的在场感知。只输出 JSON，不要解释。',
              '字段：present(布尔，画面里是否有人)、expression(中文，最多 6 字，例如"专注""疲惫""微笑"；看不清就写"")、',
              'stranger(布尔，画面里的人是否看起来**不是**常用用户；完全无法判断时写 false)、posture(中文，最多 8 字，例如"坐着""站着""离开了")。',
              '只描述可见特征，不要推测身份、性别、年龄、种族等敏感属性。',
            ].join('\n'),
          },
          { role: 'user', content: [{ type: 'text', text: '分析这一帧。' }, { type: 'image', mimeType, dataBase64: imageBase64 }] },
        ],
        temperature: 0.1,
        maxTokens: 160,
      });
      const parsed = parseJsonObject(result.text);
      return {
        ok: true,
        present: parsed?.present !== false,
        expression: stringOr(parsed?.expression, '').slice(0, 12),
        stranger: parsed?.stranger === true,
        posture: stringOr(parsed?.posture, '').slice(0, 16),
        mode: 'llm',
        error: '',
      };
    } catch (error) {
      const message = error instanceof LLMError ? error.message : describeError(error);
      this.logger.warn('camera frame analysis failed', { error: message });
      return { ok: false, present: true, expression: '', stranger: false, posture: '', mode: 'llm', error: message };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 解析辅助                                                                    */
/* -------------------------------------------------------------------------- */

/** 宽松解析 JSON 对象：容忍代码围栏与前后闲聊。 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = typeof raw === 'string' ? raw : '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}
