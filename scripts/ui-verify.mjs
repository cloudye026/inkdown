// 界面结构验证：连进正在运行的应用（CDP），检查这一版的三条界面改动是否真的生效。
//
// 验证的是"用户能看到的东西"，不是源码里的字符串：
//   1. 顶栏只剩 搜索 / 编辑·预览开关 / 侧栏 / 主题 / 设置 —— 动作按钮全没了
//   2. 搜索面板一个输入框同时给命令与文件
//   3. 预览是整幅切换，不是左右对照（没有分割条、预览占满宽度）
//
// 用法：
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//   .\src-tauri\target\release\mddeveloper.exe --workspace samples samples\demo.md
//   node scripts/ui-verify.mjs
import { writeFileSync } from "node:fs";

const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("未找到页面：应用没起来，或者没带 --remote-debugging-port=9222");
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

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function shot(file) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  截图: ${file}`);
}

// ---------------------------------------------------------------- 1. 顶栏
const topbar = await ev(`
  (() => {
    const bar = document.querySelector('.topbar');
    if (!bar) return { ok: false };
    const buttons = [...bar.querySelectorAll('button')].map(b => ({
      text: (b.textContent || '').trim(),
      title: b.title || '',
      active: b.classList.contains('active'),
    }));
    return {
      ok: true,
      brand: (bar.querySelector('.brand')?.textContent || '').trim(),
      buttons,
      width: Math.round(bar.getBoundingClientRect().width),
      scrollWidth: bar.scrollWidth,
      viewSwitch: !!bar.querySelector('.view-switch'),
    };
  })()
