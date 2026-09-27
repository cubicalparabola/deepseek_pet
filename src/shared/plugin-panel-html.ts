/**
 * 插件面板 HTML 净化（只允许"数据展示 + 两个声明式交互"）。
 *
 * 为什么需要净化：插件面板渲染在聊天窗口里（一个有历史、有输入框的真实窗口），
 * 而面板 HTML 往往来自插件拼出来的字符串 —— 其中可能夹着它刚从网上取回的
 * 远程内容（新闻标题、论文摘要、GitHub issue 正文）。插件本身是本机受信任的代码，
 * 但**远程内容不是**，所以入口这一层必须把能力面砍到最小。
 *
 * 净化后的面板只保留：
 * - 一组展示型标签（div/span/table/ul/img…）；
 * - `data-plugin-action="id"`（点击 -> 回传给插件）；
 * - `data-plugin-field="name"`（输入控件 -> 值随动作一起回传）；
 * - `data-plugin-value="..."`（按钮随身带的值，省掉一个隐藏输入框）；
 * - `class` / `style`（内联样式，用于进度条这类展示；`url()` 与 `expression` 被剔除）。
 *
 * 一律剔除：`<script>` / `<iframe>` / `<object>` / `<link>` / `<form>` 等，
 * 全部 `on*` 事件属性，非 `data:` 的图片源，非 `http(s):` 的链接，
 * 以及 `id` / `for`（避免插件面板改变聊天窗口自身的 DOM 结构）。
 *
 * 注意：真正的第二道保险是聊天窗口的 CSP —— `script-src 'self'`，
 * 因此即使净化漏了什么，内联脚本与 `onclick=` 也不会被执行。
 */

/** 允许出现的标签（展示型 + 交互所需的最小集合）。 */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'a', 'b', 'blockquote', 'br', 'button', 'caption', 'code', 'dd', 'del', 'details', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'i', 'img', 'input', 'kbd', 'label', 'li', 'mark', 'ol', 'option', 'p',
  'pre', 's', 'section', 'select', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul',
]);

/** 允许保留的属性（其余一律剔除）。 */
const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  'alt', 'checked', 'class', 'colspan', 'datetime', 'disabled', 'height', 'href', 'label',
  'max', 'min', 'multiple', 'open', 'placeholder', 'readonly', 'rowspan', 'selected', 'size',
  'src', 'start', 'step', 'style', 'summary', 'title', 'type', 'value', 'width',
]);

/** 交互属性（净化必须原样保留，否则面板就点不动了）。 */
export const PANEL_ACTION_ATTR = 'data-plugin-action';
export const PANEL_FIELD_ATTR = 'data-plugin-field';
export const PANEL_VALUE_ATTR = 'data-plugin-value';

/** 面板里点一个 `<a href>` 时宿主代为处理的保留动作（走 `system.openExternal`）。 */
export const PANEL_OPEN_LINK_ACTION = '@open-external';

/** 单个面板 HTML 的上限（超出直接截断，避免一个插件把聊天窗口卡死）。 */
export const MAX_PANEL_HTML_BYTES = 256 * 1024;

const SAFE_STYLE_PATTERN = /^(?!.*(?:url\s*\(|expression\s*\(|@import|behavior\s*:|\\))[\s\S]*$/i;
const SAFE_IMAGE_SRC = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i;
const SAFE_LINK_HREF = /^https?:\/\/[^\s"'<>]+$/i;

/**
 * 净化一段插件面板 HTML，返回可直接 `innerHTML` 的字符串。
 *
 * 需要 DOM（聊天窗口渲染进程里有）；解析失败时返回空串 —— 宁可面板空白，
 * 也不要"净化失败就把原样塞进页面"。
 */
export function sanitizePluginHtml(html: string): string {
  if (typeof html !== 'string' || html.trim() === '') return '';
  const source = html.length > MAX_PANEL_HTML_BYTES ? html.slice(0, MAX_PANEL_HTML_BYTES) : html;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(`<body>${source}</body>`, 'text/html');
  } catch {
    return '';
  }
  const body = doc.body;
  if (!body) return '';
  sanitizeChildren(body);
  return body.innerHTML;
}

function sanitizeChildren(parent: Element): void {
  const children = [...parent.children];
  for (const child of children) {
    const tag = child.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      // 危险标签连同内容一起丢掉（script 的文本没有任何展示价值）
      child.remove();
      continue;
    }
    sanitizeAttributes(child, tag);
    sanitizeChildren(child);
  }
}

function sanitizeAttributes(element: Element, tag: string): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    const isInteraction = name === PANEL_ACTION_ATTR || name === PANEL_FIELD_ATTR || name === PANEL_VALUE_ATTR;
    if (isInteraction) {
      // 交互属性是纯标识串：限制长度并去掉引号，避免拼进 HTML 时二次注入
      element.setAttribute(name, value.replace(/["'<>`]/g, '').slice(0, 120));
      continue;
    }
    if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) {
      element.removeAttribute(attribute.name);
      continue;
    }
    switch (name) {
      case 'style':
        if (!SAFE_STYLE_PATTERN.test(value)) element.removeAttribute(attribute.name);
        break;
      case 'src':
        if (tag !== 'img' || !SAFE_IMAGE_SRC.test(value.trim())) element.removeAttribute(attribute.name);
        break;
      case 'href':
        if (tag !== 'a' || !SAFE_LINK_HREF.test(value.trim())) element.removeAttribute(attribute.name);
        break;
      default:
        break;
    }
  }
}
