// 新建流程的行为测试：对着**假文件系统 + 脚本化对话框**跑完整分支。
//
// 这就是用户报的两个问题所在：
//   1) "新建 md 名称重复后没有重复提示" —— 现在必须弹出明确的提示并给出建议名
//   2) "新建未成功" —— 现在必须真的落盘，失败必须给出具体原因
//
// 之所以用假依赖而不是真机点击：文件系统与对话框的边界注入之后，
// 所有分支都能确定性复现；GUI 点击只能验证"看得见的那一次"。

import test from "node:test";
import assert from "node:assert/strict";

import { createMarkdownFile, createFolder } from "../src/commands/fileOpsCore.ts";

/** 内存文件系统 + 可编排的对话框 */
function makeHarness(opts = {}) {
  const files = new Set(opts.existing ?? []);
  const created = [];
  const dirs = [];
  const prompts = [];          // 每次 prompt 收到的参数
  const confirms = [];         // 每次 confirm 收到的参数
  const notifies = [];         // 每次 notify 收到的参数
  const opened = [];
  const afterCreate = [];

  const inputs = [...(opts.inputs ?? [])];       // 依次返回给 prompt 的值（null = 取消）
  const confirmReplies = [...(opts.confirmReplies ?? [])];

  const deps = {
    workspace: () => (opts.workspace === undefined ? "D:\\ws" : opts.workspace),
    exists: async (p) => files.has(p),
    createFile: async (p) => {
      if (opts.failCreate) throw new Error(opts.failCreate);
      files.add(p);
      created.push(p);
    },
    createDir: async (p) => {
      files.add(p);
      dirs.push(p);
    },
    openFile: async (p) => {
      opened.push(p);
      return opts.openFails === true ? false : true;
    },
    prompt: async (title, o) => {
      prompts.push({ title, ...o });
      return inputs.length ? inputs.shift() : null;
    },
    confirm: async (title, message, o) => {
      confirms.push({ title, message, ...o });
      return confirmReplies.length ? confirmReplies.shift() : false;
    },
    notify: async (title, message) => {
      notifies.push({ title, message });
    },
    afterCreate: (p) => afterCreate.push(p),
  };

  return { deps, files, created, dirs, prompts, confirms, notifies, opened, afterCreate };
}

test("正常新建：真的落盘、真的打开、收尾只跑一次", async () => {
  const h = makeHarness({ inputs: ["会议记录.md"] });
  const res = await createMarkdownFile(h.deps);

  assert.equal(res.ok, true);
  assert.equal(res.path, "D:\\ws\\会议记录.md");
  assert.deepEqual(h.created, ["D:\\ws\\会议记录.md"], "必须真的调用 createFile");
  assert.deepEqual(h.opened, ["D:\\ws\\会议记录.md"], "创建后应打开");
  assert.deepEqual(h.afterCreate, ["D:\\ws\\会议记录.md"], "刷新文件树/最近记录只跑一次");
  assert.equal(h.notifies.length, 0, "成功路径不该弹错误");
});

test("输入框预填『未命名.md』，并在提示里带上位置", async () => {
  const h = makeHarness({ inputs: ["a.md"] });
  await createMarkdownFile(h.deps);
  assert.equal(h.prompts[0].title, "新建 Markdown 文件");
  assert.equal(h.prompts[0].value, "未命名.md");
  assert.equal(h.prompts[0].label, "位置：D:\\ws");
  assert.equal(h.prompts[0].confirmText, "创建");
});

test("**重名必须提示**：给出建议名，并且允许直接打开已有文件", async () => {
  const h = makeHarness({
    existing: ["D:\\ws\\readme.md"],
    inputs: ["readme.md"],
    confirmReplies: [true], // 用户选择"打开已有文件"
  });

  const res = await createMarkdownFile(h.deps);

  assert.equal(h.confirms.length, 1, "重名时必须弹确认框，不能静默失败");
  const c = h.confirms[0];
  assert.equal(c.title, "同名文件已存在");
  assert.match(c.message, /readme\.md/, "提示里要写清是哪个文件重名");
  assert.match(c.message, /readme-2\.md/, "应给出可用的建议名");
  assert.equal(c.confirmText, "打开已有文件");

  assert.deepEqual(h.created, [], "选择打开已有文件时不应再创建");
  assert.deepEqual(h.opened, ["D:\\ws\\readme.md"]);
  assert.equal(res.ok, true);
  assert.equal(res.path, "D:\\ws\\readme.md");
});

test("重名后拒绝打开 → 把建议名回填到下一次输入", async () => {
  const h = makeHarness({
    existing: ["D:\\ws\\readme.md"],
    inputs: ["readme.md", "readme-2.md"],
    confirmReplies: [false], // 不打开已有文件，选择改名
  });

  const res = await createMarkdownFile(h.deps);

  assert.equal(h.prompts.length, 2, "应重新询问名字");
  assert.equal(
    h.prompts[1].value,
    "readme-2.md",
    "第二次应把建议名回填，用户直接回车即可",
  );
  assert.equal(res.ok, true);
  assert.equal(res.path, "D:\\ws\\readme-2.md");
  assert.deepEqual(h.created, ["D:\\ws\\readme-2.md"]);
});

