/**
 * 纯逻辑层：不依赖 DOM、不依赖 marked，因此可以在 Node 里直接跑单测。
 * 这些函数是最容易出错、也最需要回归保护的部分（数学公式误判、标题行号偏移）。
 */
import katex from "katex";

export interface HeadingHit {
  level: number;
  text: string;
  line: number;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 仅取纯文本，避免把用户原始 HTML 塞进 KaTeX 的错误输出里 */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

const MATH_BLOCK = /\$\$([\s\S]+?)\$\$/g;
const MATH_INLINE = /(^|[^\\$])\$([^\n$]+?)\$(?!\$)/g;

/**
 * 判断一段 `$...$` 里的内容该不该当公式。
 * 目的是挡掉「$100」「$ 5 」这类价格/普通文本，它们不是公式。
 */
export function looksLikeMath(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (/^\d+(\.\d+)?$/.test(t)) return false; // 纯数字 → 价格
  if (/\s/.test(t) && !/[\\^_{}=]/.test(t)) return false; // 带空格的普通短语
  if (/^[a-zA-Z]$/.test(t)) return true; // 单字母变量
  return /[\\^_{}=+\-*/]/.test(t);
}

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: "htmlAndMathml",
      strict: false,
    });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

/**
 * 在**已生成的 HTML** 上替换数学公式。
 * 注意：marked 之前已经把代码块里的内容转义成 HTML 实体，所以这里的
 * `$` 只可能来自正文，不会误伤代码内容。
 */
export function renderMath(html: string): string {
  let out = html.replace(MATH_BLOCK, (_m, tex: string) => renderKatex(tex.trim(), true));
  out = out.replace(MATH_INLINE, (_m, prefix: string, tex: string) => {
    if (!looksLikeMath(tex)) return `${prefix}$${tex}$`;
    return prefix + renderKatex(tex.trim(), false);
  });
  return out;
}

/**
 * 从源码直接扫标题，保留**行号**——marked 的 token 不带位置信息，
 * 而滚动同步与目录跳转都需要行号。
 *
 * 会跳过围栏代码块内部的 `#`，否则代码注释会被当成标题。
 */
export function scanHeadings(src: string): HeadingHit[] {
  const lines = src.split("\n");
  const out: HeadingHit[] = [];
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (fence === null) {
      // 开围栏：最多 3 个空格缩进（再多就是缩进代码块，不是围栏）
      const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        fence = (open[1] ?? "`")[0] ?? "`";
        continue;
      }
    } else {
      // 闭围栏：CommonMark 允许任意缩进。
      //
      // 这里必须比开围栏宽松：列表项里的代码块是缩进的（例如 4 空格），
      // 如果按开围栏的规则去匹配闭合，这种围栏永远关不掉，
      // 状态就会一路翻转，把后面的正文全当成代码块——大纲会整段丢失。
      const close = new RegExp(`^\\s*\\${fence}{3,}\\s*$`).exec(line);
      if (close) {
        fence = null;
        continue;
      }
    }
    if (fence !== null) continue;

    const atx = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      const text = (atx[2] ?? "").trim();
      // `#` 后面必须有实际内容才算标题，空标题不进目录
      if (!text) continue;
      out.push({ level: (atx[1] ?? "").length, text, line: i });
      continue;
    }

    // Setext 标题：上一行是文本，本行是 === 或 ---
    if (/^\s*(=+|-{2,})\s*$/.test(line) && i > 0) {
      const prev = lines[i - 1] ?? "";
      if (prev.trim() && !/^\s*([-*+]|\d+\.)\s/.test(prev)) {
        out.push({
          level: line.trim().startsWith("=") ? 1 : 2,
          text: prev.trim(),
          line: i - 1,
        });
      }
    }
  }
  return out;
}

/**
 * 把源码行号贴到渲染出来的 `<h1..h6>` 上，供滚动同步使用。
 * 按顺序与 scanHeadings 的结果对齐；数量对不上时沿用上一个标题的行号。
 */
export function attachHeadingLines(html: string, headings: HeadingHit[]): string {
  if (headings.length === 0) return html;
  let idx = 0;
  return html.replace(/<h([1-6])\b/g, (_match, lvl: string) => {
    const hit = headings[idx];
    if (hit && String(hit.level) === lvl) {
      idx++;
      return `<h${lvl} data-line="${hit.line}"`;
    }
    return `<h${lvl} data-line="${headings[idx - 1]?.line ?? 0}"`;
  });
}

/** 图表块里的源码需要原样取出，交给 Mermaid 渲染 */
export const MERMAID_FENCE = "mermaid";

