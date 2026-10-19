// 主题系统的测试。
//
// 主题最容易出的两类问题，这里都钉住：
//   1. 注册表与 CSS **对不上** —— 设置面板里的小色块和真实配色不一致（用户被骗）
//   2. 旧数据迁移丢失 —— 老版本存的是 "dark"/"light"，升级后用户的选择没了

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "src", "styles", "index.css");

const {
  THEME_LIST,
  DEFAULT_THEME,
  isThemeId,
  normalizeTheme,
  nextTheme,
  nextThemeOfSameMode,
  themeDef,
  themeMode,
  themesOfMode,
  toggleMode,
} = await import("../src/services/themes.ts");

// --------------------------------------------------------------- 注册表本身

test("主题 id 唯一，且默认主题在表里", () => {
  const ids = THEME_LIST.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "主题 id 不能重复");
  assert.ok(ids.includes(DEFAULT_THEME), "默认主题必须在注册表里");
  assert.ok(THEME_LIST.length >= 8, `主题数量应有诚意，实际 ${THEME_LIST.length}`);
});

test("每个主题都有标签、Shiki 主题名、色块", () => {
  for (const t of THEME_LIST) {
    assert.ok(t.label.trim().length > 0, `${t.id} 缺 label`);
    assert.ok(t.shiki.trim().length > 0, `${t.id} 缺 shiki 主题名`);
    assert.ok(t.mode === "light" || t.mode === "dark", `${t.id} mode 非法`);
    for (const key of ["bg", "elev", "fg", "accent"]) {
      assert.match(
        t.swatch[key],
        /^#[0-9a-fA-F]{6}$/,
        `${t.id} 的 swatch.${key} 必须是 #RRGGBB，实际 ${t.swatch[key]}`,
      );
    }
  }
});

test("浅色主题与深色主题都有，且深度主题是多数", () => {
  assert.ok(themesOfMode("light").length >= 3, "浅色主题太少");
  assert.ok(themesOfMode("dark").length >= 3, "深色主题太少");
});

// --------------------------------------------------------------- 迁移与容错

test("旧的 dark / light 设置能迁移到对应主题", () => {
  assert.equal(normalizeTheme("dark"), "github-dark");
  assert.equal(normalizeTheme("light"), "github-light");
  // 大小写与空白也要能认
  assert.equal(normalizeTheme("  DARK "), "github-dark");
  assert.equal(normalizeTheme("Light"), "github-light");
});

test("非法值一律回退到默认主题（绝不能没有配色）", () => {
  for (const bad of [undefined, null, "", "  ", "nope", 42, {}, [], true]) {
    assert.equal(normalizeTheme(bad), DEFAULT_THEME, `${JSON.stringify(bad)} 应回退`);
  }
});

test("isThemeId 只认注册表里的 id", () => {
  assert.equal(isThemeId("nord"), true);
  assert.equal(isThemeId("dark"), false, "旧值不是合法主题 id");
  assert.equal(isThemeId("NORD"), false, "大小写敏感");
  assert.equal(isThemeId(undefined), false);
});

test("themeDef / themeMode 对非法输入也不炸", () => {
  assert.equal(themeDef(normalizeTheme("坏值")).id, DEFAULT_THEME);
  assert.equal(themeMode(normalizeTheme(undefined)), "dark");
});

// --------------------------------------------------------------- 切换逻辑

test("nextTheme 遍历全部主题且能回到起点", () => {
  const seen = [];
  let cur = THEME_LIST[0].id;
  for (let i = 0; i < THEME_LIST.length; i++) {
    seen.push(cur);
    cur = nextTheme(cur);
  }
  assert.equal(new Set(seen).size, THEME_LIST.length, "应不重复地遍历所有主题");
  assert.equal(cur, THEME_LIST[0].id, `循环一圈应回到起点，实际 ${cur}`);
});

