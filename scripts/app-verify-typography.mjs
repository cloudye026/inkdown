// 在真实浏览器里验证排版的两处细节：
//   ① GFM 表格对齐（align 属性 vs 我们的 CSS 默认左对齐）
//   ② 代码块右上角的语言标签
//
// jsdom 的层叠计算不可靠，所以这一项必须在真实 WebView 里量 getComputedStyle。
import { writeFileSync } from "node:fs";

const PORT = 9222;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const p = pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
await send("Runtime.enable");
await send("Page.enable");

let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✔" : "✖"} ${msg}`);
};

// 切到 demo.md（保证有代码块可查），并进入预览视图
await ev(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => (t.title||'').endsWith('demo.md'));
  tab?.click();
  await new Promise(r => setTimeout(r, 1400));
  if (!document.querySelector('.pane-preview')) {
    [...document.querySelectorAll('button')].find(b => (b.title||'').includes('预览视图'))?.click();
    await new Promise(r => setTimeout(r, 1200));
  }
})()`);

/**
 * WebKit 会把 `align` 这个表现性属性算成带前缀的值
 * （`-webkit-center` / `-webkit-right` / `-webkit-left`），
 * 语义与 `center` / `right` / `left` 相同。比较前统一去掉前缀。
 */
const norm = (v) => String(v).replace(/^-webkit-/, "");

// ---- ① 表格对齐 ----
console.log("① 表格对齐（往预览里临时插一张带 align 的表，量完移除）");
const table = await ev(`
  (() => {
    const body = document.querySelector('.markdown-body');
    if (!body) return { ok: false, why: '没有 .markdown-body' };
    const probe = document.createElement('div');
    probe.id = '__align_probe__';
    probe.innerHTML =
      '<table><thead><tr>' +
      '<th align="left">左</th><th align="center">中</th><th align="right">右</th><th>默认</th>' +
      '</tr></thead><tbody><tr>' +
      '<td align="left">a</td><td align="center">b</td><td align="right">c</td><td>d</td>' +
      '</tr></tbody></table>';
    body.appendChild(probe);

    const cs = (sel) => getComputedStyle(probe.querySelector(sel)).textAlign;
    const result = {
      ok: true,
      thLeft: cs('th[align="left"]'),
      thCenter: cs('th[align="center"]'),
      thRight: cs('th[align="right"]'),
      thDefault: cs('th:not([align])'),
      tdLeft: cs('td[align="left"]'),
      tdCenter: cs('td[align="center"]'),
      tdRight: cs('td[align="right"]'),
      tdDefault: cs('td:not([align])'),
    };
    probe.remove();
    return result;
  })()
`);
if (!table.ok) {
  check(false, `表格探针失败: ${table.why}`);
} else {
  check(norm(table.thCenter) === "center", `表头居中对齐列 → ${table.thCenter}`);
  check(norm(table.thRight) === "right", `表头右对齐列 → ${table.thRight}`);
  check(norm(table.thLeft) === "left", `表头左对齐列 → ${table.thLeft}`);
  check(norm(table.thDefault) === "left", `表头未指定列 → ${table.thDefault}（默认 left，GitHub 风格）`);
  check(norm(table.tdCenter) === "center", `单元格居中列 → ${table.tdCenter}`);
  check(norm(table.tdRight) === "right", `单元格右对齐列 → ${table.tdRight}`);
  check(norm(table.tdDefault) === "left", `单元格未指定列 → ${table.tdDefault}`);
  // 最关键的一条：对齐列**没有**被默认规则压成 left
  check(
    ![table.thCenter, table.thRight, table.tdCenter, table.tdRight].some((v) => norm(v) === "left"),
    "对齐列没有被默认的左对齐规则盖掉",
  );
}

// ---- ② 语言标签 ----
console.log("\n② 代码块语言标签");
const lang = await ev(`
  (() => {
    const pres = [...document.querySelectorAll('.markdown-body pre')];
    return {
      count: pres.length,
      items: pres.slice(0, 6).map(p => {
        const before = getComputedStyle(p, '::before');
        return {
          lang: p.getAttribute('data-lang'),
          cls: p.className.split(' ').slice(0, 2).join(' '),
          content: before.content,
          fontSize: before.fontSize,
          color: before.color,
          pos: before.position,
        };
      }),
    };
  })()
`);
console.log(`  预览里有 ${lang.count} 个代码块`);
for (const it of lang.items) {
  console.log(
    `    data-lang=${String(it.lang).padEnd(10)} ::before content=${String(it.content).padEnd(10)} size=${it.fontSize} color=${it.color}`,
  );
}
const withLang = lang.items.filter((i) => i.lang);
check(withLang.length > 0, `至少一个代码块带 data-lang（${withLang.length} 个）`);
check(
  withLang.every((i) => i.content && i.content !== "none"),
  `带语言的块都画出了 ::before 内容（${withLang.map((i) => i.content).join(", ")}）`,
);
check(
  lang.items.filter((i) => !i.lang).every((i) => !i.content || i.content === "none"),
  "无语言的块没有多余标签",
);

// ---- ③ 截图 ----
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("verify-typo-details.png", Buffer.from(shot.data, "base64"));
console.log("\n截图: verify-typo-details.png");
console.log(`\n${failures === 0 ? "全部通过" : `有 ${failures} 项未通过`}`);
ws.close();
process.exit(failures === 0 ? 0 : 1);
