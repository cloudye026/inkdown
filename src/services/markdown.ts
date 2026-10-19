import DOMPurify from "dompurify";
import { marked, Renderer, type Token, type Tokens } from "marked";
import {
  attachHeadingLines,
  escapeHtml,
  normalizeListMarkers,
  renderMath,
  scanHeadings,
  type HeadingHit,
} from "./mdcore";
import { fingerprint } from "./blockCache";
import { assetUrl } from "./fs";

export { escapeHtml, scanHeadings, stripTags } from "./mdcore";
export type { HeadingHit };

/** marked 渲染器里 this 上我们用到的部分（marked 未导出这个类型） */
interface MarkedThis {
  parser: {
    parseInline: (tokens: Token[]) => string;
    parse: (tokens: Token[], top?: boolean) => string;
  };
}

/**
 * marked 内置的 listitem 渲染器。
 * 必须复用它而不是自己拼 —— 它负责把 checkbox 插进列表项内容里。
 */
const builtinListitem = Renderer.prototype.listitem as (
  this: unknown,
  token: Tokens.ListItem,
) => string;

export interface OutlineItemLite {
  level: number;
  text: string;
  line: number;
}

export interface RenderResult {
  html: string;
  outline: OutlineItemLite[];
}

export interface RenderOptions {
  /** 当前文档所在目录（绝对路径），用于解析相对图片 */
  docDir: string | null;
  /** true 时单换行也断行（中文写作习惯「一段一行」） */
  breakOnSingleNewline: boolean;
}

// --------------------------------------------------------------- 工具

/**
 * 标题 id 的生成：**基于内容**，同一份文档内去重。
 *
 * 不能用全局递增计数器（早期实现是 `mdd-${++uid}`）：那样每次渲染 id 都会变，
 * 带来两个真实后果——
 *   1. 预览的**增量更新永远失效**：第一块就不同，公共前缀恒为 0，
 *      等于每次仍然整棵重建（实测 19–33ms，跑在输入路径上）；
 *   2. 预览里的**锚点链接在每次重渲染后失效**，因为 id 变了。
 *
 * 现在同一份内容永远得到同一个 id，也让 `#标题` 这类站内链接可以稳定跳转。
 */
function makeSlugger() {
  const used = new Map<string, number>();
  return (text: string): string => {
    const base =
      text
        .trim()
        .toLowerCase()
        .replace(/[\s]+/g, "-")
        .replace(/[^\p{L}\p{N}\-_]/gu, "") || "section";
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    // 重复标题才加后缀，且后缀只取决于"它在这份文档里出现第几次"
    return seen === 0 ? `h-${base}` : `h-${base}-${seen + 1}`;
  };
}

// --------------------------------------------------------------- 标题目录（见 mdcore.ts）

// --------------------------------------------------------------- 主渲染

let rendererConfigured = false;

/**
 * **这一次**渲染要用的选项。
 *
 * 渲染器只在第一次调用时注册一次（每次按键都重建 renderer 对象没必要），
 * 但 `docDir` 是**每份文档都不同**的。之前把 `opts` 直接闭包进渲染器，
 * 于是永远沿用**第一次渲染**那份文档的目录：
 *   - 打开第二份文档后，里面的相对路径图片会按第一份文档的目录解析；
 *   - 更糟的是首次渲染若发生在 `docDir` 还是 null 的时候（比如启动时的欢迎页），
 *     相对路径图片就**永远**解析不出来，`src` 原样留着 `docs/logo.png`。
 * 所以选项放到模块变量里，渲染器在**调用时**读取。
 */
let currentOptions: RenderOptions = { docDir: null, breakOnSingleNewline: true };

/** 当前这一次渲染使用的标题 id 生成器（每次渲染重建，保证同内容同 id） */
let activeSlugger: (text: string) => string = makeSlugger();

/**
 * 渲染器里的 this 是 marked 内部对象，TS 类型没有导出。
 * 用一次性 cast 取出 parser，调用点就不必反复处理 this 类型。
 */
function parserOf(self: unknown): MarkedThis["parser"] {
  return (self as MarkedThis).parser;
}

