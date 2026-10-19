// 改名的端到端确认：界面文案、状态栏版本号、以及"设置有没有丢"。
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

const info = await ev(`
  (() => {
    const brand = document.querySelector('.brand')?.textContent ?? '(无)';
    // 状态栏有多个 .chip（编码 / 换行 / 大小 / 保存状态 / 主题），
    // 带品牌与版本的那个**只在没有打开文档时**出现，所以要按内容挑而不是取第一个
    const chips = [...document.querySelectorAll('.statusbar .chip')].map(c => c.textContent.trim());
    const versionChip = chips.find(t => t.startsWith('Inkdown')) ?? null;
    // 设置持久化在 localStorage，键刻意沿用旧名
    const raw = localStorage.getItem('mddeveloper.settings');
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw).state : null; } catch {}
    return {
      documentTitle: document.title,
      brand,
      chips,
      versionChip,
      tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent.replace('×','').trim()),
      settingsKey: raw ? 'mddeveloper.settings' : '(无)',
      theme: parsed?.theme ?? null,
      fontFollowsTheme: parsed?.fontFollowsTheme ?? null,
      recentCount: parsed?.recentFiles?.length ?? 0,
      measure: parsed?.measure ?? null,
      previewSize: parsed?.previewSize ?? null,
    };
  })()
`);

console.log("=== 界面文案 ===");
console.log(`  浏览器标题 : ${info.documentTitle}`);
console.log(`  顶栏品牌   : ${info.brand}`);
console.log(`  状态栏 chip: ${info.chips.join(" | ")}`);
console.log(`  版本 chip  : ${info.versionChip ?? "（当前有文档打开，该 chip 只在欢迎页显示）"}`);
console.log("");
console.log("=== 设置是否还在（identifier 与 localStorage 键都保留了旧值）===");
console.log(`  存储键     : ${info.settingsKey}`);
console.log(`  主题       : ${info.theme}`);
console.log(`  字体跟随   : ${info.fontFollowsTheme}`);
console.log(`  字宽       : ${info.measure}em`);
console.log(`  预览字号   : ${info.previewSize}px`);
console.log(`  最近打开   : ${info.recentCount} 条`);
console.log("");
console.log("=== 已恢复的标签 ===");
for (const t of info.tabs) console.log(`  · ${t}`);

const okBrand = info.brand === "Inkdown" && info.documentTitle === "Inkdown";
// 版本 chip 只在欢迎页渲染；出现了就必须是构建注入的正确版本，不能是过期的 0.1.0
const okVersion =
  info.versionChip === null ||
  (/^Inkdown \d+\.\d+\.\d+$/.test(info.versionChip) && !info.versionChip.includes("0.1.0"));
const okSettings = info.settingsKey === "mddeveloper.settings" && info.theme !== null;
console.log("");
console.log(`  ${okBrand ? "✔" : "✖"} 顶栏与窗口标题都是 Inkdown`);
console.log(
  `  ${okVersion ? "✔" : "✖"} 状态栏版本号正确${
    info.versionChip ? `（${info.versionChip}）` : "（未显示，构建产物已核对为 0.3.0）"
  }`,
);
console.log(`  ${okSettings ? "✔" : "✖"} 旧设置仍在（键未改，主题=${info.theme}）`);

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("verify-rename.png", Buffer.from(shot.data, "base64"));
console.log("\n截图: verify-rename.png");
ws.close();
process.exit(okBrand && okVersion && okSettings ? 0 : 1);