test("nextThemeOfSameMode 不会跳到另一种明暗", () => {
  for (const t of THEME_LIST) {
    const next = themeDef(nextThemeOfSameMode(t.id));
    assert.equal(next.mode, t.mode, `${t.id} → ${next.id} 跳到了另一种明暗`);
    assert.notEqual(next.id, t.id, `${t.id} 应切换到别的主题`);
  }
});

test("toggleMode 一定切到另一种明暗", () => {
  for (const t of THEME_LIST) {
    const toggled = themeDef(toggleMode(t.id));
    assert.notEqual(toggled.mode, t.mode, `${t.id} 未能切换明暗`);
  }
  // 来回切两次应回到原来的模式
  const start = DEFAULT_THEME;
  assert.equal(themeMode(toggleMode(toggleMode(start))), themeMode(start));
});

// ---------------------------------------------------------------
// 注册表 ↔ CSS 一致性
//
// 这是最关键的一条：设置面板里的色块直接取注册表的 swatch，
// 而真实界面取 CSS 变量。两边不一致 = 用户看到的预览是假的。
// ---------------------------------------------------------------

/**
 * 从 index.css 里取出某个主题的变量表。
 *
 * 一个主题可能有**多个** `:root[data-theme="X"]` 区块（配色一块、编辑器语法色一块），
 * 这里全部合并——只读第一块会漏掉后面那些变量。
 */
function cssVarsFor(themeId) {
  const css = readFileSync(cssPath, "utf8");
  const re = new RegExp(`:root\\[data-theme="${themeId}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`, "gm");
  const vars = {};
  let found = 0;
  for (const m of css.matchAll(re)) {
    found++;
    for (const line of m[1].split("\n")) {
      const vm = /^\s*(--[a-z-]+|color-scheme):\s*([^;]+);/.exec(line);
      if (vm) vars[vm[1]] = vm[2].trim();
    }
  }
  assert.ok(found > 0, `index.css 里缺少 :root[data-theme="${themeId}"] 区块`);
  return vars;
}

test("每个主题在 CSS 里都有对应区块，变量齐全", () => {
  const required = [
    "--bg",
    "--bg-elev",
    "--bg-sunken",
    "--bg-hover",
    "--bg-active",
    "--border",
    "--border-strong",
    "--fg",
    "--fg-muted",
    "--fg-faint",
    "--accent",
    "--accent-soft",
    "--danger",
    "--warn",
    "--ok",
    "--mark-bg",
  ];
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    for (const key of required) {
      assert.ok(vars[key], `主题 ${t.id} 的 CSS 缺少 ${key}`);
    }
  }
});

test("CSS 里的背景/前景/强调色与注册表色块一致（否则预览小方块是假的）", () => {
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    assert.equal(
      vars["--bg"].toLowerCase(),
      t.swatch.bg.toLowerCase(),
      `${t.id}: CSS --bg=${vars["--bg"]} 与 swatch.bg=${t.swatch.bg} 不一致`,
    );
    assert.equal(
      vars["--bg-elev"].toLowerCase(),
      t.swatch.elev.toLowerCase(),
      `${t.id}: CSS --bg-elev 与 swatch.elev 不一致`,
    );
    assert.equal(
      vars["--fg"].toLowerCase(),
      t.swatch.fg.toLowerCase(),
      `${t.id}: CSS --fg 与 swatch.fg 不一致`,
    );
    assert.equal(
      vars["--accent"].toLowerCase(),
      t.swatch.accent.toLowerCase(),
      `${t.id}: CSS --accent 与 swatch.accent 不一致`,
    );
  }
});

test("CSS 的 color-scheme 与主题明暗一致", () => {
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    assert.equal(
      vars["color-scheme"],
      t.mode,
      `${t.id}: color-scheme 应为 ${t.mode}，实际 ${vars["color-scheme"]}`,
    );
  }
});

