// 预览增强的缓存测试。
//
// 目的：预览每次更新都会重建整棵 DOM，但大多数块内容没变。
// 没有缓存时会一边打字一边重新高亮所有代码块、重画所有图表，输入发滞。

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
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
Object.defineProperty(globalThis, "navigator", {
  value: w.navigator,
  configurable: true,
  writable: true,
});

const { BlockCache, commonEdges, fingerprint } = await import("../src/services/blockCache.ts");
const { renderMarkdown } = await import("../src/services/markdown.ts");

test("fingerprint 对相同内容稳定，对改动敏感", () => {
  assert.equal(fingerprint("hello"), fingerprint("hello"));
  assert.notEqual(fingerprint("hello"), fingerprint("hello "));
  assert.notEqual(fingerprint("a"), fingerprint("b"));
  assert.equal(fingerprint(""), fingerprint(""));
  // 长短差异极大也不碰撞（同一前缀）
  assert.notEqual(fingerprint("x".repeat(100)), fingerprint("x".repeat(101)));
});

test("BlockCache 命中/未命中计数正确", () => {
  const cache = new BlockCache(10);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.stats.miss, 1);
  cache.set("a", 1);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.stats.hit, 1);
});

test("BlockCache 超容量时淘汰最久未使用的项", () => {
  const cache = new BlockCache(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), 1, "访问 a，让它变成最近使用");
  cache.set("d", 4); // 应淘汰 b

  assert.equal(cache.get("b"), undefined, "b 是最久未使用的，应被淘汰");
  assert.equal(cache.get("a"), 1, "a 刚被访问过，应保留");
  assert.equal(cache.get("c"), 3);
  assert.equal(cache.get("d"), 4);
  assert.ok(cache.size <= 3, `容量不应超过上限，实际 ${cache.size}`);
});

test("BlockCache clear 会重置统计", () => {
  const cache = new BlockCache(2);
  cache.set("a", 1);
  cache.get("a");
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.stats.hit, 0);
});

test("渲染产物带上内容指纹（缓存的前提）", () => {
  const { html } = renderMarkdown("```ts\nconst a = 1;\n```\n", {
    docDir: null,
    breakOnSingleNewline: true,
  });
  assert.match(html, /data-fp="[^"]+"/, "代码块必须带 data-fp，否则无法按内容复用");

  // 同一份源码两次渲染指纹一致
  const again = renderMarkdown("```ts\nconst a = 1;\n```\n", {
    docDir: null,
    breakOnSingleNewline: true,
  }).html;
  const fp1 = /data-fp="([^"]+)"/.exec(html)?.[1];
  const fp2 = /data-fp="([^"]+)"/.exec(again)?.[1];
  assert.equal(fp1, fp2, "相同内容应得到相同指纹");

  // 内容变了指纹必须变
  const changed = renderMarkdown("```ts\nconst a = 2;\n```\n", {
    docDir: null,
    breakOnSingleNewline: true,
  }).html;
  const fp3 = /data-fp="([^"]+)"/.exec(changed)?.[1];
  assert.notEqual(fp1, fp3, "内容变化必须换指纹，否则会复用旧的高亮结果");
});

test("语言不同也换指纹", () => {
  const a = renderMarkdown("```ts\nx\n```", { docDir: null, breakOnSingleNewline: true }).html;
  const b = renderMarkdown("```js\nx\n```", { docDir: null, breakOnSingleNewline: true }).html;
  assert.notEqual(
    /data-fp="([^"]+)"/.exec(a)?.[1],
    /data-fp="([^"]+)"/.exec(b)?.[1],
    "同样的代码换语言必须重新高亮",
  );
});

test("mermaid 块也带指纹", () => {
  const { html } = renderMarkdown("```mermaid\nflowchart TD\n  A-->B\n```\n", {
    docDir: null,
    breakOnSingleNewline: true,
  });
  assert.match(html, /class="mermaid-src"[^>]*data-fp="[^"]+"/);
});

test("包含 Chinese 与特殊字符的内容指纹稳定", () => {
  const src = ["```md", "# 标题 & <tag> \"引号\" `反引号`", "```"].join("\n");
  const a = renderMarkdown(src, { docDir: null, breakOnSingleNewline: true }).html;
  const b = renderMarkdown(src, { docDir: null, breakOnSingleNewline: true }).html;
  assert.equal(
    /data-fp="([^"]+)"/.exec(a)?.[1],
    /data-fp="([^"]+)"/.exec(b)?.[1],
  );
});

