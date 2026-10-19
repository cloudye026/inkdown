// 路径与文件名校验的单测。
//
// 这一层的价值在于：新建/重命名失败时能给出**具体原因**，
// 而不是上一版那种"点了没反应"或者一句没有信息量的"新建失败"。

import test from "node:test";
import assert from "node:assert/strict";

import {
  basename,
  checkFileName,
  dirname,
  joinPath,
  relativeTo,
  stem,
  suggestFreeName,
} from "../src/services/pathUtils.ts";

test("checkFileName 拒绝空名字", () => {
  for (const input of ["", "   ", "\t"]) {
    const r = checkFileName(input);
    assert.equal(r.ok, false, `「${input}」应被拒绝`);
    assert.ok(r.reason, "必须给出原因");
  }
});

test("checkFileName 拒绝 Windows 非法字符", () => {
  for (const ch of ["<", ">", ":", '"', "|", "?", "*"]) {
    const r = checkFileName(`笔记${ch}1.md`);
    assert.equal(r.ok, false, `含 ${ch} 应被拒绝`);
    assert.match(r.reason ?? "", new RegExp(`\\${ch}`), "原因里应指出那个字符");
  }
});

test("checkFileName 拒绝系统保留名", () => {
  for (const name of ["CON", "con.md", "PRN", "aux.txt", "COM1", "lpt9.md"]) {
    const r = checkFileName(name);
    assert.equal(r.ok, false, `${name} 是保留名`);
    assert.match(r.reason ?? "", /保留/);
  }
});

test("checkFileName 拒绝以句点结尾（Windows 会静默截断）", () => {
  assert.equal(checkFileName("笔记.").ok, false);
  // 尾部分隔符会被规范化掉：这是"在 notes 目录下新建"的合理输入
  const dirLike = checkFileName("notes/");
  assert.equal(dirLike.ok, true);
  assert.equal(dirLike.normalized, "notes");
  // 尾部空格是常见手滑，直接帮用户去掉，不算错误
  const spaced = checkFileName("笔记.md   ", { requireMd: true });
  assert.equal(spaced.ok, true);
  assert.equal(spaced.normalized, "笔记.md");
});

test("checkFileName 去掉首尾空格并规范化分隔符", () => {
  const r = checkFileName("  notes//todo.md  ", { requireMd: true });
  assert.equal(r.ok, true);
  assert.equal(r.normalized, "notes/todo.md");
});

test("checkFileName 允许带子目录的相对路径", () => {
  const r = checkFileName("会议/2026/周会.md", { requireMd: true });
  assert.equal(r.ok, true);
  assert.equal(r.normalized, "会议/2026/周会.md");
});

test("checkFileName 拒绝 .. 穿越", () => {
  for (const input of ["../秘密.md", "notes/../../x.md", "a/./b.md"]) {
    const r = checkFileName(input, { requireMd: true });
    assert.equal(r.ok, false, `${input} 应被拒绝`);
  }
});

test("checkFileName requireMd 要求 markdown 扩展名", () => {
  assert.equal(checkFileName("笔记.txt", { requireMd: true }).ok, false);
  assert.equal(checkFileName("笔记", { requireMd: true }).ok, false);
  assert.equal(checkFileName("笔记.markdown", { requireMd: true }).ok, true);
  assert.equal(checkFileName("笔记.MD", { requireMd: true }).ok, true);
  // 不要求扩展名时，文件夹名可以是任意合法名字
  assert.equal(checkFileName("我的笔记").ok, true);
});

test("suggestFreeName 依次往后找可用名字", () => {
  const taken = new Set(["D:\\ws\\todo.md", "D:\\ws\\todo-2.md"]);
  const exists = (p) => taken.has(p);
  const next = suggestFreeName("D:\\ws\\todo.md", exists);
  assert.equal(next, "D:\\ws\\todo-3.md");
});

test("suggestFreeName 不冲突时直接给 -2", () => {
  const next = suggestFreeName("D:\\ws\\note.md", () => false);
  assert.equal(next, "D:\\ws\\note-2.md");
});

test("suggestFreeName 保留扩展名且支持无扩展名", () => {
  assert.equal(suggestFreeName("/ws/a.markdown", () => false), "/ws/a-2.markdown");
  assert.equal(suggestFreeName("/ws/readme", () => false), "/ws/readme-2");
});

test("joinPath 跟随目录已有的分隔符风格", () => {
  assert.equal(joinPath("D:\\mddeveloper\\samples", "a.md"), "D:\\mddeveloper\\samples\\a.md");
  assert.equal(joinPath("/home/me/notes", "a.md"), "/home/me/notes/a.md");
  // 目录末尾已有分隔符时不重复
  assert.equal(joinPath("D:\\ws\\", "a.md"), "D:\\ws\\a.md");
  // 名字以分隔符开头时不留双斜杠
  assert.equal(joinPath("D:\\ws", "\\a.md"), "D:\\ws\\a.md");
});

test("joinPath 与 checkFileName 组合出正确的落盘路径", () => {
  const ws = "D:\\mddeveloper\\samples";
  const check = checkFileName("notes/todo.md", { requireMd: true });
  assert.equal(check.ok, true);
  // 子目录用正斜杠输入，落盘时必须统一成 Windows 风格，不能混用分隔符
  assert.equal(joinPath(ws, check.normalized), "D:\\mddeveloper\\samples\\notes\\todo.md");
  // POSIX 风格目录同理
  assert.equal(joinPath("/home/me/ws", check.normalized), "/home/me/ws/notes/todo.md");
  // 反斜杠输入在 POSIX 目录下也要被归一
  assert.equal(joinPath("/home/me/ws", "notes\\todo.md"), "/home/me/ws/notes/todo.md");
});

test("basename / dirname / stem 处理混用分隔符", () => {
  assert.equal(basename("D:\\ws\\sub\\a.md"), "a.md");
  assert.equal(basename("/ws/sub/a.md"), "a.md");
  // dirname 保留原有分隔符风格，否则后续 joinPath 会拼出混用路径
  assert.equal(dirname("D:\\ws\\sub\\a.md"), "D:\\ws\\sub");
  assert.equal(dirname("/ws/sub/a.md"), "/ws/sub");
  assert.equal(dirname("D:\\a.md"), "D:\\");
  assert.equal(stem("D:\\ws\\a.md"), "a");
  assert.equal(stem("D:\\ws\\noext"), "noext");
});

test("relativeTo 给出工作区内的短路径", () => {
  assert.equal(relativeTo("D:\\ws", "D:\\ws\\sub\\a.md"), "sub/a.md");
  assert.equal(relativeTo(null, "D:\\ws\\a.md"), "D:\\ws\\a.md");
  assert.equal(relativeTo("D:\\ws", "E:\\other\\a.md"), "E:/other/a.md");
});
