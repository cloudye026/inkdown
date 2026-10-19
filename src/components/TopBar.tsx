import { useSettings } from "../store/settings";
import { themeDef } from "../services/themes";
import { anchorOf } from "../services/popover";
import { useUi } from "../store/ui";
import type { ViewMode } from "../types";

/**
 * 顶栏只放**入口**，不放动作。
 *
 * 这里原本有十几个按钮（打开/文件夹/新建/保存 + 加粗/斜体/链接/代码/引用/
 * 贴左/补标记/自检），既挤又和快捷键重复：真正写字的时候手不会离开键盘去点按钮，
 * 而这些操作在**搜索面板**里都能找到（Ctrl+P 输入"加粗"），也都有快捷键。
 * 现在留下的只有入口：搜索、编辑/预览开关、侧栏、主题、设置。
 */
export function TopBar() {
  const sidebarVisible = useUi((s) => s.sidebarVisible);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const viewMode = useSettings((s) => s.viewMode);
  const theme = useSettings((s) => s.theme);

  return (
    <div className="topbar">
      <span className="brand">Inkdown</span>

      <button
        className="btn"
        onClick={() => useUi.getState().openPalette()}
        title="搜索命令与文件 (Ctrl+P)"
      >
        搜索…
      </button>

      <span className="spacer" />

      <div className="view-switch" role="group" aria-label="视图">
        {(["edit", "preview"] as const).map((mode) => (
          <button
            key={mode}
            className={viewMode === mode ? "active" : ""}
            aria-pressed={viewMode === mode}
            title={viewTitle(mode)}
            onClick={() => useSettings.getState().update({ viewMode: mode })}
          >
            {mode === "edit" ? "编辑" : "预览"}
          </button>
        ))}
      </div>

      <span style={{ width: 6 }} />

      <button
        className={`btn icon${sidebarVisible ? " active" : ""}`}
        onClick={toggleSidebar}
        title="侧栏"
      >
        ▤
      </button>
      <button
        className="btn icon"
        onClick={(e) => useUi.getState().openThemePicker(anchorOf(e.currentTarget))}
        title={`主题：${themeDef(theme).label}（点击选择）`}
      >
        {themeDef(theme).mode === "dark" ? "☾" : "☀"}
      </button>
      <button
        className={`btn icon${settingsOpen ? " active" : ""}`}
        data-settings-toggle
        onClick={() => useUi.getState().setSettingsOpen(!settingsOpen)}
        title="设置 (Ctrl+,)"
      >
        ⚙
      </button>
    </div>
  );
}

function viewTitle(mode: ViewMode): string {
  return mode === "edit"
    ? "编辑视图（Ctrl+Shift+V 切换）"
    : "预览视图：整幅渲染，不再左右对照（Ctrl+Shift+V 切换）";
}