function configureRenderer(opts: RenderOptions): void {
  marked.use({
    gfm: true,
    breaks: opts.breakOnSingleNewline,
    pedantic: false,
  });

  marked.use({
    renderer: {
      // 代码块：这里只输出占位标记，真正的 Shiki / Mermaid 渲染在异步后处理里做。
      // `data-fp` 是内容指纹：内容没变时后处理阶段会直接复用上次的渲染结果，
      // 避免一边打字一边重画所有图表（mermaid.render 很贵）。
      code(token: Tokens.Code): string {
        const lang = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
        const body = escapeHtml(token.text);
        const fp = fingerprint(`${lang}\u0000${token.text}`);
        if (lang.toLowerCase() === "mermaid") {
          return `<div class="mermaid-src" data-lang="mermaid" data-fp="${fp}">${body}</div>`;
        }
        return (
          `<pre class="code-block" data-lang="${escapeHtml(lang)}" data-fp="${fp}">` +
          `<code class="language-${escapeHtml(lang)}">${body}</code></pre>`
        );
      },
      // 标题：加稳定的 id 便于目录跳转与锚点链接，data-line 在下面统一贴
      heading(this: unknown, token: Tokens.Heading): string {
        const id = activeSlugger(token.text);
        const inner = parserOf(this).parseInline(token.tokens);
        return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
      },
      image(token: Tokens.Image): string {
        // 读**当前**这次渲染的 docDir，不是注册渲染器时的那份
        const src = resolveImageSrc(token.href, currentOptions.docDir);
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}"${title} loading="lazy">`;
      },
      // 任务列表的勾选框。
      // marked 15 起 checkbox 由独立 renderer 生成（listitem 内部调用 this.checkbox），
      // 这里显式实现，勾选状态与禁用状态都自己控制。
      checkbox(token: Tokens.Checkbox): string {
        const cb = token as Tokens.Checkbox & { checked?: boolean; disabled?: boolean };
        const checked = cb.checked ? ' checked=""' : "";
        const disabled = cb.disabled === false ? "" : ' disabled=""';
        return `<input${checked}${disabled} type="checkbox">`;
      },
      // 任务列表项：委托给 marked 内置实现，只补一个 class。
      //
      // 不能自己写 `parser.parse(token.tokens)` —— marked 15 的 checkbox 是在
      // listitem 内部拼进 itemBody 的（还分 loose / 段落首 token 等情况），
      // 绕过它勾选框就会静默消失。委托 + 覆盖 checkbox 才是稳的写法。
      listitem(this: unknown, token: Tokens.ListItem): string {
        const inner = builtinListitem.call(this, token);
        return token.task
          ? inner.replace(/^<li>/, '<li class="task-list-item">')
          : inner;
      },
      link(this: unknown, token: Tokens.Link): string {
        const { href } = token;
        const external = /^(https?:)?\/\//i.test(href);
        const attrs = external ? ' target="_blank" rel="noreferrer noopener"' : "";
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        const inner = parserOf(this).parseInline(token.tokens);
        return `<a href="${escapeHtml(href)}"${title}${attrs}>${inner}</a>`;
      },
    },
  });
  rendererConfigured = true;
}

/**
 * 本地图片走 Tauri 的 asset 协议；网络图与 data URI 原样保留。
 * 相对路径以**文档所在目录**为基准——md 里写 `./img/a.png` 是最常见写法。
 *
 * 交给 assetUrl（内部用 Tauri 的 convertFileSrc）：
 *   Windows 是 `http://asset.localhost/…`，macOS/Linux 是 `asset://localhost/…`。
 * 硬编码前者会让 macOS 上的本地图片全部加载失败。
 */
function resolveImageSrc(href: string, docDir: string | null): string {
  if (/^(https?:|data:|blob:|asset:|file:)/i.test(href)) return href;
  if (!docDir) return href;
  const cleaned = href.replace(/^\.\//, "").replace(/\//g, sepOf(docDir));
  // 绝对路径（`/x/y.png`、`C:\x\y.png`）直接用；其余按文档目录拼接
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(cleaned) || cleaned.startsWith("/");
  const abs = isAbsolute ? cleaned : `${docDir.replace(/[\\/]+$/, "")}${sepOf(docDir)}${cleaned}`;
  return assetUrl(abs);
}

/** 目录使用的分隔符风格 */
function sepOf(dir: string): string {
  return dir.includes("\\") ? "\\" : "/";
}

/**
 * 把**原始 HTML 里**的 `<img src>` 也解析成 asset URL。
 *
 * marked 的 `image()` 渲染器只处理 `![]()` 语法；手写的
 * `<img src="docs/logo.png" width="120">` 是原始 HTML，**完全不经过渲染器**，
 * 相对路径会原样留在 DOM 里。
 *
 * 后果：同样的文件在 GitHub 上是好的（浏览器按文档 URL 解析相对路径），
 * 在应用里却是碎图 —— 因为 Tauri 里文档是 `http://tauri.localhost/`，
 * 相对路径指不到磁盘上的文件。用 HTML 排版（居中的 logo、截图）必然会踩到。
 *
 * 只改 `<img>` 标签内的 `src` 属性，且此时 HTML 已消毒：
 * 属性值里的 `"` 已被转义成 `&quot;`，所以按 `src="..."` 取值是安全的。
 */
function resolveHtmlImages(html: string, docDir: string | null): string {
  if (!docDir) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) =>
    tag.replace(/\bsrc="([^"]*)"/i, (_m, src: string) => {
      const fixed = resolveImageSrc(src.replace(/&amp;/g, "&"), docDir);
      return `src="${escapeHtml(fixed)}"`;
    }),
  );
}

