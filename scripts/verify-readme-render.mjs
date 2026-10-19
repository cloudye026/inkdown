// 用 Inkdown 自己渲染 README，截图验收（顺便验证相对路径图片能解析）。
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

// 确保预览视图、滚到顶部、等图片加载
await ev(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  if (!document.querySelector('.pane-preview')) {
    [...document.querySelectorAll('button')].find(b => (b.title||'').includes('预览视图'))?.click();
    await wait(1600);
  }
  const host = document.querySelector('.pane-preview');
  if (host) host.scrollTop = 0;
  [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '大纲')?.click();
  await wait(2500);
})()`);

const info = await ev(`
  (() => {
    const body = document.querySelector('.markdown-body');
    const imgs = [...body.querySelectorAll('img')].map(i => ({
      src: i.getAttribute('src')?.slice(0, 46),
      loaded: i.complete && i.naturalWidth > 0,
      w: i.naturalWidth,
    }));
    return {
      tab: document.querySelector('.tab.active')?.title,
      h1: body.querySelector('h1')?.textContent?.trim() ?? '(无 h1)',
      imgCount: imgs.length,
      imgs: imgs.slice(0, 8),
      outline: [...document.querySelectorAll('.outline-row')].map(r => r.textContent.trim()).slice(0, 10),
    };
  })()
`);

console.log(`文档: ${info.tab}`);
console.log(`H1  : ${info.h1}`);
console.log(`图片: ${info.imgCount} 张`);
for (const i of info.imgs) console.log(`  ${i.loaded ? "✔" : "✖"} w=${String(i.w).padEnd(5)} ${i.src}`);
console.log(`大纲: ${info.outline.join(" | ")}`);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("verify-readme-render.png", Buffer.from(shot.data, "base64"));
console.log("\n截图: verify-readme-render.png");
ws.close();
