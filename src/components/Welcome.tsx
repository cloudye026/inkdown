import { useUi, runCommand } from "../store/ui";

export function ToastHost() {
  const toasts = useUi((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

interface WelcomeProps {
  onDropPaths: (paths: string[]) => void;
  dropping: boolean;
}

export function Welcome({ onDropPaths, dropping }: WelcomeProps) {
  return (
    <div className="welcome">
      <h1>开始写作</h1>
      <div className="shortcuts">
        <kbd>Ctrl+O</kbd>
        <span>打开文件</span>
        <kbd>Ctrl+Shift+O</kbd>
        <span>打开文件夹</span>
        <kbd>Ctrl+P</kbd>
        <span>搜索命令与文件</span>
        <kbd>Ctrl+Shift+V</kbd>
        <span>切换编辑 / 预览</span>
        <kbd>Ctrl+B / I / K</kbd>
        <span>加粗 / 斜体 / 链接</span>
        <kbd>F11</kbd>
        <span>全屏专注</span>
      </div>
      <div className="preset-row" style={{ marginTop: 8 }}>
        <button className="btn primary" onClick={() => void runCommand("file.open")}>
          打开文件
        </button>
        <button className="btn" onClick={() => void runCommand("file.openFolder")}>
          打开文件夹
        </button>
        <button className="btn" onClick={() => void runCommand("file.new")}>
          新建
        </button>
      </div>
      <div className={`drop${dropping ? " over" : ""}`}>
        把 .md 文件或文件夹拖进来也可以直接打开
      </div>
      <input
        type="hidden"
        onChange={(e) => {
          const files = e.target.files;
          if (files) onDropPaths(Array.from(files).map((f) => (f as File & { path?: string }).path ?? ""));
        }}
      />
    </div>
  );
}