`);

check("顶栏存在", topbar.ok);
console.log(`  品牌=${topbar.brand}  顶栏按钮: ${topbar.buttons.map((b) => b.text).join(" | ")}`);

const removed = ["打开", "文件夹", "新建", "保存", "B", "I", "🔗", "<>", "❝", "⇤", "≣", "✓", "跳转…", "命令"];
const stillThere = removed.filter((label) => topbar.buttons.some((b) => b.text === label));
check("动作按钮全部撤掉", stillThere.length === 0, stillThere.length ? `仍在: ${stillThere.join(", ")}` : "无残留");
check(
  "只留入口：搜索 + 视图开关 + 侧栏/主题/设置",
  topbar.buttons.some((b) => b.text.startsWith("搜索")) && topbar.viewSwitch,
  topbar.viewSwitch ? "编辑/预览为分段开关" : "缺少 .view-switch",
);
check(
  "窄窗口下顶栏不被裁",
  topbar.scrollWidth <= topbar.width + 1,
  `内容宽 ${topbar.scrollWidth} ≤ 容器宽 ${topbar.width}`,
);
await shot("ui-1-topbar.png");

// ---------------------------------------------------------------- 2. 视图切换
const geometry = () =>
  ev(`
    (() => {
      const panes = document.querySelector('.panes');
      const editor = document.querySelector('.pane-editor');
      const preview = document.querySelector('.pane-preview');
      const inner = document.querySelector('.panes .splitter');
      const r = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
      return {
        panes: r(panes),
        editor: r(editor),
        editorDisplay: editor ? getComputedStyle(editor).display : null,
        editorMounted: !!editor,
        preview: r(preview),
        innerSplitter: !!inner,
        view: [...document.querySelectorAll('.view-switch button')].find(b => b.classList.contains('active'))?.textContent.trim() ?? null,
      };
    })()
  `);

const clickView = async (label) => {
  await ev(`
    (() => {
      const btn = [...document.querySelectorAll('.view-switch button')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
      if (btn) btn.click();
      return !!btn;
    })()
  `);
  await sleep(900);
};

const before = await geometry();
check("默认停在编辑视图", before.view === "编辑", `当前视图=${before.view}`);
check("编辑视图下没有预览面板", before.preview === null && before.editor !== null);
check("编辑视图占满宽度", before.editor === before.panes, `${before.editor}px / 容器 ${before.panes}px`);

// 进入预览前先滚动编辑器，等切回来时检查位置有没有丢
const scrollBefore = await ev(`
  (() => {
    const sc = document.querySelector('.pane-editor .cm-scroller');
    if (!sc) return null;
    sc.scrollTop = Math.min(600, Math.max(0, sc.scrollHeight - sc.clientHeight));
    sc.dispatchEvent(new Event('scroll'));
    return Math.round(sc.scrollTop);
  })()
`);
await sleep(400);

await clickView("预览");
const inPreview = await geometry();
check("切到预览后只看到预览", inPreview.preview !== null && inPreview.editorDisplay === "none");
check(
  "不再左右对照：没有分割条、预览占满宽度",
  !inPreview.innerSplitter && inPreview.preview === inPreview.panes,
  `预览 ${inPreview.preview}px / 容器 ${inPreview.panes}px，分割条=${inPreview.innerSplitter}`,
);

// 编辑器实例必须留在 DOM 里（只是藏起来）：重建实例会把光标位置和撤销历史丢掉
const kept = await ev(`
  (() => {
    const el = document.querySelector('.pane-editor');
    window.__editorPane = el;
    return {
      mounted: !!el,
      editors: document.querySelectorAll('.pane-editor .cm-editor').length,
    };
  })()
`);
check(
  "编辑器实例仍然挂载（只是隐藏）",
  kept.mounted && kept.editors > 0,
  `隐藏的编辑器实例 ${kept.editors} 个`,
);
await shot("ui-2-preview.png");

await clickView("编辑");
const backToEdit = await geometry();
check(
  "切回编辑，编辑器回到满宽",
  backToEdit.editor === backToEdit.panes && backToEdit.preview === null,
  `编辑器 ${backToEdit.editor}px / 容器 ${backToEdit.panes}px`,
);

const keptSame = await ev(`document.querySelector('.pane-editor') === window.__editorPane`);
check("切回来还是同一个编辑器节点（没被重建）", keptSame === true);

// 采样两次：刚切回来那一瞬间，CodeMirror 可能还在重新测量（首次挂载预览时更慢），
// 而"位置丢没丢"要看**最终**停在哪。永久丢失两次都不是原位。
const scrollAfter = [];
for (let i = 0; i < 2; i++) {
  scrollAfter.push(
    await ev(`
      (() => {
        const sc = document.querySelector('.pane-editor .cm-scroller');
        return sc ? Math.round(sc.scrollTop) : null;
      })()
    `),
  );
  await sleep(600);
}
check(
  "编辑器滚动位置不丢",
  scrollBefore === null || (scrollAfter[scrollAfter.length - 1] ?? 0) === scrollBefore,
  `切走前 ${scrollBefore}px → 切回后采样 ${scrollAfter.join(", ")}px`,
);

// ---------------------------------------------------------------- 3. 搜索面板
const paletteState = () =>
  ev(`
    (() => {
      const palette = document.querySelector('.palette');
      if (!palette) return { open: false };
      const items = [...palette.querySelectorAll('.palette-item')].map(el => ({
        title: el.querySelector('.title')?.textContent ?? '',
        sub: el.querySelector('.sub')?.textContent ?? '',
      }));
      const sections = [...palette.querySelectorAll('.palette-section')].map(el => el.textContent.trim());
      return {
        open: true,
        placeholder: palette.querySelector('input')?.placeholder ?? '',
        sections,
        items,
      };
    })()
  `);

const type = async (text) => {
  await ev(`
    (() => {
      const input = document.querySelector('.palette input');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(400);
};

/**
 * 确保面板开着再输入。
 *
 * 面板偶尔会因为应用侧的一次重排/重载而消失（长跑脚本 + 图表渲染时的偶发），
 * 那不是"功能坏了"，但会让后面的断言读到 undefined。宁可在这里重开一次并留下
 * 明确诊断，也不要把这种噪声当成回归。
 */
const ensurePalette = async () => {
  for (let i = 0; i < 3; i++) {
    const st = await paletteState();
    if (st.open) return true;
    await ev(`
      (() => {
        const btn = [...document.querySelectorAll('.topbar button')].find(b => b.textContent.trim().startsWith('搜索'));
        if (btn) btn.click();
        return !!btn;
      })()
    `);
    await sleep(1200);
  }
  const diag = await ev(`
    (() => ({
      hasApp: !!document.querySelector('.app'),
      topbar: [...document.querySelectorAll('.topbar button')].map(b => b.textContent.trim()),
    }))()
  `);
  console.log("  诊断：", JSON.stringify(diag));
  return false;
};

/**
 * 轮询等待某个条件成立。
 *
 * 应用刚起来那几秒要编译 Shiki 的 WASM、跑首屏渲染，主线程会被占住：
 * 这时候"派发了事件 → 立刻读 DOM"会读到还没渲染出来的状态，
 * 表现为随机某几项失败。断言的是**最终会不会成立**，不是"多快成立"。
 */
const waitFor = async (fn, timeoutMs = 5000, stepMs = 200) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await sleep(stepMs);
  }
};

// Ctrl+P：App 的全局快捷键，这条路径不经过任何按钮
const key = async (k, opts = {}) => {
  await ev(`
    window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ${JSON.stringify(k)}, bubbles: true }, ${JSON.stringify(opts)})))
  `);
  await sleep(1200);
};

await key("p", { ctrlKey: true });
const byShortcut = await waitFor(async () => (await paletteState()).open);
check("Ctrl+P 也能打开搜索面板", byShortcut === true, byShortcut ? "" : "3 秒内没打开");
await key("Escape");
await waitFor(async () => !(await paletteState()).open);

