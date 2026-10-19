// 端到端验证：换主题时字体**真的**被写进了 DOM。
//
// 之前只测了纯逻辑 resolveFontId（"该用哪个字体"），但没验证
// applySettingsToDom（"有没有真写进去"）。这一层才是用户能感知的部分：
// 逻辑对但没写进 CSS 变量，界面上字体照样不变。

import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
globalThis.Node = w.Node;
globalThis.Element = w.Element;
globalThis.HTMLElement = w.HTMLElement;
Object.defineProperty(globalThis, "navigator", {
  value: w.navigator,
  configurable: true,
  writable: true,
});

const { applySettingsToDom, DEFAULT_SETTINGS, resolveFontId } = await import(
  "../src/store/settings.ts"
);
const { THEME_LIST, themeDef } = await import("../src/services/themes.ts");
const { FONT_PRESETS, fontPreset } = await import("../src/services/fonts.ts");

const root = document.documentElement;

/** 用给定设置跑一次"应用设置"，返回写入后的关键值 */
function apply(patch) {
  const s = { ...DEFAULT_SETTINGS, ...patch };
  applySettingsToDom(s);
  return {
    theme: root.dataset.theme,
    font: root.dataset.font,
    sans: root.style.getPropertyValue("--font-sans"),
    serif: root.style.getPropertyValue("--font-serif"),
    editorFont: root.style.getPropertyValue("--editor-font"),
    previewFont: root.style.getPropertyValue("--preview-font"),
  };
}

test("applySettingsToDom 把主题写到 data-theme 上", () => {
  for (const t of THEME_LIST) {
    const r = apply({ theme: t.id });
    assert.equal(r.theme, t.id, `${t.id} 没写到 data-theme`);
  }
});

test("跟随主题时：每套主题写入的字体栈就是它推荐的", () => {
  for (const t of THEME_LIST) {
    const r = apply({ theme: t.id, fontFollowsTheme: true });
    const expected = fontPreset(themeDef(t.id).fontPreset);
    assert.equal(r.sans, expected.sans, `${t.id} 的 --font-sans 不对`);
    assert.equal(r.editorFont, expected.sans, `${t.id} 的 --editor-font 不对`);
    assert.equal(r.previewFont, expected.sans, `${t.id} 的 --preview-font 不对`);
    assert.equal(r.font, themeDef(t.id).fontPreset, `${t.id} 的 data-font 不对`);
  }
});

test("**换主题时字体确实会变**（这是用户报的问题）", () => {
  const seen = new Map();
  for (const t of THEME_LIST) {
    const r = apply({ theme: t.id, fontFollowsTheme: true });
    seen.set(t.id, r.sans);
  }
  const distinct = new Set(seen.values());
  assert.ok(
    distinct.size >= 4,
    `15 套主题只写出 ${distinct.size} 种字体栈，"跟随主题"几乎看不出变化`,
  );

  // 具体挑三套风格差异大的，逐一确认字体栈不同
  const gruvbox = apply({ theme: "gruvbox-dark", fontFollowsTheme: true }).sans;
  const solarized = apply({ theme: "solarized-dark", fontFollowsTheme: true }).sans;
  const github = apply({ theme: "github-dark", fontFollowsTheme: true }).sans;
  assert.notEqual(gruvbox, solarized, "Gruvbox（等宽）与 Solarized（衬线）字体应不同");
  assert.notEqual(gruvbox, github, "Gruvbox 与 GitHub（系统字体）应不同");
  assert.notEqual(solarized, github, "Solarized 与 GitHub 应不同");
  // 且确实是各自预设的内容
  assert.equal(gruvbox, FONT_PRESETS.mono.sans);
  assert.equal(solarized, FONT_PRESETS.serif.sans);
  assert.equal(github, FONT_PRESETS.system.sans);
});

test("关闭跟随后：换主题不再改字体（用户自选优先）", () => {
  const first = apply({ theme: "github-dark", fontPreset: "noto", fontFollowsTheme: false });
  for (const t of THEME_LIST) {
    const r = apply({ theme: t.id, fontPreset: "noto", fontFollowsTheme: false });
    assert.equal(r.sans, first.sans, `关闭跟随后 ${t.id} 不该改字体`);
    assert.equal(r.font, "noto");
  }
  assert.equal(first.sans, FONT_PRESETS.noto.sans);
});

test("重新打开跟随：字体回到主题推荐值", () => {
  apply({ theme: "monokai", fontPreset: "noto", fontFollowsTheme: false });
  assert.equal(root.style.getPropertyValue("--font-sans"), FONT_PRESETS.noto.sans, "先确认是自选字体");

  const r = apply({ theme: "monokai", fontPreset: "noto", fontFollowsTheme: true });
  assert.equal(r.sans, FONT_PRESETS.mono.sans, "打开跟随后应回到主题推荐字体");
  assert.equal(r.font, "mono");
});

test("脏值不会让界面失去配色或字体", () => {
  const r = apply({ theme: "坏主题", fontPreset: "没有这个", fontFollowsTheme: false });
  assert.equal(r.theme, "github-dark", "非法主题应回退到默认");
  assert.ok(r.sans.length > 0, "字体栈不能为空");
  assert.equal(r.font, "system");
  // 回退到默认主题后，CSS 里那套变量才存在（否则界面会没有配色）
  assert.equal(r.theme, DEFAULT_SETTINGS.theme);
});

test("字号/行高/字宽也一并写进变量（同一条链路）", () => {
  applySettingsToDom({ ...DEFAULT_SETTINGS, editorSize: 19, editorLineHeight: 2.1, measure: 42 });
  assert.equal(root.style.getPropertyValue("--editor-size"), "19px");
  assert.equal(root.style.getPropertyValue("--editor-line-height"), "2.1");
  assert.equal(root.style.getPropertyValue("--editor-measure"), "42em");
});

test("resolveFontId 与 applySettingsToDom 结论一致（两处逻辑不能各说各话）", () => {
  for (const t of THEME_LIST) {
    for (const follows of [true, false]) {
      const s = { ...DEFAULT_SETTINGS, theme: t.id, fontPreset: "sarasa", fontFollowsTheme: follows };
      applySettingsToDom(s);
      assert.equal(
        root.dataset.font,
        resolveFontId(s),
        `${t.id}（跟随=${follows}）两处结果不一致`,
      );
    }
  }
});
