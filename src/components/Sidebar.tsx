import { useEffect, useMemo, useState } from "react";
import { useUi } from "../store/ui";
import { useSettings } from "../store/settings";
import { useDocs } from "../store/docs";
import { FileTree } from "./FileTree";
import { Outline } from "./Outline";
import { listCommands, runCommand } from "../store/ui";

interface Props {
  width: number;
  onWidthChange: (w: number) => void;
  onOpenFile: (path: string) => void;
  currentLine: number;
  onJumpLine: (line: number) => void;
}

export function Sidebar({ width, onWidthChange, onOpenFile, currentLine, onJumpLine }: Props) {
  const tab = useUi((s) => s.sidebarTab);
  const setTab = useUi((s) => s.setSidebarTab);
  const workspace = useSettings((s) => s.workspace);
  const recentFiles = useSettings((s) => s.recentFiles);
  const activePath = useDocs((s) => s.activePath);
  const commands = useMemo(() => listCommands().slice(0, 6), []);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => onWidthChange(Math.min(520, Math.max(170, e.clientX)));
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, onWidthChange]);

  return (
    <>
      <aside className="sidebar" style={{ width }}>
        <div className="sidebar-tabs">
          <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")}>
            文件
          </button>
          <button className={tab === "outline" ? "active" : ""} onClick={() => setTab("outline")}>
            大纲
          </button>
        </div>

        <div className="sidebar-body">
          {tab === "files" ? (
            workspace ? (
              <FileTree root={workspace} onOpen={onOpenFile} />
            ) : (
              <div className="tree-empty">
                还没有打开文件夹。
                <br />
                <br />
                <button className="btn" onClick={() => void runCommand("file.openFolder")}>
                  打开文件夹
                </button>
                <br />
                <br />
                或者用 Ctrl+O 直接打开单个文件。
              </div>
            )
          ) : activePath && !activePath.startsWith("untitled:") ? (
            <Outline path={activePath} currentLine={currentLine} onPick={onJumpLine} />
          ) : (
            <div className="tree-empty">打开一个文档后，这里会显示它的标题结构。</div>
          )}
        </div>

        {tab === "files" && (recentFiles.length > 0 || commands.length > 0) ? (
          <div style={{ borderTop: "1px solid var(--border)", padding: "6px 0", maxHeight: 190, overflow: "auto" }}>
            {recentFiles.length > 0 ? (
              <>
                <div style={{ padding: "4px 10px", fontSize: 11, color: "var(--fg-faint)" }}>最近打开</div>
                {recentFiles.slice(0, 5).map((p) => (
                  <button
                    key={p}
                    className="outline-row"
                    style={{ paddingLeft: 12, fontSize: 12 }}
                    title={p}
                    onClick={() => onOpenFile(p)}
                  >
                    {p.split(/[\\/]/).pop()}
                  </button>
                ))}
              </>
            ) : null}
          </div>
        ) : null}
      </aside>
      <div className={`splitter${dragging ? " dragging" : ""}`} onMouseDown={() => setDragging(true)} />
    </>
  );
}
