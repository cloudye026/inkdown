import { useEffect, useState } from "react";
import { THEME_LIST, themesOfMode } from "../services/themes";
import { placePopover } from "../services/popover";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { ThemeCard } from "./ThemeCard";

const WIDTH = 352;

/**
 * 主题选择面板。
 *
 * 以前点顶栏那个 ☾ 是"换下一个同色系主题"——按十几次才能碰到想要的那套，
 * 而且用户根本不知道会跳到哪。现在点它就是**打开选择**：贴着你点的按钮弹出，
 * 一次点到位。状态栏右下角的主题名同样处理（右键换明暗保留）。
 * 点空白处或 Esc 关闭。
 */
export function ThemePicker() {
  const picker = useUi((s) => s.themePicker);
  const close = useUi((s) => s.closeThemePicker);
  const current = useSettings((s) => s.theme);
  const update = useSettings((s) => s.update);

  // 视口尺寸只在打开时取一次：面板开着的时候窗口变化是极少数情况，
  // 而每次 resize 都订阅会让这个小组件跟着重渲染。
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    if (!picker) return;
    setViewport({ width: window.innerWidth, height: window.innerHeight });
  }, [picker]);

  if (!picker) return null;

  const pos = placePopover({
    anchor: picker.anchor,
    viewport,
    width: WIDTH,
  });

  const dark = themesOfMode("dark");
  const light = themesOfMode("light");

  return (
    <>
      <div className="popover-backdrop" onMouseDown={close} />
      <div
        className="theme-menu"
        role="dialog"
        aria-label="选择主题"
        style={{
          left: pos.left,
          width: Math.min(WIDTH, viewport.width - 16),
          ...(pos.above ? { bottom: pos.bottom } : { top: pos.top }),
        }}
      >
        <div className="theme-menu-head">
          <span>主题</span>
          <span className="spacer" />
          <span className="theme-menu-current">{THEME_LIST.length} 套</span>
        </div>
        <div className="theme-menu-body">
          <div className="theme-menu-group">深色</div>
          <div className="theme-grid">
            {dark.map((t) => (
              <ThemeCard
                key={t.id}
                theme={t}
                compact
                active={t.id === current}
                onPick={() => {
                  update({ theme: t.id });
                  close();
                }}
              />
            ))}
          </div>
          <div className="theme-menu-group">浅色</div>
          <div className="theme-grid">
            {light.map((t) => (
              <ThemeCard
                key={t.id}
                theme={t}
                compact
                active={t.id === current}
                onPick={() => {
                  update({ theme: t.id });
                  close();
                }}
              />
            ))}
          </div>
        </div>
        <div className="theme-menu-foot">
          <span className="hint">字体跟随主题时，字体会一起换</span>
          <span className="spacer" />
          <button
            className="btn"
            onClick={() => {
              close();
              useUi.getState().setSettingsOpen(true);
            }}
          >
            更多设置…
          </button>
        </div>
      </div>
    </>
  );
}
