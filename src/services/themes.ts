/**
 * 主题注册表。
 *
 * 一个主题包含两部分，必须成对定义，否则会出现"界面换了但代码还是旧配色"：
 *   1. **界面配色**：一组 CSS 变量，见 styles/index.css 里对应的
 *      `:root[data-theme="<id>"]` 区块（bg / fg / border / accent…）
 *   2. **代码高亮配色**：Shiki 主题名，用于预览里的代码块
 *
 * 这里的色板同时用于设置面板里的预览色块，所以改主题时**要同步改 CSS**。
 * 两边对不上会被 tests 里的色板一致性检查发现。
 */

export type ThemeId =
  | "github-dark"
  | "github-dark-dimmed"
  | "github-dark-high-contrast"
  | "github-light"
  | "github-light-high-contrast"
  | "one-dark-pro"
  | "dracula"
  | "nord"
  | "tokyo-night"
  | "catppuccin-mocha"
  | "catppuccin-latte"
  | "gruvbox-dark"
  | "solarized-dark"
  | "solarized-light"
  | "monokai";

export interface ThemeDef {
  id: ThemeId;
  /** 设置面板里显示的名字 */
  label: string;
  /** 明暗模式：决定 color-scheme、Mermaid 基础主题等 */
  mode: "light" | "dark";
  /** Shiki 代码高亮主题名（必须是 shiki 内置主题） */
  shiki: string;
  /**
   * 该主题推荐的字体预设 id（见 services/fonts.ts）。
   *
   * 主题切换时字体跟着换——这是"主题"作为一个完整外观的一部分。
   * 用户可以关掉「字体跟随主题」，那样就用他自己选的字体。
   *
   * 分配依据是各配色方案的出身：GitHub / VS Code 系用系统界面字体，
   * 终端出身的（Gruvbox、Monokai）用等宽，为长文阅读设计的 Solarized 用衬线。
   */
  fontPreset: string;
  /**
   * 预览代码块的 **token 颜色修正表**（原色 → 修正色），交给 Shiki 的 colorReplacements。
   *
   * 为什么需要：官方配色里的浅色 token 压在我的代码块底色上对比度会低到 2.2–2.8，
   * 看起来像没上色（用户反馈"切换到 Solarized 浅色和 Catppuccin Latte 时
   * 代码块的颜色不对"）。修正规则是**保持色相、只调亮度**到刚好可读。
   *
   * ⚠️ 这里是**对整段 HTML 做颜色替换**，所以：
   *   - 只能放真实的 token 前景色
   *   - **绝不能放背景色**，否则连 background-color 一起被改掉，代码块会改烂
   * 测试会拦住"把背景色放进修正表"这种错误。
   */
  codeColorFixes?: Record<string, string>;
  /**
   * 设置面板里的预览色块。值必须与 CSS 里的主题变量一致，
   * 这样用户在小方块里看到的就是真实配色。
   */
  swatch: { bg: string; elev: string; fg: string; accent: string };
}

