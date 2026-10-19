// 图片布局的静态守卫。
//
// 踩过的坑：为了让图片居中，写过 `.markdown-body img { display: block }`，
// 结果把**同一段里的一排徽章**也变成了块级 —— 一条 `<p align="center">` 里的
// 五个徽章竖着堆成一列（每个之间还有 1.2em 的上下边距）。
// 这类回归单测算不出来（jsdom 不做布局），所以在这里守源码。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const raw = readFileSync("src/styles/index.css", "utf8");

/**
 * 去掉注释再解析。
 * 不去的话，注释里出现的 `.markdown-body img { display: block }` 会被当成一条真规则
 * ——这个测试第一次跑就是这么误报的（我恰好在注释里引用了旧写法）。
 */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取出所有以 .markdown-body 开头、且提到 img 的规则 */
function imgRules() {
  const out = [];
  for (const m of css.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    const [, sel, body] = m;
    if (!/\.markdown-body[^{}]*\bimg\b/.test(sel)) continue;
    out.push({ selector: sel.trim().replace(/\s+/g, " "), body: body.trim() });
  }
  return out;
}

test("不能无条件把 .markdown-body img 设成块级（会把一排徽章竖着堆）", () => {
  for (const r of imgRules()) {
    if (!/display\s*:\s*block/.test(r.body)) continue;
    assert.match(
      r.selector,
      /:only-child|:first-child|figure/,
      `这条规则会把行内图片也变成块级：${r.selector} { ${r.body} }`,
    );
  }
});

test("独占一段的图片确实居中了（否则普通插图会贴左）", () => {
  const scoped = imgRules().find((r) => /p\s*>\s*img:only-child/.test(r.selector));
  assert.ok(scoped, "应有一条 `p > img:only-child` 规则");
  assert.match(scoped.body, /display\s*:\s*block/, "应设成块级");
  assert.match(scoped.body, /auto/, "左右应为 auto 以居中");
});

test("图片本身保留 max-width，避免超宽撑破版面", () => {
  const base = imgRules().find((r) => r.selector === ".markdown-body img");
  assert.ok(base, "应有 `.markdown-body img` 基础规则");
  assert.match(base.body, /max-width\s*:\s*100%/, "应有 max-width: 100%");
});
