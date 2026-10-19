// 在真实应用里验证「大纲导航」这条链路：
//   ① 预览视图下点大纲 → 预览真的滚动，且目标标题落在顶部
//   ② 点完之后大纲高亮跟到所点那一节
//   ③ 滚动预览 → 大纲高亮自动跟随（Typora 式）
//
// 用法（需要应用以远程调试端口启动）：
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//   .\src-tauri\target\release\Inkdown.exe samples\demo.md
//   node scripts/app-verify-outline.mjs
import { writeFileSync } from "node:fs";

const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("未找到页面目标");
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
    const r = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return { send, ev, ws };
}

const { send, ev, ws } = await connect();
let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✔" : "✖"} ${msg}`);
};

// ---- 准备：没有打开文档就先从「最近打开」开一份；再确保预览视图 + 大纲标签 ----
// **不指定具体文档**：工具要对任意文档生效，否则用户关掉标签之后就再也跑不起来。
const opened = await ev(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  if (document.querySelector('.tab.active')) return { opened: false, why: '已有打开的文档' };

  // 1) 侧栏要先可见，否则「最近打开」不在 DOM 里
  if (!document.querySelector('.sidebar')) {
    [...document.querySelectorAll('button')].find(b => (b.title || '') === '侧栏')?.click();
    await wait(600);
  }
  // 2) 「最近打开」只在「文件」标签下渲染
  [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '文件')?.click();
  await wait(500);

  // 3) 最近打开的按钮带完整路径（以 .md 结尾），大纲项只有标题文字
  const recents = [...document.querySelectorAll('.outline-row')]
    .filter(b => /\\.md$/i.test(b.title || ''));
  const pick = recents.find(b => /demo\\.md$/i.test(b.title)) ?? recents[0];
  if (!pick) return { opened: false, why: '「最近打开」里没有 .md', count: recents.length };
  const name = pick.title;
  pick.click();
  await wait(2200);
  return { opened: true, file: name, hasTab: !!document.querySelector('.tab.active') };
})()`);
console.log(`打开文档: ${opened.opened ? opened.file : `(已在编辑：${opened.why ?? ""})`}`);

await ev(`(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  if (!document.querySelector('.pane-preview')) {
    [...document.querySelectorAll('button')].find(b => (b.title||'').includes('预览视图'))?.click();
    await wait(1400);
  }
  [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '大纲')?.click();
  await wait(500);
})()`);

const prep = await ev(`({
  tab: document.querySelector('.tab.active')?.title ?? '(无)',
  preview: !!document.querySelector('.pane-preview'),
  editorVisible: [...document.querySelectorAll('.cm-scroller')].some(s => s.offsetParent !== null),
  rows: [...document.querySelectorAll('.outline-row')].map(r => r.textContent.trim()),
})`);
console.log(`文档: ${prep.tab}`);
console.log(`预览视图: ${prep.preview}   编辑器可见: ${prep.editorVisible}`);
console.log(`大纲 ${prep.rows.length} 项\n`);

if (!prep.preview) {
  console.log("✖ 预览未挂载，无法验证（请先切到「预览」视图）");
  ws.close();
  process.exit(2);
}
if (prep.rows.length < 3) {
  console.log("✖ 当前文档的标题少于 3 个，无法验证大纲跳转。换一份有多个标题的文档再跑。");
  ws.close();
  process.exit(2);
}

/** 点第 idx 个大纲项，返回跳转与高亮结果 */
async function clickRow(idx) {
  return ev(`
    (async () => {
      const host = document.querySelector('.pane-preview');
      const rows = [...document.querySelectorAll('.outline-row')];
      if (!host) return { ok: false, why: '预览未挂载' };
      if (!rows[${idx}]) return { ok: false, why: '大纲项不足' };
      // 先回到顶部，避免"已经在目标上"被误判成"没滚动"
      host.scrollTop = 0;
      await new Promise(r => setTimeout(r, 250));
      const row = rows[${idx}];
      const label = row.textContent.trim();
      const before = Math.round(host.scrollTop);
      row.click();
      await new Promise(r => setTimeout(r, 900));
      const after = Math.round(host.scrollTop);
      const hr = host.getBoundingClientRect();
      const heading = [...document.querySelectorAll('.markdown-body [data-line]')]
        .find(h => h.textContent.trim() === label);
      const top = heading ? Math.round(heading.getBoundingClientRect().top - hr.top) : null;
      const active = document.querySelector('.outline-row.active')?.textContent.trim() ?? '(无)';
      return { ok: true, label, before, after, top, active,
               maxScroll: Math.round(host.scrollHeight - host.clientHeight) };
    })()
  `);
}

// ---- ① 点任意几节，检查跳转精度 + 高亮同步 ----
console.log("① 点击大纲 → 预览跳转 + 高亮同步");
for (const idx of [1, Math.floor(prep.rows.length / 2), prep.rows.length - 1]) {
  const r = await clickRow(idx);
  if (!r.ok) {
    check(false, `第 ${idx} 项: ${r.why}`);
    continue;
  }
  const last = r.after >= r.maxScroll - 1; // 最后一节可能滚不动了
  check(r.after !== r.before || last, `「${r.label}」预览滚动了 (${r.before} → ${r.after})`);
  check(
    last || (r.top !== null && r.top >= 0 && r.top <= 60),
    `  目标标题落在顶部附近 (top=${r.top}${last ? "，已到底部" : ""})`,
  );
  check(r.active === r.label, `  大纲高亮跟到所点项 (实际「${r.active}」)`);
}

// ---- ② 滚动预览 → 大纲跟随 ----
console.log("\n② 滚动预览 → 大纲自动跟随");
let mismatch = 0;
for (const pct of [0, 0.25, 0.5, 0.75, 1]) {
  await ev(`(async () => {
    const h = document.querySelector('.pane-preview');
    h.scrollTop = (h.scrollHeight - h.clientHeight) * ${pct};
    await new Promise(r => setTimeout(r, 700));
  })()`);
  const d = await ev(`
    (() => {
      const host = document.querySelector('.pane-preview');
      const base = host.getBoundingClientRect().top;
      const anchors = [...document.querySelectorAll('.markdown-body [data-line]')].map(el => ({
        text: el.textContent.trim(),
        offsetTop: el.getBoundingClientRect().top - base + host.scrollTop,
      }));
      const probe = host.scrollTop + host.clientHeight * 0.25;
      let expected = anchors[0];
      for (const a of anchors) { if (a.offsetTop <= probe) expected = a; else break; }
      return {
        expected: expected?.text ?? '(空)',
        actual: document.querySelector('.outline-row.active')?.textContent.trim() ?? '(无)',
      };
    })()
  `);
  const ok = d.expected === d.actual;
  if (!ok) mismatch++;
  console.log(`    ${ok ? "✔" : "✖"} ${String(Math.round(pct * 100)).padStart(3)}%  应=${d.expected}  实=${d.actual}`);
}
check(mismatch === 0, `5 个位置全部一致（不一致 ${mismatch} 个）`);

// ---- ③ 编辑视图下点大纲 → 编辑器滚动 ----
console.log("\n③ 编辑视图下点大纲 → 编辑器滚动");
await ev(`(async () => {
  [...document.querySelectorAll('button')].find(x => (x.title||'').includes('编辑视图'))?.click();
  await new Promise(r => setTimeout(r, 1200));
  [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '大纲')?.click();
  await new Promise(r => setTimeout(r, 400));
})()`);

const editorJump = await ev(`
  (async () => {
    const scroller = [...document.querySelectorAll('.cm-scroller')].find(s => s.offsetParent !== null);
    if (!scroller) return { ok: false, why: '编辑器不可见' };
    const rows = [...document.querySelectorAll('.outline-row')];
    if (rows.length < 6) return { ok: false, why: '大纲项不足: ' + rows.length };

    // 先点第一节把位置挪开，否则"已经在目标上"会被误判成"没滚动"
    rows[0].click();
    await new Promise(r => setTimeout(r, 700));
    const before = Math.round(scroller.scrollTop);

    const row = rows[5];
    const label = row.textContent.trim();
    row.click();
    await new Promise(r => setTimeout(r, 900));
    const after = Math.round(scroller.scrollTop);
    const sr = scroller.getBoundingClientRect();
    const firstLine = [...scroller.querySelectorAll('.cm-line')]
      .map(l => ({ t: l.textContent.slice(0, 30), top: Math.round(l.getBoundingClientRect().top - sr.top) }))
      .filter(l => l.top >= -2)
      .sort((a, b) => a.top - b.top)[0] ?? null;
    return { ok: true, label, before, after, scrolled: after !== before, active: document.querySelector('.outline-row.active')?.textContent.trim() ?? '(无)', firstLine };
  })()
