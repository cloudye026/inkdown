import { useEffect, useRef, useState } from "react";
import { EditorState, Compartment, Prec, type ChangeSpec, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  lineNumbers as lineNumbersExt,
} from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { bracketMatching, syntaxTree, foldGutter, foldKeymap } from "@codemirror/language";
import { markdown, markdownLanguage, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { useDocs } from "../store/docs";
import { useSettings } from "../store/settings";
import { runCommand } from "../store/ui";
import { outdentAmounts, fillListMarkers, emptyListItem, shouldFollowCursor } from "../services/mdcore";
import { markdownHighlightStyle, markdownTheme } from "./theme";
import type { CursorInfo } from "../types";

export interface EditorHandle {
  replaceAll: (text: string, line?: number) => void;
  focus: () => void;
  scrollToLine: (line: number) => void;
  currentLine: () => number;
  openSearch: () => void;
}

interface Props {
  path: string;
  visible: boolean;
  onCursor: (info: CursorInfo) => void;
  /** 编辑器滚动时上报：当前可见首行 + 滚动比例（供预览同步） */
  onScrollLine: (line: number, ratio: number) => void;
  onReady: (path: string, handle: EditorHandle) => void;
}

export function MarkdownEditor({ path, visible, onCursor, onScrollLine, onReady }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastDispatched = useRef<string>("");
  const [error, setError] = useState<string | null>(null);

  // 用 Compartment 做动态配置：改行号/只读/打字机不需要重建编辑器
  const compartments = useRef({
    lineNumbers: new Compartment(),
    typewriter: new Compartment(),
    readOnly: new Compartment(),
  });

  const onCursorRef = useRef(onCursor);
  const onScrollRef = useRef(onScrollLine);
  const onReadyRef = useRef(onReady);
  /** 上一次上报给预览的光标行，用于判断"是否明显移动" */
  const lastCursorLine = useRef(1);
  onCursorRef.current = onCursor;
  onScrollRef.current = onScrollLine;
  onReadyRef.current = onReady;

  // ---------------------------------------------------------------- 创建视图
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const initial = useDocs.getState().findByPath(path);
    if (!initial) return;
    lastDispatched.current = initial.text;

    const s = useSettings.getState();

    const extensions: Extension[] = [
      history(),
      bracketMatching(),
      foldGutter({ openText: "▾", closedText: "▸" }),
      search({ top: true }),
      EditorView.lineWrapping,
      // 在空列表项上按回车应"退出列表"。
      //
      // markdown 自带的 insertNewlineContinueMarkup 只在"前面有空行 / 已是第二项之后"
      // 等条件下才去掉标记；两项紧邻时它插入空行并**保留标记**——用户想结束列表，
      // 结果又续了一行 `- `，只能再按一次退格。
      //
      // 自带绑定是 markdown() 内部的 Prec.high(keymap.of([Enter, Backspace]))。
      // 同优先级下**先注册者先跑**，所以这段必须放在 markdown() 之前才拿得到机会；
      // 不是空列表项时返回 false，自然落回自带实现。
      // 同时补上 Backspace（deleteMarkupBackward），避免提高优先级把它挤掉。
      Prec.high(
        keymap.of([
          { key: "Enter", run: exitEmptyListItem },
          { key: "Backspace", run: deleteMarkupBackward },
        ]),
      ),
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
      markdownHighlightStyle,
      markdownTheme,
      headingLineClasses,
      compartments.current.lineNumbers.of(s.showLineNumbers ? lineNumbersExt() : []),
      compartments.current.readOnly.of(EditorState.readOnly.of(initial.readOnly)),
      compartments.current.typewriter.of([]),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            void runCommand("file.save");
            return true;
          },
        },
        {
          key: "Mod-f",
          preventDefault: true,
          run: (view) => {
            openSearchPanel(view);
            return true;
          },
        },
        { key: "Mod-b", preventDefault: true, run: (v) => (toggleWrap(v, "**"), true) },
        { key: "Mod-i", preventDefault: true, run: (v) => (toggleWrap(v, "*"), true) },
        { key: "Mod-e", preventDefault: true, run: (v) => (toggleWrap(v, "`"), true) },
        { key: "Mod-k", preventDefault: true, run: (v) => (insertLink(v), true) },
        indentWithTab,
      ]),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          lastDispatched.current = text;
          useDocs.getState().setText(path, text);
        }
        if (update.docChanged || update.selectionSet) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          const sel = update.state.selection.main;
          onCursorRef.current({
            line: line.number,
            col: head - line.from + 1,
            selectionLength: Math.abs(sel.to - sel.from),
          });
        }
      }),
      EditorView.domEventHandlers({
        scroll: (_ev, view) => {
          const scroller = view.scrollDOM;
          const block = view.lineBlockAtHeight(scroller.scrollTop + 4);
          const line = view.state.doc.lineAt(block.from).number;
          const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          const ratio = maxScroll > 0 ? scroller.scrollTop / maxScroll : 0;
          onScrollRef.current(line, ratio);
          return false;
        },
        // 编辑时光标会跟着走，但**不一定会触发滚动**（还在可视区内时编辑器不滚动），
        // 于是预览停在原处不动 —— 用户看到的就是"按了回车预览不跟着走"。
        // 所以在光标明显移动时也上报一次，让预览跟着编辑位置走。
        // 只报"移动了 3 行以上"，避免逐字符输入时把预览抖来抖去。
        updateListener: (update) => {
          if (!update.selectionSet && !update.docChanged) return false;
          const view = update.view;
          const line = view.state.doc.lineAt(view.state.selection.main.head).number;
          const scroller = view.scrollDOM;
          const visibleTop = view.lineBlockAtHeight(scroller.scrollTop).from;
          const visibleBottom = view.lineBlockAtHeight(
            scroller.scrollTop + scroller.clientHeight,
          ).from;
          const firstVisible = view.state.doc.lineAt(visibleTop).number;
          const lastVisible = view.state.doc.lineAt(visibleBottom).number;

          const outOfView = shouldFollowCursor(line, lastCursorLine.current, firstVisible, lastVisible);
          if (!outOfView) return false;

          lastCursorLine.current = line;
          const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          const ratio = maxScroll > 0 ? scroller.scrollTop / maxScroll : 0;
          onScrollRef.current(line, ratio);
          return false;
        },
      }),
    ];

    let view: EditorView;
    try {
      view = new EditorView({
        state: EditorState.create({ doc: initial.text, extensions }),
        parent: host,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    viewRef.current = view;

    onReadyRef.current(path, {
      replaceAll: (text, line) => replaceAll(view, text, line),
      focus: () => view.focus(),
      scrollToLine: (l) => scrollToLine(view, l),
      currentLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
      openSearch: () => openSearchPanel(view),
    });

    const first = view.state.doc.lineAt(view.state.selection.main.head);
    onCursorRef.current({ line: first.number, col: 1, selectionLength: 0 });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 每个标签一份 EditorView；path 变化时由父组件用 key 重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // ---------------------------------------------------------------- 设置响应
  const showLineNumbers = useSettings((s) => s.showLineNumbers);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: compartments.current.lineNumbers.reconfigure(showLineNumbers ? lineNumbersExt() : []),
    });
  }, [showLineNumbers]);

  const typewriterMode = useSettings((s) => s.typewriterMode);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: compartments.current.typewriter.reconfigure(typewriterMode ? typewriter() : []),
    });
  }, [typewriterMode]);

  const readOnly = useDocs((s) => s.findByPath(path)?.readOnly ?? false);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: compartments.current.readOnly.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  // 内容被**外部替换**时（重新载入 / 采纳磁盘版本 / 另存为落盘）同步进视图。
  //
  // 订阅 loadVersion 而不是 text：text 每次按键都变，订阅它会让编辑器组件
  // 自己也跟着重渲染 —— 而编辑器是命令式的，输入路径上不该有 React 参与。
  const loadVersion = useDocs((s) => s.findByPath(path)?.loadVersion ?? 0);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = useDocs.getState().findByPath(path);
    if (!doc) return;
    const text = doc.text;
    if (text === view.state.doc.toString()) {
      lastDispatched.current = text;
      return;
    }
    replaceAll(view, text);
  }, [loadVersion, path]);

  useEffect(() => {
    if (!visible) return;
    const view = viewRef.current;
    if (!view) return;
    view.focus();
    // 从 display:none 里恢复时必须重新测量：隐藏期间容器没有尺寸，
    // 视口、行高这些几何量都还是旧值（切"编辑 / 预览"就是在隐藏与显示之间来回）。
    view.requestMeasure();
  }, [visible]);

  // 顶栏 / 搜索面板触发的格式命令。
  //
  // "我是不是当前正在编辑的那一个"用**实时 store** 判断，而不是闭包里的 visible：
  // 从搜索面板触发格式命令时会先切回编辑视图，事件可能赶在 React 重新渲染之前到达，
  // 读闭包值会读到 false 而把命令悄悄丢掉。
  useEffect(() => {
    const handler = (ev: Event) => {
      const view = viewRef.current;
      if (!view || !isActiveEditor(path)) return;
      const kind = (ev as CustomEvent<string>).detail;
      switch (kind) {
        case "bold":
          toggleWrap(view, "**");
          break;
        case "italic":
          toggleWrap(view, "*");
          break;
        case "code":
          toggleWrap(view, "`");
          break;
        case "link":
          insertLink(view);
          break;
        case "quote":
          toggleLinePrefix(view, "> ");
          break;
        case "ul":
          toggleLinePrefix(view, "- ");
          break;
        case "ol":
          toggleOrderedList(view);
          break;
        case "outdent":
          outdentLines(view);
          break;
        case "fillList":
          fillListMarkersInSelection(view);
          break;
        case "check":
          void checkDocumentHealth(view.state.doc.toString());
          break;
        default:
          break;
      }
    };
    window.addEventListener("inkdown:format", handler);
    return () => window.removeEventListener("inkdown:format", handler);
  }, [path]);

  // 查找面板
  useEffect(() => {
    const onFind = () => {
      const view = viewRef.current;
      if (!view || !isActiveEditor(path)) return;
      view.focus();
      openSearchPanel(view);
    };
    window.addEventListener("inkdown:find", onFind);
    return () => window.removeEventListener("inkdown:find", onFind);
  }, [path]);

  return (
    <div
      className="editor-host"
      ref={hostRef}
      style={visible ? undefined : { display: "none" }}
      data-error={error ?? undefined}
    />
  );
}