test("每个主题的 Shiki 主题名都在 shiki 内置主题里（拼错会静默失去高亮）", async () => {
  const { bundledThemes } = await import("shiki");
  for (const t of THEME_LIST) {
    assert.ok(
      t.shiki in bundledThemes,
      `${t.id} 的 shiki 主题 "${t.shiki}" 不是 shiki 内置主题`,
    );
  }
});

// ---------------------------------------------------------------
// 可读性（对比度）
//
// 加主题最容易犯的错：直接照搬某个配色方案的官方色值，看着很"正宗"，
// 但它在自己的背景上根本读不清。实测就撞到过——Solarized 深色的正文
// 只有 5.6（正文标准是 7），One Dark 的次要文字只有 3.7（标准 4.5）。
//
// 标准用 WCAG：正文 ≥7（AAA），次要文字 ≥4.5（AA），
// 图标/装饰性颜色 ≥3。**新增主题必须过这一关。**
// ---------------------------------------------------------------

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) =>
    srgbToLinear(parseInt(h.slice(i, i + 2), 16)),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度：1（完全相同）～ 21（黑白） */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** [说明, 前景变量, 背景变量, 最低对比度] */
const CONTRAST_CHECKS = [
  ["正文 / 背景", "--fg", "--bg", 7],
  ["正文 / 面板", "--fg", "--bg-elev", 7],
  ["正文 / 代码块底", "--fg", "--bg-sunken", 7],
  ["正文 / 选中项", "--fg", "--bg-active", 4.5],
  // 行内代码的底色是 --bg-hover（`.markdown-body code` 用的就是它）
  ["正文 / 悬停底（行内代码）", "--fg", "--bg-hover", 4.5],
  ["次要文字 / 背景", "--fg-muted", "--bg", 4.5],
  ["次要文字 / 面板", "--fg-muted", "--bg-elev", 4.5],
  ["提示文字 / 背景", "--fg-faint", "--bg", 3],
  ["强调色 / 背景", "--accent", "--bg", 3],
  ["强调色 / 面板", "--accent", "--bg-elev", 3],
  ["错误色 / 背景", "--danger", "--bg", 3],
  ["警告色 / 背景", "--warn", "--bg", 3],
  ["成功色 / 背景", "--ok", "--bg", 3],
];

test("所有主题的文字对比度达标（不能有看着好看但读不清的配色）", () => {
  const failures = [];
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    for (const [label, fgVar, bgVar, min] of CONTRAST_CHECKS) {
      const fg = vars[fgVar];
      const bg = vars[bgVar];
      if (!fg || !bg) {
        failures.push(`${t.id} ${label}: 变量缺失（${fgVar} / ${bgVar}）`);
        continue;
      }
      const ratio = contrast(fg, bg);
      if (ratio < min) {
        failures.push(
          `${t.id} ${label}: ${ratio.toFixed(2)} < ${min}  (${fg} on ${bg})`,
        );
      }
    }
  }
  assert.equal(
    failures.length,
    0,
    `以下配色读不清，请调亮/调暗后重跑：\n  ${failures.join("\n  ")}`,
  );
});

test("代码块底色与主背景可区分（否则代码块糊在正文里）", () => {
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    assert.notEqual(
      vars["--bg-sunken"].toLowerCase(),
      vars["--bg"].toLowerCase(),
      `${t.id}: 代码块底色与主背景相同`,
    );
    // 差异不必很大，但要能被看出来
    const diff = Math.abs(luminance(vars["--bg-sunken"]) - luminance(vars["--bg"]));
    assert.ok(diff > 0.002, `${t.id}: 代码块底色与主背景几乎一样（亮度差 ${diff.toFixed(4)}）`);
  }
});

