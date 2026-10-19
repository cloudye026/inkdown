import type { ThemeDef } from "../services/themes";

/**
 * 主题卡片：设置面板与主题选择面板**共用同一个组件**。
 *
 * 两处各画一遍色块的话，早晚会出现"设置里是这个色、快选里是另一个色"，
 * 而色块的意义就是"点它之前先看到真实配色"（色值直接取注册表，见 services/themes.ts）。
 */
export function ThemeCard({
  theme,
  active,
  compact,
  onPick,
}: {
  theme: ThemeDef;
  active: boolean;
  /** 快选面板里用紧凑尺寸 */
  compact?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      className={`theme-card${active ? " active" : ""}${compact ? " compact" : ""}`}
      title={`${theme.label}（${theme.mode === "dark" ? "深色" : "浅色"}）`}
      aria-pressed={active}
      onClick={onPick}
    >
      <span className="theme-preview" style={{ background: theme.swatch.bg }}>
        <span className="theme-preview-bar" style={{ background: theme.swatch.elev }}>
          <span className="theme-preview-fg" style={{ background: theme.swatch.fg }} />
          <span className="theme-preview-accent" style={{ background: theme.swatch.accent }} />
        </span>
      </span>
      <span className="theme-label">{theme.label}</span>
    </button>
  );
}
