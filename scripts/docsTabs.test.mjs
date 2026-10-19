// 标签去重规则的测试。
//
// 背景：同一路径绝不能同时开出两个标签——各自的未保存状态、光标、撤销历史
// 都会分叉，用户一保存就互相覆盖。这里把去重规则钉死：
//   1) openFile 对已打开的文件直接复用标签（含大小写/分隔符差异）
//   2) 并发调用同一个文件只开一个标签
//   3) adoptPath（未命名文档落盘）拒绝路径已被占用的情况
//   4) rekey（重命名）拒绝改成已打开文件的名字

import test from "node:test";
import assert from "node:assert/strict";

import { useDocs } from "../src/store/docs.ts";
import { scanHeadings } from "../src/services/mdcore.ts";

void scanHeadings;

const docs = () => useDocs.getState();

function reset() {
  useDocs.setState({ docs: [], activePath: null, order: [] });
}

function fakeDoc(path) {
  return {
    path,
    name: path.replace(/\\/g, "/").split("/").pop() ?? path,
    saved: "",
    text: "",
    loadVersion: 0,
    encoding: "UTF-8",
    bom: false,
    eol: null,
    diskMtimeMs: 1,
    openedMtimeMs: 1,
    readOnly: false,
    conflict: false,
    missing: false,
    outline: [],
    size: 0,
  };
}

// ---------------------------------------------------------------
// order 的作用：App 订阅它而不是 docs，这样输入时不会重渲染整棵树。
// 所以它必须在增删文档时更新，而在**输入时绝不能变**。
// ---------------------------------------------------------------

test("order 与 docs 保持一致（增删改时同步）", () => {
  reset();
  useDocs.setState({
    docs: [fakeDoc("D:\\ws\\a.md"), fakeDoc("D:\\ws\\b.md")],
    order: ["D:\\ws\\a.md", "D:\\ws\\b.md"],
    activePath: "D:\\ws\\a.md",
  });

  docs().close("D:\\ws\\a.md");
  assert.deepEqual(docs().order, ["D:\\ws\\b.md"], "关闭后 order 要同步");

  docs().closeOthers("D:\\ws\\b.md");
  assert.deepEqual(docs().order, ["D:\\ws\\b.md"]);

  docs().rekey("D:\\ws\\b.md", "D:\\ws\\c.md");
  assert.deepEqual(docs().order, ["D:\\ws\\c.md"], "改名后 order 要跟着换");

  docs().close("D:\\ws\\c.md");
  assert.deepEqual(docs().order, [], "全部关闭后为空");
});

test("**输入时 order 必须保持不变**（否则 App 会跟着重渲染）", () => {
  reset();
  useDocs.setState({
    docs: [fakeDoc("D:\\ws\\a.md")],
    order: ["D:\\ws\\a.md"],
    activePath: "D:\\ws\\a.md",
  });
  const before = docs().order;

  for (const text of ["a", "ab", "abc", "abcd"]) {
    docs().setText("D:\\ws\\a.md", text);
  }

  assert.equal(docs().order, before, "order 的引用都不该变（组件才不会被唤醒）");
  assert.deepEqual(docs().order, ["D:\\ws\\a.md"]);
  assert.equal(docs().findByPath("D:\\ws\\a.md").text, "abcd", "文本要正常更新");
});

test("输入不会改动 docs 的其它字段（避免无谓的重渲染）", () => {
  reset();
  const doc = { ...fakeDoc("D:\\ws\\a.md"), encoding: "GB18030", readOnly: true };
  useDocs.setState({ docs: [doc], order: [doc.path], activePath: doc.path });

  docs().setText(doc.path, "新内容");

  const after = docs().findByPath(doc.path);
  assert.equal(after.text, "新内容");
  assert.equal(after.encoding, "GB18030", "编码等字段不应被输入影响");
  assert.equal(after.readOnly, true);
  assert.equal(after.loadVersion, 0, "输入不该递增 loadVersion（那是外部替换才用的）");
});

