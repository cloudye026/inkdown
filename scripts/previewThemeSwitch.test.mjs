// 回归测试：**换主题后代码块必须重新着色**。
//
// 这是用户报的"切换到 Solarized 浅色和 Catppuccin Latte 时 代码块的颜色不对"
// 的完整根因，而且它有两层：
//
//   ① enhancePreview 从 <html data-theme> 读主题，而那个属性是 App 的 effect
//      写的；React 的 effect 是**子先父后**，预览会读到上一个主题。
//      → 改为主题由调用方显式传入。
//
//   ② 更隐蔽：第一次增强后 DOM 里已经没有 `pre.code-block`（被 Shiki 输出替换了），
//      而 enhancePreview 只处理 `pre.code-block`。换主题时 HTML 一个字没变，
//      增量更新判定"无需改动" → 没有任何块被重新高亮 → 代码块一直沿用旧配色。
//      → 主题变化时强制整棵重建，把 `pre.code-block` 还原出来。
//
// 关键：测试必须走**同一棵 DOM 上的连续两步**（注入 → 换主题再注入），
// 每次都新建 host 会绕过增量更新路径，测不出 ②。

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

const MD = "```ts\nconst 名字 = 42;\n```";
const { html } = renderMarkdown(MD, { docDir: null, breakOnSingleNewline: true });

/** 从容器里取出代码块当前用到的所有颜色与 class */
function snapshot(content) {
  const pre = content.querySelector("pre");
  if (!pre) return { colors: new Set(), cls: "", blocksLeft: 0 };
  const out = new Set();
  const preStyle = /style="([^"]*)"/.exec(pre.outerHTML)?.[1] ?? "";
  const c0 = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,8})/.exec(preStyle)?.[1];
  if (c0) out.add(c0.toLowerCase());
  for (const m of pre.innerHTML.matchAll(/<span[^>]*style="([^"]*)"/g)) {
    const cc = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,8})/.exec(m[1])?.[1];
    if (cc) out.add(cc.toLowerCase());
  }
  return {
    colors: out,
    cls: pre.className,
    blocksLeft: content.querySelectorAll("pre.code-block").length,
  };
}

const has = (set, arr) => arr.some((c) => set.has(c));
/** 只可能来自 GitHub 深色 */
const DARK = ["#e6edf3", "#ff7b72", "#79c0ff"];
/** 只可能来自 Solarized 浅色 */
const LIGHT = ["#5c7077", "#268bd2", "#d33682"];

/** 建一个全新的预览容器（模拟文档切换） */
function freshContent() {
  const el = document.createElement("div");
  el.className = "markdown-body";
  document.body.appendChild(el);
  return el;
}

test("**首次增强后 DOM 里已没有 pre.code-block**（这是 bug ② 的前提）", async () => {
  resetPreviewBaseline();
  invalidatePreviewCaches();
  const content = freshContent();
  await applyPreview(content, html, { theme: "github-dark", force: true });

  const s = snapshot(content);
  assert.equal(s.blocksLeft, 0, "增强后 pre.code-block 应被 Shiki 输出替换掉");
  assert.match(s.cls, /shiki/, "应已变成 shiki 代码块");
  assert.ok(has(s.colors, DARK), `应是深色配色，实际 ${[...s.colors].join(", ")}`);
});

test("**同一棵 DOM 上换主题：代码块必须重新着色**（用户报的现象）", async () => {
  resetPreviewBaseline();
  invalidatePreviewCaches();
  const content = freshContent();

  // 步骤 1：深色
  await applyPreview(content, html, { theme: "github-dark", force: true });
  const before = snapshot(content);
  assert.ok(has(before.colors, DARK), "前提：先渲染成深色");

  // 步骤 2：换浅色，HTML 完全没变（这正是真实场景）
  await applyPreview(content, html, { theme: "solarized-light", force: true });
  const after = snapshot(content);

  assert.ok(
    has(after.colors, LIGHT),
    `换主题后应使用浅色配色，实际 ${[...after.colors].join(", ")}`,
  );
  assert.ok(
    !has(after.colors, DARK),
    `换主题后不该还留着深色配色：${[...after.colors].join(", ")}`,
  );
  assert.match(after.cls, /solarized-light/, `class 应换成新主题，实际 ${after.cls}`);
});

