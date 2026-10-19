import type { TreeIconKind } from "../services/fileKind";

/**
 * 文件树图标。
 *
 * 一律用内联 SVG 而不是 emoji 或字体图标：
 *   - emoji 在 Windows 上会被渲染成彩色字形，跟主题配色完全脱节，
 *     而且不同系统长得不一样（📁 在 Win10 和 Win11 上是两个样子）；
 *   - 字体图标要额外载入字体，小字号下还会被字体回退换成别的形状；
 *   - SVG 用 `currentColor` / 主题变量取色，15 套主题都能自动适配，
 *     任意 DPI 下都是同一个形状。
 *
 * 统一 16×16 视框、`stroke-width: 1.4`、圆角线帽——在 13px 显示尺寸下依然清楚。
 * 颜色：文件夹跟随行文字色（不抢注意力），文件按类型取主题的代码色，
 * 这样扫一眼能分出"文档 / 图片 / 代码 / 配置"。
 */

const SIZE = 13;

const sw = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={SIZE}
      height={SIZE}
      focusable="false"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 合上的文件夹 */
function Folder() {
  return (
    <Frame>
      <path
        d="M1.8 4.2a1 1 0 0 1 1-1h3.1l1.3 1.5h5a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"
        {...sw}
      />
    </Frame>
  );
}

/** 打开的文件夹（展开状态） */
function FolderOpen() {
  return (
    <Frame>
      <path d="M1.8 11.8V4.2a1 1 0 0 1 1-1h3.1l1.3 1.5h4.5a1 1 0 0 1 1 1v1.1" {...sw} />
      <path d="M1.8 11.8 3.6 7.4h11.2l-1.9 4.4a1 1 0 0 1-.9.6H2.8a1 1 0 0 1-1-.6z" {...sw} />
    </Frame>
  );
}

/** 文档轮廓（markdown / 文本 / 通用文件的底座） */
function DocPath() {
  return (
    <path
      d="M3.6 1.9h6l3 3v9.2H3.6z M9.6 1.9v3h3"
      {...sw}
    />
  );
}

/** Markdown：文档 + 一个小 M（M 的两笔在 13px 下仍可辨） */
function Markdown() {
  return (
    <Frame>
      <DocPath />
      <path d="M5.3 11.6V8.2l1.3 1.9 1.3-1.9v3.4" {...sw} strokeWidth={1.3} />
    </Frame>
  );
}

/** 图片：画框 + 山峰 + 太阳 */
function Image() {
  return (
    <Frame>
      <rect x="1.9" y="3.1" width="12.2" height="9.8" rx="1.6" {...sw} />
      <circle cx="5.6" cy="6.4" r="1.05" {...sw} strokeWidth={1.2} />
      <path d="M2.6 11.6l3.3-3.1 2.2 2 1.9-1.6 3.3 2.9" {...sw} strokeWidth={1.2} />
    </Frame>
  );
}

/** 代码：左右尖括号 */
function Code() {
  return (
    <Frame>
      <path d="M5.9 4.6 2.4 8l3.5 3.4M10.1 4.6 13.6 8l-3.5 3.4" {...sw} />
    </Frame>
  );
}

/** 数据/配置：一对花括号 */
function Data() {
  return (
    <Frame>
      <path d="M6.2 2.6c-1.6 0-2 .7-2 1.9v1.6c0 .9-.5 1.5-1.4 1.9.9.4 1.4 1 1.4 1.9v1.6c0 1.2.4 1.9 2 1.9" {...sw} />
      <path d="M9.8 2.6c1.6 0 2 .7 2 1.9v1.6c0 .9.5 1.5 1.4 1.9-.9.4-1.4 1-1.4 1.9v1.6c0 1.2-.4 1.9-2 1.9" {...sw} />
    </Frame>
  );
}

/** 纯文本：文档 + 三条横线 */
function Text() {
  return (
    <Frame>
      <DocPath />
      <path d="M5.5 8h5M5.5 10.2h5M5.5 12.4h3" {...sw} strokeWidth={1.2} />
    </Frame>
  );
}

/** 通用文件：文档 + 右下折角 */
function PlainFile() {
  return (
    <Frame>
      <DocPath />
    </Frame>
  );
}

const ICONS: Record<TreeIconKind, () => React.ReactElement> = {
  folder: Folder,
  "folder-open": FolderOpen,
  markdown: Markdown,
  image: Image,
  code: Code,
  data: Data,
  text: Text,
  file: PlainFile,
};

export function TreeIcon({ kind }: { kind: TreeIconKind }) {
  const Icon = ICONS[kind] ?? PlainFile;
  return (
    <span className={`tree-icon kind-${kind}`} aria-hidden="true">
      <Icon />
    </span>
  );
}
