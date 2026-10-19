// "保存成功之后重复保存只提示一次"的策略测试。
//
// 用户报的是：连按 Ctrl+S 时每次都弹一遍「已保存」，没有信息量。
// 这条策略的红线是**不能把"该提示"也去重掉**：真的有改动、或者刚解决冲突，
// 必须让用户知道磁盘上现在是哪个版本。

import test from "node:test";
import assert from "node:assert/strict";

import { saveToastText, shouldAnnounceSave } from "../src/services/saveNotice.ts";

test("没有改动时的重复保存不弹提示", () => {
  assert.equal(shouldAnnounceSave({ dirty: false, conflict: false }), false);
});

test("有改动时保存必须提示", () => {
  assert.equal(shouldAnnounceSave({ dirty: true, conflict: false }), true);
});

test("刚解决过冲突时保存必须提示（要让用户知道磁盘上是哪个版本）", () => {
  assert.equal(shouldAnnounceSave({ dirty: false, conflict: true }), true);
  assert.equal(shouldAnnounceSave({ dirty: true, conflict: true }), true);
});

test("UTF-8 的提示就是「已保存」", () => {
  assert.equal(saveToastText({ encoding: "UTF-8", eol: null }), "已保存");
  assert.equal(saveToastText({ encoding: "UTF-8", eol: "\r\n" }), "已保存");
});

test("非 UTF-8 把编码带上，CRLF 一起说清", () => {
  assert.equal(saveToastText({ encoding: "GB18030", eol: null }), "已保存（GB18030）");
  assert.equal(saveToastText({ encoding: "GB18030", eol: "\r\n" }), "已保存（GB18030 / CRLF）");
  assert.equal(saveToastText({ encoding: "Big5", eol: "\r\n" }), "已保存（Big5 / CRLF）");
});