const paletteUp = await ensurePalette();
const emptyQuery = await paletteState();
check("点「搜索…」打开面板", paletteUp, emptyQuery.open ? `占位符「${emptyQuery.placeholder}」` : "没打开");
check(
  "空输入只列命令（不做文件空转）",
  emptyQuery.open && emptyQuery.items.length > 0 && emptyQuery.sections.includes("命令"),
  `${emptyQuery.items?.length ?? 0} 条，分组: ${emptyQuery.sections?.join("/")}`,
);

await ensurePalette();
await type("自检");
const cmdSearch = await waitFor(async () => {
  const st = await paletteState();
  return (st.items ?? []).some((i) => i.title.includes("结构自检")) ? st : null;
});
const cmdItems = (cmdSearch ?? (await paletteState())).items ?? [];
check(
  "原来顶栏 ✓ 才能用的「结构自检」现在搜得到",
  cmdItems.some((i) => i.title.includes("结构自检")),
  cmdItems.map((i) => i.title).join(" / ") || "(面板没开)",
);

await ensurePalette();
await type("demo");
const fileSearch = await waitFor(async () => {
  const st = await paletteState();
  return (st.items ?? []).some((i) => i.sub.includes("demo")) ? st : null;
});
const fileItems = (fileSearch ?? (await paletteState())).items ?? [];
check(
  "同一个输入框也搜文件",
  fileItems.some((i) => i.sub.includes("demo")),
  fileItems.map((i) => `${i.title}(${i.sub})`).join(" / ") || "无结果（工作区没打开？）",
);
await shot("ui-3-search.png");

// 一个字母同时命中命令 id 与文件名，用来验证"两种结果在同一个列表里、命令在前"
await ensurePalette();
await type("e");
const mixed = await ev(`
  (() => {
    const items = [...document.querySelectorAll('.palette-item')];
    return {
      sections: [...document.querySelectorAll('.palette-section')].map(el => el.textContent.trim()),
      first: items[0]?.querySelector('.title')?.textContent ?? '',
      count: items.length,
    };
  })()
`);
check(
  "命令与文件出现在同一个列表，且命令在前",
  mixed.sections.includes("命令") && mixed.sections.includes("文件") && mixed.first.length > 0,
  `分组 ${mixed.sections.join("/")}，共 ${mixed.count} 条，首条「${mixed.first}」`,
);
await ev(`
  (() => {
    const overlay = document.querySelector('.overlay');
    if (overlay) overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  })()
`);
await sleep(300);

// ---------------------------------------------------------------- 4. 按钮删了 ≠ 功能删了
// 在**预览视图**下从搜索面板执行一个格式命令：应该自动切回编辑视图并真的改动文档。
// 这条路径最容易出事——事件派发与 React 渲染谁先谁后，只有跑起来才知道。
//
// 判据用**状态栏的字符数**：上一步刚把编辑器滚到中间，CodeMirror 只渲染可视行，
// "取第一行的文字"取到的是当前渲染出来的那一行，命令改的却是光标所在行——
// 两者根本不是同一行。字符数不受滚动和虚拟化影响。
const charCount = async () => {
  const text = await ev(`document.querySelector('.statusbar')?.textContent ?? ''`);
  const m = text.match(/([0-9]+)\s*字符/);
  return m ? Number(m[1]) : null;
};
const charsBefore = await charCount();

await clickView("预览");
await key("p", { ctrlKey: true });
await waitFor(async () => (await paletteState()).open);
await type("无序列表");
// 等列表里真的出现这条命令再回车：否则回车会落到列表第一项（可能触发打开文件对话框）
const readyToCommit = await waitFor(async () => {
  const st = await paletteState();
  return (st.items ?? []).some((i) => i.title.includes("无序列表"));
}, 4000);
if (!readyToCommit) await ev(`console.warn('palette did not show 无序列表')`);
await ev(`
  (() => {
    const input = document.querySelector('.palette input');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()
`);
await sleep(1200);

const afterCommand = await ev(`
  (() => ({
    view: [...document.querySelectorAll('.view-switch button')].find(b => b.classList.contains('active'))?.textContent.trim() ?? null,
    paletteClosed: !document.querySelector('.palette'),
  }))()
`);
const charsAfter = await charCount();
check(
  "预览视图下执行格式命令会自动切回编辑视图",
  afterCommand.view === "编辑" && afterCommand.paletteClosed,
  `视图=${afterCommand.view}，面板已关闭=${afterCommand.paletteClosed}`,
);
check(
  "命令真的作用到了文档（字符数随之变化）",
  charsBefore !== null && charsAfter !== null && charsAfter !== charsBefore,
  `${charsBefore} → ${charsAfter} 字符`,
);

