// 文档结构自检的测试。
//
// 起因是真实事故：samples/demo.md 里一行被写成了
//     > [链接文字]([url]([url](`url`)))```ts
// —— 引用内容与围栏挤在同一行，导致那个 TypeScript 代码块没有被识别成代码块。
// 表现是"在代码块里按回车会插入 `> `"，排查了很久。
// 这类问题肉眼极难发现，应该有办法一眼看出来。

import test from "node:test";
import assert from "node:assert/strict";

import { checkDocument } from "../src/services/mdcore.ts";

test("正常文档没有问题", () => {
  const doc = [
    "# 标题",
    "",
    "正文段落。",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
    "> 引用",
    "> 第二行",
    "",
    "```mermaid",
    "flowchart TD",
    "  A-->B",
    "```",
  ].join("\n");
  assert.deepEqual(checkDocument(doc), []);
});

test("**查得出真实事故里的那行**：围栏与正文挤在一行", () => {
  // 就是 demo.md 曾经被写坏的样子
  const doc = [
    "## 四、代码高亮",
    "",
    "> [链接文字]([url]([url](`url`)))```ts",
    "// 切换主题时这里不需要重新高亮",
    "export function createDoc() {}",
    "```",
  ].join("\n");

  const issues = checkDocument(doc);
  assert.ok(issues.length > 0, "必须报出问题");
  assert.ok(
    issues.some((i) => i.kind === "fence-not-alone" || i.kind === "unclosed-fence"),
    `应指出围栏没独立成行或未闭合，实际: ${JSON.stringify(issues)}`,
  );
  assert.ok(
    issues.some((i) => i.line === 3),
    "应指向第 3 行",
  );
});

test("查得出未闭合的围栏", () => {
  const doc = ["# 标题", "", "```ts", "const a = 1;", "", "正文被误当成代码"].join("\n");
  const issues = checkDocument(doc);
  const unclosed = issues.find((i) => i.kind === "unclosed-fence");
  assert.ok(unclosed, `应报未闭合，实际 ${JSON.stringify(issues)}`);
  assert.equal(unclosed.line, 3, "应指向起始行");
});

test("查得出围栏类型不匹配（``` 与 ~~~ 混用）", () => {
  const doc = ["```ts", "const a = 1;", "~~~", "正文"].join("\n");
  const issues = checkDocument(doc);
  assert.ok(
    issues.some((i) => i.kind === "mismatched-fence"),
    `应报类型不匹配，实际 ${JSON.stringify(issues)}`,
  );
});

test("查得出围栏内部的引用标记（围栏没闭合的信号）", () => {
  const doc = ["```ts", "const a = 1;", "> 这行看起来像引用", "```"].join("\n");
  const issues = checkDocument(doc);
  assert.ok(
    issues.some((i) => i.kind === "heading-in-fence" && i.line === 3),
    `应指出第 3 行在代码块内部，实际 ${JSON.stringify(issues)}`,
  );
});

test("带语言名的围栏是正常的", () => {
  for (const lang of ["ts", "rust", "python", "c++", "c#", "objective-c", "shell script", ""]) {
    const doc = ["```" + lang, "x", "```"].join("\n");
    assert.deepEqual(checkDocument(doc), [], `语言名 "${lang}" 不应被误判`);
  }
});

test("~~~ 围栏同样支持", () => {
  assert.deepEqual(checkDocument(["~~~", "x", "~~~"].join("\n")), []);
});

test("缩进 0–3 空格的围栏正常，深缩进不算围栏", () => {
  assert.deepEqual(checkDocument(["   ```ts", "   x", "   ```"].join("\n")), []);
  // 4 空格缩进是缩进代码块，不是围栏。但它也不该被误报成"未闭合"。
  const deep = checkDocument(["    ```ts", "    x"].join("\n"));
  assert.ok(
    !deep.some((i) => i.kind === "unclosed-fence"),
    `深缩进不应报未闭合，实际 ${JSON.stringify(deep)}`,
  );
});

test("空的围栏与非文档输入都不误报", () => {
  assert.deepEqual(checkDocument(""), []);
  assert.deepEqual(checkDocument("```\n```"), []);
  assert.deepEqual(checkDocument("没有围栏的普通文本"), []);
});

test("同类型围栏成对出现时不报错（```py 作为闭合是合法的）", () => {
  // CommonMark：闭合围栏可以带任意信息字符串，```py 在这里就是闭合
  assert.deepEqual(checkDocument(["```ts", "a", "", "```py", "b"].join("\n")), []);
  assert.deepEqual(checkDocument(["```ts", "a", "", "```py"].join("\n")), []);
});

test("围栏没有配对时一定报出来", () => {
  // 只有一个起始围栏，没有闭合
  const unclosed = checkDocument(["# 标题", "", "```ts", "const a = 1;"].join("\n"));
  assert.ok(
    unclosed.some((i) => i.kind === "unclosed-fence"),
    `应报未闭合，实际 ${JSON.stringify(unclosed)}`,
  );
  assert.equal(unclosed.find((i) => i.kind === "unclosed-fence").line, 3);
});

test("多个问题会被全部列出（含行号与可读说明）", () => {
  const doc = ["```ts", "const a = 1;", "> 引用出现在代码块内部", "文本 ``` 夹在中间"].join("\n");
  const issues = checkDocument(doc);
  assert.ok(issues.length >= 1, `应报出问题，实际 ${JSON.stringify(issues)}`);
  assert.ok(issues.every((i) => i.line >= 1 && i.line <= 4), "行号应在范围内");
  assert.ok(issues.every((i) => typeof i.message === "string" && i.message.length > 0));
  assert.ok(issues.every((i) => typeof i.text === "string"));
});
