import { useMemo, useState } from "react";
import { useDocs } from "../store/docs";
import { scanHeadings } from "../services/markdown";

interface Props {
  path: string;
  currentLine: number;
  onPick: (line: number) => void;
}

export function Outline({ path, currentLine, onPick }: Props) {
  const text = useDocs((s) => s.findByPath(path)?.text ?? "");
  const [filter, setFilter] = useState("");

  // 大纲按文本 memo 计算：只有真正显示大纲时才付这个代价。
  // 以前是每次按键都在 setText 里重算（O(行数)），大文档下输入明显发滞。
  const outline = useMemo(() => scanHeadings(text), [text]);

  const items = useMemo(() => {
    if (!filter.trim()) return outline;
    const q = filter.trim().toLowerCase();
    return outline.filter((h) => h.text.toLowerCase().includes(q));
  }, [outline, filter]);

  // 当前光标所在的最近标题
  const activeLine = useMemo(() => {
    let best = -1;
    for (const h of outline) {
      if (h.line + 1 <= currentLine) best = h.line;
      else break;
    }
    return best;
  }, [outline, currentLine]);

  if (outline.length === 0) {
    return <div className="tree-empty">当前文档没有标题。用 # 开头写一行，这里就会出现大纲。</div>;
  }

  return (
    <div>
      <div style={{ padding: "6px 10px" }}>
        <input
          type="text"
          value={filter}
          placeholder="过滤标题…"
          onChange={(e) => setFilter(e.target.value)}
          style={{
            width: "100%",
            height: 26,
            padding: "0 8px",
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            outline: "none",
          }}
        />
      </div>
      <div className="outline">
        {items.map((h) => (
          <button
            key={`${h.line}-${h.text}`}
            className={`outline-row${h.line === activeLine ? " active" : ""}`}
            style={{
              paddingLeft: 10 + (h.level - 1) * 13,
              fontWeight: h.level <= 2 ? 600 : 400,
              opacity: h.level >= 4 ? 0.82 : 1,
            }}
            onClick={() => onPick(h.line)}
            title={h.text}
          >
            {h.text || "（无标题）"}
          </button>
        ))}
        {items.length === 0 ? <div className="tree-empty">没有匹配的标题</div> : null}
      </div>
    </div>
  );
}
