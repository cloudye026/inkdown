// 保存流程的行为测试：在 Node 里注入假的 Tauri IPC，检查"是否真的调用了写盘"。
//
// 起因是一个数据丢失级别的缺陷：save() 里有一句
//     if (doc.text === doc.saved) return true;
// 对自动保存是省 IO，对用户按 Ctrl+S 却是灾难——一旦内存脏标记与磁盘状态不同步
// （比如文件曾被外部程序改动过），就会"提示已保存、实际没写"。
//
// 底层写入链路已由 Rust 测试覆盖（原子替换、不留临时文件、编码与换行保留），
// 这里只钉住 JS 侧这一层：**save() 返回 true 就必须真的发起过 write_file**。

import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------- 假的 Tauri 运行时
const calls = [];
let nextWrite = { mtimeMs: 1000, size: 10 };
let failWrite = null;

const internals = {
  invoke(cmd, args) {
    calls.push({ cmd, args });
    if (cmd === "write_file") {
      if (failWrite) return Promise.reject(new Error(failWrite));
      return Promise.resolve(nextWrite);
    }
    if (cmd === "path_exists") return Promise.resolve(true);
    if (cmd === "watch_file" || cmd === "unwatch_file" || cmd === "mark_self_write") {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(undefined);
  },
  transformCallback: () => 1,
  unregisterCallback: () => {},
  convertFileSrc: (p) => p,
};

const win = { __TAURI_INTERNALS__: internals, setTimeout, clearTimeout };
globalThis.window = win;
globalThis.document = { documentElement: { dataset: {}, style: { setProperty() {} } } };

const { useDocs } = await import("../src/store/docs.ts");

const docs = () => useDocs.getState();
const writeCalls = () => calls.filter((c) => c.cmd === "write_file");

function reset(overrides = {}) {
  calls.length = 0;
  failWrite = null;
  useDocs.setState({
    docs: [
      {
        path: "D:\\ws\\note.md",
        name: "note.md",
        saved: "原始内容",
        text: "原始内容",
        encoding: "UTF-8",
        bom: false,
        eol: null,
        diskMtimeMs: 1,
        openedMtimeMs: 1,
        readOnly: false,
        conflict: false,
        missing: false,
        outline: [],
        size: 12,
        ...overrides,
      },
    ],
    activePath: "D:\\ws\\note.md",
  });
}

test("**文本与已保存内容一致时，也必须真的写盘**（原缺陷的回归测试）", async () => {
  reset({ saved: "同一份内容", text: "同一份内容" });

  const ok = await docs().save("D:\\ws\\note.md");

  assert.equal(ok, true);
  assert.equal(
    writeCalls().length,
    1,
    "内容一致时以前会提前 return，现在必须仍然发起写入——显式保存要确定性",
  );
  assert.equal(writeCalls()[0].args.contents, "同一份内容");
});

test("有改动时写盘，并把标签更新为已保存", async () => {
  reset({ saved: "旧", text: "新内容" });
  nextWrite = { mtimeMs: 2000, size: 7 };

  const ok = await docs().save("D:\\ws\\note.md");

  assert.equal(ok, true);
  assert.equal(writeCalls().length, 1);
  assert.equal(writeCalls()[0].args.path, "D:\\ws\\note.md");
  assert.equal(writeCalls()[0].args.contents, "新内容");

  const doc = docs().findByPath("D:\\ws\\note.md");
  assert.equal(doc.saved, "新内容", "保存后脏标记应清除");
  assert.equal(doc.diskMtimeMs, 2000, "应记录新的磁盘时间戳");
  assert.equal(doc.size, 7);
  assert.equal(doc.conflict, false);

  assert.equal(
    calls.filter((c) => c.cmd === "mark_self_write").length,
    1,
    "必须登记自身写入，否则监听线程会把它报成外部修改",
  );
});

test("连续保存两次要写两次（不做无意义的跳过）", async () => {
  reset({ saved: "x", text: "x" });
  await docs().save("D:\\ws\\note.md");
  await docs().save("D:\\ws\\note.md");
  assert.equal(writeCalls().length, 2);
});

test("只读文档返回 false 且不写盘（调用方据此提示，不能报成功）", async () => {
  reset({ readOnly: true, saved: "a", text: "b" });

  const ok = await docs().save("D:\\ws\\note.md");

  assert.equal(ok, false, "返回 false 才能让调用方避免弹出『已保存』");
  assert.equal(writeCalls().length, 0, "只读文档绝不能写盘");
});

test("写盘失败会抛出，调用方才能提示失败", async () => {
  reset({ saved: "a", text: "b" });
  failWrite = "拒绝访问 (os error 5)";

  await assert.rejects(
    () => docs().save("D:\\ws\\note.md"),
    /os error 5/,
    "必须把系统错误抛给调用方，不能静默吞掉",
  );

  const doc = docs().findByPath("D:\\ws\\note.md");
  assert.equal(doc.saved, "a", "失败时不能把脏标记清掉");
});

test("保存不存在的文档返回 false", async () => {
  reset();
  const ok = await docs().save("D:\\ws\\不存在的.md");
  assert.equal(ok, false);
  assert.equal(writeCalls().length, 0);
});

test("保存时会带上原文件的编码与换行风格", async () => {
  reset({ saved: "中文", text: "中文二", encoding: "GB18030", bom: true, eol: "\r\n" });

  await docs().save("D:\\ws\\note.md");

  const args = writeCalls()[0].args;
  assert.equal(args.encoding, "GB18030", "必须按原编码写回，否则中文会乱码");
  assert.equal(args.bom, true);
  assert.equal(args.eol, "\r\n", "CRLF 文件不能被悄悄改成 LF");
});