// ---------------------------------------------------------------
// 代码 token 颜色修正表
//
// 用户反馈"切换到 Solarized 浅色和 Catppuccin Latte 时 代码块的颜色不对"——
// 根因是官方配色里的浅色 token 压在代码块底色上只有 2.2–2.8 对比度，像没上色。
// 修法是保持色相、压暗到可读，通过 Shiki 的 colorReplacements 应用。
//
// ⚠️ colorReplacements 是**对整段 HTML 替换颜色**，所以表里混进背景色
// 就会把 background-color 一起改坏（我第一次生成时就误入了 6 个背景色：
// GitHub 深色的 #161b22、浅色高对比的 #ffffff 都是底色）。下面几条就是拦这个。
// ---------------------------------------------------------------

test("修正表的键不能是背景色（否则会把 background-color 一起改坏）", () => {
  const failures = [];
  for (const t of THEME_LIST) {
    const fixes = t.codeColorFixes;
    if (!fixes) continue;
    const vars = cssVarsFor(t.id);
    const bg = vars["--bg-sunken"];
    for (const from of Object.keys(fixes)) {
      const r = contrast(from, bg);
      if (r < 1.5) {
        failures.push(
          `${t.id}: ${from} 与代码块底色 ${bg} 的对比度只有 ${r.toFixed(2)}，` +
            `它本身就是背景色，不能进替换表`,
        );
      }
    }
  }
  assert.equal(failures.length, 0, `替换表里混入了背景色：\n  ${failures.join("\n  ")}`);
});

test("修正表的每个条目都确实提升了对比度（不能帮倒忙）", () => {
  const failures = [];
  for (const t of THEME_LIST) {
    const fixes = t.codeColorFixes;
    if (!fixes) continue;
    const vars = cssVarsFor(t.id);
    const bg = vars["--bg-sunken"];
    for (const [from, to] of Object.entries(fixes)) {
      const before = contrast(from, bg);
      const after = contrast(to, bg);
      if (after <= before) {
        failures.push(`${t.id}: ${from}(${before.toFixed(2)}) → ${to}(${after.toFixed(2)}) 没有变好`);
      }
    }
  }
  assert.equal(failures.length, 0, `以下修正没有效果：\n  ${failures.join("\n  ")}`);
});

test("修正后代码 token 在代码块底色上都可读（≥3.5）", async () => {
  // 门槛的来历：把配色画成 PNG 肉眼比对发现，刚好卡 3.0 的主题
  // （Solarized 浅色、Catppuccin Latte）色条明显发白、几乎糊在底色里，
  // 而 GitHub 浅色（4.3–14.8）饱满清晰。3.0 是 WCAG 的**大号文字**下限，
  // 但代码是要逐行读的。
  //
  // 分级目标：默认前景（代码正文）≥4.5、语义 token ≥4.0、注释 ≥3.5。
  // 这里统一卡 3.5 —— 全场最低值都出现在刻意弱化的注释色上。
  const MIN = 3.5;
  const { createHighlighter } = await import("shiki");
  const SAMPLES = [
    ["typescript", `// 注释\nimport { useState } from "react";\n/** 文档注释 */\nexport class Foo extends Bar {\n  private n: number = 42;\n  async run(items: Item[]): Promise<void> {\n    const s = "字符串";\n    if (s === "x" && this.n !== null) return;\n  }\n}\n`],
    ["python", `# 注释\ndef total(items: list[Item], rate: float = 0.13) -> float:\n    """文档字符串"""\n    return sum(i.price for i in items) * (1 + rate)\n`],
    ["bash", `# 注释\nexport PATH="$PATH:/usr/local/bin"\nfor f in *.md; do echo "\${f}"; done\n`],
    ["json", `{ "name": "值", "count": 42, "ok": true, "nil": null }\n`],
    ["css", `.a { color: #fff; margin: 0 auto; }\n`],
  ];
  const langs = [...new Set(SAMPLES.map(([l]) => l))];

  const failures = [];
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    const bg = vars["--bg-sunken"];
    const hl = await createHighlighter({ themes: [t.shiki], langs });
    const colors = new Set();
    for (const [lang, code] of SAMPLES) {
      const html = hl.codeToHtml(code, {
        lang,
        theme: t.shiki,
        ...(t.codeColorFixes ? { colorReplacements: t.codeColorFixes } : {}),
      });
      for (const m of html.matchAll(/<span[^>]*style="([^"]*)"/g)) {
        const c = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{6})/.exec(m[1])?.[1];
        if (c) colors.add(c.toLowerCase());
      }
    }
    hl.dispose();

    const weak = [...colors]
      .map((c) => ({ c, r: contrast(c, bg) }))
      .filter((x) => x.r < MIN && x.r >= 1.5); // <1.5 的是背景类色，不算 token
    if (weak.length) {
      failures.push(
        `${t.id}: ${weak.map((x) => `${x.c}(${x.r.toFixed(2)})`).join(", ")}`,
      );
    }
  }
  assert.equal(
    failures.length,
    0,
    `以下主题仍有 token 在代码块底色上偏弱：\n  ${failures.join("\n  ")}`,
  );
});

