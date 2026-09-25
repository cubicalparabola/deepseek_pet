/**
 * 视觉理解（3.1 屏幕感知 / 3.2 按需看屏幕 / 3.5 摄像头）。
 *
 * 三件事共用同一条"图像 -> 模型 -> 结构化结果"的链路：
 *
 *   1. `analyzeScene`    周期采样：判断在写代码/读论文/看视频… + 是否私人内容
 *   2. `view`            按需"看屏幕"：一句话说明用户在做什么（3.2 只保留场景这一件事）
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
import {
  SCENE_LABELS,
  UNREADABLE_VIEW_TEXT,
  gateUnreadableContent,
  isUrlLike,
  matchesSensitiveKeywords,
  normalizeScene,
  normalizeWindowTitle,
  refineScene,
  safeHost,
} from '../../shared/perception';
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
  '- contentReadable: 布尔值。**只有当你真的能逐字读出画面里的文字**（终端里具体的命令与输出、编辑器里具体的代码行、网页或文档里的正文）时才为 true；字太小、模糊、或者只是"看起来像代码/像文档"，一律 false。',
  '- activity: 一句话说明用户在做什么（不超过 20 字，中文）。**contentReadable 为 false 时不许写具体内容**（不要写"在跑 npm test"这种），只写活动类型（如 "在用命令行"、"在看网页"、"在写东西"）；连类型都不确定就写 ""。',
  '- url: **如果这是一张网页，且你能看清地址栏里的网址，就把它填在这里**（可以只填域名，例如 "github.com"）；看不到、看不清、或者不是网页就填空字符串 ""。**绝对不要猜**。',
  '- browserChrome: 布尔值。画面上是否能看到**浏览器界面**（地址栏、标签页、书签栏、前进后退按钮）',
  '- editorChrome: 布尔值。画面上是否能看到**编辑器界面**（闪烁的文本光标、行号、笔记列表侧栏、格式工具栏）',
  '- sensitive: 布尔值。**如果画面包含明显的私人内容（密码、银行/支付、私信、身份信息、私密照片等）必须为 true**',
  '- focus: "deep"（专注做一件事）或 "shallow"（看起来在频繁切换/分心），不确定写 "unknown"',
  '- suggestion: **只有 contentReadable 为 true 且你确实看清了报错/失败信息**时才给一句建议（中文，不超过 30 字）；读不清、或者没看到报错，一律空字符串 ""',
  '',
  '⚠️ 判断 scene 的判据（很重要，请严格按此，不要凭页面内容多不多猜）：',
  '- **在浏览器里看文章、文档、论坛、维基、新闻、GitHub 网页，都是 browsing（浏览网页）**，',
  '  即使页面上有很多文字、看起来像一份文档 —— 只要看不到编辑器界面，就**不是** writing。',
  '- 只有看到**编辑器/笔记软件的界面**（光标、行号、笔记侧栏、格式工具栏），或者明确是 Word/Notion/Obsidian 这类应用，才是 writing。',
  '- 在浏览器里看论文 PDF 属于 reading；看视频/直播属于 video；玩游戏属于 gaming。',
  '- 拿不准时，先用 browserChrome / editorChrome 两个字段描述你**确实看到**的界面，再据此选 scene。',
  '',
  '⚠️ **看不清就不许猜（用户明确要求）**：',
  '- 终端、命令行、日志这类画面最容易骗人 —— "黑底白字、有光标"**不足以**说明在写代码或在跑什么命令。',
  '- 你**看不见**具体命令与输出时：`contentReadable` 必须为 false，`activity` 只能写活动类型，`suggestion` 留空。',
  '- 宁可少说，也不要编；猜错比不说更让人失望。',
  '',
  '注意：只描述你**确实看到**的内容，不要猜测用户身份，不要复述敏感信息的具体内容；',
  '也不要把画面里的原文抄进任何字段（命令、路径、代码、网址查询串、密钥一律不要抄），用一句话概括即可。',
].join('\n');

/** 3.2 唯一保留的按需动作：场景。 */
const VIEW_SCENE_INSTRUCTION = '看看我这会儿在做什么，按约定的 JSON 输出。';

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
   * @param closeUp 可选的**最上层窗口特写**（按原分辨率截的那块窗口画面）——
   *   终端/编辑器里的文字靠它才读得清，`contentReadable` 也主要看它
   */
  public async analyzeScene(
    imageBase64: string,
    mimeType = 'image/jpeg',
    addressBar?: { readonly dataBase64: string; readonly mimeType: string } | null,
    windowContext?: string | null,
    closeUp?: { readonly dataBase64: string; readonly mimeType: string } | null,
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
      /*
       * 窗口特写放在**最后**：前面的文案都在描述"整屏"与"地址栏横条"，
       * 这张图是额外的、分辨率最高的一块，说明文字必须紧挨着它出现，
       * 否则模型会把顺序搞混（早期地址栏横条就是这么踩过一次）。
       */
      if (closeUp && closeUp.dataBase64 !== '') {
        parts.push({
          type: 'text',
          text: '最后这张是**最上层窗口的特写**（按原分辨率截取的窗口区域，最清楚）：判断"用户在做什么、画面里写了什么"时**以它为准**。如果连它也看不清文字，就把 contentReadable 设为 false，并且不要猜内容。',
        });
        parts.push({ type: 'image', mimeType: closeUp.mimeType, dataBase64: closeUp.dataBase64 });
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
       * 「看不清就不许回答内容」——**代码侧硬约束**，不只靠提示词。
       *
       * `contentReadable` 是模型自报的"我看清了吗"。它经常一边说看不清、一边又写
       * "在跑 npm run acceptance" 这种具体内容；那句话会进观察记录、进日志、甚至触发
       * 主动开口。所以这里在落盘之前把 activity / suggestion 清掉（见 gateUnreadableContent）。
       */
      const readable = parsed?.contentReadable === true;
      const gated = gateUnreadableContent({ readable, activity, suggestion: stringOr(parsed?.suggestion, '') });
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
        activity: gated.activity,
        // 两道闸：模型判定 + 关键词命中。
        // 关键词要扫 **app / activity / 网址 / 最上层窗口标题** —— 窗口标题恰恰是
        // 文档名出现的地方（"工资表.xlsx"），漏掉它就等于漏掉最该拦的一路。
        sensitive:
          modelSensitive ||
          matchesSensitiveKeywords(`${app} ${activity} ${storedUrl} ${foreground?.title ?? ''}`, keywords),
        readable,
        focus: parsed?.focus === 'deep' || parsed?.focus === 'shallow' ? parsed.focus : 'unknown',
        summary: '',
        suggestion: gated.suggestion,
        mode: 'llm',
        tokens: result.totalTokens,
      };
      this.logger.debug('scene analyzed', {
        data: {
          scene: observation.scene,
          app: observation.app,
          sensitive: observation.sensitive,
          readable,
          closeUp: closeUp !== undefined && closeUp !== null && closeUp.dataBase64 !== '',
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
   * 按需"看屏幕"：一句话说明用户现在在做什么（3.2 唯一保留的动作）。
   *
   * ⚠️ **返回的是 JSON**（`{readable, answer}`），不再是自由文本：这是"看不清就不许
   * 回答内容"的落点 —— 模型必须显式声明它有没有真的看清；说没看清（或者干脆没按
   * 契约返回 JSON）时，回答会被换成一句兜底话（见 `UNREADABLE_VIEW_TEXT`），
   * 而不是让它顺着"看起来像代码"编一句。
   *
   * @param addressBar 可选的地址栏横条：有了网址，"在哪个网站做什么"会答得更准。
   *   与整屏一样，用完即弃。
   * @param windowContext 可选的窗口上下文文本（最上层窗口 + 打开的窗口列表）。
   * @param closeUp 可选的窗口特写（原分辨率那块窗口画面）——终端文字靠它才读得清。
   */
  public async view(
    mode: PerceptionViewMode,
    imageBase64: string,
    mimeType = 'image/jpeg',
    addressBar?: { readonly dataBase64: string; readonly mimeType: string } | null,
    windowContext?: string | null,
    closeUp?: { readonly dataBase64: string; readonly mimeType: string } | null,
  ): Promise<PerceptionViewResult> {
    const client = this.options.getClient();
    if (!client) {
      return { ok: false, mode, text: '我还没接上大模型，看不懂屏幕内容（可以去设置里填密钥）。', scene: 'other', sensitive: false, tokens: 0, error: 'no-llm' };
    }
    try {
      /*
       * ⚠️ parts 的顺序必须与文案一致：**整屏在前、地址栏横条在后、窗口特写最后**。
       * 早期版本把横条 push 到了整屏之前，而提示词写着"第二张图是地址栏区域"——
       * 模型会把整屏当成地址栏看（文档评审抓到这个不自洽）。
       */
      const parts: LLMContentPart[] = [{ type: 'text', text: VIEW_SCENE_INSTRUCTION }];
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
      if (closeUp && closeUp.dataBase64 !== '') {
        parts.push({
          type: 'text',
          text: '最后这张是**最上层窗口的特写**（按原分辨率截的，最清楚）：你"看清了什么"以它为准；如果连它也看不清，就老实说看不清。',
        });
        parts.push({ type: 'image', mimeType: closeUp.mimeType, dataBase64: closeUp.dataBase64 });
      }
      const result = await client.complete({
        messages: [
          {
            role: 'system',
            content: [
              '你是一只住在 Windows 桌面上的鲸鱼娘桌宠，正在看主人的屏幕。',
              '用中文回答，语气自然、简短，不要提"作为一个 AI"。',
              '**只输出一个 JSON 对象**（不要解释、不要 Markdown 围栏），字段只有两个：',
              '  · readable: 布尔值。**只有当你真的能看清屏幕上的文字**（终端里的命令与输出、编辑器里的代码、文档正文）时才为 true；字太小、模糊、只看出"像是代码"一律 false。',
              '  · answer: 一句话（中文，不超过 25 字）。readable 为 true 时正常回答；readable 为 false 时**只说你能确定的东西**（例如"你在用命令行"），连这都不确定就写 ""。',
              '**绝对不要猜内容**：看不见的东西不许编（尤其别编终端里在跑什么命令）；宁可少说。',
              '不要抄录画面里的原文（命令、路径、代码、网址查询串、密钥），用一句话概括。',
              '如果画面里包含明显的私人内容（密码/银行/私信/身份信息等），answer 只写"这个是私人的，我不看"，不要复述任何细节。',
            ].join('\n'),
          },
          { role: 'user', content: parts },
        ],
        temperature: 0.3,
        maxTokens: 400,
      });
      const text = result.text.trim();
      const privateHit = /私人的，我不看/.test(text);
      const parsed = parseJsonObject(text);
      const readable = parsed?.readable === true;
      const answer = parsed ? stringOr(parsed.answer, '').trim() : '';
      /*
       * 兜底两种"没资格回答内容"的情况：
       * ① 模型说自己没看清（readable=false）；
       * ② 它连 JSON 契约都没遵守（解析不出来）—— 那我们就无从知道它看清没有，
       *    按"没看清"处理。宁可让她说一句"看不清"，也不要放一句可能编出来的话出去。
       */
      const finalText = readable && answer !== '' ? answer : UNREADABLE_VIEW_TEXT;
      if (parsed === null) {
        this.logger.warn('view answer was not JSON; falling back to unreadable hedge', {
          data: { length: text.length },
        });
      }
      const scene = this.quickScene(readable ? answer : '');
      return {
        ok: true,
        mode,
        text: finalText.slice(0, 1200),
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

  /**
   * 从那句回答里粗判场景。
   *
   * 「看我在做什么」只要一句人话（进气泡），不返回受控的场景字段，
   * 所以这里用关键词兜一个 `SceneKind` 出来 —— 它只用来挑动画，
   * 影响很小（真正的场景分类走 `analyzeScene` 的受控词表）。
   * 读不清时调用方传空串进来，结果就是 `other`。
   */
  private quickScene(text: string): SceneKind {
    const lower = text.toLowerCase();
    if (/报错|error|exception|failed|traceback/.test(lower)) return 'coding';
    if (/论文|参考文献|abstract|pdf/.test(lower)) return 'reading';
    if (/视频|直播|bilibili|youtube|番剧/.test(lower)) return 'video';
    if (/游戏|game|steam/.test(lower)) return 'gaming';
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
