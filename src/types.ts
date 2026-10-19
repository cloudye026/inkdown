import type { ThemeId } from "./services/themes";

/**
 * 主题 id 定义在 services/themes.ts（那里同时维护配色与 Shiki 主题名）。
 * 这里转出，方便只用类型的地方不必写完整路径。
 *
 * 注意：旧版本只存 "dark" / "light"，读取时必须用 normalizeTheme 迁移。
 */
export type { ThemeId };

/**
 * 视图模式：整幅切换，不做左右两栏对照。
 *
 * - `edit`    只显示编辑器
 * - `preview` 只显示渲染后的预览
 *
 * 之所以用联合类型而不是 `previewVisible: boolean`：后者表达的是"预览面板要不要
 * 一起显示"，是并排布局的产物；换成切换式之后，"现在看哪一边"才是真实状态。
 */
export type ViewMode = "edit" | "preview";

/** 后端 read_file 的返回结构（字段名与 Rust 侧 serde rename_all = camelCase 对齐） */
export interface ReadResult {
  path: string;
  name: string;
  text: string;
  encoding: string;
  bom: boolean;
  eol: string | null;
  mtimeMs: number;
  size: number;
  isMarkdown: boolean;
}

export interface WriteResult {
  mtimeMs: number;
  size: number;
}

export interface DirEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

export interface FileChangedEvent {
  path: string;
  mtimeMs: number;
  size: number;
}

/** 编辑器里的光标坐标（1 基，给状态栏显示用） */
export interface CursorInfo {
  line: number;
  col: number;
  selectionLength: number;
}

export interface OutlineItem {
  level: number;
  text: string;
  /** 在源码中的行号（0 基） */
  line: number;
}

/** 打开着的一份文档 */
export interface Doc {
  path: string;
  name: string;
  /** 最近一次从磁盘读取或成功写入的内容 */
  saved: string;
  /** 编辑器当前内容 */
  text: string;
  /**
   * "内容被外部替换"的计数器：重新载入、采纳磁盘版本、落盘时递增。
   *
   * 编辑器订阅它而不是订阅 `text`——`text` 每次按键都变，订阅它会让编辑器
   * 自己也跟着重渲染（编辑器本身是命令式的，不需要 React 参与输入）。
   */
  loadVersion: number;
  encoding: string;
  bom: boolean;
  eol: string | null;
  /** 最近一次已知的磁盘 mtime，用于外部变更检测 */
  diskMtimeMs: number;
  /** 首次读入时的 mtime */
  openedMtimeMs: number;
  readOnly: boolean;
  /** 磁盘上的内容比编辑器新（外部修改），需要用户决策 */
  conflict: boolean;
  /** 外部删除 */
  missing: boolean;
  outline: OutlineItem[];
  size: number;
}

export interface Settings {
  theme: ThemeId;
  fontPreset: string;
  /**
   * 字体是否跟随主题。
   * 开启时切主题会同时换字体（用各主题推荐的字体栈）；
   * 关闭时 `fontPreset` 是唯一依据。
   */
  fontFollowsTheme: boolean;
  editorSize: number;
  editorLineHeight: number;
  previewSize: number;
  previewLineHeight: number;
  /** 预览渲染的防抖延迟（毫秒）。太小会拖累输入，太大会显得迟钝 */
  previewDelayMs: number;
  measure: number;
  showLineNumbers: boolean;
  softWrap: boolean;
  breakOnSingleNewline: boolean;
  autoSave: boolean;
  autoSaveDelayMs: number;
  typewriterMode: boolean;
  /**
   * 切视图时是否按当前位置对齐。
   * 编辑 ↔ 预览是**整幅切换**（不是左右对照），所以这一项的含义是
   * "切过去时接着刚才那一行看"，而不是两个面板实时联动。
   */
  syncScroll: boolean;
  /** 当前视图：编辑还是预览。两者互斥，不再并排 */
  viewMode: ViewMode;
  sidebarWidth: number;
  recentFiles: string[];
  workspace: string | null;
  lastSession: { path: string; line: number } | null;
}

export interface Command {
  id: string;
  title: string;
  hint?: string;
  run: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  text: string;
}