// --------------------------------------------------------------- 列表缩进

/**
 * 行首"看起来像缩进"的字符。
 *
 * 除了半角空格与制表符，还要处理**全角空格 U+3000**：从微信、Word、
 * 网页上复制中文内容时非常常见，而 Markdown 完全不认它——
 * 于是"我明明缩进了/我明明贴左了"两种观感都会出现，排查起来很折磨人。
 */
const LEADING_BLANK = /^[ \t\u3000\u00a0]+/;

/** 列表标记前最多允许 3 个空格缩进（CommonMark） */
export const MAX_LIST_INDENT = 3;

/**
 * 计算每一行该去掉几个行首空白字符，让内容真正贴左。
 *
 * 依据：CommonMark 规定列表标记前可以有 0–3 个空格缩进，**超过 3 个就不再是列表**
 * （4 个以上会被当成缩进代码块，或上一段的续行）。从聊天记录、Word、网页里
 * 复制来的名单常常带 4 个以上空格，粘进来就"贴不住"。
 *
 * 这里是**整块去掉**而不是"每次只减 3 格"：命令叫"贴左"，就该一次到位；
 * 想保留层级时用户会用 Tab 缩进，而不是靠这个命令。
 *
 * 返回与传入行数等长的数组；不需要改动的行返回 0。
 */
export function outdentAmounts(lines: string[]): number[] {
  return lines.map((line) => (LEADING_BLANK.exec(line)?.[0] ?? "").length);
}

/** 按 outdentAmounts 的结果裁掉行首缩进（供编辑器命令直接使用） */
export function outdentText(text: string): string {
  const lines = text.split("\n");
  const amounts = outdentAmounts(lines);
  return lines.map((line, i) => line.slice(amounts[i] ?? 0)).join("\n");
}

// --------------------------------------------------------------- 列表补标记

/** 列表标记：- / * / + 后跟空格，或 1. / 1) 后跟空格 */
const LIST_MARKER = /^(\s*)([-*+]|\d+[.)])(\s+)/;

/**
 * 给"看起来是列表、但缺标记"的行补上 `- `。
 *
 * 解决的实际问题：从聊天记录复制名单进来，往往只有第一行带 `- `，
 * 后面的内容是**第一个列表项的续行**——预览里就变成一个圆点套好几行，
 * 用户会觉得"列表贴不住 / 没生效"。
 *
 * 规则（保守，只补确定该补的）：
 *   - 只处理**已经处于列表块内**的行（前面出现过列表标记且中间没有空行）
 *   - 已经有标记或缩进超过 3 空格的行不动（后者可能是刻意嵌套或代码块）
 *   - 空行结束这个列表块
 */
export function fillListMarkers(text: string): { text: string; added: number } {
  const lines = text.split("\n");
  let inList = false;
  let inheritedIndent = "";
  let added = 0;

  const out = lines.map((line) => {
    if (!line.trim()) {
      inList = false;
      return line;
    }

    const marker = LIST_MARKER.exec(line);
    if (marker) {
      inList = true;
      inheritedIndent = marker[1] ?? "";
      return line;
    }

    const lead = LEADING_BLANK.exec(line)?.[0] ?? "";
    if (inList && lead.length <= MAX_LIST_INDENT) {
      added++;
      return `${inheritedIndent}- ${line.slice(lead.length)}`;
    }
    return line;
  });

  return { text: out.join("\n"), added };
}

/** 把偏工具字符替换成可见记号，用来肉眼确认"看不见的空白"到底是什么 */
export function visualizeWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u3000\u00a0]/g, (ch) => {
      if (ch === " ") return "·";
      if (ch === "\t") return "→";
      if (ch === "\u3000") return "□"; // 全角空格
      return "◇"; // U+00A0 不换行空格
    }))
    .join("\n");
}

// --------------------------------------------------------------- 滚动同步

/** 预览区里一个标题锚点的位置 */
export interface ScrollAnchor {
  /** 源码行号（0 基） */
  line: number;
  /** 相对滚动容器的像素位置 */
  offsetTop: number;
}

export interface SyncInput {
  /** 编辑器里当前可见的首行（**1 基**） */
  line: number;
  /** 文档总行数（等于行数，即最后一行的索引 + 1） */
  totalLines: number;
  /** 编辑器滚动比例 0–1（用于没有标题的文档） */
  ratio: number;
  /** 预览区里的标题锚点，按行号升序（行号为 **0 基**） */
  anchors: ScrollAnchor[];
  /** 预览内容总高度 */
  contentHeight: number;
  /** 预览可视高度 */
  viewportHeight: number;
}

