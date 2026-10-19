// 对话框 promise 机制的单测。
//
// 这是本次修复的核心：window.prompt / window.confirm 在 WebView2 里被静默禁用，
// 所以换成"store 里挂一个 promise + 组件调用 settleModal 兑现"。
// 这套胶水代码一旦写错，表现就是"点了没反应"或者 promise 永远悬着，肉眼极难发现。
//
// 测试方式：调用 promptText/confirmAction 拿到 promise，检查 store 里的模态状态，
// 再模拟用户操作（提交 / 取消 / 校验失败），断言 promise 的兑现结果。

import test from "node:test";
import assert from "node:assert/strict";

import {
  confirmAction,
  promptText,
  showMessage,
  useUi,
} from "../src/store/ui.ts";

const ui = () => useUi.getState();

test("promptText 打开输入框并把值带给组件", async () => {
  const p = promptText("新建文件", { value: "未命名.md", label: "位置：D:\\ws" });
  const modal = ui().modal;
  assert.ok(modal, "应打开对话框");
  assert.equal(modal.kind, "prompt");
  assert.equal(modal.title, "新建文件");
  assert.equal(modal.value, "未命名.md");
  assert.equal(modal.label, "位置：D:\\ws");

  ui().settleModal("笔记.md");
  assert.equal(await p, "笔记.md");
  assert.equal(ui().modal, null, "兑现后应关闭");
});

test("取消返回 null（不能返回空字符串，否则会被当成有效名字）", async () => {
  const p = promptText("重命名", { value: "a.md" });
  ui().settleModal(null);
  assert.equal(await p, null);
});

test("校验函数返回错误时不提交，并且错误会显示出来", async () => {
  let attempts = 0;
  const p = promptText("新建", {
    value: "x",
    validate: (v) => {
      attempts++;
      return v.includes(".") ? null : "请使用 .md 扩展名";
    },
  });

  // 组件在提交前调用 validate；这里直接模拟组件的行为
  const modal = ui().modal;
  assert.equal(modal?.kind, "prompt");
  const validate = modal.kind === "prompt" ? modal.validate : undefined;

  const problem = validate?.("无扩展名");
  assert.equal(problem, "请使用 .md 扩展名");
  assert.equal(attempts, 1, "校验只应被调用一次");

  // 组件把校验结果写回 store，界面上就能看到具体原因
  ui().setModalError(problem ?? null);
  assert.equal(ui().modal?.error, "请使用 .md 扩展名");

  // 改成合法名字后提交成功
  ui().settleModal("合法.md");
  assert.equal(await p, "合法.md");
});

test("confirmAction 确定返回 true、取消返回 false", async () => {
  const yes = confirmAction("移入回收站", "确定删除？", { danger: true });
  assert.equal(ui().modal?.kind, "confirm");
  assert.equal(ui().modal?.danger, true);
  ui().settleModal(true);
  assert.equal(await yes, true);

  const no = confirmAction("移入回收站", "确定删除？");
  ui().settleModal(null);
  assert.equal(await no, false);
});

test("showMessage 只有一个确认按钮，点掉即结束", async () => {
  const p = showMessage("名称不合法", "名称不能包含 * 字符");
  const modal = ui().modal;
  assert.equal(modal?.kind, "message");
  assert.equal(modal?.confirmText, "知道了");
  ui().settleModal(true);
  await p;
  assert.equal(ui().modal, null);
});

test("新对话框会先以取消兑现旧对话框，避免 promise 永远悬着", async () => {
  const first = promptText("第一个", { value: "a" });
  const second = promptText("第二个", { value: "b" });

  // 旧的必须立刻以取消结束，否则调用方会一直 await 下去
  assert.equal(await first, null);
  assert.equal(ui().modal?.title, "第二个");

  ui().settleModal("b.md");
  assert.equal(await second, "b.md");
});

test("打开对话框会顺手关掉右键菜单（避免菜单压在对话框上）", async () => {
  ui().openContextMenu({ x: 10, y: 10, target: "D:\\ws\\a.md", isDir: false });
  assert.ok(ui().contextMenu, "菜单应打开");

  const p = promptText("重命名", { value: "a.md" });
  assert.equal(ui().contextMenu, null, "对话框打开时菜单必须关闭");

  ui().settleModal(null);
  await p;
});

test("右键菜单状态可打开可关闭，且重复关闭不出错", () => {
  ui().openContextMenu({ x: 5, y: 6, target: "D:\\ws\\b.md", isDir: false });
  assert.deepEqual(
    { x: ui().contextMenu?.x, y: ui().contextMenu?.y, target: ui().contextMenu?.target },
    { x: 5, y: 6, target: "D:\\ws\\b.md" },
  );
  ui().closeContextMenu();
  assert.equal(ui().contextMenu, null);
  ui().closeContextMenu();
  assert.equal(ui().contextMenu, null);
});