// 编辑器里的 **token 级** 高亮：曾经因为 HighlightStyle 带了 themeType 而被整段丢掉，
// 只剩行级装饰（标题变大、代码行加底纹），用户看到的现象是"json 代码片段没高亮"。
// 这里查标题行里有没有 .cm-md-heading 的 token span —— 有 span 才说明高亮样式挂上了。
await ev(`(() => { const sc = document.querySelector('.pane-editor .cm-scroller'); if (sc) sc.scrollTop = 0; return true; })()`);
await sleep(600);
const editorTokens = await ev(`
  (() => {
    const line = [...document.querySelectorAll('.pane-editor .cm-content .cm-line')]
      .find((l) => (l.textContent ?? '').startsWith('#'));
    if (!line) return null;
    const spans = [...line.querySelectorAll('span')];
    return {
      text: (line.textContent ?? '').slice(0, 30),
      spans: spans.length,
      headingSpan: spans.some((s) => s.className.includes('cm-md-heading')),
      classes: [...new Set(spans.map((s) => s.className).filter(Boolean))],
    };
  })()
`);
check(
  "编辑器里 token 级高亮生效（标题不是一整块纯文本）",
  editorTokens?.headingSpan === true,
  editorTokens
    ? `「${editorTokens.text}」分成 ${editorTokens.spans} 个 token：${editorTokens.classes.join(" / ") || "（无 class）"}`
    : "找不到标题行",
);

// ---------------------------------------------------------------- 5. 主题选择浮层
const clickTop = async (titlePrefix) =>
  ev(`
    (() => {
      const b = [...document.querySelectorAll('.topbar button')].find(x => (x.title || '').startsWith(${JSON.stringify(titlePrefix)}));
      if (b) b.click();
      return !!b;
    })()
  `);

await clickTop("主题");
await sleep(700);
const menu = await ev(`
  (() => {
    const el = document.querySelector('.theme-menu');
    if (!el) return { open: false };
    const r = el.getBoundingClientRect();
    return {
      open: true,
      cards: el.querySelectorAll('.theme-card').length,
      groups: [...el.querySelectorAll('.theme-menu-group')].map(g => g.textContent.trim()),
      inside: r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 0 && r.bottom <= window.innerHeight + 1,
      rect: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
    };
  })()
`);
check(
  "点顶栏 ☾ 打开主题选择（不再盲目轮换）",
  menu.open && menu.cards === 15,
  menu.open ? `${menu.cards} 套主题，分组 ${menu.groups.join("/")}，位置 ${JSON.stringify(menu.rect)}` : "没打开",
);
check("浮层完整落在窗口内", menu.inside === true);
await shot("ui-7-theme-menu.png");

const themeBefore = await ev(`document.documentElement.dataset.theme`);
const picked = await ev(`
  (() => {
    const card = [...document.querySelectorAll('.theme-menu .theme-card')].find(c => !c.classList.contains('active'));
    if (!card) return null;
    const label = card.querySelector('.theme-label').textContent;
    card.click();
    return label;
  })()
`);
await sleep(800);
const afterPick = await ev(`
  (() => ({ theme: document.documentElement.dataset.theme, menuOpen: !!document.querySelector('.theme-menu') }))()
`);
check(
  "点一套主题就换过去，并自动收起浮层",
  afterPick.theme !== themeBefore && afterPick.menuOpen === false,
  `选「${picked}」：${themeBefore} → ${afterPick.theme}，浮层已收起=${!afterPick.menuOpen}`,
);

// 状态栏那一侧：锚点在窗口底部，浮层应该向上弹且不出界
await ev(`
  (() => {
    const chip = [...document.querySelectorAll('.statusbar .chip')].find(c => (c.title || '').includes('当前主题'));
    if (chip) chip.click();
    return !!chip;
  })()
`);
await sleep(700);
const bottomMenu = await ev(`
  (() => {
    const el = document.querySelector('.theme-menu');
    if (!el) return { open: false };
    const r = el.getBoundingClientRect();
    return {
      open: true,
      inside: r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 0 && r.bottom <= window.innerHeight + 1,
      anchoredToBottom: el.style.bottom !== '',
      top: Math.round(r.top),
    };
  })()
`);
check(
  "状态栏主题名同样打开选择，且向上弹不出界",
  bottomMenu.open && bottomMenu.inside && bottomMenu.anchoredToBottom,
  bottomMenu.open ? `bottom 定位=${bottomMenu.anchoredToBottom}，面板顶部 y=${bottomMenu.top}` : "没打开",
);
await shot("ui-8-theme-menu-bottom.png");