/**
 * 这个编辑器实例现在是不是"用户正在编辑的那一个"。
 *
 * 与 `visible` 同义，但读的是**实时 store**：可见性是 React 渲染出来的，
 * 而事件（格式命令、查找）可能在同一帧里就派发过来。见上面格式命令的注释。
 */
function isActiveEditor(path: string): boolean {
  return useDocs.getState().activePath === path && useSettings.getState().viewMode === "edit";
}

// ---------------------------------------------------------------- 编辑操作

function replaceAll(view: EditorView, text: string, line?: number): void {
  const target = line ?? view.state.doc.lineAt(view.state.selection.main.head).number;
  const fresh = EditorState.create({ doc: text });
  const clamped = Math.max(1, Math.min(target, fresh.doc.lines));
  const info = fresh.doc.line(clamped);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: info.from },
    scrollIntoView: true,
  });
}

function scrollToLine(view: EditorView, line: number): void {
  const l = Math.max(1, Math.min(line, view.state.doc.lines));
  const info = view.state.doc.line(l);
  view.dispatch({
    selection: { anchor: info.from },
    effects: EditorView.scrollIntoView(info.from, { y: "start", yMargin: 20 }),
  });
  view.focus();
}

function toggleWrap(view: EditorView, marker: string): void {
  const sel = view.state.selection.main;
  if (sel.empty) {
    view.dispatch({
      changes: { from: sel.from, insert: marker + marker },
      selection: { anchor: sel.from + marker.length },
    });
    view.focus();
    return;
  }
  const text = view.state.sliceDoc(sel.from, sel.to);
  const wrapped =
    text.length > marker.length * 2 && text.startsWith(marker) && text.endsWith(marker);
  if (wrapped) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text.slice(marker.length, -marker.length) },
    });
  } else {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: marker + text + marker },
      selection: { anchor: sel.from + marker.length, head: sel.to + marker.length },
    });
  }
  view.focus();
}

