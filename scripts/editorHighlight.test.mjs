// 编辑器里的语法高亮测试：确认 token 级高亮真的生效。
//
// 用户报的是"json 代码片段没高亮了"—— 实际根因不在 json：整个编辑器**任何** token
// 高亮都没生效，只剩我们自己加的行级装饰（标题变大、代码行加底纹），所以看起来"还像
// 个 markdown 编辑器"。原因在 CodeMirror 的一个静默陷阱：
//
//   HighlightStyle.define(specs, { themeType: "dark" })
//
// 带 themeType 的样式只有在编辑器主题类型匹配时才会挂进 highlighter facet
// （源码：syntaxHighlighting() 里 `themeType ? highlighterFacet.computeN([darkTheme], …)`）。
// 我们的基础主题是 baseTheme（没声明 dark），darkTheme 为 false，"dark" 样式被整段丢掉，
// 而且**不报错**。
//
// 这个测试用真实 EditorView 渲染，直接查 DOM 里有没有 token span，所以它同时覆盖
// "样式有没有被挂上"和"语言有没有加载"两件事。

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
globalThis.Node = w.Node;
globalThis.Element = w.Element;
globalThis.HTMLElement = w.HTMLElement;
globalThis.Range = w.Range;
globalThis.MutationObserver = w.MutationObserver;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.getSelection = w.getSelection.bind(w);
globalThis.DOMParser = w.DOMParser;
globalThis.NodeFilter = w.NodeFilter;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
Object.defineProperty(globalThis, "navigator", {
  value: w.navigator,
  configurable: true,
  writable: true,
});

const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { markdown, markdownLanguage } = await import("@codemirror/lang-markdown");
const { languages } = await import("@codemirror/language-data");
const { markdownHighlightStyle, markdownTheme } = await import("../src/editor/theme.ts");

const DOC = [
  "# 高亮标题",
  "",
  "```json",
  '{ "name": "mddeveloper", "count": 3, "ok": true }',
  "```",
  "",
  "```ts",
  "const a: number = 1;",
  "```",
].join("\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        markdownHighlightStyle,
        markdownTheme,
      ],
    }),
    parent: host,
  });
  return view;
}

const spansOf = (view, needle) => {
  const line = [...view.dom.querySelectorAll(".cm-line")].find((l) =>
    (l.textContent ?? "").includes(needle),
  );
  return line ? [...line.querySelectorAll("span")] : [];
};

test("markdown 的标题要有 token 样式（高亮样式没被主题类型门控掉）", () => {
  const view = mount();
  try {
    const spans = spansOf(view, "高亮标题");
    assert.ok(
      spans.some((s) => s.className.includes("cm-md-heading")),
      `标题行没有 token span，说明高亮样式没生效。实际 DOM：${spansOf(view, "高亮标题").length} 个 span`,
    );
  } finally {
    view.destroy();
  }
});

test("json 围栏里的内容要被分词（不同 token 拿到不同样式）", async () => {
  const view = mount();
  try {
    // json 语言是**异步加载**的（language-data 里是动态 import），
    // 加载完成后 CodeMirror 会重新解析并重新渲染
    let spans = [];
    for (let i = 0; i < 60 && spans.length === 0; i++) {
      await sleep(25);
      spans = spansOf(view, '"name"');
    }
    assert.ok(spans.length > 0, "json 围栏里的内容一个 token span 都没有（等于没高亮）");

    const classes = new Set(spans.map((s) => s.className).filter(Boolean));
    assert.ok(
      classes.size >= 2,
      `json 里的 token 只有一种样式，等于没有区分：${[...classes].join(" / ")}`,
    );
  } finally {
    view.destroy();
  }
});

test("ts 围栏里的内容同样要被分词", async () => {
  const view = mount();
  try {
    let spans = [];
    for (let i = 0; i < 60 && spans.length === 0; i++) {
      await sleep(25);
      spans = spansOf(view, "const a");
    }
    assert.ok(spans.length > 0, "ts 围栏里的内容没有 token span");
  } finally {
    view.destroy();
  }
});
