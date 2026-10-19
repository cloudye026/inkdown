// 给 README 拍截图：预览（hero）、编辑器、主题面板。
// 全部走页面内 JS，不注入系统输入。
import { mkdirSync, writeFileSync } from "node:fs";

const PORT = 9222;
const OUT = "docs";
mkdirSync(OUT, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("未找到页面");
  process.exit(2);
}
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

const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, "base64"));
  console.log(`  ${OUT}/${name}`);
};

// 统一准备：打开 demo.md、侧栏展开在文件标签、浅色主题（截图更清爽）
await ev(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  if (!document.querySelector('.tab.active')) {
    // 从「最近打开」里挑一份
    document.querySelector('.sidebar') || [...document.querySelectorAll('button')].find(b => (b.title||'') === '侧栏')?.click();
    await wait(500);
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '文件')?.click();
    await wait(400);
    const recents = [...document.querySelectorAll('.outline-row')].filter(b => /\\.md$/i.test(b.title || ''));
    (recents.find(b => /demo\\.md$/i.test(b.title)) ?? recents[0])?.click();
    await wait(2200);
  }
  if (!document.querySelector('.sidebar')) {
    [...document.querySelectorAll('button')].find(b => (b.title||'') === '侧栏')?.click();
    await wait(600);
  }
  [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '文件')?.click();
  await wait(400);
  if (!document.querySelector('.pane-preview')) {
    [...document.querySelectorAll('button')].find(b => (b.title||'').includes('预览视图'))?.click();
    await wait(1500);
  }
})()`);

// ---- 1. hero：预览里滚到「四、代码高亮」那一节 ----
console.log("截图 1：预览（hero）");
await ev(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const host = document.querySelector('.pane-preview');
  const target = [...document.querySelectorAll('.markdown-body [data-line]')]
    .find(h => h.textContent.includes('代码高亮'));
  if (host && target) {
    const base = host.getBoundingClientRect().top;
    host.scrollTop = target.getBoundingClientRect().top - base + host.scrollTop - 24;
  }
  await wait(700);
})()`);
await shot("screenshot.png");

// ---- 2. 编辑器：语法着色 + 行级装饰 ----
console.log("截图 2：编辑器");
await ev(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  [...document.querySelectorAll('button')].find(b => (b.title||'').includes('编辑视图'))?.click();
  await wait(1600);
  // 滚到代码块，让围栏里的高亮入镜
  const scroller = [...document.querySelectorAll('.cm-scroller')].find(s => s.offsetParent !== null);
  if (scroller) {
    // 找代码围栏那一行。**不能在这里写反引号字面量**：
  // 这段代码本身位于模板字符串里，一个反引号就会把它提前截断
  // （真踩过：整个脚本报 SyntaxError，看起来像 Node 坏了）。
  const fence = String.fromCharCode(96).repeat(3);
  const lines = [...scroller.querySelectorAll('.cm-line')];
  const code = lines.find(l => l.textContent.includes(fence));
    if (code) {
      const sr = scroller.getBoundingClientRect();
      scroller.scrollTop += code.getBoundingClientRect().top - sr.top - 60;
    }
  }
  await wait(700);
})()`);
await shot("screenshot-editor.png");

// ---- 3. 主题面板 ----
console.log("截图 3：主题面板");
await ev(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  [...document.querySelectorAll('button')].find(b => (b.title||'').includes('预览视图'))?.click();
  await wait(1400);
  // 顶栏主题按钮（title 里带「主题」）
  const btn = [...document.querySelectorAll('button')].find(b => /^主题/.test(b.title || ''));
  btn?.click();
  await wait(800);
})()`);
await shot("screenshot-themes.png");

// 收尾：关掉主题面板，回到预览
await ev(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(400);
})()`);

console.log("\n完成");
ws.close();