`);
if (!editorJump.ok) {
  check(false, `编辑视图跳转: ${editorJump.why}`);
} else {
  check(editorJump.scrolled, `点「${editorJump.label}」编辑器滚动了 (${editorJump.before} → ${editorJump.after})`);
  check(
    (editorJump.firstLine?.t ?? "").includes(editorJump.label),
    `  视口首行就是该标题（实际「${editorJump.firstLine?.t}」@top ${editorJump.firstLine?.top}）`,
  );
  check(editorJump.active === editorJump.label, `  大纲高亮跟到所点项 (实际「${editorJump.active}」)`);
}

// 回到预览视图，别把界面留在编辑态
await ev(`(async () => {
  [...document.querySelectorAll('button')].find(x => (x.title||'').includes('预览视图'))?.click();
  await new Promise(r => setTimeout(r, 800));
})()`);

// ---- 截图 ----
await ev(
  `(async () => { document.querySelector('.pane-preview').scrollTop = 0; await new Promise(r=>setTimeout(r,500)); })()`,
);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("verify-outline.png", Buffer.from(shot.data, "base64"));
console.log("\n截图: verify-outline.png");

console.log(`\n${failures === 0 ? "全部通过" : `有 ${failures} 项未通过`}`);
ws.close();
process.exit(failures === 0 ? 0 : 1);
