// 回归测试：预览的代码高亮必须用**传入的主题**，不能读 <html data-theme>。
//
// 起因（用户报的"切换到 Solarized 浅色和 Catppuccin Latte 时 代码块的颜色不对"）：
// enhancePreview 原来从 document.documentElement.dataset.theme 读主题，
// 而那个属性是 App 的 effect 里写的。React 的 effect 顺序是**子组件先跑、
// 父组件后跑** —— 预览的 effect 先执行，读到的是**上一个主题**。
// 结果：切到浅色主题后，代码块仍用深色主题的 token 配色
// （浅蓝 #a5d6ff、淡紫 #d2a8ff 压在浅底上对比度只有 1.0–1.7，几乎看不见）。

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
const { enhancePreview, invalidatePreviewCaches } = await import(
  "../src/services/previewRender.ts"
);

const MD = [
  "```ts",
  "// 注释",
  'const 名字 = "字符串";',
  "function f(n: number) { return n + 1; }",
  "```",
].join("\n");

/** 渲染 + 增强，返回代码块里出现的所有颜色 */
async function colorsFor(domTheme, passedTheme) {
  // 模拟"data-theme 还是旧值"的状态
  document.documentElement.dataset.theme = domTheme;
  invalidatePreviewCaches();

  const host = document.createElement("div");
  document.body.appendChild(host);
  const { html } = renderMarkdown(MD, { docDir: null, breakOnSingleNewline: true });
  host.innerHTML = html;

  if (passedTheme === undefined) await enhancePreview(host);
  else await enhancePreview(host, passedTheme);

  const pre = host.querySelector("pre");
  const out = new Set();
  if (pre) {
    const preStyle = /style="([^"]*)"/.exec(pre.outerHTML)?.[1] ?? "";
    const c = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,8})/.exec(preStyle)?.[1];
    if (c) out.add(c.toLowerCase());
    for (const m of pre.innerHTML.matchAll(/<span[^>]*style="([^"]*)"/g)) {
      const cc = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,8})/.exec(m[1])?.[1];
      if (cc) out.add(cc.toLowerCase());
    }
  }
  host.remove();
  return out;
}

/** 这些颜色只可能来自 GitHub 深色 */
const GITHUB_DARK_MARKERS = ["#e6edf3", "#ff7b72", "#a5d6ff", "#d2a8ff", "#79c0ff", "#ffa657"];
/** 这些颜色只可能来自 Solarized 浅色 */
const SOLARIZED_LIGHT_MARKERS = ["#fdf6e3", "#5c7077", "#268bd2", "#7d8e8e", "#d33682", "#289990"];

function has(colors, markers) {
  return markers.some((m) => colors.has(m));
}

test("传入的主题说了算，不受 <html data-theme> 的旧值影响", async () => {
  // DOM 里写着深色（模拟 App 的 effect 还没跑），但调用方说要浅色
  const colors = await colorsFor("github-dark", "solarized-light");

  assert.ok(
    has(colors, SOLARIZED_LIGHT_MARKERS),
    `应使用传入的 Solarized 浅色配色，实际颜色：${[...colors].join(", ")}`,
  );
  assert.ok(
    !has(colors, GITHUB_DARK_MARKERS),
    `**不该**出现 GitHub 深色的配色（说明又读到了 DOM 的旧值）：${[...colors].join(", ")}`,
  );
});

test("反向也成立：DOM 是浅色、传入深色时用深色", async () => {
  const colors = await colorsFor("solarized-light", "github-dark");
  assert.ok(
    has(colors, GITHUB_DARK_MARKERS),
    `应使用传入的 GitHub 深色配色，实际：${[...colors].join(", ")}`,
  );
  assert.ok(
    !has(colors, SOLARIZED_LIGHT_MARKERS),
    `不该出现 Solarized 浅色配色：${[...colors].join(", ")}`,
  );
});

test("不传主题时回退到读 DOM（兼容旧调用点）", async () => {
  const colors = await colorsFor("solarized-light", undefined);
  assert.ok(
    has(colors, SOLARIZED_LIGHT_MARKERS),
    `回退路径应读 DOM 的值，实际：${[...colors].join(", ")}`,
  );
});

test("缓存按主题分离：换主题不会复用上一个主题的高亮结果", async () => {
  // 先按深色渲染并缓存
  const dark = await colorsFor("github-dark", "github-dark");
  assert.ok(has(dark, GITHUB_DARK_MARKERS), "第一次应是深色");

  // 同一份内容、换成浅色：必须重新高亮，不能命中深色的缓存
  const light = await colorsFor("github-dark", "solarized-light");
  assert.ok(
    has(light, SOLARIZED_LIGHT_MARKERS),
    `换主题后应重新高亮，实际：${[...light].join(", ")}`,
  );
  assert.ok(
    !has(light, GITHUB_DARK_MARKERS),
    `换主题后不该复用旧缓存：${[...light].join(", ")}`,
  );
});

test("Solorized 浅色下代码块正文色不是深色主题的浅色（用户报的现象）", async () => {
  const colors = await colorsFor("github-dark", "solarized-light");
  // GitHub 深色的默认前景是 #e6edf3（很浅），压在浅底上对比度 1.0 左右——
  // 这正是用户看到的"颜色不对"。
  assert.ok(
    !colors.has("#e6edf3"),
    "代码块正文不该是 #e6edf3（深色主题的前景色）",
  );
});