export const THEME_LIST: readonly ThemeDef[] = [
  {
    id: "github-dark",
    label: "GitHub 深色",
    mode: "dark",
    // 界面配色取自 GitHub **现代**深色主题（#0d1117），所以 Shiki 主题也要用
    // `github-dark-default`。指向旧的 `github-dark`（背景 #24292e、token 偏旧）
    // 会与界面脱节——这是早期的一处映射错误。
    shiki: "github-dark-default",
    fontPreset: "system",
    swatch: { bg: "#0d1117", elev: "#161b22", fg: "#e6edf3", accent: "#2f81f7" },
  },
  {
    id: "github-dark-dimmed",
    label: "GitHub 深色（柔和）",
    mode: "dark",
    shiki: "github-dark-dimmed",
    fontPreset: "system",
    swatch: { bg: "#22272e", elev: "#2d333b", fg: "#b8c1ce", accent: "#539bf5" },
  },
  {
    id: "github-dark-high-contrast",
    label: "GitHub 深色（高对比）",
    mode: "dark",
    shiki: "github-dark-high-contrast",
    fontPreset: "system",
    swatch: { bg: "#0a0c10", elev: "#161b22", fg: "#f0f3f6", accent: "#71b7ff" },
  },
  {
    id: "github-light",
    label: "GitHub 浅色",
    mode: "light",
    shiki: "github-light-default",
    fontPreset: "system",
    swatch: { bg: "#ffffff", elev: "#f6f8fa", fg: "#1f2328", accent: "#0969da" },
  },
  {
    id: "github-light-high-contrast",
    label: "GitHub 浅色（高对比）",
    mode: "light",
    shiki: "github-light-high-contrast",
    fontPreset: "system",
    swatch: { bg: "#ffffff", elev: "#f6f8fa", fg: "#0e1116", accent: "#0349b4" },
  },
  {
    id: "one-dark-pro",
    label: "One Dark Pro",
    mode: "dark",
    shiki: "one-dark-pro",
    fontPreset: "system",
    swatch: { bg: "#282c34", elev: "#2c313a", fg: "#b9bfca", accent: "#61afef" },
  },
  {
    id: "dracula",
    label: "Dracula",
    mode: "dark",
    shiki: "dracula",
    fontPreset: "system",
    codeColorFixes: { "#6272a4": "#6675a6" },
    swatch: { bg: "#282a36", elev: "#30323f", fg: "#f8f8f2", accent: "#bd93f9" },
  },
  {
    id: "nord",
    label: "Nord",
    mode: "dark",
    shiki: "nord",
    fontPreset: "system",
    codeColorFixes: { "#616e88": "#75829d" },
    swatch: { bg: "#2e3440", elev: "#343b48", fg: "#d8dee9", accent: "#88c0d0" },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    mode: "dark",
    shiki: "tokyo-night",
    fontPreset: "sarasa",
    codeColorFixes: { "#51597d": "#626c97" },
    swatch: { bg: "#1a1b26", elev: "#1f2335", fg: "#c0caf5", accent: "#7aa2f7" },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    mode: "dark",
    shiki: "catppuccin-mocha",
    fontPreset: "noto",
    swatch: { bg: "#1e1e2e", elev: "#252537", fg: "#cdd6f4", accent: "#89b4fa" },
  },
  {
    id: "catppuccin-latte",
    label: "Catppuccin Latte",
    mode: "light",
    shiki: "catppuccin-latte",
    fontPreset: "noto",
    // 代码块底色 #e6e9ef。修正目标：语义 token 4.0、注释 3.5。
    // 3.0 会让 Catppuccin 的柔和色发白，4.5 又会把蜜桃色压成深棕。
    codeColorFixes: {
      "#7c7f93": "#75788d",
      "#40a02b": "#348123",
      "#df8e1d": "#9c6314",
      "#179299": "#147c82",
      "#fe640b": "#c34801",
      "#e64553": "#dc1e2e",
      "#04a5e5": "#0378a7",
      "#ea76cb": "#cc1f9e",
    },
    swatch: { bg: "#eff1f5", elev: "#e6e9ef", fg: "#42455c", accent: "#1e66f5" },
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox 深色",
    mode: "dark",
    shiki: "gruvbox-dark-medium",
    fontPreset: "mono",
    swatch: { bg: "#282828", elev: "#32302f", fg: "#ebdbb2", accent: "#fabd2f" },
  },
  {
    id: "solarized-dark",
    label: "Solarized 深色",
    mode: "dark",
    shiki: "solarized-dark",
    fontPreset: "serif",
    // 深色主题同样有"发白"问题（只是不那么刺眼）：注释 #586e75 只有 3.18，
    // 橙色/紫罗兰/品红三类语义 token 在 3.7–3.9，不够清楚。
    codeColorFixes: {
      "#586e75": "#5d757c",
      "#cb4b16": "#d44e17",
      "#6c71c4": "#6f74c5",
      "#d33682": "#d54088",
    },
    swatch: { bg: "#002b36", elev: "#073642", fg: "#b8c1c1", accent: "#268bd2" },
  },
  {
    id: "solarized-light",
    label: "Solarized 浅色",
    mode: "light",
    shiki: "solarized-light",
    fontPreset: "serif",
    // 代码块底色 #f6efdc。修正目标 **4.0**（介于"刚好达标"3.0 与正文 4.5）：
    // 卡 3.0 时 token 看起来发白（实测对比 GitHub 浅色的代码色差别明显），
    // 卡 4.5 又会把 Solarized 的黄压成暗橄榄、失去原配色观感。
    // #657b83 是默认前景色（未着色代码的正文色），按正文标准 4.5 压。
    codeColorFixes: {
      "#657b83": "#5c7077",
      "#93a1a1": "#718282",
      "#859900": "#6c7c00",
      "#268bd2": "#217ab8",
      "#2aa198": "#22827b",
      "#6c71c4": "#686dc2",
      "#d33682": "#d23380",
      "#b58900": "#926f00",
    },
    swatch: { bg: "#fdf6e3", elev: "#f5efdc", fg: "#073642", accent: "#268bd2" },
  },
  {
    id: "monokai",
    label: "Monokai",
    mode: "dark",
    shiki: "monokai",
    fontPreset: "mono",
    swatch: { bg: "#272822", elev: "#2e2f28", fg: "#f8f8f2", accent: "#a6e22e" },
  },
];

