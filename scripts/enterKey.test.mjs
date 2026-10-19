// 编辑器的回车行为测试：走真实的 keymap 分发路径。
//
// 覆盖两件事：
//   1) 空列表项上回车要"退出列表"（用户报的"回车的 bug"）
//   2) 非空列表项上回车仍然要正常续行（不能为了修 1 而破坏原有行为）
//
// 用真实分发而不是直接调命令：只有分发才会暴露优先级/绑定顺序问题。

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
const { markdown, markdownLanguage, deleteMarkupBackward } = await import(
  "@codemirror/lang-markdown"
);
const { emptyListItem } = await import("../src/services/mdcore.ts");

/** 展开 facet 值里的 Prec wrapper */
function flat(values, out = []) {
  for (const v of values) {
    if (Array.isArray(v)) flat(v, out);
    else if (v && typeof v === "object" && "facet" in v) flat(v.facet.values ?? [], out);
    else out.push(v);
  }
  return out;
}

/** 与 MarkdownEditor 一致的"退出空列表项"命令 */
function exitEmptyListItem(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
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

/** 与 MarkdownEditor 一致的扩展顺序（注意：退出命令必须在 markdown() 之前） */
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

function pressEnter(doc, cursorPos, debug = false) {
  const pos = Math.min(cursorPos ?? doc.length, doc.length);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(pos),
    extensions: makeExtensions(),
  });
  const view = new EditorView({ state });
  const matching = flat(view.state.facet(keymap)).filter((b) => {
    const keys = Array.isArray(b.key) ? b.key : [b.key];
    return keys.includes("Enter");
  });

  let winner = null;
  for (const b of matching) {
    if (debug) console.log(`    [dbg] 尝试绑定 run=${b.run.name || "匿名"} 文档=${JSON.stringify(view.state.doc.toString())}`);
    if (b.run(view)) {
      winner = Array.isArray(b.key) ? b.key[0] : b.key;
      if (debug) console.log(`    [dbg] 胜出，文档=${JSON.stringify(view.state.doc.toString())}`);
      break;
    }
  }
  const result = view.state.doc.toString();
  view.destroy();
  return { result, winner, matching: matching.length };
}

test("空列表项上回车：退出列表（这是用户报的 bug）", () => {
  const before = "- 未申请\n- ";
  const { result, winner } = pressEnter(before);

  assert.equal(winner, "Enter", "应被回车绑定处理");
  assert.equal(result, "- 未申请\n\n");
  assert.ok(!/\n- \s*$/.test(result), "不应残留空列表项标记");
  assert.ok(!/[ \t]+\n/.test(result), "不应残留只有空白的行");
});

test("空列表项（无尾随空格）上回车也退出", () => {
  const { result } = pressEnter("- 未申请\n-");
  assert.equal(result, "- 未申请\n\n");
  assert.ok(!/\n-$/.test(result), "裸 `-` 也应被清掉");
});

test("最后一行是空列表项：清掉标记并留一个空行", () => {
  const { result } = pressEnter("- 未申请\n- ");
  assert.equal(result, "- 未申请\n\n", "退出一行空列表项后应留一个空行");
});

test("任务列表的空项也要退出", () => {
  const { result } = pressEnter("- [ ] 待办\n- [ ] ");
  assert.match(result, /^- \[ \] 待办\n\n?$/, "标记应被清掉");
  assert.ok(!/\[ \]\s*$/.test(result.replace("- [ ] 待办", "")), "不应残留空任务项");
});

test("有序列表的空项退出", () => {
  const { result } = pressEnter("1. 第一条\n2. ");
  assert.match(result, /^1\. 第一条\n\n?$/);
  assert.ok(!/\d+\.\s*$/.test(result), "不应残留空编号项");
});

test("缩进列表的空项退出并清掉缩进", () => {
  const { result } = pressEnter("- 父项\n  - ");
  assert.equal(result, "- 父项\n\n", "整行清掉，缩进也不残留");
  assert.ok(!/\n\s+-/.test(result), "缩进标记不应残留");
});

test("非空列表项上回车：仍然正常续行（不能破坏原有行为）", () => {
  const { result } = pressEnter("- 未申请");
  assert.equal(result, "- 未申请\n- ", "应续上新标记");
});

