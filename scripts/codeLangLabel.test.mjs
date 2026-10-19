// 代码块语言标签：Shiki 的输出里没有语言信息，由 previewRender 在 `<pre>` 上补
// `data-lang`，CSS 再把它显示在右上角（Typora 的做法）。
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

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
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
Object.defineProperty(globalThis, "navigator", {
  value: w.navigator,
  configurable: true,
  writable: true,
});

const { renderMarkdown } = await import("../src/services/markdown.ts");
const { applyPreview, resetPreviewBaseline } = await import("../src/services/previewApply.ts");
const { invalidatePreviewCaches } = await import("../src/services/previewRender.ts");

const MD = [
  "```ts",
  "const a = 1;",
  "```",
  "",
  "```",
  "无语言围栏",
  "```",
].join("\n");

test("高亮后的代码块带 data-lang，供 CSS 显示语言名", async () => {
  resetPreviewBaseline();
  invalidatePreviewCaches();
  const content = document.createElement("div");
  content.className = "markdown-body";
  document.body.appendChild(content);

  const { html } = renderMarkdown(MD, { docDir: null, breakOnSingleNewline: true });
  await applyPreview(content, html, { theme: "github-dark" });

  const pres = [...content.querySelectorAll("pre")];
  assert.equal(pres.length, 2, `应有两个代码块，实际 ${pres.length}`);

  const ts = pres.find((p) => p.getAttribute("data-lang") === "ts");
  assert.ok(ts, "带语言的块应有 data-lang=ts");
  assert.match(ts.className, /shiki/, "该块应已被 Shiki 高亮");

  // 无语言围栏不该硬塞标签（否则右上角会冒出空框或 "undefined"）
  const plain = pres.find((p) => !p.hasAttribute("data-lang"));
  assert.ok(plain, `无语言围栏不应带 data-lang；实际：${pres.map((p) => p.getAttribute("data-lang")).join(" / ")}`);

  content.remove();
});

test("语言名只保留安全字符（防乱码 + 防属性注入）", async () => {
  resetPreviewBaseline();
  invalidatePreviewCaches();
  const content = document.createElement("div");
  content.className = "markdown-body";
  document.body.appendChild(content);

  const md = ['```js"onmouseover="alert(1)', "x", "```"].join("\n");
  const { html } = renderMarkdown(md, { docDir: null, breakOnSingleNewline: true });
  await applyPreview(content, html, { theme: "github-dark" });

  const pre = content.querySelector("pre");
  assert.ok(pre, "应渲染出代码块");
  const lang = pre.getAttribute("data-lang") ?? "";
  assert.equal(lang, "jsonmouseoveralert1", `应被过滤成纯字母数字，实际 ${JSON.stringify(lang)}`);
  assert.equal(pre.getAttribute("onmouseover"), null, "不应产生事件属性");

  content.remove();
});

test("没有语言后缀的围栏不会被塞进 data-lang", async () => {
  resetPreviewBaseline();
  invalidatePreviewCaches();
  const content = document.createElement("div");
  content.className = "markdown-body";
  document.body.appendChild(content);

  const { html } = renderMarkdown("```\n纯文本\n```", {
    docDir: null,
    breakOnSingleNewline: true,
  });
  await applyPreview(content, html, { theme: "github-dark" });

  const pre = content.querySelector("pre");
  assert.ok(pre, "应渲染出代码块");
  assert.equal(pre.hasAttribute("data-lang"), false, "无语言时不该有 data-lang");

  content.remove();
});
