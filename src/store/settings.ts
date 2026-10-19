import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Settings, ThemeId } from "../types";
import { DEFAULT_THEME, normalizeTheme, themeDef } from "../services/themes";
import { FONT_PRESETS, fontPreset, normalizeFontPreset } from "../services/fonts";

export type { ThemeId };
// 字体预设放在 services/fonts.ts（主题要引用它，留在本文件会形成循环导入），
// 这里转出以保持既有 import 路径可用
export { FONT_PRESETS };

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME,
  fontPreset: "system",
  // 默认跟随主题：切主题时字体一起换，主题才像一套完整外观。
  // 想固定字体的人可以关掉，之后 fontPreset 就是唯一依据。
  fontFollowsTheme: true,
  editorSize: 16,
  editorLineHeight: 1.85,
  previewSize: 16,
  previewLineHeight: 1.85,
  // 预览防抖：单次渲染实测 4–29ms（取决于代码块/图表数量），逐键渲染会明显卡顿。
  // 80ms 在"看不出延迟"和"不拖累输入"之间比较平衡。
  previewDelayMs: 80,
  measure: 46,
  showLineNumbers: false,
  softWrap: true,
  // 中文写作"一段一行"，默认软换行即断行更符合直觉
  breakOnSingleNewline: true,
  autoSave: false,
  autoSaveDelayMs: 1200,
  typewriterMode: false,
  syncScroll: true,
  // 预览从"并排的面板"改成"整幅切换"之后，默认停在编辑视图：
  // 打开应用先看到自己的文字，Ctrl+Shift+V 或顶栏开关切到预览。
  viewMode: "edit",
  sidebarWidth: 250,
  recentFiles: [],
  workspace: null,
  lastSession: null,
};

interface SettingsState extends Settings {
  update: (patch: Partial<Settings>) => void;
  pushRecent: (path: string) => void;
  reset: () => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,
      update: (patch) => {
        // 换主题必须让预览里**按主题缓存**的内容失效：
        // 代码高亮与图表都按"源码指纹"缓存，而同一段代码在不同主题下
        // 配色不同。不失效的话换主题后代码块还是旧配色。
        const next = patch.theme === undefined ? undefined : normalizeTheme(patch.theme);
        const themeChanged = next !== undefined && next !== get().theme;
        set(patch.theme === undefined ? patch : { ...patch, theme: next });
        if (themeChanged) void invalidatePreviewCaches();
      },
      pushRecent: (path) =>
        set((s) => {
          const next = [path, ...s.recentFiles.filter((p) => p !== path)].slice(0, 25);
          return { recentFiles: next };
        }),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      // localStorage 的键**故意保留旧名字**：它只是存储位置，不是产品名。
      // 改成 inkdown.settings 会让所有人的设置（主题、字体、最近打开、
      // 上次会话位置）在改名当天全部丢失。要改必须同时写迁移代码。
      name: "mddeveloper.settings",
      // 版本 2：theme 从 "dark" | "light" 变成主题 id（12 套）。
      // 版本 3：previewVisible + paneRatio（左右并排）→ viewMode（整幅切换）。
      // migrate 负责把老数据搬过来，**不能只靠 normalizeTheme**——
      // 否则老用户每次启动都会读到一个非法值再回退，白白丢掉他原本的选择。
      version: 3,
      migrate: (persisted, from) => {
        const state = (persisted ?? {}) as Partial<Settings> & {
          previewVisible?: boolean;
          paneRatio?: number;
        };
        if (from < 2) {
          state.theme = normalizeTheme(state.theme);
        }
        if (from < 3) {
          // 旧的 previewVisible 说的是"预览面板是不是也显示着"，而新模型里
          // 编辑与预览互斥，没有能一一对应的取值。默认停在编辑视图，
          // 不把用户直接甩到只剩预览的界面上。
          state.viewMode = "edit";
          delete state.previewVisible;
          delete state.paneRatio;
        }
        return state as Settings;
      },
      // 只持久化数据字段，函数不进 localStorage
      partialize: (s) => {
        const { update: _u, pushRecent: _p, reset: _r, ...rest } = s;
        return rest as Settings;
      },
    },
  ),
);

/**
 * 让预览里按主题缓存的内容失效（代码高亮、图表）。
 *
 * 用动态 import 而不是顶层 import：previewRender → highlight → 本模块，
 * 静态导入会形成环。
 */
async function invalidatePreviewCaches(): Promise<void> {
  try {
    const mod = await import("../services/previewRender");
    mod.invalidatePreviewCaches();
  } catch (err) {
    console.warn("[settings] 清理预览缓存失败", err);
  }
}

/**
 * 把设置写进 CSS 变量，让样式表只认变量、不认 JS。
 *
 * 主题要先归一化再写到 data-theme：localStorage 里可能是旧值（"dark"/"light"）
 * 或被手工改坏的内容，直接写上去会导致**整套 CSS 变量都不匹配、界面没有配色**。
 *
 * 字体同理：**开了「跟随主题」就用该主题推荐的字体**，否则用用户自己选的。
 * 这一步是"换主题时字体也跟着换"的落点——App 订阅设置变化后重新调用本函数。
 */
export function applySettingsToDom(s: Settings): void {
  const root = document.documentElement;
  const themeId = normalizeTheme(s.theme);
  root.dataset.theme = themeId;

  const fontId = resolveFontId(s, themeId);
  const preset = fontPreset(fontId);
  root.style.setProperty("--font-sans", preset.sans);
  root.style.setProperty("--font-serif", preset.serif);
  root.style.setProperty("--editor-font", preset.sans);
  root.style.setProperty("--preview-font", preset.sans);
  root.style.setProperty("--editor-size", `${s.editorSize}px`);
  root.style.setProperty("--editor-line-height", String(s.editorLineHeight));
  root.style.setProperty("--preview-size", `${s.previewSize}px`);
  root.style.setProperty("--preview-line-height", String(s.previewLineHeight));
  root.style.setProperty("--editor-measure", `${s.measure}em`);
  // 记录当前实际生效的字体，供设置面板显示（用户关掉跟随后仍能看到当前是什么）
  root.dataset.font = fontId;
}

/**
 * 当前**实际生效**的字体预设 id。
 *
 * 跟随主题时取主题推荐值；否则取用户选择。两条路径都会归一化，
 * 避免主题里写错一个不存在的字体 id 就让界面失去字体。
 */
export function resolveFontId(s: Settings, themeId = normalizeTheme(s.theme)): string {
  if (s.fontFollowsTheme) {
    return normalizeFontPreset(themeDef(themeId).fontPreset);
  }
  return normalizeFontPreset(s.fontPreset);
}