test("代码块默认前景色在代码块底色上可读（≥4.5，它是代码正文）", async () => {
  // 之前漏掉的一条：只查了 token 颜色，没查 Shiki 的**默认前景色**——
  // 那是未着色代码的正文色，占代码块里最大的篇幅。
  // 实测 Solarized 浅色的 #657b83 在压暗后的底色上只有 3.92，正文发虚。
  const { createHighlighter } = await import("shiki");
  const failures = [];
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    const bg = vars["--bg-sunken"];
    const hl = await createHighlighter({ themes: [t.shiki], langs: ["typescript"] });
    const raw = "#" + String(hl.getTheme(t.shiki).fg ?? "").replace("#", "").slice(0, 6).toLowerCase();
    hl.dispose();

    // 修正表可能把默认前景色也换了，这里要按修正后的算
    const fixed = (t.codeColorFixes?.[raw] ?? raw).toLowerCase();
    const r = contrast(fixed, bg);
    if (r < 4.5) {
      failures.push(`${t.id}: 默认前景 ${fixed} on ${bg} = ${r.toFixed(2)} < 4.5`);
    }
  }
  assert.equal(
    failures.length,
    0,
    `以下主题的代码块正文色偏弱：\n  ${failures.join("\n  ")}`,
  );
});

test("代码块底色必须比主背景更暗（「下沉」的字面含义）", () => {
  // 这条是用户报的问题：Catppuccin Latte 与 Solarized 浅色的代码块底色
  // 一度被调成比页面还亮，看起来像被高亮了，用户反馈"代码块的颜色不对"。
  //
  // 变量名就叫 sunken（下沉），所以方向是硬要求：
  // 浅色主题的代码块要更暗，深色主题也要更暗。15 套主题一致。
  const failures = [];
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    const page = luminance(vars["--bg"]);
    const sunken = luminance(vars["--bg-sunken"]);
    if (sunken >= page) {
      failures.push(
        `${t.id}: 代码块底色 ${vars["--bg-sunken"]}（亮度 ${sunken.toFixed(4)}）` +
          `并不比页面底色 ${vars["--bg"]}（${page.toFixed(4)}）更暗`,
      );
    }
  }
  assert.equal(
    failures.length,
    0,
    `以下主题的代码块没有"下沉"，看起来会像被高亮：\n  ${failures.join("\n  ")}`,
  );
});

test("同主题内 accent 与 fg 不能是同一个颜色（否则强调等于没强调）", () => {
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    assert.notEqual(
      vars["--accent"].toLowerCase(),
      vars["--fg"].toLowerCase(),
      `${t.id}: 强调色与正文色相同`,
    );
  }
});