test("有序列表非空项续行时编号递增", () => {
  const { result } = pressEnter("1. 第一条");
  assert.equal(result, "1. 第一条\n2. ");
});

test("引用里的列表续行", () => {
  const { result } = pressEnter("> - 引用里的列表");
  assert.equal(result, "> - 引用里的列表\n> - ");
});

test("普通段落上回车不该被我们拦截", () => {
  const { result, winner } = pressEnter("普通文字");
  // 普通段落没有 Enter 绑定胜出时，CodeMirror 交给浏览器默认换行，
  // 文档在命令层不变——这正是期望行为（不该被改成列表）
  assert.equal(result, "普通文字");
  assert.equal(winner, null, "不应有命令处理，交给默认换行");
});

test("光标在标记中间时不触发退出（避免误删）", () => {
  const { result } = pressEnter("- 未申请\n- ", 6);
  assert.equal(result, "- 未申请\n- ", "光标在标记内不应改写内容");
});

test("emptyListItem 的纯逻辑：识别各种空列表项", () => {
  // 第 4 个参数是"行内偏移长度"：有换行符时为 line.length + 1
  assert.ok(emptyListItem("- ", 2, false, 3));
  assert.ok(emptyListItem("-", 1, false, 2));
  assert.ok(emptyListItem("  - ", 4, false, 5), "缩进列表也算");
  assert.ok(emptyListItem("1. ", 3, false, 4));
  assert.ok(emptyListItem("- [ ] ", 6, false, 7), "任务列表空项");
  assert.ok(emptyListItem("- [x] ", 6, false, 7));

  assert.equal(emptyListItem("- 有内容", 6, false, 7), null, "非空项不处理");
  assert.equal(emptyListItem("普通文字", 4, false, 5), null);
  assert.equal(emptyListItem("", 0, false, 0), null);
  assert.equal(emptyListItem("- ", 0, false, 3), null, "光标在标记之前不处理");
});

// ---------------------------------------------------------------
// 针对 samples/demo.md 里真实出现的结构（用户测的就是这份文件）
// ---------------------------------------------------------------

test("demo.md 的任务列表：回车续出未勾选的新项", () => {
  const { result } = pressEnter("- [x] 双栏编辑 + 实时预览");
  assert.equal(result, "- [x] 双栏编辑 + 实时预览\n- [ ] ");
});

test("demo.md 的任务列表：空项回车退出（不留 `- [ ]`）", () => {
  const { result } = pressEnter("- [x] 双栏编辑 + 实时预览\n- [ ] ");
  assert.match(result, /^- \[x\] 双栏编辑 \+ 实时预览\n\n?$/);
  assert.ok(!/\[ \]/.test(result), "空任务项应被清掉");
});

test("demo.md 的无序列表：回车续出同级项", () => {
  const { result } = pressEnter("- 粗体 / 斜体 / 行内代码 / 链接");
  assert.equal(result, "- 粗体 / 斜体 / 行内代码 / 链接\n- ");
});

test("demo.md 的引用块：回车续出 `> `", () => {
  const { result } = pressEnter("> 引用块第一行");
  assert.equal(result, "> 引用块第一行\n> ");
});

test("demo.md 的引用块：空引用行回车清掉标记", () => {
  const { result } = pressEnter("> 引用块第一行\n> ");
  assert.match(result, /^> 引用块第一行\n\n?$/);
  assert.ok(!/\n> ?\n?$/.test(result), "不应残留 `> `");
});

test("demo.md 的表格行：回车不产生列表标记", () => {
  const { result } = pressEnter("| 项目 | 选型 | 备注 |");
  assert.equal(result, "| 项目 | 选型 | 备注 |");
});

test("demo.md 的代码块内：回车不续列表标记", () => {
  const { result } = pressEnter("```ts\nconst a = 1;\n```", 18);
  assert.equal(result, "```ts\nconst a = 1;\n```");
});

test("demo.md 的标题行：回车另起一行，不加标记", () => {
  const { result } = pressEnter("## 一、基础排版");
  assert.equal(result, "## 一、基础排版");
});

test("demo.md 的有序列表：编号递增", () => {
  const { result } = pressEnter("1. 外壳：Tauri 2");
  assert.equal(result, "1. 外壳：Tauri 2\n2. ");
});
