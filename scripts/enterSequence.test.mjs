// 连续回车的序列场景测试。
//
// 之前的测试都只按**一次**回车，覆盖不到"连续输入 + 退出后再输入"这类真实过程。
// 这里用一个持久视图模拟真实编辑：回车 → 打字 → 回车 → 打字…
//
// 注意：构造视图时**必须把光标放在文档末尾**。漏掉会默认放在 0，
// 于是所有输入都插到开头，测出来的结果完全失真（这个坑踩过一次）。

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

const { EditorState, EditorSelection, Prec } = await import("@codemirror/state");
const { EditorView, keymap } = await import("@codemirror/view");
const { syntaxTree } = await import("@codemirror/language");
const { markdown, markdownLanguage, deleteMarkupBackward } = await import(
  "@codemirror/lang-markdown"
);
const { emptyListItem } = await import("../src/services/mdcore.ts");

function flat(values, out = []) {
  for (const v of values) {
    if (Array.isArray(v)) flat(v, out);
    else if (v && typeof v === "object" && "facet" in v) flat(v.facet.values ?? [], out);
    else out.push(v);
  }
  return out;
}

/** 与 MarkdownEditor 一致的"标记上下文"判断 */
const CODE_NODES = new Set(["FencedCode", "CodeBlock", "CodeText", "InlineCode", "CodeInfo"]);
const MARKUP_NODES = new Set([
  "BulletList",
  "OrderedList",
  "ListItem",
  "Blockquote",
  "QuoteMark",
  "ListMark",
  "Task",
]);

function isInMarkupContext(view, pos) {
  let node = syntaxTree(view.state).resolveInner(pos, -1);
  while (node) {
    if (CODE_NODES.has(node.name)) return false;
    if (MARKUP_NODES.has(node.name)) return true;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

/** 与 MarkdownEditor 一致的"退出空标记行"命令 */
function exitEmptyListItem(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  if (!isInMarkupContext(view, sel.from)) return false;
  const doc = view.state.doc;
  const line = doc.lineAt(sel.from);
  const info = emptyListItem(
    line.text,
    sel.from - line.from,
    line.number === doc.lines,
    line.length + (line.to > line.from + line.length ? 1 : 0),
  );
  if (!info) return false;
  view.dispatch({
    changes: {
      from: line.from + info.deleteFrom,
      to: line.from + info.deleteTo,
      insert: info.insert,
    },
    selection: { anchor: line.from + info.insert.length },
  });
  return true;
}

function makeExtensions() {
  return [
    Prec.high(
      keymap.of([
        { key: "Enter", run: exitEmptyListItem },
        { key: "Backspace", run: deleteMarkupBackward },
      ]),
    ),
    markdown({ base: markdownLanguage, addKeymap: true }),
  ];
}

/** 持久视图：模拟真实的"回车 → 打字 → 回车"过程 */
function makeEditor(doc) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(doc.length),
      extensions: makeExtensions(),
    }),
  });
  assert.equal(
    view.state.selection.main.head,
    doc.length,
    "探针自检：光标必须在文档末尾，否则后面的场景全部失真",
  );
  return {
    view,
    text: () => view.state.doc.toString(),
    /** 按一次回车：走真实 keymap 分发，没有命令胜出时按浏览器默认插入换行 */
    enter() {
      const matching = flat(view.state.facet(keymap)).filter((b) => {
        const keys = Array.isArray(b.key) ? b.key : [b.key];
        return keys.includes("Enter");
      });
      for (const b of matching) {
        if (b.run(view)) return;
      }
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: "\n" },
        selection: { anchor: sel.from + 1 },
      });
    },
    type(text) {
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
      });
    },
    destroy: () => view.destroy(),
  };
}

test("有序列表连续回车：编号递增", () => {
  const ed = makeEditor("1. 第一项");
  ed.enter();
  ed.type("第二项");
  ed.enter();
  ed.type("第三项");
  assert.equal(ed.text(), "1. 第一项\n2. 第二项\n3. 第三项");
  ed.destroy();
});

test("有序列表空项退出后再输入：不再有编号", () => {
  const ed = makeEditor("1. 第一项\n2. ");
  ed.enter();
  assert.equal(ed.text(), "1. 第一项\n\n", "空项应被清掉");
  ed.type("这是正文了");
  assert.ok(!/^\d+\.\s*这是正文/m.test(ed.text()), "正文不应带编号");
  assert.equal(ed.text(), "1. 第一项\n\n这是正文了");
  ed.destroy();
});

test("任务列表连续回车：续出未勾选的新项", () => {
  const ed = makeEditor("- [x] 已完成");
  ed.enter();
  ed.type("新任务");
  ed.enter();
  ed.type("第三项");
  assert.equal(ed.text(), "- [x] 已完成\n- [ ] 新任务\n- [ ] 第三项");
  ed.destroy();
});

test("任务列表空项退出后再输入：变回普通正文", () => {
  const ed = makeEditor("- [x] 已完成\n- [ ] ");
  ed.enter();
  assert.equal(ed.text(), "- [x] 已完成\n\n");
  ed.type("普通正文");
  assert.equal(ed.text(), "- [x] 已完成\n\n普通正文");
  ed.destroy();
});

test("引用块连续回车：始终保持引用标记", () => {
  const ed = makeEditor("> 第一行");
  ed.enter();
  ed.type("第二行");
  ed.enter();
  ed.type("第三行");
  assert.equal(ed.text(), "> 第一行\n> 第二行\n> 第三行");
  ed.destroy();
});