/**
 * 由视口坐标求"元素在滚动内容里的位置"。
 *
 * `elementTop` / `containerTop` 都是 `getBoundingClientRect().top`（视口坐标），
 * `scrollTop` 是容器的滚动偏移。结果等价于"把容器滚到 0 时元素距内容顶部的距离"。
 *
 * **为什么不用 `el.offsetTop`**：`.pane-preview` 是 `position: static`，
 * 它会一路找到 `BODY` 当 offsetParent，于是 offsetTop 里混进了标题栏和
 * 标签栏的高度（实测偏 72px）。表现为：点大纲时目标标题被顶到视口外面，
 * 而编辑器→预览的滚动同步也整体偏移。
 */
export function contentOffset(
  elementTop: number,
  containerTop: number,
  scrollTop: number,
): number {
  return elementTop - containerTop + scrollTop;
}

/**
 * 从升序锚点里挑出"行号 ≤ line 的最后一个"；都比 line 大时退回第一个。
 *
 * 用于**点击大纲后把预览滚到对应标题**。原先只滚编辑器，
 * 而编辑器在「预览视图」下是隐藏的 —— 于是点了大纲什么也不发生。
 * 抽成纯函数是为了能单测边界（第一项之前、最后一项之后、空列表）。
 */
export function pickAnchorAtLine<T extends { line: number }>(
  anchors: T[],
  line: number,
): T | null {
  if (anchors.length === 0) return null;
  let best: T | null = null;
  for (const a of anchors) {
    if (a.line <= line) best = a;
    else break;
  }
  return best ?? anchors[0]!;
}

/**
 * 计算预览区应该滚到哪里。返回目标 scrollTop。
 *
 * 两段式：
 *
 * 1. **有标题锚点**时按锚点对齐。锚点内不再用"固定每行多少像素"去推算——
 *    那必然漂移（预览行高由字号与行高倍数决定，和编辑器不是一回事）。
 *    改成用"到下一个锚点之间的实际像素"按行数**插值**，测量值自洽。
 *
 * 2. **没有标题**时退化为按比例同步。以前的实现遇到没有标题的文档
 *    直接 return，表现为"完全不同步"——用户手写的记录通常一个标题都没有。
 */
export function computePreviewScrollTop(input: SyncInput): number {
  const { line, totalLines, ratio, anchors, contentHeight, viewportHeight } = input;
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  const target = Math.max(1, line);

  if (anchors.length === 0) {
    return clamp(ratio * maxScroll, 0, maxScroll);
  }

  // 找到"行号不超过当前行的最后一个锚点"
  let index = -1;
  for (let i = 0; i < anchors.length; i++) {
    if ((anchors[i]?.line ?? 0) <= target - 1) index = i;
    else break;
  }
  if (index < 0) return 0;

  const current = anchors[index]!;
  const next = anchors[index + 1];
  // 行号是 0 基，totalLines 是"行数"：最后一行索引 = totalLines - 1
  const linesInSection = next
    ? Math.max(1, next.line - current.line)
    : Math.max(1, totalLines - 1 - current.line);
  const pixelsInSection = next
    ? Math.max(0, next.offsetTop - current.offsetTop)
    : Math.max(0, contentHeight - current.offsetTop);

  const elapsed = target - 1 - current.line;
  const sectionOffset = (elapsed / linesInSection) * pixelsInSection;
  return clamp(current.offsetTop + sectionOffset, 0, maxScroll);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 编辑时"预览要不要跟着光标走"的判断。
 *
 * 背景：编辑时光标会移动，但**不一定会触发编辑器滚动**（光标还在可视区内时
 * 编辑器不滚动），于是预览停在原处不动——用户看到的就是"按了回车预览不跟着走"。
 *
 * 又不能每次光标一动就同步：逐字符输入时预览会被抖来抖去。
 * 规则：光标移出可视区，或者纵向移动超过 minDelta 行，才跟随。
 */
export function shouldFollowCursor(
  cursorLine: number,
  lastFollowedLine: number,
  firstVisibleLine: number,
  lastVisibleLine: number,
  minDelta = 3,
): boolean {
  if (cursorLine < firstVisibleLine || cursorLine > lastVisibleLine) return true;
  return Math.abs(cursorLine - lastFollowedLine) >= minDelta;
}

/**
 * 节流 + **尾补发**。
 *
 * 为什么必须补发：滚动停下时的最后一个事件经常落在节流窗口内。
 * 早期实现直接 `return` 丢掉它，预览就永远停在倒数第二个位置、差最后一点——
 * 表现为"滚到底了预览还没到底"。
 */
export function createTrailingThrottle<T>(
  emit: (value: T) => void,
  windowMs: number,
  hooks: { now: () => number; setTimer: (fn: () => void, ms: number) => unknown },
): (value: T) => void {
  let lastEmit = Number.NEGATIVE_INFINITY;
  let pending: T | null = null;
  let timer: unknown = null;

  return (value: T) => {
    const now = hooks.now();
    const elapsed = now - lastEmit;

    if (elapsed >= windowMs) {
      lastEmit = now;
      emit(value);
      return;
    }

    pending = value;
    if (timer !== null) return;
    timer = hooks.setTimer(() => {
      timer = null;
      lastEmit = hooks.now();
      const next = pending;
      pending = null;
      if (next !== null) emit(next);
    }, windowMs - elapsed);
  };
}

// --------------------------------------------------------------- 空标记行回车

/**
 * 行首的"标记"：可嵌套的引用层级（`> `）或列表标记（含任务列表 `[ ]`）。
 *
 * 匹配"只有标记、没有内容"的行，例如：`- `、`>`、`1. `、`- [x] `、`> - `、`> > `。
 * 标记后可以没有空格（如行尾的 `-`）。
 *
 * 两个分支必须**至少命中一个**：否则空字符串也会匹配，
 * 那样在空行上按回车就会走"退出标记"分支、凭空多插一个换行。
 *
 * `> - ` 这种"引用里的空列表项"也要能匹配：回车应当把整行清掉，
 * 而不是留下半截 `> `。
 */
const EMPTY_MARKUP_PATTERN =
  /^((?:[ \t]*>[ \t]*)+(?:[-*+]|\d{1,9}[.)])?[ \t]*|(?:[ \t]*[-*+]|\d{1,9}[.)])[ \t]*)(\[[ xX]\][ \t]*)?$/;