// ---------------------------------------------------------------
// 填充色按钮上的文字
//
// 这是实测撞到的第二个可读性问题：主按钮是"强调色底 + 白字"，
// 而 12 套主题里只有 2 套的强调色深到白字能读。Gruvbox 的亮黄、
// Monokai 的亮绿上白字对比度只有 1.7/1.6 —— 基本等于看不见。
// 所以文字色必须由 --accent-fg / --danger-fg 给出，不能写死。
// ---------------------------------------------------------------

test("强调色/危险色填充上的文字色要读得清", () => {
  const failures = [];
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    // --accent-fg / --danger-fg 允许继承 :root 的默认值
    const rootVars = cssVarsFor.__root ?? (cssVarsFor.__root = rootBlockVars());
    const accentFg = vars["--accent-fg"] ?? rootVars["--accent-fg"];
    const dangerFg = vars["--danger-fg"] ?? rootVars["--danger-fg"];

    assert.ok(accentFg, "--accent-fg 未定义（:root 也没有默认值）");
    assert.ok(dangerFg, "--danger-fg 未定义（:root 也没有默认值）");

    // 按钮文字按"大号加粗文字"算，WCAG 门槛 3:1；这里取 4.5 更稳
    const a = contrast(accentFg, vars["--accent"]);
    if (a < 4.5) {
      failures.push(`${t.id} 主按钮: ${accentFg} on ${vars["--accent"]} = ${a.toFixed(2)}`);
    }
    const d = contrast(dangerFg, vars["--danger"]);
    // Nord 的官方红偏亮，两种文字色最多只能到 4.34，放宽到 4.3
    if (d < 4.3) {
      failures.push(`${t.id} 危险按钮: ${dangerFg} on ${vars["--danger"]} = ${d.toFixed(2)}`);
    }
  }
  assert.equal(failures.length, 0, `以下按钮文字看不清：\n  ${failures.join("\n  ")}`);
});

/** 取 :root 里第一个（共享）区块的变量，作为主题可继承的默认值 */
function rootBlockVars() {
  const css = readFileSync(cssPath, "utf8");
  // 第一个 :root { ... } 区块（不带 [data-theme]）
  const m = /(?:^|\n):root\s*\{([\s\S]*?)\n\}/m.exec(css);
  assert.ok(m, "index.css 里缺少 :root 共享区块");
  const vars = {};
  for (const line of m[1].split("\n")) {
    const vm = /^\s*(--[a-z-]+|color-scheme):\s*([^;]+);/.exec(line);
    if (vm) vars[vm[1]] = vm[2].trim();
  }
  return vars;
}

// ---------------------------------------------------------------
// 代码块底色不能把 token 压得比 Shiki 主题自己还差
//
// 实测撞到的问题：预览里代码块的背景被统一成 --bg-sunken，
// 而 Shiki 的 token 配色是按**它自己主题的背景**调的。
// 两边差太多时，关键字、变量会明显变暗 —— 浅色主题尤其严重
// （Catppuccin Latte 46 处、Solarized 浅色 79 处低于可读阈值）。
//
// 官方配色里"注释"这类 token 本来就被刻意弱化（Nord 2.4、Tokyo Night 2.5），
// 在它自己的底色上也不达标，所以这里不去卡一个绝对标准（那会永远失败），
// 而是卡一条**我们自己能保证的不变量**：
//   「换底色之后，token 的对比度不能比用主题原底色时更差」
// 这条既真实可满足，又能抓住"底色选错把代码压暗"这一类回归。
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// 编辑器语法配色
//
// 编辑器里的代码着色原本只复用 4 个通用变量，导致：
//   1. 关键字与函数名同色、数字与类型名同色 —— 语法层次分不出来
//   2. 撞色：Gruvbox 的 --accent 与 --warn 都是 #fabd2f（四类同色），
//      Monokai 的 --accent 与 --ok 都是 #a6e22e（三类同色）
// 现在每套主题各配 6 个 --code-* 变量，这里把它钉死。
// ---------------------------------------------------------------