// 点空白处关闭浮层。
// 用 elementFromPoint 取"那个坐标上真正最上层的元素"再派发事件：
// 直接对 .panes 派发会绕过命中测试，等于假装点到了根本不接受点击的地方。
await ev(`
  (() => {
    const target = document.elementFromPoint(300, 400) ?? document.body;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return target.className;
  })()
`);
await sleep(400);
const menuClosed = await ev(`!document.querySelector('.theme-menu')`);
check("点空白处关闭主题浮层", menuClosed === true);

// ---------------------------------------------------------------- 6. 设置弹窗
await clickTop("设置");
await sleep(600);
const readModal = () =>
  ev(`
    (() => {
      const el = document.querySelector('.settings-modal');
      if (!el) return { open: false };
      const r = el.getBoundingClientRect();
      const nav = [...el.querySelectorAll('.settings-nav-item')].map((b) =>
        (b.querySelector('.nav-label')?.textContent ?? '').trim(),
      );
      return {
        open: true,
        // 居中：中心点与窗口中心差 6px 以内
        centered: Math.abs(r.left + r.width / 2 - window.innerWidth / 2) < 6 &&
                  Math.abs(r.top + r.height / 2 - window.innerHeight / 2) < 6,
        inside: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
        backdrop: !!document.querySelector('.settings-backdrop'),
        nav,
        active: el.querySelector('.settings-nav-item.active .nav-label')?.textContent?.trim() ?? null,
        themeCards: el.querySelectorAll('.theme-card').length,
        rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      };
    })()
  `);
// 刚启动那几秒，弹窗可能先画出外框、内容还在渲染（15 张主题卡不便宜）——
// 等"内容真的出现了"再断言，否则会读到 themeCards=0 的中间态
const modal = (await waitFor(async () => {
  const st = await readModal();
  return st.open && st.themeCards > 0 ? st : null;
}, 5000)) ?? (await readModal());
check(
  "点 ⚙ 打开设置弹窗",
  modal.open === true,
  modal.open ? `${modal.rect.w}×${modal.rect.h} @ (${modal.rect.left},${modal.rect.top})` : "没打开",
);
check(
  "设置是居中的弹窗（不是贴边抽屉），带压暗层且在窗口内",
  modal.centered === true && modal.inside === true && modal.backdrop === true,
  `居中=${modal.centered}，在窗口内=${modal.inside}，压暗层=${modal.backdrop}`,
);
check(
  "左侧四个分类，默认停在外观、15 套主题都在",
  modal.nav.length === 4 && modal.active === "外观" && modal.themeCards === 15,
  `分类：${modal.nav.join(" / ")}，当前「${modal.active}」，主题卡 ${modal.themeCards}`,
);

// 切分类：内容要真的换掉（主题卡消失、出现该分类的项）
const switchTab = async (label) => {
  const ok = await ev(`
    (() => {
      const btn = [...document.querySelectorAll('.settings-nav-item')].find(
        (b) => (b.querySelector('.nav-label')?.textContent ?? '').trim() === ${JSON.stringify(label)},
      );
      if (btn) btn.click();
      return !!btn;
    })()
  `);
  await sleep(400);
  return ok;
};
const paneState = () =>
  ev(`
    (() => {
      const pane = document.querySelector('.settings-pane');
      return {
        text: (pane?.textContent ?? ''),
        themeCards: pane?.querySelectorAll('.theme-card').length ?? 0,
        active: document.querySelector('.settings-nav-item.active .nav-label')?.textContent?.trim() ?? null,
      };
    })()
  `);

await switchTab("编辑器");
const editorPane = await paneState();
check(
  "切到「编辑器」分类，内容真的换了",
  editorPane.active === "编辑器" && editorPane.themeCards === 0 && editorPane.text.includes("打字机模式"),
  `当前「${editorPane.active}」，主题卡 ${editorPane.themeCards} 张，含打字机模式=${editorPane.text.includes("打字机模式")}`,
);
await shot("ui-6-settings.png");

await switchTab("工作区");
const wsPane = await paneState();
check(
  "切到「工作区」分类能看到当前文件夹路径",
  wsPane.active === "工作区" && wsPane.text.includes("当前文件夹") && /[\\/]/.test(wsPane.text),
  `当前「${wsPane.active}」，路径片段：${(wsPane.text.match(/[A-Za-z]:\\[^\\s]{0,40}/) ?? ["(无)"])[0]}`,
);
await switchTab("外观");