test("findByPath 忽略大小写与分隔符差异（Windows 路径的坑）", () => {
  reset();
  useDocs.setState({ docs: [fakeDoc("D:\\ws\\Notes\\A.md")], activePath: null });

  assert.ok(docs().findByPath("D:\\ws\\Notes\\A.md"), "完全相同应命中");
  assert.ok(docs().findByPath("d:\\ws\\notes\\a.md"), "大小写不同应命中");
  assert.ok(docs().findByPath("D:/ws/Notes/A.md"), "分隔符不同应命中");
  assert.equal(docs().findByPath("D:\\ws\\Notes\\B.md"), undefined, "不同文件不应命中");
});

test("adoptPath 在目标路径已被别的标签打开时拒绝", () => {
  reset();
  useDocs.setState({
    docs: [fakeDoc("untitled:1"), fakeDoc("D:\\ws\\demo.md")],
    activePath: "untitled:1",
  });

  const res = docs().adoptPath("untitled:1", "D:\\ws\\demo.md", { mtimeMs: 2, size: 3 });

  assert.equal(res.ok, false, "必须拒绝，否则会出现两个指向同一文件的标签");
  assert.equal(res.existingPath, "D:\\ws\\demo.md");

  // 关键：拒绝后状态不能被改动
  const stillTemp = docs().findByPath("untitled:1");
  assert.ok(stillTemp, "未命名标签应保持原样");
  assert.equal(docs().docs.length, 2, "标签数量不应变化");
  assert.equal(docs().activePath, "untitled:1");
});

test("adoptPath 在目标未被占用时正常落盘并保留内容", () => {
  reset();
  const temp = { ...fakeDoc("untitled:2"), text: "草稿内容", saved: "" };
  useDocs.setState({ docs: [temp], activePath: "untitled:2" });

  const res = docs().adoptPath("untitled:2", "D:\\ws\\新笔记.md", { mtimeMs: 9, size: 12 });

  assert.equal(res.ok, true);
  const doc = docs().findByPath("D:\\ws\\新笔记.md");
  assert.ok(doc, "应改成真实路径");
  assert.equal(doc.name, "新笔记.md", "标签名应跟着更新");
  assert.equal(doc.text, "草稿内容", "内容不能丢");
  assert.equal(doc.saved, "草稿内容", "落盘后应视为已保存");
  assert.equal(doc.diskMtimeMs, 9);
  assert.equal(doc.size, 12);
  assert.equal(docs().activePath, "D:\\ws\\新笔记.md", "活动标签要指向新路径");
  assert.equal(docs().findByPath("untitled:2"), undefined, "旧的临时路径不应残留");
});

test("rekey 后标签路径与活动标签一起更新", () => {
  reset();
  useDocs.setState({ docs: [fakeDoc("D:\\ws\\old.md")], activePath: "D:\\ws\\old.md" });

  docs().rekey("D:\\ws\\old.md", "D:\\ws\\new.md");

  assert.ok(docs().findByPath("D:\\ws\\new.md"));
  assert.equal(docs().findByPath("D:\\ws\\old.md"), undefined);
  assert.equal(docs().activePath, "D:\\ws\\new.md");
});

test("close 之后活动标签回退到相邻项，不会指向已关闭的文件", () => {
  reset();
  useDocs.setState({
    docs: [fakeDoc("D:\\ws\\a.md"), fakeDoc("D:\\ws\\b.md"), fakeDoc("D:\\ws\\c.md")],
    activePath: "D:\\ws\\b.md",
  });

  docs().close("D:\\ws\\b.md");

  assert.equal(docs().docs.length, 2);
  assert.ok(
    docs().docs.some((d) => d.path === docs().activePath),
    "activePath 必须指向仍然存在的标签",
  );
});

test("closeOthers 只留下指定标签", () => {
  reset();
  useDocs.setState({
    docs: [fakeDoc("D:\\ws\\a.md"), fakeDoc("D:\\ws\\b.md")],
    activePath: "D:\\ws\\a.md",
  });

  docs().closeOthers("D:\\ws\\b.md");

  assert.deepEqual(
    docs().docs.map((d) => d.path),
    ["D:\\ws\\b.md"],
  );
  assert.equal(docs().activePath, "D:\\ws\\b.md", "留下的那个应成为活动标签");
});