/**
 * 同步部分：markdown → 已消毒的 HTML。
 * 异步的语法高亮 / Mermaid 由 previewRender.ts 在这之后接管。
 */
export function renderMarkdown(src: string, opts: RenderOptions): RenderResult {
  // 每份文档的目录都可能不同：必须在解析前更新，渲染器调用时读它
  currentOptions = opts;

  if (!rendererConfigured) configureRenderer(opts);
  else
    marked.use({
      gfm: true,
      breaks: opts.breakOnSingleNewline,
    });

  // 每次渲染重置标题 id 生成器：同一份内容必须得到同一组 id，
  // 否则预览的增量更新会失效、锚点链接也会在重渲染后断掉。
  activeSlugger = makeSlugger();

  // 先把 `8.内容` 这类"编号标记后缺空格"补成 `8. 内容`。
  // CommonMark 认前者、marked 不认，不补的话列表项会掉出去变成段落或代码块。
  // 注意：标题行号要基于**原始源码**计算，所以这里只影响传给 marked 的副本。
  const normalized = normalizeListMarkers(src).text;

  const raw = marked.parse(normalized, { async: false }) as string;

  // 消毒必须在**公式渲染之前**。
  //
  // KaTeX 的输出带大量 MathML，实测把 HTML 从 4.1 KB 撑到 17 KB（4.1 倍）。
  // 让 DOMPurify 去解析这堆 MathML 会从 8.7ms 涨到 24ms——而这段代码跑在
  // 每次输入的路径上，直接表现就是打字卡顿、抖动。
  //
  // 调换顺序后：先消毒小 HTML（~9ms），再做纯字符串替换插入公式（~3.5ms）。
  // 而且这样**更安全**：外部 HTML 只在消毒时过一遍，MathML 也不需要进白名单了
  // （KaTeX 的输出由我们自己生成，不含用户 HTML）。
  const clean = DOMPurify.sanitize(raw, {
    // 注意：没有放开 DOMPurify 默认允许的 style —— 保留 style 等于允许 CSS 注入
    // （position:fixed 就能盖住整个界面做钓鱼）。Shiki 的颜色靠 class，
    // KaTeX 的排版靠自带样式表，都不需要行内 style。
    ADD_ATTR: [
      "target",
      "rel",
      "loading",
      "class",
      "data-lang",
      "id",
      "align",
      // 任务列表的 checkbox：一旦漏掉 type，勾选框就会退化成裸 input 直接消失；
      // disabled 也要留着，否则预览里的勾选框可以被误点（点完不落盘更困惑）
      "type",
      "checked",
      "disabled",
      // 表格排版
      "colspan",
      "rowspan",
    ],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "style"],
    ALLOW_DATA_ATTR: true,
    // DOMPurify 默认只允许 http/https/mailto 等协议，**不含 `asset:`**。
    // 而 Tauri 在 macOS / Linux 上给本地文件用的就是 `asset://localhost/…`，
    // 不在白名单里就会被整条 `src` 删掉 —— 表现为"macOS 上预览里的本地图片全部不显示"。
    // 这里在默认规则的基础上补上 asset。
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel|callto|sms|cid|xmpp|asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });

  // 消毒之后再做公式渲染（纯字符串替换，产物可信）
  const withMath = renderMath(clean);

  // 原始 HTML 里的 `<img src>` 也要按文档目录解析（marked 的 image() 只管 ![]()），
  // 否则用 HTML 排版的居中图片在预览里全是碎图。放在消毒之后：
  // 此时属性已规范化、危险协议已被剥离。
  const withImages = resolveHtmlImages(withMath, opts.docDir);

  // 把源码行号贴到标题上，供滚动同步使用
  const headings: HeadingHit[] = scanHeadings(src);
  const html = attachHeadingLines(withImages, headings);

  return {
    html,
    outline: headings.map((h) => ({ level: h.level, text: h.text, line: h.line })),
  };
}

/** 供预览增强阶段生成唯一 DOM id 使用 */
export function newBlockId(prefix = "mdd"): string {
  return `${prefix}-${++blockSeq}`;
}

let blockSeq = 0;