export const DEFAULT_THEME: ThemeId = "github-dark";

const BY_ID = new Map<string, ThemeDef>(THEME_LIST.map((t) => [t.id, t]));

/** 旧版本只存了 "dark" / "light" 两个值，必须能平滑迁移 */
const LEGACY: Record<string, ThemeId> = {
  dark: "github-dark",
  light: "github-light",
};

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && BY_ID.has(value);
}

/**
 * 把任意来源的值（旧设置、损坏的 localStorage、浅色/深色开关）归一成合法主题 id。
 * 认不出来就回退到默认主题——**绝不能因为一个脏值就让界面没有配色**。
 */
export function normalizeTheme(value: unknown): ThemeId {
  if (isThemeId(value)) return value;
  if (typeof value === "string") {
    const legacy = LEGACY[value.trim().toLowerCase()];
    if (legacy) return legacy;
  }
  return DEFAULT_THEME;
}

export function themeDef(id: ThemeId): ThemeDef {
  return BY_ID.get(id) ?? (BY_ID.get(DEFAULT_THEME) as ThemeDef);
}

/** 明暗模式（CSS 的 color-scheme、Mermaid 主题、滚动条等都靠它） */
export function themeMode(id: ThemeId): "light" | "dark" {
  return themeDef(id).mode;
}

/** 按下标取主题，越界时回退到默认主题（noUncheckedIndexedAccess 下必须显式处理） */
function themeAt(index: number): ThemeDef {
  return THEME_LIST[index] ?? themeDef(DEFAULT_THEME);
}

/** 循环切换到下一个主题（遍历全部 12 套） */
export function nextTheme(id: ThemeId): ThemeId {
  const i = THEME_LIST.findIndex((t) => t.id === normalizeTheme(id));
  return themeAt((i < 0 ? 0 : i + 1) % THEME_LIST.length).id;
}

/**
 * 在同模式（浅色↔浅色、深色↔深色）的主题之间循环。
 * 工具栏那个"☀/☾"按钮用它：用户点它想要的是"换个亮/暗的样式"，
 * 而不是被切到一个风格完全不同的深色主题。
 */
export function nextThemeOfSameMode(id: ThemeId): ThemeId {
  const current = normalizeTheme(id);
  const same = themesOfMode(themeDef(current).mode);
  const i = same.findIndex((t) => t.id === current);
  const at = i < 0 ? -1 : i;
  return (same[(at + 1) % same.length] ?? themeDef(current)).id;
}

/** 切到"另一种明暗模式"：当前是深色就切到默认浅色主题，反之亦然 */
export function toggleMode(id: ThemeId): ThemeId {
  const mode = themeDef(normalizeTheme(id)).mode;
  const target: "light" | "dark" = mode === "dark" ? "light" : "dark";
  return (themesOfMode(target)[0] ?? themeDef(DEFAULT_THEME)).id;
}

/** 只取某个模式的主题，用于"浅色/深色"快速切换 */
export function themesOfMode(mode: "light" | "dark"): ThemeDef[] {
  return THEME_LIST.filter((t) => t.mode === mode);
}
