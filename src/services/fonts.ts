/**
 * 中文字体预设。
 *
 * 单独放在这里而不是 store/settings.ts：主题要声明"自己推荐哪套字体"，
 * 如果字体预设留在 settings 里就会形成 themes → settings → themes 的循环导入。
 *
 * 中英混排的字重、基线、行高差异很大，所以给整条回退链而不是让用户填字符串。
 */
export interface FontPreset {
  label: string;
  /** 界面与正文用的无衬线栈 */
  sans: string;
  /** 衬线栈（部分主题的正文走衬线） */
  serif: string;
}

export const FONT_PRESETS: Record<string, FontPreset> = {
  system: {
    label: "系统默认（微软雅黑 / 苹方）",
    sans: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif',
    serif: '"Noto Serif SC", "Songti SC", "SimSun", Georgia, serif',
  },
  noto: {
    label: "思源黑体 / Noto Sans SC",
    sans: '"Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif',
    serif: '"Noto Serif SC", "Source Han Serif SC", Georgia, serif',
  },
  sarasa: {
    label: "更纱黑体（等宽，中英对齐）",
    sans: '"Sarasa Gothic SC", "Sarasa Mono SC", "Noto Sans SC", sans-serif',
    serif: '"Sarasa Gothic SC", "Noto Serif SC", serif',
  },
  serif: {
    label: "宋体 / 衬线（长文阅读）",
    sans: '"Songti SC", "SimSun", "Noto Serif SC", Georgia, serif',
    serif: '"Songti SC", "SimSun", "Noto Serif SC", Georgia, serif',
  },
  mono: {
    label: "等宽（代码笔记）",
    sans: '"Sarasa Mono SC", "Cascadia Code", "JetBrains Mono", Consolas, monospace',
    serif: '"Sarasa Mono SC", "Noto Serif SC", monospace',
  },
};

export const DEFAULT_FONT_PRESET = "system";

export function isFontPreset(id: unknown): id is string {
  return typeof id === "string" && id in FONT_PRESETS;
}

/** 认不出来就回退到默认字体——绝不能因为一个脏值让界面没有字体 */
export function normalizeFontPreset(id: unknown): string {
  return isFontPreset(id) ? id : DEFAULT_FONT_PRESET;
}

export function fontPreset(id: unknown): FontPreset {
  return FONT_PRESETS[normalizeFontPreset(id)] ?? FONT_PRESETS[DEFAULT_FONT_PRESET]!;
}