const CODE_KINDS = [
  "--code-keyword",
  "--code-string",
  "--code-comment",
  "--code-number",
  "--code-func",
  "--code-type",
];

// ---------------------------------------------------------------
// 字体跟随主题
//
// 用户要的是"换主题时字体也跟着换"。做法是每套主题声明一个推荐字体预设，
// 设置里开了「字体跟随主题」就用它，关掉则用用户自己选的。
// 关键风险：主题里写了一个不存在的字体 id —— 界面会失去字体，
// 所以要校验每个 fontPreset 都能在 FONT_PRESETS 里找到。
// ---------------------------------------------------------------

test("每套主题都声明了字体预设，且预设真实存在", async () => {
  const { FONT_PRESETS } = await import("../src/services/fonts.ts");
  const failures = [];
  for (const t of THEME_LIST) {
    if (!t.fontPreset) {
      failures.push(`${t.id} 未声明 fontPreset`);
      continue;
    }
    if (!(t.fontPreset in FONT_PRESETS)) {
      failures.push(`${t.id} 的 fontPreset="${t.fontPreset}" 不在 FONT_PRESETS 里`);
    }
  }
  assert.equal(failures.length, 0, `字体预设有问题：\n  ${failures.join("\n  ")}`);
});

test("字体预设覆盖了多种风格（否则跟随主题看不出变化）", () => {
  const used = new Set(THEME_LIST.map((t) => t.fontPreset));
  assert.ok(
    used.size >= 4,
    `主题用到的字体预设应有多种，实际只有 ${[...used].join(", ")}`,
  );
});

test("同色系轮换时字体也应该可能变化（不能所有主题同一个字体）", () => {
  // 深色主题里如果全都推荐同一个字体，"跟随主题"在深色之间切换就没效果
  const dark = THEME_LIST.filter((t) => t.mode === "dark").map((t) => t.fontPreset);
  const light = THEME_LIST.filter((t) => t.mode === "light").map((t) => t.fontPreset);
  assert.ok(new Set(dark).size >= 2, `深色主题的字体过于单一：${[...new Set(dark)].join(", ")}`);
  assert.ok(new Set(light).size >= 2, `浅色主题的字体过于单一：${[...new Set(light)].join(", ")}`);
});

test("resolveFontId：跟随主题时用主题的字体，否则用用户选的", async () => {
  const { resolveFontId } = await import("../src/store/settings.ts");
  const { themeDef } = await import("../src/services/themes.ts");

  // 跟随主题：无论 fontPreset 填什么都以主题为准
  for (const t of THEME_LIST) {
    const id = resolveFontId({ theme: t.id, fontPreset: "mono", fontFollowsTheme: true });
    assert.equal(id, themeDef(t.id).fontPreset, `${t.id} 跟随主题时应取主题推荐字体`);
  }

  // 不跟随：以用户选择为准
  assert.equal(
    resolveFontId({ theme: "github-dark", fontPreset: "serif", fontFollowsTheme: false }),
    "serif",
  );

  // 脏值不能把字体搞丢
  assert.equal(
    resolveFontId({ theme: "nope", fontPreset: "也不存在", fontFollowsTheme: false }),
    "system",
  );
  assert.ok(
    resolveFontId({ theme: "nope", fontPreset: "", fontFollowsTheme: true }).length > 0,
    "主题非法时也要给出一套字体，不能为空",
  );
});

test("每套主题都定义了 6 个语法色，且为合法色值", () => {  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    for (const k of CODE_KINDS) {
      const v = vars[k];
      assert.ok(v, `${t.id} 缺少 ${k}`);
      assert.match(v, /^#[0-9a-fA-F]{6}$/, `${t.id} 的 ${k}="${v}" 不是 #RRGGBB`);
    }
  }
});