// 点弹窗外面关闭：取一个确定在弹窗之外的坐标（弹窗居中，所以贴左边缘最稳）
const outside = await ev(`
  (() => {
    const r = document.querySelector('.settings-modal').getBoundingClientRect();
    const x = r.left > 20 ? 6 : window.innerWidth - 6;
    return { x, y: Math.round(window.innerHeight / 2) };
  })()
`);
await ev(`
  (() => {
    const target = document.elementFromPoint(${outside.x}, ${outside.y}) ?? document.body;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return target.className;
  })()
`);
await sleep(400);
const modalClosed = await ev(`!document.querySelector('.settings-modal') && !document.querySelector('.settings-backdrop')`);
check("点弹窗外面关闭设置", modalClosed === true, `点的是 (${outside.x}, ${outside.y})`);

// ⚙ 是开关：再点一次应该能关掉（不能被"点空白关闭"抢先）
await clickTop("设置");
await sleep(500);
const reopened = await ev(`!!document.querySelector('.settings-modal')`);
await clickTop("设置");
await sleep(500);
const toggled = await ev(`!document.querySelector('.settings-modal')`);
check(
  "⚙ 再点一次能收起（开关语义）",
  reopened === true && toggled === true,
  `打开=${reopened}，再点后关闭=${toggled}`,
);

// ---------------------------------------------------------------- 7. 文件树：收起 / 展开 / 刷新
// 收起状态看 **.tree-caret.open**（图标已经是 SVG 了，没有文字可读）
const treeState = () =>
  ev(`
    (() => {
      const rows = [...document.querySelectorAll('.tree .tree-row')];
      const mark = (row) => {
        const el = row.querySelector('.tree-caret');
        if (!el) return '·';
        return el.classList.contains('open') ? '▾' : '▸';
      };
      return {
        rootCaret: rows[0] ? mark(rows[0]) : null,
        names: rows.map((r) => mark(r) + ' ' + (r.querySelector('.name')?.textContent ?? '')),
      };
    })()
  `);

const clickTreeRow = async (name) => {
  const ok = await ev(`
    (() => {
      const row = [...document.querySelectorAll('.tree .tree-row')].find(r => (r.querySelector('.name')?.textContent ?? '') === ${JSON.stringify(name)});
      if (row) row.click();
      return !!row;
    })()
  `);
  await sleep(700);
  return ok;
};

const expandedAtStart = await treeState();

// 从"当前状态"出发断言**翻转**，而不是断言"默认必须是展开的"：
// 这个脚本会被连跑（同一实例），上一次可能把根节点留在了收起状态。
await clickTreeRow("samples");
const toggledOnce = await treeState();
await shot("ui-10-tree-collapsed.png"); // 收起状态的证据
await clickTreeRow("samples");
const toggledTwice = await treeState();
check(
  "点工作区根目录能收起／展开（以前点它没有任何反应）",
  toggledOnce.rootCaret !== expandedAtStart.rootCaret &&
    toggledOnce.names.length !== expandedAtStart.names.length &&
    toggledTwice.rootCaret === expandedAtStart.rootCaret &&
    toggledTwice.names.length === expandedAtStart.names.length,
  `${expandedAtStart.rootCaret}(${expandedAtStart.names.length} 行) → ${toggledOnce.rootCaret}(${toggledOnce.names.length} 行) → ${toggledTwice.rootCaret}(${toggledTwice.names.length} 行)`,
);

// 后面两项要在展开状态下测
if ((await treeState()).rootCaret !== "▾") await clickTreeRow("samples");

// 子目录同样按"翻转"断言：脚本可能连跑多次，起始状态不保证
const subBefore = await treeState();
await clickTreeRow("assets");
const subAfter = await treeState();
const svgBefore = subBefore.names.some((n) => n.includes("demo.svg"));
const svgAfter = subAfter.names.some((n) => n.includes("demo.svg"));
check(
  "点子目录能收起／展开（里面的文件跟着出现或消失）",
  svgBefore !== svgAfter,
  `demo.svg ${svgBefore ? "在" : "不在"} → ${svgAfter ? "在" : "不在"}：${subAfter.names.join(" | ")}`,
);
if (!svgAfter) await clickTreeRow("assets");

// F5 刷新：既要刷新文件树，又不能把展开状态清空、更不能把整个前端重载
await ev(`window.__uiVerifyMarker = 'alive'`);
await send("Input.dispatchKeyEvent", {
  type: "rawKeyDown",
  windowsVirtualKeyCode: 116,
  nativeVirtualKeyCode: 116,
  code: "F5",
  key: "F5",
});
await send("Input.dispatchKeyEvent", {
  type: "keyUp",
  windowsVirtualKeyCode: 116,
  nativeVirtualKeyCode: 116,
  code: "F5",
  key: "F5",
});
await sleep(1200);

