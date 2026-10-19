import { useDocs } from "../store/docs";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { themeDef, toggleMode } from "../services/themes";
import { anchorOf } from "../services/popover";
import type { CursorInfo } from "../types";

interface Props {
  cursor: CursorInfo;
  wordCount: number;
  charCount: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function StatusBar({ cursor, wordCount, charCount }: Props) {
  const doc = useDocs((s) => (s.activePath ? s.findByPath(s.activePath) : null));
  const theme = useSettings((s) => s.theme);
  const update = useSettings((s) => s.update);
  const breakOnSingleNewline = useSettings((s) => s.breakOnSingleNewline);

  if (!doc) {
    return (
      <div className="statusbar">
        <span>就绪</span>
        <span className="spacer" />
        <span className="chip">Inkdown {__APP_VERSION__}</span>
      </div>
    );
  }

  const dirty = doc.text !== doc.saved;

  return (
    <div className="statusbar">
      <span>
        行 {cursor.line}, 列 {cursor.col}
        {cursor.selectionLength > 0 ? ` （已选 ${cursor.selectionLength}）` : ""}
      </span>
      <span>
        {wordCount} 词 / {charCount} 字符
      </span>
      <button
        className="chip"
        title="点击切换编码（保存时按此编码写回）"
        onClick={() => {
          const next = doc.encoding === "UTF-8" ? "GB18030" : "UTF-8";
          const s = useDocs.getState();
          useDocs.setState({
            docs: s.docs.map((d) => (d.path === doc.path ? { ...d, encoding: next } : d)),
          });
          useUi.getState().toast(`保存编码改为 ${next}`);
        }}
      >
        {doc.encoding}
        {doc.bom ? " BOM" : ""}
      </button>
      <button
        className={`chip${doc.eol === "\r\n" ? " warn" : ""}`}
        title="换行符风格；点击在 CRLF / LF 之间切换（保存时生效）"
        onClick={() => {
          const next = doc.eol === "\r\n" ? null : "\r\n";
          const s = useDocs.getState();
          useDocs.setState({
            docs: s.docs.map((d) => (d.path === doc.path ? { ...d, eol: next } : d)),
          });
          useUi.getState().toast(next ? "保存为 CRLF" : "保存为 LF");
        }}
      >
        {doc.eol === "\r\n" ? "CRLF" : "LF"}
      </button>
      <span className="chip">{formatSize(doc.size)}</span>
      <button
        className={`chip${breakOnSingleNewline ? "" : " warn"}`}
        title="软换行是否断行：中文写作常「一段一行」，关掉后单个换行不再产生新段落"
        onClick={() => update({ breakOnSingleNewline: !breakOnSingleNewline })}
      >
        {breakOnSingleNewline ? "软换行断行" : "严格 CommonMark"}
      </button>

      <span className="spacer" />
      {dirty ? <span className="chip warn">未保存</span> : <span className="chip">已保存</span>}
      {/* 点一下**打开主题选择面板**（贴着这个 chip 弹出），右键直接换明暗。
          以前点击是"同色系轮换"：按十几次才能碰到想要的那套，还看不出会跳到哪。 */}
      <button
        className="chip"
        title={`当前主题：${themeDef(theme).label}（点击选择，右键换明暗）`}
        onClick={(e) => useUi.getState().openThemePicker(anchorOf(e.currentTarget))}
        onContextMenu={(e) => {
          e.preventDefault();
          update({ theme: toggleMode(theme) });
        }}
      >
        {themeDef(theme).label}
      </button>
    </div>
  );
}