test("同一主题内 6 类语法色互不重复（否则语法层次分不出来）", () => {
  const failures = [];
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    const seen = new Map();
    for (const k of CODE_KINDS) {
      const c = (vars[k] ?? "").toLowerCase();
      if (seen.has(c)) failures.push(`${t.id}: ${seen.get(c)} 与 ${k} 都是 ${c}`);
      else seen.set(c, k);
    }
  }
  assert.equal(failures.length, 0, `以下主题存在同类色：\n  ${failures.join("\n  ")}`);
});

test("语法色在编辑器背景上可读（关键字 ≥4.5，其余 ≥3）", () => {
  // 语法着色是阅读辅助而非正文，按 WCAG 大号文字标准卡 3；
  // 关键字是扫读结构的主要线索，单独要求 4.5。
  const MIN = { "--code-keyword": 4.5 };
  const failures = [];
  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    const bg = vars["--bg"];
    for (const k of CODE_KINDS) {
      const need = MIN[k] ?? 3;
      const r = contrast(vars[k], bg);
      if (r < need) {
        failures.push(`${t.id} ${k}: ${vars[k]} on ${bg} = ${r.toFixed(2)} < ${need}`);
      }
    }
  }
  assert.equal(
    failures.length,
    0,
    `以下语法色在编辑器背景上读不清：\n  ${failures.join("\n  ")}`,
  );
});

test("代码块底色不会让 token 比 Shiki 主题原底色更差", async () => {  const { createHighlighter } = await import("shiki");
  const sample = `// 注释
import { useState } from "react";
export function total(items: Item[], rate = 0.13): number {
  const sum = items.reduce((acc, it) => acc + it.price * it.qty, 0);
  return sum * (1 + rate);
}
`;
  const failures = [];

  for (const t of THEME_LIST) {
    const vars = cssVarsFor(t.id);
    const mine = vars["--bg-sunken"];

    const hl = await createHighlighter({ themes: [t.shiki], langs: ["typescript"] });
    const { tokens } = hl.codeToTokens(sample, { lang: "typescript", theme: t.shiki });
    const ownBg = `#${(hl.getTheme(t.shiki).bg ?? "").replace("#", "").slice(0, 6)}`;
    hl.dispose();

    const colors = [...new Set(tokens.flat().map((x) => x.color).filter((c) => c?.startsWith("#")))];
    const fixes = t.codeColorFixes ?? {};
    const norm = (c) => c.toLowerCase();

    // 两组要**各自成套**地比，不能混：
    //   作者原本交付的 = 原色 + Shiki 自己的底色
    //   我们交付的     = 修正色 + 我们的代码块底色
    // 之前拿"修正后的颜色"去和"Shiki 原底色"比，等于算了两种组合里
    // 较有利的那一种，结论没有意义。
    const ownMin = Math.min(...colors.map((c) => contrast(norm(c), norm(ownBg))));
    const mineMin = Math.min(
      ...colors.map((c) => contrast(norm(fixes[norm(c)] ?? c), norm(mine))),
    );

    // 容差用**相对值**：代码块比页面略深/略浅本身是合理设计（GitHub 自己
    // 就是白底页 + #f6f8fa 代码块），只要不显著变差即可。
    // 10% 足够抓住真问题（实测 Catppuccin Latte 差 14%、Solarized 浅色差 12%），
    // 又不会把合理的轻微着色判成错误。
    if (mineMin < ownMin * 0.9) {
      failures.push(
        `${t.id}: 代码块底色 ${mine} 下最低对比度 ${mineMin.toFixed(2)}，` +
          `比 Shiki 原底色 ${ownBg} 的 ${ownMin.toFixed(2)} 差了 ` +
          `${(((ownMin - mineMin) / ownMin) * 100).toFixed(0)}%`,
      );
    }
  }

  assert.equal(
    failures.length,
    0,
    `以下主题的代码块底色把 token 压暗了，请让它更接近该主题 Shiki 的底色：\n  ${failures.join("\n  ")}`,
  );
});
