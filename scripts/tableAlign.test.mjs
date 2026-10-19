// 表格对齐回归测试。
//
// 起因：重做排版时加了 `.markdown-body th, td { text-align: left }`（GitHub 风格表头左对齐），
// 但 GFM 的 `|:---:|` / `|---:|` 是 marked 输出成 `align="center"` / `align="right"`
// 的**表现性属性**，而作者样式优先级高于表现性属性 —— 加上那条规则后，
// 所有对齐列都被静默压回左对齐。
//
// 修法是给默认规则加 `:not([align])`。这里同时锁两件事：
//   1. 渲染出来的 HTML 确实带 align 属性（数据链路没断）；
//   2. CSS 里那条默认规则确实跳过了 [align]（否则属性会被盖掉）。
// 真实浏览器里的最终计算结果由 `scripts/app-verify-table.mjs` 验证。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.NodeFilter = dom.window.NodeFilter;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

const { renderMarkdown } = await import("../src/services/markdown.ts");

const MD = [
  "| 左 | 中 | 右 | 默认 |",
  "| :--- | :---: | ---: | --- |",
  "| a | b | c | d |",
].join("\n");

function render() {
  return renderMarkdown(MD, { docDir: null, breakOnSingleNewline: true }).html;
}test("GFM 对齐列会渲染成 align 属性", () => {
  const html = render();
  assert.match(html, /align="left"/, "` :--- ` 应输出 align=left");
  assert.match(html, /align="center"/, "` :---: ` 应输出 align=center");
  assert.match(html, /align="right"/, "` ---: ` 应输出 align=right");
});

test("没有指定对齐的列不带 align 属性（不该被硬塞一个 left）", () => {
  const html = render();
  const doc = new JSDOM(`<table><tbody>${html}</tbody></table>`).window.document;
  const cells = [...doc.querySelectorAll("th, td")];
  assert.ok(cells.length >= 8, `应至少有 8 个单元格，实际 ${cells.length}`);
  const plain = cells.filter((c) => !c.hasAttribute("align"));
  assert.ok(plain.length >= 2, `默认列应没有 align 属性，实际 ${plain.length} 个`);
});

test("消毒不会把 align 属性丢掉", () => {
  const html = render();
  const count = (html.match(/align="/g) ?? []).length;
  // 3 个对齐列 × 2 行（表头 + 数据行）
  assert.equal(count, 6, `应保留 6 处 align，实际 ${count}`);
});

test("CSS 的默认对齐规则必须跳过 [align]，否则会盖掉 GFM 对齐", () => {
  const css = readFileSync("src/styles/index.css", "utf8");
  // 找出所有给 th/td 设置 text-align 的规则
  const rules = [...css.matchAll(/([^{}]*\btd\b[^{}]*)\{([^}]*text-align[^}]*)\}/g)];
  assert.ok(rules.length > 0, "应能找到给 td 设置 text-align 的规则");
  for (const [, selector, body] of rules) {
    if (!/text-align\s*:\s*left/.test(body)) continue;
    assert.match(
      selector,
      /:not\(\[align\]\)/,
      `设置 text-align:left 的选择器必须排除 [align]，实际选择器：${selector.trim()}`,
    );
  }
});

test("整段 CSS 里不允许出现无条件的 th/td 左对齐", () => {
  const css = readFileSync("src/styles/index.css", "utf8");
  for (const m of css.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    const [, sel, body] = m;
    if (!/\bth\b|\btd\b/.test(sel)) continue;
    if (/text-align\s*:\s*left/.test(body) && !/:not\(\[align\]\)/.test(sel)) {
      assert.fail(`发现会盖掉表格对齐的规则：${sel.trim()} { text-align: left }`);
    }
  }
});
