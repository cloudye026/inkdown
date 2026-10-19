import { useEffect, useRef } from "react";
import { useUi } from "../store/ui";

export interface MenuItem {
  label: string;
  /** 快捷键/说明文字，右侧灰字 */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

export interface ContextMenuProps {
  items: MenuItem[];
  /** 分隔线位置：在此索引之前插入 */
  separators?: number[];
}

/**
 * 右键菜单。菜单项由调用方给出（文件树按目标类型组装）。
 * 统一在这里处理：点击外部关闭、Esc 关闭、滚动关闭、贴边翻转。
 */
export function ContextMenu({ items, separators = [] }: ContextMenuProps) {
  const menu = useUi((s) => s.contextMenu);
  const close = useUi((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", close);
      window.removeEventListener("blur", close);
    };
  }, [menu, close]);

  if (!menu) return null;

  // 贴边翻转：菜单不超出窗口
  const width = 210;
  const height = items.length * 28 + 14;
  const x = Math.min(menu.x, window.innerWidth - width - 8);
  const y = Math.min(menu.y, window.innerHeight - height - 8);

  return (
    <div className="context-menu" style={{ left: Math.max(4, x), top: Math.max(4, y) }} ref={ref}>
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`}>
          {separators.includes(i) && i > 0 ? <div className="context-sep" /> : null}
          <button
            className={`context-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              close();
              void item.run();
            }}
          >
            <span>{item.label}</span>
            {item.hint ? <span className="hint">{item.hint}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