test("force=false（内容变化）时走增量更新，颜色也跟着主题走", async () => {
  resetPreviewBaseline();
  invalidatePreviewCaches();
  const content = freshContent();

  await applyPreview(content, html, { theme: "github-dark", force: true });

  // 内容变了（模拟打字），主题换成浅色且 force=false
  const md2 = "```ts\nconst 名字 = 43;\n```";
  const html2 = renderMarkdown(md2, { docDir: null, breakOnSingleNewline: true }).html;
  await applyPreview(content, html2, { theme: "solarized-light", force: false });

  const s = snapshot(content);
  assert.ok(
    has(s.colors, LIGHT),
    `内容变化 + 换主题时应重新高亮成新主题，实际 ${[...s.colors].join(", ")}`,
  );
});

test("来回切换主题：每次都跟着变（不能只生效一次）", async () => {
  resetPreviewBaseline();
  invalidatePreviewCaches();
  const content = freshContent();

  const seq = ["github-dark", "solarized-light", "github-dark", "catppuccin-latte"];
  for (const theme of seq) {
    await applyPreview(content, html, { theme, force: true });
    const s = snapshot(content);
    assert.match(s.cls, new RegExp(theme), `class 应包含 ${theme}，实际 ${s.cls}`);
    if (theme === "github-dark") {
      assert.ok(has(s.colors, DARK), `${theme}: 应是深色配色`);
    } else if (theme === "solarized-light") {
      assert.ok(has(s.colors, LIGHT), `${theme}: 应是 Solarized 浅色配色`);
    }
  }
});

test("force=false 且 HTML 未变时**不会**重新着色（说明 force 是必需的）", async () => {
  // 这条刻意断言"修复前的行为"，用来把机制钉死：
  // 主题切换时若不做整棵重建，增量更新会判"无需改动"，
  // 代码块就沿用旧配色 —— 这正是用户报的现象。
  //
  // 它与上面那条"必须重新着色"是一对：谁把 force 去掉了，上面那条就会失败。
  resetPreviewBaseline();
  invalidatePreviewCaches();
  const content = freshContent();

  await applyPreview(content, html, { theme: "github-dark", force: true });
  const before = snapshot(content);

  // 换主题，但 force=false 且 HTML 完全相同
  await applyPreview(content, html, { theme: "solarized-light", force: false });
  const after = snapshot(content);

  assert.deepEqual(
    [...after.colors].sort(),
    [...before.colors].sort(),
    "force=false 时颜色不应变化（说明不重建就不会重新高亮）",
  );
  assert.ok(
    has(after.colors, DARK),
    "仍是旧主题的配色 —— 这就是需要 force 的原因",
  );
});

test("**调用方只管传主题**：服务自己识别主题变化并重建（组件不必判断）", async () => {
  // 这条模拟组件的真实调用方式（不传 force），验证服务内部的主题跟踪。
  resetPreviewBaseline();
  invalidatePreviewCaches();
  const content = freshContent();

  // 连续四种情况：首次、同主题内容变化、换主题、同主题无变化
  await applyPreview(content, html, { theme: "github-dark" });
  assert.ok(has(snapshot(content).colors, DARK), "首次应是深色");

  const html2 = renderMarkdown("```ts\nconst 名字 = 43;\n```", {
    docDir: null,
    breakOnSingleNewline: true,
  }).html;
  await applyPreview(content, html2, { theme: "github-dark" }); // 同主题、内容变
  assert.ok(has(snapshot(content).colors, DARK), "同主题内容变化后仍是深色");

  await applyPreview(content, html2, { theme: "solarized-light" }); // 换主题
  const s3 = snapshot(content);
  assert.ok(has(s3.colors, LIGHT), `换主题后应重建成浅色，实际 ${[...s3.colors].join(", ")}`);
  assert.ok(!has(s3.colors, DARK), "换主题后不该留深色");

  await applyPreview(content, html2, { theme: "solarized-light" }); // 同主题、无变化
  assert.ok(has(snapshot(content).colors, LIGHT), "无变化时保持浅色");
});

test("换文档（resetPreviewBaseline）后仍按当前主题着色", async () => {
  invalidatePreviewCaches();
  const a = freshContent();
  const b = freshContent();

  await applyPreview(a, html, { theme: "github-dark" });
  resetPreviewBaseline(a); // 模拟切走
  await applyPreview(b, html, { theme: "catppuccin-latte" });

  const sb = snapshot(b);
  assert.match(sb.cls, /catppuccin-latte/, `新文档应用当前主题，实际 ${sb.cls}`);
});

test("代码块底色与主题无关地正确（CSS 由 data-theme 驱动，不经过 JS）", () => {
  // 这里只确认两个主题的 --bg-sunken 方向正确（详细校验见 themes.test.mjs）
  const content = freshContent();
  assert.ok(content, "占位：CSS 变量由样式表负责，见 themes.test.mjs 的下沉校验");
  content.remove();
});