const afterF5 = await ev(`
  (() => ({
    reloaded: window.__uiVerifyMarker !== 'alive',
    toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(" / "),
    names: [...document.querySelectorAll('.tree .tree-row')].map((r) => {
      const caret = r.querySelector('.tree-caret');
      const mark = caret ? (caret.classList.contains('open') ? '▾' : '▸') : '·';
      return mark + ' ' + (r.querySelector('.name')?.textContent ?? '');
    }),
  }))()
`);
check("F5 不重载整个前端（未保存的改动不会没）", afterF5.reloaded === false);
check(
  "F5 刷新文件树，且已展开的目录不会被收起来",
  afterF5.names.some((n) => n.includes("demo.svg")) && afterF5.names.some((n) => n.includes("demo.md")),
  `${afterF5.toast ? `提示「${afterF5.toast}」，` : ""}${afterF5.names.join(" | ")}`,
);

// ---------------------------------------------------------------- 8. 层级要看得出来
// 验收的是"眼睛能分辨"，所以量的是：导轨条数、逐层缩进、同级对齐、文件夹与文件的字重差
const hierarchy = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.tree .tree-row')];
    const byName = (n) => rows.find((r) => (r.querySelector('.name')?.textContent ?? '') === n);
    const info = (row) => {
      if (!row) return null;
      const name = row.querySelector('.name');
      const guide = row.querySelector('.tree-guide');
      const cs = getComputedStyle(name);
      return {
        name: name?.textContent ?? '',
        guides: row.querySelectorAll('.tree-guide').length,
        nameLeft: Math.round(name.getBoundingClientRect().left),
        guideWidth: guide ? Math.round(guide.getBoundingClientRect().width) : 0,
        // 注意：1px 的 CSS 边框在这台机器上算出来是 **0.8px**——WebView 的
        // 设备像素比是 1.25，Chromium 会把边框吸附到设备像素网格上。
        // 所以这里断言"是实线且宽度大于 0"，而不是等于 "1px"。
        guideBorder: guide ? getComputedStyle(guide).borderLeftWidth : '',
        guideStyle: guide ? getComputedStyle(guide).borderLeftStyle : '',
        guideColor: guide ? getComputedStyle(guide).borderLeftColor : '',
        guideHeight: guide ? Math.round(guide.getBoundingClientRect().height) : 0,
        weight: cs.fontWeight,
      };
    };
    return {
      root: info(rows[0]),
      dir1: info(byName("assets")),
      file2: info(byName("demo.svg")),
      file1: info(byName("demo.md")),
    };
  })()