/** 逐行加/去前缀（引用、无序列表） */
function toggleLinePrefix(view: EditorView, prefix: string): void {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);
  const changes: ChangeSpec[] = [];
  let allPrefixed = true;

  for (let n = startLine.number; n <= endLine.number; n++) {
    if (!view.state.doc.line(n).text.startsWith(prefix)) allPrefixed = false;
  }

  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = view.state.doc.line(n);
    if (allPrefixed) {
      if (line.text.startsWith(prefix)) {
        changes.push({ from: line.from, to: line.from + prefix.length, insert: "" });
      }
    } else if (!line.text.startsWith(prefix)) {
      changes.push({ from: line.from, insert: prefix });
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

function toggleOrderedList(view: EditorView): void {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);
  const changes: ChangeSpec[] = [];
  let index = 1;
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = view.state.doc.line(n);
    const existing = /^(\d+)\.\s/.exec(line.text);
    if (existing) {
      changes.push({ from: line.from, to: line.from + existing[0].length, insert: "" });
    } else {
      changes.push({ from: line.from, insert: `${index}. ` });
      index++;
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
}

function insertLink(view: EditorView): void {
  const sel = view.state.selection.main;
  const label = sel.empty ? "链接文字" : view.state.sliceDoc(sel.from, sel.to);
  const snippet = `[${label}](url)`;
  const urlStart = sel.from + label.length + 3;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: snippet },
    selection: { anchor: urlStart, head: urlStart + 3 },
  });
  view.focus();
}

