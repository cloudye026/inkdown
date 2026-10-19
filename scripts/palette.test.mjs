// 搜索面板的结果构建（services/palette.ts）单元测试。
//
// 这里锁住的是一条**产品决定**：面板只有一个，同一个输入框既搜命令也搜文件，
// 命令永远排在文件前面。以前是"跳转"和"命令"两个面板，用户得先想清楚
// 自己要找的东西算文件还是算功能——这条测试防止它退化回两套逻辑。

import test from "node:test";
import assert from "node:assert/strict";

import { buildPaletteItems, scoreMatch } from "../src/services/palette.ts";

const commands = [
  { id: "file.open", title: "打开文件…", hint: "Ctrl+O", run: () => {} },
  { id: "file.save", title: "保存", hint: "Ctrl+S", run: () => {} },
  { id: "edit.bold", title: "加粗", hint: "Ctrl+B", run: () => {} },
  { id: "edit.check", title: "结构自检（代码块围栏是否闭合）", run: () => {} },
];

const workspace = "D:\\notes";
const files = [
  "D:\\notes\\demo.md",
  "D:\\notes\\sub\\bold-note.md",
  "D:\\notes\\readme.md",
];

function build(query, extra = {}) {
  return buildPaletteItems({
    query,
    commands,
    files,
    workspace,
    openFile: () => {},
    ...extra,
  });
}

test("空查询只列命令，不把几千个文件铺一屏", () => {
  const items = build("");
  assert.equal(items.length, commands.length);
  assert.ok(items.every((i) => i.kind === "command"));
  // 顺序就是注册顺序，用户按位置记快捷键时不会错位
  assert.deepEqual(
    items.map((i) => i.title),
    commands.map((c) => c.title),
  );
});

test("同一个查询同时命中命令与文件，且命令排在文件前面", () => {
  const items = build("bold");
  const kinds = items.map((i) => i.kind);
  assert.deepEqual(kinds, ["command", "file"]);
  assert.equal(items[0].title, "加粗");
  assert.equal(items[1].title, "bold-note.md");
});

test("文件结果给出工作区内的相对路径", () => {
  const file = build("readme").find((i) => i.kind === "file");
  assert.equal(file.sub, "readme.md");
});

test("按 id 也能搜到命令（英文习惯的用户敲 save 也能用）", () => {
  const items = build("file.save");
  assert.equal(items[0].key, "cmd:file.save");
});

test("模糊匹配：字符按序出现即可命中，不必连续", () => {
  assert.ok(scoreMatch("demo.md", "dmd") > 0, "d-m-d 在 demo.md 里是顺序出现的");
  assert.equal(scoreMatch("demo.md", "mdx"), 0, "没有 x 就不该命中");
  const items = build("dmd");
  assert.equal(items[0].title, "demo.md");
});

test("中文标题按子串命中（面板里可以直接打「自检」）", () => {
  const items = build("自检");
  assert.equal(items[0].title, "结构自检（代码块围栏是否闭合）");
  assert.equal(items[0].sub, "");
});

test("命令与文件的 key 不会互相撞车", () => {
  const items = build("bold");
  const keys = items.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((k) => k.startsWith("cmd:") || k.startsWith("file:")));
});

test("文件结果受上限约束，命令不受影响", () => {
  const many = Array.from({ length: 500 }, (_, i) => `D:\\notes\\note-${i}.md`);
  const items = buildPaletteItems({
    query: "note",
    commands,
    files: many,
    workspace,
    openFile: () => {},
    fileLimit: 10,
  });
  assert.equal(items.filter((i) => i.kind === "file").length, 10);
});

test("没有工作区时只剩命令，不会误报文件结果", () => {
  const items = build("demo", { workspace: null });
  assert.ok(items.every((i) => i.kind === "command"));
  assert.equal(items.length, 0);
});

test("回车执行的是被选中那条自己的动作", () => {
  const opened = [];
  const items = buildPaletteItems({
    query: "demo",
    commands,
    files,
    workspace,
    openFile: (p) => opened.push(p),
  });
  items[0].run();
  assert.deepEqual(opened, ["D:\\notes\\demo.md"]);
});

test("scoreMatch：文件名命中优先于目录名命中", () => {
  const inName = scoreMatch("sub/note-demo.md", "demo");
  const inDir = scoreMatch("demo/sub/note.md", "demo");
  assert.ok(inName > inDir, `${inName} 应大于 ${inDir}`);
  assert.equal(scoreMatch("abc.md", "zzz"), 0);
});
