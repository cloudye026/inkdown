import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * 源码模式的视觉降噪：标题加粗、标记符号变淡、代码块等宽，
 * 目标是"读起来像渲染过的文档，同时还是可编辑的源码"。
 *
 * ⚠️ **不要给 HighlightStyle.define 传 `{ themeType: "dark" }`。**
 * 带 themeType 的样式只有在编辑器主题类型匹配时才挂进 highlighter facet
 * （见 @codemirror/language 的 syntaxHighlighting：`themeType ? highlighterFacet
 * .computeN([EditorView.darkTheme], …)`）。而这里的基础主题是 `EditorView.baseTheme`
 * （没声明 dark），darkTheme 恒为 false —— 整个高亮样式会被**静默丢掉**，
 * 一行 token 颜色都不出，只剩行级装饰（标题放大、代码行底纹）还生效，
 * 看起来"像个 markdown 编辑器"，于是问题被误报成"json 代码片段没高亮了"。
 *
 * 颜色全部走 CSS 变量（`--code-*`），明暗由主题自己决定，所以这个样式本来就应该
 * 在两种主题类型下都生效。回归测试：`scripts/editorHighlight.test.mjs`。
 */
export const markdownHighlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.heading1, class: "cm-md-heading", fontSize: "1.5em", lineHeight: "1.45" },
    { tag: t.heading2, class: "cm-md-heading", fontSize: "1.32em", lineHeight: "1.45" },
    { tag: t.heading3, class: "cm-md-heading", fontSize: "1.18em", lineHeight: "1.45" },
    { tag: t.heading4, class: "cm-md-heading", fontSize: "1.08em" },
    { tag: t.heading5, class: "cm-md-heading", fontSize: "1.02em" },
    { tag: t.heading6, class: "cm-md-heading", fontSize: "1em" },
    { tag: t.strong, class: "cm-md-strong" },
    { tag: t.emphasis, class: "cm-md-emphasis" },
    { tag: t.strikethrough, class: "cm-md-strike", textDecoration: "line-through" },
    { tag: t.link, class: "cm-md-link" },
    { tag: t.url, class: "cm-md-link" },
    { tag: t.monospace, class: "cm-md-code" },
    { tag: t.quote, class: "cm-md-quote" },
    { tag: t.contentSeparator, class: "cm-md-marker" },
    { tag: t.processingInstruction, class: "cm-md-marker" }, // `#` `*` `>` 等标记
    { tag: t.labelName, class: "cm-md-marker" },
    // 列表
    { tag: t.list, class: "cm-md-list" },
    // 代码块内的语言高亮跟随主题。
    //
    // 用**按主题各配一套**的 --code-* 变量，而不是复用 --accent/--ok 那几个
    // 通用色：那样会让关键字与函数名同色、数字与类型名同色，
    // 某些主题（Gruvbox 的黄、Monokai 的绿）还会让四类撞成一片。
    { tag: t.keyword, color: "var(--code-keyword)" },
    { tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
    {
      tag: [t.comment, t.lineComment, t.blockComment],
      color: "var(--code-comment)",
      fontStyle: "italic",
    },
    { tag: [t.number, t.bool, t.null], color: "var(--code-number)" },
    {
      tag: [t.function(t.variableName), t.function(t.propertyName)],
      color: "var(--code-func)",
    },
    { tag: [t.typeName, t.className], color: "var(--code-type)" },
    // 变量、属性、运算符等没有专属配色时退到正文色，避免出现"彩色噪音"
    { tag: [t.variableName, t.propertyName], color: "var(--fg)" },
    { tag: [t.operator, t.punctuation, t.bracket], color: "var(--fg-muted)" },
  ]),
);

/**
 * 编辑器基础主题改用 CSS 类而不是内联样式，
 * 这样亮暗切换、字号/行高改动都由 CSS 变量接管，不用重建扩展。
 */
export const markdownTheme = EditorView.baseTheme({
  "&": { height: "100%", backgroundColor: "transparent" },
  ".cm-content": { padding: "0", caretColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  // 输入法：关掉拼写检查与自动纠正，否则拼音输入会被系统词典干扰
  ".cm-content, .cm-line": {
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
    writingMode: "horizontal-tb",
  },
  "&.cm-focused": { outline: "none" },
});
