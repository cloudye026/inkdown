// 滚动到代码块位置并截图，专门看"代码块的颜色"。
import { writeFileSync } from "node:fs";

const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("未找到页面");
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
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

/** 关掉设置面板、滚到第一个代码块、返回它的信息 */
async function focusCodeBlock() {
  return ev(`
    (async () => {
      // 关掉设置弹窗（否则挡住预览）
      const closeBtn = [...document.querySelectorAll('.settings-modal-head button')].find(b => b.textContent.trim() === '关闭');
      if (closeBtn) closeBtn.click();
      await new Promise(r => setTimeout(r, 400));

      const pre = document.querySelector('.markdown-body pre');
      if (!pre) return { ok: false, why: '文档里没有代码块' };
      pre.scrollIntoView({ block: 'center' });
      await new Promise(r => setTimeout(r, 500));

      const cs = getComputedStyle(pre);
      const root = getComputedStyle(document.documentElement);
      const rect = pre.getBoundingClientRect();
      const tokens = [...pre.querySelectorAll('span')].slice(0, 40).map(s => ({
        t: s.textContent.slice(0, 24),
        c: getComputedStyle(s).color,
      }));
      return {
        ok: true,
        theme: document.documentElement.dataset.theme,
        font: document.documentElement.dataset.font,
        preClass: pre.className,
        preColor: cs.color,
        preBg: cs.backgroundColor,
        pageBg: getComputedStyle(document.body).backgroundColor,
        sunken: root.getPropertyValue('--bg-sunken').trim(),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        sample: tokens.slice(0, 10),
      };
    })()
  `);
}

async function switchTheme(label) {
  return ev(`
    (async () => {
      const openBtn = [...document.querySelectorAll('button')].find(b => (b.title || '').startsWith('设置'));
      if (openBtn && !document.querySelector('.theme-grid')) openBtn.click();
      await new Promise(r => setTimeout(r, 350));
      const card = [...document.querySelectorAll('.theme-card')].find(c => (c.textContent || '').includes(${JSON.stringify(label)}));
      if (!card) return { ok: false, why: '找不到卡片' };
      card.click();
      await new Promise(r => setTimeout(r, 700));
      return { ok: true };
    })()
  `);
}

const THEMES = ["Solarized 浅色", "Catppuccin Latte"];
const shots = [];

for (const label of THEMES) {
  const sw = await switchTheme(label);
  if (!sw.ok) {
    console.log(`✖ ${label}: ${sw.why}`);
    continue;
  }
  await sleep(1200);
  const info = await focusCodeBlock();
  if (!info.ok) {
    console.log(`✖ ${label}: ${info.why}`);
    continue;
  }
  console.log(`\n========== ${label} ==========`);
  console.log(`  data-theme=${info.theme}   data-font=${info.font}`);
  console.log(`  代码块 class  = ${info.preClass}`);
  console.log(`  页面底色      = ${info.pageBg}`);
  console.log(`  代码块底色    = ${info.preBg}   (--bg-sunken=${info.sunken})`);
  console.log(`  代码块默认色  = ${info.preColor}`);
  console.log(`  代码块位置    = x${info.rect.x} y${info.rect.y}  ${info.rect.w}×${info.rect.h}`);
  console.log(`  文字与颜色样例:`);
  for (const s of info.sample) console.log(`     ${JSON.stringify(s.t).padEnd(26)} ${s.c}`);

  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: {
      x: Math.max(0, info.rect.x - 20),
      y: Math.max(0, info.rect.y - 20),
      width: Math.min(1400, info.rect.w + 40),
      height: Math.min(900, info.rect.h + 40),
      scale: 1,
    },
  });
  const file = `code-${label.replace(/\s+/g, "-")}.png`;
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  shots.push(file);
  console.log(`  代码块截图: ${file}`);
}

// 最后恢复成默认主题，不留下奇怪的状态
await switchTheme("GitHub 深色");
ws.close();
console.log(`\n已恢复默认主题。截图: ${shots.join(", ")}`);