/**
 * 整段贴左：去掉选区各行开头的全部空白（含全角空格）。
 *
 * 纯逻辑在 mdcore.ts 的 outdentAmounts 里（有单测），这里只做 CodeMirror 的
 * 选区映射。**不要 export 这个函数**：组件文件里导出非组件符号会让
 * react-refresh 失效（"incompatible export"），改编辑器代码就得整页刷新。
 */
function outdentLines(view: EditorView): void {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);
  const lines: string[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    lines.push(view.state.doc.line(n).text);
  }

  const amounts = outdentAmounts(lines);
  const changes: ChangeSpec[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const strip = amounts[i] ?? 0;
    if (strip <= 0) continue;
    const line = view.state.doc.line(startLine.number + i);
    changes.push({ from: line.from, to: line.from + strip, insert: "" });
  }

  if (changes.length) view.dispatch({ changes });
  view.focus();
}

/**
 * 给选区里"缺标记"的列表行补上 `- `。
 *
 * 场景：从聊天记录复制名单，通常只有第一行带 `- `，后面几行会被当成
 * **第一个列表项的续行**——预览里变成一个圆点套好几行。这条命令把它们
 * 补成真正的同级列表项。
 */
function fillListMarkersInSelection(view: EditorView): void {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);
  const lines: string[] = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    lines.push(view.state.doc.line(n).text);
  }

  const { text, added } = fillListMarkers(lines.join("\n"));
  if (added === 0) {
    view.focus();
    return;
  }

  view.dispatch({
    changes: { from: startLine.from, to: endLine.to, insert: text },
    selection: { anchor: startLine.from, head: startLine.from + text.length },
  });
  view.focus();
}

/**
 * 在空标记行上按回车 → 退出标记（去掉标记，留一个空行）。
 *
 * 不是空标记行时返回 false，让 markdown 自带的续行逻辑接手。
 *
 * **必须由语法树确认光标真的在标记里**，只看行的文本是不够的：
 *   - 代码块里常常有单独的 `- `、`> `、`1. `（写 Markdown 教程时必然出现），
 *     它们是示例内容。早期实现没做判断，在代码块里按回车会**把整行删掉**。
 *   - 反过来，`- ` 也可能只是普通段落里的一小段文本，
 *     不该因为"长得像标记"就被删掉。
 *
 * 所以这里要求：光标所在位置必须处于列表 / 引用 / 任务列表节点内，
 * 且最近的块节点不是代码块。
 */
function exitEmptyListItem(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  if (!isInMarkupContext(view, sel.from)) return false;

  const doc = view.state.doc;
  const line = doc.lineAt(sel.from);
  // 行内偏移：有换行符时比文本长度多 1，这样"删整行"会连换行一起删掉
  const lineLength = line.length + (line.to > line.from + line.length ? 1 : 0);
  const info = emptyListItem(line.text, sel.from - line.from, line.number === doc.lines, lineLength);
  if (!info) return false;

  view.dispatch({
    changes: { from: line.from + info.deleteFrom, to: line.from + info.deleteTo, insert: info.insert },
    selection: { anchor: line.from + info.insert.length },
    scrollIntoView: true,
  });
  return true;
}

/** 代码类节点：这些里面的内容一律不碰 */
const CODE_NODES = new Set(["FencedCode", "CodeBlock", "CodeText", "InlineCode", "CodeInfo"]);
/** 标记类节点：只有光标处于这些节点内，才认为"这是真的标记" */
const MARKUP_NODES = new Set([
  "BulletList",
  "OrderedList",
  "ListItem",
  "Blockquote",
  "QuoteMark",
  "ListMark",
  "Task",
]);