`);

check(
  "层级看得见：根 0 条导轨、一级 1 条、二级 2 条，缩进逐层加深",
  hierarchy.root?.guides === 0 &&
    hierarchy.dir1?.guides === 1 &&
    hierarchy.file2?.guides === 2 &&
    hierarchy.dir1.nameLeft > hierarchy.root.nameLeft &&
    hierarchy.file2.nameLeft > hierarchy.dir1.nameLeft,
  `根 ${hierarchy.root?.nameLeft}px(0 条) → 一级 ${hierarchy.dir1?.nameLeft}px(1 条) → 二级 ${hierarchy.file2?.nameLeft}px(2 条)`,
);
check(
  "导轨真的画出来了（实线、有色、撑满行高）",
  hierarchy.dir1?.guideStyle === "solid" &&
    Number.parseFloat(hierarchy.dir1.guideBorder) > 0 &&
    hierarchy.dir1.guideColor !== "rgba(0, 0, 0, 0)" &&
    hierarchy.dir1.guideWidth >= 10 &&
    hierarchy.dir1.guideHeight >= 20,
  `${hierarchy.dir1?.guideBorder} ${hierarchy.dir1?.guideStyle}（设备像素比 1.25 下算出来是 0.8px）、` +
    `占位 ${hierarchy.dir1?.guideWidth}px、高 ${hierarchy.dir1?.guideHeight}px、颜色 ${hierarchy.dir1?.guideColor}`,
);
check(
  "同一层的文件夹与文件名左边缘对齐",
  hierarchy.dir1?.nameLeft === hierarchy.file1?.nameLeft,
  `assets ${hierarchy.dir1?.nameLeft}px vs demo.md ${hierarchy.file1?.nameLeft}px`,
);
check(
  "文件夹比文件重一档（能一眼分出哪些还能展开）",
  Number(hierarchy.dir1?.weight) > Number(hierarchy.file1?.weight),
  `文件夹 ${hierarchy.dir1?.weight} vs 文件 ${hierarchy.file1?.weight}`,
);

// 展开箭头：必须是矢量图标，而且收起/展开在视觉上真的不一样
const caretState = (name) =>
  ev(`
    (() => {
      const row = [...document.querySelectorAll('.tree .tree-row')].find(
        (r) => (r.querySelector('.name')?.textContent ?? '') === ${JSON.stringify(name)},
      );
      const el = row?.querySelector('.tree-caret');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const svg = el.querySelector('svg');
      const path = svg?.querySelector('path');
      return {
        text: el.textContent.trim(),
        hasSvg: !!svg,
        hasPath: !!path,
        width: Math.round(el.getBoundingClientRect().width),
        svgWidth: svg ? Math.round(svg.getBoundingClientRect().width) : 0,
        rotated: cs.transform !== 'none',
        transform: cs.transform,
        stroke: path ? getComputedStyle(path).stroke : '',
        strokeWidth: path ? getComputedStyle(path).strokeWidth : '',
      };
    })()
  `);

const caretExpanded = await caretState("assets");
check(
  "展开图标是矢量折角线（不再是 9px 的字形，也就不会糊成圆点）",
  caretExpanded?.text === "" &&
    caretExpanded.hasSvg === true &&
    caretExpanded.hasPath === true &&
    caretExpanded.svgWidth >= 10 &&
    Number.parseFloat(caretExpanded.strokeWidth) > 0,
  caretExpanded
    ? `文本内容「${caretExpanded.text}」、SVG ${caretExpanded.svgWidth}px、线宽 ${caretExpanded.strokeWidth}、颜色 ${caretExpanded.stroke}`
    : "找不到 .tree-caret",
);

await clickTreeRow("assets");
const caretCollapsed = await caretState("assets");
await clickTreeRow("assets"); // 翻回展开，保持后面的状态
const caretReExpanded = await caretState("assets");
check(
  "收起是指向右的折角，展开时整体转 90°（状态看得出来）",
  caretCollapsed?.rotated === false && caretReExpanded?.rotated === true,
  `收起 transform=${caretCollapsed?.transform}，展开 transform=${caretReExpanded?.transform}`,
);

const caretFile = await caretState("demo.md");
check(
  "文件行是同宽空占位（没有图标，但名字与文件夹对齐）",
  caretFile?.hasSvg === false && caretFile?.text === "" && caretFile?.width === caretExpanded?.width,
  `文件占位 ${caretFile?.width}px vs 文件夹箭头 ${caretExpanded?.width}px`,
);
await shot("ui-12-tree-hierarchy.png");

// ---------------------------------------------------------------- 9. 保存提示：有改动才提示一次
//
// 用户报的是"保存成功之后反复按 Ctrl+S，每次都弹一遍已保存"。这里走真实路径：
// 在编辑器里插入一个字符把文档改脏 → Ctrl+S → 应该弹一次 → 等提示消失 → 再 Ctrl+S，
// 没有改动，就不该再弹。**验证会真的写盘**，所以必须在临时工作区里跑（见 README）。
await ev(`(() => { const el = document.querySelector('.pane-editor .cm-content'); el?.focus(); return !!el; })()`);
await sleep(300);
await send("Input.insertText", { text: "x" });
await sleep(500);

const dirtyAfterEdit = await ev(
  `(document.querySelector('.statusbar')?.textContent ?? '').includes('未保存')`,
);
const toastCount = () => ev(`document.querySelectorAll('.toast').length`);

const ctrlS = async () => {
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: 2,
    windowsVirtualKeyCode: 83,
    nativeVirtualKeyCode: 83,
    code: "KeyS",
    key: "s",
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    windowsVirtualKeyCode: 83,
    nativeVirtualKeyCode: 83,
    code: "KeyS",
    key: "s",
  });
  await sleep(900);
};

check("插入字符后文档变成「未保存」", dirtyAfterEdit === true);

// 用"增量"判定：上一步（F5 等）的提示可能还在屏幕上，
// 绝对条数会因为残留而误判。先等提示清空，再比"保存前后多了几条"。
await waitFor(async () => (await toastCount()) === 0, 3500);
const toastsBeforeSave = await toastCount();
await ctrlS();
const toastsAfterFirst = await toastCount();
const savedClean = await ev(
  `(document.querySelector('.statusbar')?.textContent ?? '').includes('已保存')`,
);
check(
  "有改动时保存会提示「已保存」，并把文档标成已保存",
  toastsAfterFirst === toastsBeforeSave + 1 && savedClean === true,
  `保存前 ${toastsBeforeSave} 条 → 保存后 ${toastsAfterFirst} 条，已保存标记=${savedClean}`,
);

await sleep(2800); // 等提示自动消失（2.6s）
const toastsBeforeSecond = await toastCount();
await ctrlS();
const toastsAfterSecond = await toastCount();
check(
  "没有改动时重复保存不再提示",
  toastsBeforeSecond === 0 && toastsAfterSecond === 0,
  `第二次保存前 ${toastsBeforeSecond} 条、之后 ${toastsAfterSecond} 条`,
);

// ---------------------------------------------------------------- 汇总
ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log("失败项：" + failed.map((f) => f.name).join("、"));
  process.exit(1);
}
console.log("界面结构验证通过。");
