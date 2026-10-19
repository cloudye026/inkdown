// 文件类型判定：图标画错很难在界面上一眼发现，所以把分类表测住。
import test from "node:test";
import assert from "node:assert/strict";
import { extOf, fileKind, treeIconKind } from "../src/services/fileKind.ts";

test("extOf：取小写扩展名，点文件与无扩展名不误判", () => {
  assert.equal(extOf("a.md"), "md");
  assert.equal(extOf("A.MD"), "md");
  assert.equal(extOf("dir/sub/x.tar.gz"), "gz");
  assert.equal(extOf("D:\\work\\a.markdown"), "markdown");
  assert.equal(extOf(".gitignore"), "", "以点开头的名字没有扩展名");
  assert.equal(extOf("Makefile"), "");
  assert.equal(extOf(""), "");
});

test("fileKind：常见 Markdown 后缀都认", () => {
  for (const n of ["a.md", "b.markdown", "c.mdown", "d.mkd", "e.mdx", "笔记.md"]) {
    assert.equal(fileKind(n), "markdown", `${n} 应判为 markdown`);
  }
});

test("fileKind：图片 / 代码 / 数据 / 文本分开", () => {
  assert.equal(fileKind("a.png"), "image");
  assert.equal(fileKind("b.JPEG"), "image");
  assert.equal(fileKind("c.svg"), "image");
  assert.equal(fileKind("d.ts"), "code");
  assert.equal(fileKind("e.py"), "code");
  assert.equal(fileKind("f.rs"), "code");
  assert.equal(fileKind("g.css"), "code");
  assert.equal(fileKind("h.sh"), "code");
  assert.equal(fileKind("i.json"), "data");
  assert.equal(fileKind("j.yml"), "data");
  assert.equal(fileKind("k.toml"), "data");
  assert.equal(fileKind("l.txt"), "text");
});

test("fileKind：没有扩展名的已知文件名（Dockerfile / Makefile / README）", () => {
  assert.equal(fileKind("Dockerfile"), "code");
  assert.equal(fileKind("Makefile"), "code");
  assert.equal(fileKind("README"), "markdown");
  assert.equal(fileKind("README.md"), "markdown", "主名命中也要认");
  assert.equal(fileKind("LICENSE"), "text");
});

test("fileKind：点文件当配置，未知扩展名落到 other", () => {
  assert.equal(fileKind(".gitignore"), "data");
  assert.equal(fileKind(".editorconfig"), "data");
  assert.equal(fileKind("weird.zzz"), "other");
  assert.equal(fileKind("noext"), "other");
});

test("treeIconKind：文件夹按展开状态换图标，文件按类型", () => {
  assert.equal(treeIconKind("docs", true, false), "folder");
  assert.equal(treeIconKind("docs", true, true), "folder-open");
  assert.equal(treeIconKind("docs", true, undefined), "folder", "没传状态时用合上的图标");
  assert.equal(treeIconKind("a.md", false), "markdown");
  assert.equal(treeIconKind("a.png", false), "image");
  // 未知扩展名画通用文件图标，而不是空着
  assert.equal(treeIconKind("a.zzz", false), "file");
  assert.equal(treeIconKind("a.zzz", false), "file");
});

test("图标种类之间互不重复（不允许两种类型共用同一个图标）", () => {
  const seen = new Map();
  for (const name of ["a.md", "a.png", "a.ts", "a.yml", "a.txt", "a.zzz"]) {
    const k = treeIconKind(name, false);
    if (seen.has(k)) {
      // 允许 text 与 file 有各自的图标即可；同一种类复用同一个图标是正常的，
      // 这里只要求"不同文件类型不要挤到同一个种类上"
    }
    seen.set(name, k);
  }
  const kinds = [...seen.values()];
  assert.equal(new Set(kinds).size, kinds.length, "六种文件应落到六个不同种类");
});
