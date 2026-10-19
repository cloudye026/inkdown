import { useCallback, useEffect, useRef, useState } from "react";
import { basename, fs } from "../services/fs";
import { treeIconKind } from "../services/fileKind";
import { useDocs } from "../store/docs";
import { useUi } from "../store/ui";
import type { DirEntry } from "../types";
import { TreeIcon } from "./TreeIcons";
interface Props {
  root: string;
  onOpen: (path: string) => void;
}

export function FileTree({ root, onOpen }: Props) {
  const treeVersion = useUi((s) => s.treeVersion);
  const openContextMenu = useUi((s) => s.openContextMenu);
  /** 工作区根目录（用户选的那个文件夹）自己也能收起/展开 */
  const [rootOpen, setRootOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());

  // 展开集合的镜像。刷新时要按它重扫，但它不能进下面 effect 的依赖——
  // 否则每展开一层就会把整棵树重扫一遍。
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const loadDir = useCallback(async (dir: string) => {
    setLoading((prev) => new Set(prev).add(dir));
    try {
      const items = await fs.scanDir(dir, false);
      setChildren((prev) => new Map(prev).set(dir, items));
    } catch (err) {
      console.error("扫描目录失败", dir, err);
      setChildren((prev) => new Map(prev).set(dir, []));
    } finally {
      setLoading((prev) => {
        const next = new Set(prev);
        next.delete(dir);
        return next;
      });
    }
  }, []);

  // 换工作区：整套状态清空，别把上一个工作区里的展开路径带过来
  useEffect(() => {
    setRootOpen(true);
    setExpanded(new Set());
    expandedRef.current = new Set();
    setChildren(new Map());
  }, [root]);

  // 重新扫描：根目录 + **当前展开着的**目录。
  //
  // treeVersion 在保存/新建/删除之后 +1。这里刻意不清 expanded：
  // 存一次文件就把用户展开的目录全收起来，是这块最烦人的地方
  // （展开到三层，按一下 Ctrl+S 全没了）。
  useEffect(() => {
    void loadDir(root);
    for (const dir of expandedRef.current) void loadDir(dir);
  }, [root, treeVersion, loadDir]);

  const toggle = useCallback(
    (dir: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(dir)) {
          next.delete(dir);
        } else {
          next.add(dir);
          if (!children.has(dir)) void loadDir(dir);
        }
        return next;
      });
    },
    [children, loadDir],
  );

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const items = children.get(dir);
    if (!items) {
      return loading.has(dir) ? (
        <div className="tree-empty" style={{ paddingLeft: 12 + depth * 12 }}>
          读取中…
        </div>
      ) : null;
    }
    if (items.length === 0) {
      return (
        <div className="tree-empty" style={{ paddingLeft: 12 + depth * 12 }}>
          （空）
        </div>
      );
    }
    return items.map((item) => (
      <TreeRow
        key={item.path}
        entry={item}
        depth={depth}
        expanded={expanded.has(item.path)}
        onToggle={toggle}
        onOpen={onOpen}
        renderDir={renderDir}
      />
    ));
  };

  return (
    <div
      className="tree"
      // 点在空白处 → 针对工作区根目录的菜单
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        openContextMenu({ x: e.clientX, y: e.clientY, target: root, isDir: true });
      }}
    >
      <div
        className="tree-row root"
        onClick={() => setRootOpen((v) => !v)}
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu({ x: e.clientX, y: e.clientY, target: root, isDir: true });
        }}
        aria-expanded={rootOpen}
        title={root}
      >
        <TreeCaret open={rootOpen} />
        <TreeIcon kind={treeIconKind(basename(root), true, rootOpen)} />
        <span className="name">{basename(root)}</span>
      </div>
      {rootOpen ? renderDir(root, 1) : null}
      <div className="tree-blank" />
    </div>
  );
}

/**
 * 层级导轨：每个层级画一条竖线。
 *
 * 原来只靠 `8 + (depth-1) * 12` 的缩进区分层级，一行 12px 太窄，
 * 三四层以后基本看不出谁是谁的子项；而且直接子项与根节点**完全对齐**（都是 8px），
 * 看起来像平级。现在每层一条竖线、缩进 14px，相邻行的线首尾相接形成连续的层级线，
 * 层级关系不用猜。
 */
/**
 * 展开箭头。
 *
 * 原来用的是 `▾` / `▸` 两个字形，字号 9px——真正渲染出来是一小团，用户反馈
 * "展开之后图标成了圆点"。而且这类几何字符在不同字体、不同主题下的形状和粗细都不一样，
 * 小字号还容易被字体回退换成别的样子。改用 SVG 折角线：任何 DPI 下都是同一个形状，
 * 展开时整体旋转 90°，收起↔展开有一次连续的动作可以看。
 *
 * 不传 `open` 就是文件行用的**同宽空占位**，保证同级文件夹名与文件名左边缘对齐。
 */
function TreeCaret({ open }: { open?: boolean }) {
  return (
    <span className={`tree-caret${open ? " open" : ""}`} aria-hidden="true">
      {open === undefined ? null : (
        <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
          <path
            d="M6 3.5 L10.5 8 L6 12.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

function Guides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="tree-guide" aria-hidden="true" />
      ))}
    </>
  );
}

interface RowProps {
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  onToggle: (dir: string) => void;
  onOpen: (path: string) => void;
  renderDir: (dir: string, depth: number) => React.ReactNode;
}

function TreeRow({ entry, depth, expanded, onToggle, onOpen, renderDir }: RowProps) {
  const activePath = useDocs((s) => s.activePath);
  const dirty = useDocs((s) => {
    const d = s.docs.find((x) => x.path === entry.path);
    return d ? d.text !== d.saved : false;
  });
  const openContextMenu = useUi((s) => s.openContextMenu);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openContextMenu({ x: e.clientX, y: e.clientY, target: entry.path, isDir: entry.isDir });
  };

  if (entry.isDir) {
    return (
      <>
        <div
          className="tree-row dir"
          onClick={() => onToggle(entry.path)}
          onContextMenu={onContextMenu}
          title={entry.path}
        >
          <Guides depth={depth} />
          <TreeCaret open={expanded} />
          <TreeIcon kind={treeIconKind(entry.name, true, expanded)} />
          <span className="name">{entry.name}</span>
        </div>
        {expanded ? renderDir(entry.path, depth + 1) : null}
      </>
    );
  }

  return (
    <div
      className={`tree-row file${activePath === entry.path ? " selected" : ""}`}
      onClick={() => onOpen(entry.path)}
      onContextMenu={onContextMenu}
      title={entry.path}
    >
      <Guides depth={depth} />
      {/* 文件没有折叠箭头，但要让文件名和同级文件夹名对齐 */}
      <TreeCaret />
      <TreeIcon kind={treeIconKind(entry.name, false)} />
      <span className="name">{entry.name}</span>
      {dirty ? <span className="dirty-dot">•</span> : null}
    </div>
  );
}
