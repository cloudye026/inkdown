// 发布说明从 CHANGELOG 里摘取。写测试是因为它决定了每个 GitHub Release 的正文，
// 摘错（多摘一节 / 少摘一行 / 版本号带不带 v）在发布之后才发现就晚了。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { extractSection, normalizeVersion } from "../scripts/release-notes.mjs";

const CL = [
  "# 更新日志",
  "",
  "## 0.4.0",
  "",
  "- 新功能 A",
  "",
  "## 0.3.0",
  "",
  "这一版的核心是 X。",
  "",
  "### 修复",
  "",
  "- 修了 B",
  "",
  "## 0.2.0",
  "",
  "- 旧内容",
].join("\n");

test("normalizeVersion：标签带不带 v 都能对上", () => {
  assert.equal(normalizeVersion("v0.3.0"), "0.3.0");
  assert.equal(normalizeVersion("0.3.0"), "0.3.0");
  assert.equal(normalizeVersion("V1.2.3"), "1.2.3");
  assert.equal(normalizeVersion(" v0.3.0 "), "0.3.0");
});

test("extractSection：只取目标版本那一节", () => {
  const s = extractSection(CL, "v0.3.0");
  assert.ok(s.includes("这一版的核心是 X"), "应包含本节正文");
  assert.ok(s.includes("修了 B"), "应包含本节子标题下的内容");
  assert.ok(!s.includes("新功能 A"), "不能混进上一版");
  assert.ok(!s.includes("旧内容"), "不能混进下一版");
  assert.ok(!/^## /m.test(s), "返回值里不该再带 `## ` 标题行");
});

test("extractSection：首尾版本（没有上一版/下一版）也能取对", () => {
  const first = extractSection(CL, "0.4.0");
  assert.ok(first.includes("新功能 A"));
  assert.ok(!first.includes("这一版的核心是 X"), "不能把下一节也带上");

  const last = extractSection(CL, "0.2.0");
  assert.ok(last.includes("旧内容"));
});

test("extractSection：版本不存在返回 null（由调用方兜底）", () => {
  assert.equal(extractSection(CL, "9.9.9"), null);
});

test("extractSection：版本号按整段匹配，不能用前缀误伤", () => {
  // 0.3 不该匹配 0.3.0；0.3.0 也不该匹配 0.3.01
  assert.equal(extractSection(CL, "0.3"), null);
  assert.equal(extractSection(CL, "0.3.01"), null);
});

test("命令行：拿真实 CHANGELOG 摘 v0.3.0 能出内容，不存在的版本给兜底", () => {
  // 这条会跑真正的脚本入口（顺带覆盖"Windows 上入口判断失效"那个坑：
  // 曾经用 `file://${argv[1]}` 拼 URL，Windows 上永远不相等，脚本静默无输出）
  const real = execFileSync(process.execPath, ["scripts/release-notes.mjs", "v0.3.0"], {
    encoding: "utf8",
  });
  assert.ok(real.trim().length > 100, `真实 CHANGELOG 的 v0.3.0 段落不该这么短：${real.length} 字符`);

  const missing = execFileSync(process.execPath, ["scripts/release-notes.mjs", "v9.9.9"], {
    encoding: "utf8",
  });
  assert.match(missing, /CHANGELOG/, "找不到时要给一句指引，而不是空正文");
});
