// 验证文件树图标：真的画出来了、按类型不同、文件夹按展开状态切换、名字左边缘仍对齐。
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

// 切到「文件」标签
await ev(`(async () => {
  [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '文件')?.click();
  await new Promise(r => setTimeout(r, 600));
})()`);

const report = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.tree-row')];
    const items = rows.map(row => {
      const icon = row.querySelector('.tree-icon');
      const name = row.querySelector('.name');
      return {
        cls: row.className,
        name: name ? name.textContent.trim() : '(无)',
        icon: icon ? (icon.className.match(/kind-[\\w-]+/) || ['(无)'])[0] : '(无图标)',
        svgPaths: icon ? icon.querySelectorAll('path, rect, circle').length : 0,
        iconColor: icon ? getComputedStyle(icon).color : null,
        nameLeft: name ? Math.round(name.getBoundingClientRect().left) : null,
      };
    });
    // 同级对齐检查：同一层级(导轨条数相同)的行，名字左边缘应一致
    const byDepth = {};
    for (const row of rows) {
      const guides = row.querySelectorAll('.tree-guide').length;
      const name = row.querySelector('.name');
      if (!name) continue;
      (byDepth[guides] ||= []).push(Math.round(name.getBoundingClientRect().left));
    }
    const alignment = Object.entries(byDepth).map(([d, lefts]) => ({
      depth: Number(d),
      count: lefts.length,
      distinct: [...new Set(lefts)],
      aligned: new Set(lefts).size === 1,
    }));
    return { total: rows.length, items: items.slice(0, 20), alignment };
  })()
`);

console.log(`文件树共 ${report.total} 行\n`);
console.log("行 | 名称 | 图标种类 | SVG 元素数 | 图标颜色");
for (const it of report.items) {
  console.log(
    `${it.cls.includes("dir") ? "D" : it.cls.includes("root") ? "R" : "F"}  ${it.name.padEnd(16)} ${it.icon.padEnd(16)} ${String(it.svgPaths).padEnd(4)} ${it.iconColor}`,
  );
}

console.log("\n同级名字左边缘对齐:");
for (const a of report.alignment) {
  console.log(`  层级 ${a.depth}: ${a.count} 行，左边缘 ${a.distinct.join(" / ")} ${a.aligned ? "✔ 对齐" : "✖ 不齐"}`);
}

const kinds = new Set(report.items.map((i) => i.icon));
console.log(`\n出现的图标种类: ${[...kinds].join(", ")}`);
const allHaveSvg = report.items.every((i) => i.svgPaths > 0);
console.log(`每行都有图标且画出了图形: ${allHaveSvg ? "✔" : "✖"}`);

// 展开一个文件夹，看图标是否切换
const toggle = await ev(`
  (async () => {
    const dir = [...document.querySelectorAll('.tree-row.dir')][0];
    if (!dir) return { ok: false, why: '没有文件夹行' };
    const before = dir.querySelector('.tree-icon')?.className.match(/kind-[\\w-]+/)?.[0];
    dir.click();
    await new Promise(r => setTimeout(r, 700));
    const dir2 = [...document.querySelectorAll('.tree-row.dir')][0];
    const after = dir2?.querySelector('.tree-icon')?.className.match(/kind-[\\w-]+/)?.[0];
    return { ok: true, name: dir.querySelector('.name')?.textContent, before, after, changed: before !== after };
  })()
`);
console.log(`\n文件夹展开切换图标: ${JSON.stringify(toggle)}`);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("verify-tree-icons.png", Buffer.from(shot.data, "base64"));
console.log("截图: verify-tree-icons.png");
ws.close();