/**
 * 光标所在行如果是"空的标记行"（只剩列表标记或引用标记，可带缩进），
 * 返回该如何改写；否则返回 null。
 *
 * 用途：在这种行上按回车应当**退出该层标记**——把整行清掉。
 *
 * 为什么需要自己实现：CodeMirror 的 `insertNewlineContinueMarkup` 只在
 * "前面有空行 / 已是第二项之后"等条件下才去掉标记，紧邻时它插入空行并
 * **保留标记**——用户按回车想结束列表/引用，结果又续了一行 `- ` 或 `> `，
 * 只能再按一次退格。
 *
 * `visualCol` 是光标在本行的列号（0 基）。
 *
 * 返回的 `deleteFrom` / `deleteTo` 都是**行内偏移**（调用方加上行首位置即可用）：
 * 直接把整行删掉，包含换行符（若该行有换行）。
 */
export function emptyListItem(
  line: string,
  visualCol: number,
  /** 该行是否为文档最后一行（决定删完后要不要补一个换行） */
  lastLine: boolean,
  /** 行尾位置的**行内偏移**：有换行符时为 line.length + 1，否则为 line.length */
  lineLength = line.length,
): { markerLength: number; deleteFrom: number; deleteTo: number; insert: string } | null {
  const m = EMPTY_MARKUP_PATTERN.exec(line);
  if (!m) return null;
  const markerLength = (m[1] ?? "").length + (m[2]?.length ?? 0);

  // 光标必须在标记之后（含行尾），否则当作"在标记中间编辑"
  if (visualCol < markerLength) return null;

  // 整行清掉（含缩进）：这才是"退出标记"该有的结果。
  // 只删标记长度会把缩进留下，得到 `  ` 这种看起来像空行、实际有内容的残留。
  //
  // 两种情况都删整行：
  //   - 非最后一行：连换行一起删，光标自然落到下一行行首
  //   - 最后一行：行尾没有换行符，补一个换行让用户落在新的空行上
  return {
    markerLength,
    deleteFrom: 0,
    deleteTo: lineLength,
    insert: lastLine ? "\n" : "",
  };
}

// --------------------------------------------------------------- 文档结构自检

export interface DocIssue {
  /** 1 基行号 */
  line: number;
  kind: "unclosed-fence" | "mismatched-fence" | "heading-in-fence" | "fence-not-alone";
  message: string;
  /** 该行的原文，便于定位 */
  text: string;
}