/**
 * 判断光标是否处于"真的标记"上下文里。
 *
 * 从光标位置向外逐层走语法树：
 *   - 先撞到代码节点 → 不是标记（代码块内不处理）
 *   - 撞到标记节点 → 是标记（列表 / 引用 / 任务列表）
 *   - 走到文档根都没撞到 → 只是普通文本，不该处理
 */
function isInMarkupContext(view: EditorView, pos: number): boolean {
  let node = syntaxTree(view.state).resolveInner(pos, -1);
  while (node) {
    if (CODE_NODES.has(node.name)) return false;
    if (MARKUP_NODES.has(node.name)) return true;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

/** 文档结构自检：把问题用对话框列出来，并跳到第一处 */
async function checkDocumentHealth(text: string): Promise<void> {
  const { checkDocument } = await import("../services/mdcore");
  const { showMessage, useUi } = await import("../store/ui");

  const issues = checkDocument(text);
  if (issues.length === 0) {
    useUi.getState().toast("结构检查通过：没有发现未闭合的代码块");
    return;
  }
  const lines = issues.slice(0, 8).map((it) => `第 ${it.line} 行：${it.message}`).join("\n");
  const more = issues.length > 8 ? `\n\n（还有 ${issues.length - 8} 处未列出）` : "";
  await showMessage(
    `发现 ${issues.length} 处结构问题`,
    `${lines}${more}\n\n提示：围栏（\`\`\`）必须独立成行；没闭合时，它后面的内容都会被当成代码。`,
  );
}

// ---------------------------------------------------------------- 扩展
/** 打字机模式：光标所在行停在视口纵向 45% 处 */
function typewriter(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet) return;
    const view = update.view;
    if (view.composing) return; // 输入法组合期间不要动滚动，否则候选框会跳
    const head = update.state.selection.main.head;
    const block = view.lineBlockAt(head);
    const target = view.scrollDOM.scrollTop + block.top - view.scrollDOM.clientHeight * 0.45;
    view.scrollDOM.scrollTop = Math.max(0, target);
  });
}

const headingClass = Decoration.line({ class: "cm-md-heading-line" });
const codeClass = Decoration.line({ class: "cm-md-code-line" });
const quoteClass = Decoration.line({ class: "cm-md-quote-line" });

/**
 * 行级装饰：给标题、围栏代码块、引用行挂 class。
 *
 * 只遍历语法树的顶层块节点（O(块数)，不是 O(行数)），
 * 因此几万行的文档也不会在每次输入时卡住。
 * 行装饰必须落在行首，块节点的 from 天然满足这个条件。
 *
 * 节点名来自 @lezer/markdown 的语法（ATXHeading1-6 / FencedCode / CodeBlock /
 * Blockquote）。要复核的话：
 *   node -e "const{parser}=require('@lezer/markdown');parser.parse('# a\n> b').iterate({enter:n=>console.log(n.name)})"
 */
const headingLineClasses: Extension = EditorView.decorations.compute(["doc"], (state) => {
  const marks: { from: number; deco: Decoration }[] = [];
  const tree = syntaxTree(state);
  const doc = state.doc;

  tree.iterate({
    from: 0,
    to: doc.length,
    enter: (node) => {
      const name = node.name;
      if (name === "Document") return true; // 只下钻一层
      if (/^ATXHeading[1-6]$/.test(name)) {
        marks.push({ from: node.from, deco: headingClass });
      } else if (name === "FencedCode" || name === "CodeBlock") {
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(Math.min(node.to, doc.length)).number;
        for (let n = first; n <= last; n++) {
          marks.push({ from: doc.line(n).from, deco: codeClass });
        }
      } else if (name === "Blockquote") {
        const first = doc.lineAt(node.from).number;
        const last = doc.lineAt(Math.min(node.to, doc.length)).number;
        for (let n = first; n <= last; n++) {
          marks.push({ from: doc.line(n).from, deco: quoteClass });
        }
      }
      return false; // 不再深入块内部
    },
  });

  marks.sort((a, b) => a.from - b.from);
  return Decoration.set(
    marks.map((m) => m.deco.range(m.from)),
    true,
  );
});