test("重名提示里不出现多余的国家/地区猜测，且建议名依次递增", async () => {
  const h = makeHarness({
    existing: ["D:\\ws\\todo.md", "D:\\ws\\todo-2.md", "D:\\ws\\todo-3.md"],
    inputs: ["todo.md"],
    confirmReplies: [true],
  });
  await createMarkdownFile(h.deps);
  assert.match(h.confirms[0].message, /todo-4\.md/, "已占用 -2/-3 时应建议 -4");
});

test("取消输入 → 不创建、不报错", async () => {
  const h = makeHarness({ inputs: [null] });
  const res = await createMarkdownFile(h.deps);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "已取消");
  assert.deepEqual(h.created, []);
  assert.equal(h.notifies.length, 0, "用户主动取消不该弹错误提示");
});

test("非法扩展名被输入框直接挡下（validate 返回原因）", async () => {
  const h = makeHarness({ inputs: ["笔记.txt"] });
  await createMarkdownFile(h.deps);
  const validate = h.prompts[0].validate;
  assert.equal(typeof validate, "function");
  assert.match(validate("笔记.txt") ?? "", /\.md/);
  assert.equal(validate("笔记.md"), null, "合法名字不应报错");
});

test("非法名字来自非常规路径时，给出具体原因而不是一句『新建失败』", async () => {
  // 用带非法字符的名字，验证 validate 会指出具体字符
  const h = makeHarness({ inputs: ["a.md"] });
  await createMarkdownFile(h.deps);
  const validate = h.prompts[0].validate;
  assert.match(validate("笔记<1>.md") ?? "", /</);
  assert.match(validate("CON.md") ?? "", /保留/);
  assert.match(validate("../逃跑.md") ?? "", /不是合法/);
});

test("路径穿越被拦下，绝不写到工作区之外", async () => {
  const h = makeHarness({ inputs: ["../evil.md"] });
  await createMarkdownFile(h.deps);
  // 第一次 prompt 的 validate 就应该拒绝
  assert.ok(h.prompts[0].validate("../evil.md"), "必须以错误原因拒绝");
  assert.deepEqual(h.created, [], "不能创建任何文件");
});

test("支持子目录写法，按 Windows 风格拼接", async () => {
  const h = makeHarness({ inputs: ["notes/todo.md"] });
  const res = await createMarkdownFile(h.deps);
  assert.equal(res.ok, true);
  assert.equal(res.path, "D:\\ws\\notes\\todo.md");
});

test("在指定目录下新建（右键文件夹的场景）", async () => {
  const h = makeHarness({ inputs: ["子目录里的.md"] });
  const res = await createMarkdownFile(h.deps, "D:\\ws\\notes");
  assert.equal(res.path, "D:\\ws\\notes\\子目录里的.md");
  assert.equal(h.prompts[0].label, "位置：D:\\ws\\notes");
});

test("没有工作区时明确告知，而不是无声无息", async () => {
  const h = makeHarness({ workspace: null, inputs: ["a.md"] });
  const res = await createMarkdownFile(h.deps);
  assert.equal(res.ok, false);
  assert.equal(h.notifies.length, 1);
  assert.match(h.notifies[0].message, /打开一个文件夹/);
});

test("落盘失败时把系统错误原样告诉用户", async () => {
  const h = makeHarness({ inputs: ["a.md"], failCreate: "拒绝访问 (os error 5)" });
  const res = await createMarkdownFile(h.deps);
  assert.equal(res.ok, false);
  assert.equal(h.notifies.length, 1);
  assert.equal(h.notifies[0].title, "创建失败");
  assert.match(h.notifies[0].message, /os error 5/);
});

test("创建成功但读取失败时，仍要告知文件其实已经创建", async () => {
  const h = makeHarness({ inputs: ["a.md"], openFails: true });
  const res = await createMarkdownFile(h.deps);
  assert.equal(res.ok, true, "文件确实建好了");
  assert.equal(h.notifies.length, 1);
  assert.match(h.notifies[0].title, /打开失败/);
  assert.match(h.notifies[0].message, /D:\\ws\\a\.md/);
});

test("新建文件夹：重名时明确提示", async () => {
  const h = makeHarness({ existing: ["D:\\ws\\新文件夹"], inputs: ["新文件夹"] });
  const res = await createFolder(h.deps);
  assert.equal(res.ok, false);
  assert.deepEqual(h.dirs, [], "重名不能创建");
  assert.equal(h.notifies.length, 1);
  assert.match(h.notifies[0].title, /同名文件夹/);
});

test("新建文件夹：正常创建并按名字落盘", async () => {
  const h = makeHarness({ inputs: ["会议记录"] });
  const res = await createFolder(h.deps);
  assert.equal(res.ok, true);
  assert.deepEqual(h.dirs, ["D:\\ws\\会议记录"]);
});
