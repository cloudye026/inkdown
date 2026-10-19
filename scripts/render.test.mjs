// 端到端渲染断言：在 jsdom 里跑完整的 marked + DOMPurify + KaTeX 管线，
// 直接检查产出的 DOM，而不是肉眼看截图。
//
// 覆盖两类最容易出事的点：
//   1) 渲染是否真的产出（表格 / 公式 / 代码块 / 消毒）
//   2) 恶意 md 是否被消毒（打开别人发来的文件不能执行脚本）

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// marked / DOMPurify 需要一个浏览器环境，先装好再动态 import 被测模块
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
globalThis.Node = w.Node;
globalThis.Element = w.Element;
globalThis.HTMLElement = w.HTMLElement;
globalThis.DOMParser = w.DOMParser;
globalThis.NodeFilter = w.NodeFilter;
// Node 24 里 navigator 是只读 getter，得用 defineProperty 覆盖
Object.defineProperty(globalThis, "navigator", {
  value: w.navigator,
  configurable: true,
  writable: true,
});
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);

// Tauri 运行时模拟：本地图片地址由 convertFileSrc 生成，平台不同格式也不同。
// 不同平台的实际格式（用于确认我们没有硬编码某一个平台）：
//   Windows / Android → http://asset.localhost/<路径>
//   macOS / Linux / iOS → asset://localhost/<路径>
globalThis.__ASSET_PREFIX__ = "asset://localhost/";
Object.defineProperty(w, "__TAURI_INTERNALS__", {
  value: {
    convertFileSrc: (p) => globalThis.__ASSET_PREFIX__ + encodeURIComponent(p),
  },
  configurable: true,
  writable: true,
});

const { renderMarkdown } = await import("../src/services/markdown.ts");

const OPTIONS = { docDir: "D:\\mddeveloper\\samples", breakOnSingleNewline: true };

function render(md) {
  const { html, outline } = renderMarkdown(md, OPTIONS);
  const host = w.document.createElement("div");
  host.innerHTML = html;
  return { host, outline, html };
}

test("GFM 表格渲染成真正的 <table>", () => {
  const { host } = render(
    ["| 项目 | 选型 |", "| --- | --- |", "| 外壳 | Tauri 2 |"].join("\n"),
  );
  const table = host.querySelector("table");
  assert.ok(table, "应产出 table");
  assert.equal(host.querySelectorAll("th").length, 2);
  assert.equal(host.querySelectorAll("tbody td").length, 2);
  assert.match(table.textContent, /Tauri 2/);
});

test("任务列表渲染成 checkbox", () => {
  const { host } = render("- [x] 已完成\n- [ ] 未完成\n");
  const boxes = host.querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].checked, false);
});

test("行内与块级公式都产出 KaTeX", () => {
  const { host } = render("当 $a \\ne 0$ 时：\n\n$$x = \\frac{-b}{2a}$$\n");
  assert.ok(host.querySelector(".katex"), "行内公式应有 .katex");
  assert.ok(host.querySelector(".katex-display"), "块级公式应有 .katex-display");
  assert.ok(host.querySelector("math"), "KaTeX 应输出 MathML 供无障碍读取");
});

test("价格写法不被当成公式", () => {
  const { host } = render("价格是 $100 和 $200，注意区分。\n");
  assert.equal(host.querySelector(".katex"), null, "不应产出公式");
  assert.match(host.textContent, /\$100 和 \$200/);
});

test("代码块保留语言标记，供异步高亮接管", () => {
  const { host } = render("```ts\nconst a = 1;\n```\n\n```mermaid\nflowchart TD\n  A-->B\n```\n");
  const pre = host.querySelector("pre.code-block");
  assert.ok(pre, "普通代码块应有 pre.code-block");
  assert.equal(pre.dataset.lang, "ts");
  assert.match(pre.textContent, /const a = 1;/);
  const mermaid = host.querySelector(".mermaid-src");
  assert.ok(mermaid, "mermaid 块应留给异步渲染处理");
  assert.match(mermaid.textContent, /flowchart TD/);
});

test("标题带 id 与 data-line，供目录跳转和滚动同步", () => {
  const md = ["# 一", "", "正文", "", "## 二"].join("\n");
  const { host, outline } = render(md);
  const h1 = host.querySelector("h1");
  const h2 = host.querySelector("h2");
  assert.ok(h1.id && h2.id, "标题必须有 id");
  assert.notEqual(h1.id, h2.id, "id 不能重复");
  assert.equal(h1.dataset.line, "0");
  assert.equal(h2.dataset.line, "4");
  assert.deepEqual(
    outline.map((h) => [h.level, h.text, h.line]),
    [
      [1, "一", 0],
      [2, "二", 4],
    ],
  );
});

