// 相对路径图片的目录解析。
//
// 这类 bug 只在**打开第二份文档**（或第一份文档没有目录）时才出现，
// 而且表现成"图片碎了"，很容易被当成文件放错了位置。
//
// 注意：测试里必须桩住 Tauri 的 `convertFileSrc`。否则非 Tauri 环境下它抛异常、
// `assetUrl` 回退成裸 Windows 路径（`C:\notes\x.png`），而消毒器的协议白名单会把
// `C:` 当成未知 scheme 把整个 src 剥掉 —— 那样测到的就不是"路径解析"，而是"消毒器"。
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.NodeFilter = dom.window.NodeFilter;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true, writable: true });

// 桩：模仿 Tauri v2 的 convertFileSrc（Windows 走 http://asset.localhost/）
dom.window.__TAURI_INTERNALS__ = {
  convertFileSrc: (path, protocol = "asset") =>
    `http://${protocol}.localhost/${encodeURIComponent(path)}`,
};

const { renderMarkdown } = await import("../src/services/markdown.ts");

const MD = ["# 图", "", "![logo](docs/logo.png)"].join("\n");

/** 渲染后取出 img 的 src，并解码回可读路径 */
function imgSrc(docDir) {
  const { html } = renderMarkdown(MD, { docDir, breakOnSingleNewline: true });
  const doc = new JSDOM(`<div>${html}</div>`).window.document;
  const src = doc.querySelector("img")?.getAttribute("src");
  if (!src) return "(无)";
  return decodeURIComponent(src.replace(/^http:\/\/asset\.localhost\//, ""));
}

test("相对路径图片按文档目录解析", () => {
  const src = imgSrc("C:\\notes");
  assert.equal(src, "C:\\notes\\docs\\logo.png", `实际 ${src}`);
});

test("换一份文档后，图片按**新的**文档目录解析（不能沿用上一份）", () => {
  assert.equal(imgSrc("C:\\notes"), "C:\\notes\\docs\\logo.png");
  const second = imgSrc("D:\\blog\\content");
  assert.equal(
    second,
    "D:\\blog\\content\\docs\\logo.png",
    `第二次渲染仍用了旧目录：${second}`,
  );
});

test("首次渲染没有目录时，后续有目录的文档仍能正确解析", () => {
  // 模拟"启动时先渲染了没有路径的内容"——这正是预览本仓库 README 时踩到的情形：
  // 渲染器一旦把 docDir = null 闭包进去，后面所有相对图片都再也解析不出来。
  assert.equal(imgSrc(null), "docs/logo.png", "没有目录时保持原样");

  const after = imgSrc("D:\\mddeveloper");
  assert.equal(
    after,
    "D:\\mddeveloper\\docs\\logo.png",
    `之前把 null 永久记下来了：${after}`,
  );
});

test("网络图片不受文档目录影响", () => {
  const md = "![a](https://example.com/x.png)";
  const { html } = renderMarkdown(md, { docDir: "C:\\notes", breakOnSingleNewline: true });
  const doc = new JSDOM(`<div>${html}</div>`).window.document;
  assert.equal(doc.querySelector("img")?.getAttribute("src"), "https://example.com/x.png");
});

test("混合目录反复渲染不会串味", () => {
  for (const dir of ["C:\\a", "D:\\b", "C:\\a", "E:\\c"]) {
    const src = imgSrc(dir);
    assert.ok(src.startsWith(dir), `${dir} 的图片解析到了 ${src}`);
  }
});

test("反斜杠与正斜杠两种写法都能拼对", () => {
  assert.equal(imgSrc("C:\\notes"), "C:\\notes\\docs\\logo.png", "反斜杠目录用反斜杠拼接");
  assert.equal(imgSrc("/home/u/notes"), "/home/u/notes/docs/logo.png", "正斜杠目录用正斜杠拼接");
});

// ---- 原始 HTML 里的 <img> ----
//
// marked 的 `image()` 渲染器只处理 `![]()`。用 HTML 排版（居中的 logo、截图，
// MarkText 那种 README 必然这么写）时 `<img src>` 完全不经过渲染器，
// 相对路径原样留在 DOM 里 → 预览里是碎图；同样的文件在 GitHub 上是好的。

const HTML_MD = `<div align="center"><img src="docs/logo.png" width="112" alt="logo" /></div>`;

function htmlImgSrc(docDir, md = HTML_MD) {
  const { html } = renderMarkdown(md, { docDir, breakOnSingleNewline: true });
  const doc = new JSDOM(`<div>${html}</div>`).window.document;
  const img = doc.querySelector("figure img, div img, img");
  const src = img?.getAttribute("src");
  if (!src) return "(无)";
  return decodeURIComponent(src.replace(/^http:\/\/asset\.localhost\//, ""));
}

test("HTML <img> 的相对路径也按文档目录解析", () => {
  assert.equal(htmlImgSrc("D:\\mddeveloper"), "D:\\mddeveloper\\docs\\logo.png");
});

test("HTML <img> 的宽度等其它属性不受影响", () => {
  const { html } = renderMarkdown(HTML_MD, { docDir: "D:\\mddeveloper", breakOnSingleNewline: true });
  const doc = new JSDOM(`<div>${html}</div>`).window.document;
  const img = doc.querySelector("img");
  assert.equal(img.getAttribute("width"), "112", "width 应保留");
  assert.equal(img.getAttribute("alt"), "logo", "alt 应保留");
});

test("HTML <img> 的网络图片原样保留", () => {
  const md = `<p><img src="https://example.com/a.png" /></p>`;
  assert.equal(htmlImgSrc("D:\\x", md), "https://example.com/a.png");
});

test("HTML <img> 没有文档目录时保持原样", () => {
  assert.equal(htmlImgSrc(null), "docs/logo.png");
});

test("HTML 里的危险协议仍然被消毒器剥掉", () => {
  const md = `<p><img src="javascript:alert(1)" /></p>`;
  const { html } = renderMarkdown(md, { docDir: "D:\\x", breakOnSingleNewline: true });
  const doc = new JSDOM(`<div>${html}</div>`).window.document;
  const src = doc.querySelector("img")?.getAttribute("src") ?? "";
  assert.ok(!/^javascript:/i.test(src), `危险协议不该留下：${src}`);
});