/**
 * 检查文档的围栏结构。
 *
 * 为什么需要：围栏没闭合（或起始行被别的内容挤在一起）时，**后面一大段内容
 * 都会被解析成代码块或引用块**，而肉眼很难发现——实际遇到过：一行里同时有
 * 引用内容和 ```，导致整个 TypeScript 示例被当成引用，
 * 表现成"在代码块里按回车会插入 `> `"。这类问题应该有办法一眼看出来。
 */
export function checkDocument(text: string): DocIssue[] {
  const lines = text.split("\n");
  const issues: DocIssue[] = [];
  let fence: { marker: string; line: number } | null = null;
  /** 语言名允许字母/数字/加号/井号/点/横线/下划线/空格 */
  const LANG_OK = /^[A-Za-z0-9+#.\-_ ]*$/;
  /** 行首（允许 0–3 空格缩进）的围栏 */
  const HEAD_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  /** 行内任意位置出现的围栏序列 */
  const ANY_FENCE = /(`{3,}|~{3,})/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    const head = HEAD_FENCE.exec(line);
    if (head) {
      const marker = (head[1] ?? "")[0] ?? "`";
      const rest = (head[2] ?? "").trim();

      if (fence === null) {
        if (!LANG_OK.test(rest)) {
          issues.push({
            line: i + 1,
            kind: "fence-not-alone",
            message: "围栏标记后面跟着的不是语言名，这一行不会被识别为代码块起始",
            text: trimmed.slice(0, 60),
          });
        }
        fence = { marker, line: i + 1 };
      } else if (marker === fence.marker) {
        fence = null;
      } else {
        issues.push({
          line: i + 1,
          kind: "mismatched-fence",
          message: `围栏类型不匹配：第 ${fence.line} 行用的是 ${fence.marker.repeat(3)}，这里却是 ${marker.repeat(3)}`,
          text: trimmed.slice(0, 60),
        });
      }
      continue;
    }

    // 行首不是围栏，但行内出现了围栏序列 → 它是被别的内容挤在中间的
    const any = ANY_FENCE.exec(line);
    if (any) {
      issues.push({
        line: i + 1,
        kind: "fence-not-alone",
        message:
          "围栏标记出现在一行中间，不会被识别为代码块开始" +
          (fence ? `（当前还在第 ${fence.line} 行开始的代码块里）` : ""),
        text: trimmed.slice(0, 60),
      });
    }

    // 围栏内部出现引用标记：很可能是围栏没闭合的信号
    if (fence !== null && /^\s*>/.test(line)) {
      issues.push({
        line: i + 1,
        kind: "heading-in-fence",
        message: `这行在代码块内部（起始于第 ${fence.line} 行），但看起来像引用——通常是上面的围栏没有正确闭合`,
        text: trimmed.slice(0, 60),
      });
    }
  }

  if (fence !== null) {
    issues.push({
      line: fence.line,
      kind: "unclosed-fence",
      message: `第 ${fence.line} 行开始的代码块一直没有闭合，它后面的内容都会被当成代码`,
      text: (lines[fence.line - 1] ?? "").trim().slice(0, 60),
    });
  }

  return issues;
}

// --------------------------------------------------------------- 编号列表兼容
/** 编号列表标记后少了一个空格：`8.内容` / `8)内容` */
const MISSING_SPACE_AFTER_NUMBER = /^(\s{0,3}\d{1,9}[.)])(?=[^\s\d])/;

/**
 * 给"编号标记后缺空格"的行补一个空格。
 *
 * 为什么需要：CommonMark 明确允许 `1.foo` 这种写法——
 *
 *     A list marker followed by any number of spaces or tabs, or by the end
 *     of the line, is a valid list item marker.
 *
 * 但 marked 不认：它会把 `8.发票主体不一致` 当成普通段落。用户从截图里报的
 * "第 8 项掉出列表、变成代码块或段落"就是这个原因——他的文件里点号后没空格。
 *
 * 处理时**跳过围栏代码块**，避免改动代码内容。
 * 项目符号（`-` `*` `+`）在 CommonMark 里本来就要求有空格，无需处理。
 */
export function normalizeListMarkers(text: string): { text: string; fixed: number } {
  const lines = text.split("\n");
  let fence: string | null = null;
  let fixed = 0;

  const out = lines.map((line) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? "`")[0] ?? "`";
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      return line;
    }
    if (fence !== null) return line;

    const m = MISSING_SPACE_AFTER_NUMBER.exec(line);
    if (!m) return line;
    fixed++;
    const marker = m[1] ?? "";
    return `${marker} ${line.slice(marker.length)}`;
  });

  return { text: out.join("\n"), fixed };
}