test("相对路径图片被交给 Tauri 的 asset 协议（不硬编码某个平台）", () => {
  const { host } = render("![图](./assets/demo.svg)\n");
  const img = host.querySelector("img");
  assert.ok(img, "应产出 img");

  const src = img.getAttribute("src");
  assert.ok(
    src.startsWith(globalThis.__ASSET_PREFIX__),
    `应使用 Tauri 提供的 asset 前缀，实际 ${src}`,
  );
  // 路径按文档目录拼好、并做了编码
  assert.match(decodeURIComponent(src), /samples[\\/]assets[\\/]demo\.svg$/);

  // 换成 Windows 风格的前缀，同一段 markdown 也要跟着变 ——
  // 说明地址来自 Tauri，而不是写死的
  globalThis.__ASSET_PREFIX__ = "http://asset.localhost/";
  const win = render("![图](./assets/demo.svg)\n").host.querySelector("img").getAttribute("src");
  assert.ok(win.startsWith("http://asset.localhost/"), `Windows 前缀应生效，实际 ${win}`);
  globalThis.__ASSET_PREFIX__ = "asset://localhost/";
});

test("外链带 target 与 rel，点击时交给系统浏览器", () => {
  const { host } = render("[Tauri](https://tauri.app)\n");
  const a = host.querySelector("a");
  assert.equal(a.getAttribute("target"), "_blank");
  assert.match(a.getAttribute("rel"), /noreferrer/);
});

test("消毒：script / onerror / javascript: 全部被剔除", () => {
  const evil = [
    "普通段落",
    "",
    "<script>window.__pwned = 1;</script>",
    "",
    '<img src="x" onerror="window.__pwned = 2">',
    "",
    "[点我](javascript:window.__pwned=3)",
    "",
    '<iframe src="https://evil.example"></iframe>',
  ].join("\n");
  const { html } = render(evil);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /onerror/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<iframe/i);
});

test("消毒不会误伤正常内容", () => {
  const { host } = render("# 标题\n\n**粗体**、`代码`、[链接](https://a.b)\n\n> 引用\n");
  assert.ok(host.querySelector("h1"));
  assert.ok(host.querySelector("strong"));
  assert.ok(host.querySelector("code"));
  assert.ok(host.querySelector("a"));
  assert.ok(host.querySelector("blockquote"));
});

test("单换行断行开关生效（中文一段一行的关键设置）", () => {
  const md = "第一行\n第二行\n";
  const on = renderMarkdown(md, { ...OPTIONS, breakOnSingleNewline: true }).html;
  const off = renderMarkdown(md, { ...OPTIONS, breakOnSingleNewline: false }).html;
  assert.match(on, /<br>/, "开启后单换行应产生 <br>");
  assert.doesNotMatch(off, /<br>/, "关闭后单换行不断行");
});

// CommonMark 允许编号标记后直接跟内容（`8.发票`），marked 不认。
// 用户报的"第 8 项掉出列表、变成代码块"就是这个 —— 管线必须先补上空格。
test("编号标记后缺空格的列表项不再掉出列表", () => {
  const md = [
    "### 四、待确认",
    "",
    "1. 子目录 a.中盛必达科技有限公司",
    "2.",
    "3.",
    "4.",
    "5.",
    "6.",
    "7.",
    "",
    "8.发票主体不一致，待确认是否改名。",
  ].join("\n");

  const { host } = render(md);
  assert.equal(host.querySelectorAll("ol").length, 1, "应只有一个有序列表");
  assert.equal(host.querySelectorAll("li").length, 8, "8 项都应留在列表里");
  assert.equal(host.querySelectorAll("pre").length, 0, "不应产生代码块");
  assert.match(
    Array.from(host.querySelectorAll("li")).at(-1).textContent,
    /发票主体不一致/,
    "第 8 项内容应在最后一个列表项里",
  );
});

test("代码块里的 `8.内容` 不被改写", () => {
  const md = ["```", "8.这是代码，不能补空格", "```"].join("\n");
  const { host } = render(md);
  assert.match(host.querySelector("pre").textContent, /8\.这是代码，不能补空格/);
});

test("真实示例文档能整篇渲染且关键块齐全", () => {
  const src = readFileSync("samples/demo.md", "utf8");
  const { host, outline } = render(src);

  // 渲染产物
  assert.ok(host.querySelectorAll("table").length >= 1, "应有表格");
  assert.ok(host.querySelectorAll(".katex").length >= 3, "应有多个公式");
  assert.ok(host.querySelectorAll("pre.code-block").length >= 4, "应有多个代码块");
  assert.equal(host.querySelectorAll(".mermaid-src").length, 2, "应有两张 mermaid 图");
  assert.ok(host.querySelectorAll('input[type="checkbox"]').length >= 4, "应有任务列表");

  // 大纲：只统计真正的标题。
  // 注意 demo.md 的代码块里有 `# 中文注释…` 和 `# 中文注释也应该正常显示`——
  // 它们必须被围栏识别排除掉，这是 scanHeadings 最关键的行为。
  const levels = outline.map((h) => h.level);
  const lines = outline.map((h) => h.line);
  assert.ok(outline.length >= 6, `大纲至少 6 个标题，实际 ${outline.length}`);
  assert.equal(levels.filter((l) => l === 1).length, 1, "只有第一个是 h1");
  assert.deepEqual(lines, [...lines].sort((a, b) => a - b), "大纲行号必须递增");

  const texts = outline.map((h) => h.text);
  assert.ok(texts.includes("Inkdown 功能自检"), "应包含首标题");
  assert.ok(texts.includes("七、图片"), "应包含第七章");
  assert.ok(texts.includes("十一、编码与换行"), "应包含最后一章");
  assert.ok(
    !texts.some((t) => t.startsWith("中文注释")),
    "代码块里的 # 注释不能被当成标题",
  );
});