// --------------------------------------------------------------- 增量更新
// 预览以前是"每次整棵重建"，实测 19–33ms 且跑在输入路径上。
// 增量更新只替换变化的中间段，所以这里把"取公共前后缀"的规则钉死。

test("commonEdges：完全相同时前缀吃掉全部，后缀为 0", () => {
  assert.deepEqual(commonEdges(["a", "b", "c"], ["a", "b", "c"]), { prefix: 3, suffix: 0 });
});

test("commonEdges：尾部追加内容时不产生变化段", () => {
  // 在末尾加一段：前缀 = 3，后缀 = 0 → 变化段是「新增的第 4 项」
  assert.deepEqual(commonEdges(["a", "b", "c"], ["a", "b", "c", "d"]), { prefix: 3, suffix: 0 });
});

test("commonEdges：只改中间一块时前后缀都能对上", () => {
  const prev = ["a", "b", "c", "d", "e"];
  const next = ["a", "b", "X", "d", "e"];
  assert.deepEqual(commonEdges(prev, next), { prefix: 2, suffix: 2 });
});

test("commonEdges：删除中间一块", () => {
  assert.deepEqual(commonEdges(["a", "b", "c", "d"], ["a", "b", "d"]), { prefix: 2, suffix: 1 });
});

test("commonEdges：在开头插入", () => {
  assert.deepEqual(commonEdges(["a", "b"], ["X", "a", "b"]), { prefix: 0, suffix: 2 });
});

test("commonEdges：全不相同", () => {
  assert.deepEqual(commonEdges(["a"], ["b"]), { prefix: 0, suffix: 0 });
});

test("commonEdges：其中一边为空", () => {
  assert.deepEqual(commonEdges([], ["a", "b"]), { prefix: 0, suffix: 0 });
  assert.deepEqual(commonEdges(["a", "b"], []), { prefix: 0, suffix: 0 });
});

test("commonEdges：前后缀不会重叠（同一元素被算两次）", () => {
  // 只有一项且相同：prefix 吃掉它，suffix 必须为 0，否则会算出负数区间
  const r = commonEdges(["a"], ["a"]);
  assert.ok(r.prefix + r.suffix <= 1, `前后缀不能重叠，实际 ${JSON.stringify(r)}`);
});

test("commonEdges：变化段区间合法（用真实渲染结果验证）", () => {
  const base = ["# 标题", "", "第一段。", "", "第二段。", "", "第三段。"].join("\n");
  const edited = base.replace("第二段。", "第二段改过了。");

  const toBlocks = (md) => {
    const div = document.createElement("div");
    div.innerHTML = renderMarkdown(md, { docDir: null, breakOnSingleNewline: true }).html;
    return Array.from(div.childNodes).map((n) => n.outerHTML ?? "");
  };

  const prev = toBlocks(base);
  const next = toBlocks(edited);
  const { prefix, suffix } = commonEdges(prev, next);

  // 判定必须落在"被改的那一段"上：用真实索引算，而不是写死数字
  // （childNodes 里还夹着换行文本节点，用 indexOf 才可靠）
  const changedIndex = prev.findIndex((h) => h.includes("第二段。"));
  assert.ok(changedIndex > 0, "测试前提：应能找到第二段");

  assert.equal(prefix, changedIndex, "变化段应从被改的那一块开始");
  assert.equal(
    prefix + suffix,
    prev.length - (next.length - prev.length === 0 ? 1 : 0),
    "前后缀应恰好覆盖未变化的部分",
  );

  const changedFrom = prefix;
  const changedTo = prev.length - suffix;
  assert.ok(changedFrom < changedTo, "应当只有一个变化段");
  assert.equal(changedTo - changedFrom, 1, "只改了一段，变化段长度应为 1");
  assert.equal(next.length, prev.length, "块数不变");
});

test("标题 id 稳定：同一内容重复渲染得到同一 id", () => {
  const md = ["# 标题一", "", "## 标题二", "", "# 标题一"].join("\n");
  const a = renderMarkdown(md, { docDir: null, breakOnSingleNewline: true }).html;
  const b = renderMarkdown(md, { docDir: null, breakOnSingleNewline: true }).html;

  const ids = (html) => [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids(a), ids(b), "重复渲染必须得到同一组 id");
  // 重名标题要去重
  assert.equal(new Set(ids(a)).size, ids(a).length, "同一文档内 id 不能重复");
  assert.equal(ids(a).length, 3);
});