test("空引用行退出后再输入：不再有 `>`", () => {
  const ed = makeEditor("> 第一行\n> ");
  ed.enter();
  assert.equal(ed.text(), "> 第一行\n\n");
  ed.type("引用外的正文");
  assert.equal(ed.text(), "> 第一行\n\n引用外的正文");
  ed.destroy();
});

test("退出列表后再起一个列表：两个列表不会合并", () => {
  const ed = makeEditor("- 甲\n- ");
  ed.enter(); // 退出第一个列表
  ed.type("中间正文");
  ed.enter();
  ed.enter();
  ed.type("- 乙");
  assert.equal(ed.text(), "- 甲\n\n中间正文\n\n- 乙");
  ed.destroy();
});

test("光标在行中间回车：正确拆分，两侧都保留标记", () => {
  const ed = makeEditor("- 未申请");
  ed.view.dispatch({ selection: EditorSelection.cursor(3) });
  ed.enter();
  assert.equal(ed.text(), "- 未\n- 申请");
  ed.destroy();
});

test("普通段落连续回车：不会冒出任何标记", () => {
  const ed = makeEditor("普通段落");
  ed.enter();
  ed.enter();
  assert.equal(ed.text(), "普通段落\n\n");
  assert.ok(!/[-*>]\s*$/m.test(ed.text()), "不应出现列表或引用标记");
  ed.destroy();
});

// ---------------------------------------------------------------
// 代码块保护（回归：曾经在代码块里按回车会把整行删掉）
// 写 Markdown 教程时，代码块里经常出现单独的 "- "、"> "、"1. "，
// 它们是示例内容，不是真的标记。
// ---------------------------------------------------------------

/** 把光标放到指定文本行末尾并返回视图 */
function editorAtLine(doc, lineText) {
  const lines = doc.split("\n");
  let offset = 0;
  let target = -1;
  for (const l of lines) {
    if (l === lineText) {
      target = offset + l.length;
      break;
    }
    offset += l.length + 1;
  }
  assert.ok(target >= 0, `测试前提：文档里应有 ${JSON.stringify(lineText)}`);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(target),
      extensions: makeExtensions(),
    }),
  });
  return {
    view,
    text: () => view.state.doc.toString(),
    enter() {
      const matching = flat(view.state.facet(keymap)).filter((b) => {
        const keys = Array.isArray(b.key) ? b.key : [b.key];
        return keys.includes("Enter");
      });
      for (const b of matching) if (b.run(view)) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: "\n" },
        selection: { anchor: sel.from + 1 },
      });
    },
    destroy: () => view.destroy(),
  };
}

test("代码块里的 `- ` 行按回车：只换行，不删行", () => {
  const doc = ["示例：", "", "```md", "- ", "> ", "1. ", "```", "", "正文"].join("\n");
  const ed = editorAtLine(doc, "- ");
  ed.enter();
  assert.equal(
    ed.text(),
    ["示例：", "", "```md", "- ", "", "> ", "1. ", "```", "", "正文"].join("\n"),
    "应为空行插入换行，`- ` 这行必须保留",
  );
  ed.destroy();
});

test("代码块里的 `> ` 与 `1. ` 行同理不受影响", () => {
  const doc = ["```md", "- ", "> ", "1. ", "```"].join("\n");
  for (const line of ["> ", "1. "]) {
    const ed = editorAtLine(doc, line);
    const before = ed.text();
    ed.enter();
    const after = ed.text();
    assert.ok(after.includes(line), `${JSON.stringify(line)} 必须保留`);
    assert.equal(after.length, before.length + 1, "只应插入一个换行");
    ed.destroy();
  }
});

test("行内代码里的标记字样也不受影响", () => {
  const doc = ["行内代码 `- ` 后面还有内容", "", "下一行"].join("\n");
  const ed = editorAtLine(doc, "行内代码 `- ` 后面还有内容");
  const before = ed.text();
  ed.enter();
  assert.equal(ed.text().length, before.length + 1, "只应插入一个换行");
  ed.destroy();
});

test("缩进代码块（4 空格）里的标记行也受保护", () => {
  const doc = ["    示例文本", "    - ", "正文"].join("\n");
  const ed = editorAtLine(doc, "    - ");
  const before = ed.text();
  ed.enter();
  assert.equal(ed.text().length, before.length + 1, "只应插入一个换行");
  assert.ok(ed.text().includes("    - "), "缩进代码块内容应保留");
  ed.destroy();
});

test("语法上不是标记的孤立短横线不被误删", () => {
  // `-这是内容`（短横线后没有空格）在 CommonMark 里**不是**列表标记，
  // 只是普通文本。它落在 emptyListItem 的"标记后可无空格"规则里，
  // 靠语法树确认才能区分开。
  const doc = ["这是一段普通文字", "-这不是列表标记", "", "结尾"].join("\n");
  const ed = editorAtLine(doc, "-这不是列表标记");
  const before = ed.text();
  ed.enter();
  assert.equal(ed.text().length, before.length + 1, "只应插入一个换行");
  assert.ok(ed.text().includes("-这不是列表标记"), "内容必须保留");
  ed.destroy();
});

test("真的列表上下文里仍然正确退出（不能因为加严保护而失效）", () => {
  const doc = ["- 第一项", "- ", "", "正文"].join("\n");
  const ed = editorAtLine(doc, "- ");
  ed.enter();
  assert.equal(ed.text(), "- 第一项\n\n\n正文", "空项应被清掉");
  ed.destroy();
});

test("真的引用上下文里仍然正确退出", () => {
  const doc = ["> 引用内容", "> ", "", "正文"].join("\n");
  const ed = editorAtLine(doc, "> ");
  ed.enter();
  assert.equal(ed.text(), "> 引用内容\n\n\n正文", "空引用行应被清掉");
  ed.destroy();
});
