import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { DirEntry, FileChangedEvent, ReadResult, WriteResult } from "../types";
import { basename, dirname, joinPath, relativeTo, stem } from "./pathUtils";

// 路径工具放在 pathUtils.ts（纯函数，可单测），这里只做转出，保持调用方 import 不变
export { basename, dirname, joinPath, relativeTo, stem };

// ---------------------------------------------------------------- 文件命令

export const fs = {
  read: (path: string) => invoke<ReadResult>("read_file", { path }),

  write: (
    path: string,
    contents: string,
    opts: { encoding?: string; bom?: boolean; eol?: string | null } = {},
  ) =>
    invoke<WriteResult>("write_file", {
      path,
      contents,
      encoding: opts.encoding ?? null,
      bom: opts.bom ?? null,
      eol: opts.eol ?? null,
    }),

  createFile: (path: string) => invoke<void>("create_file", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  trash: (path: string) => invoke<void>("trash_path", { path }),
  exists: (path: string) => invoke<boolean>("path_exists", { path }),
  scanDir: (path: string, onlyMarkdown = false) =>
    invoke<DirEntry[]>("scan_dir", { path, onlyMarkdown }),
  collectMarkdown: (root: string, limit?: number) =>
    invoke<string[]>("collect_markdown", { root, limit: limit ?? null }),
  nowMs: () => invoke<number>("now_ms"),
  /** 启动时命令行带来的参数（文件 / 工作区目录） */
  startupArgs: () =>
    invoke<{ file: string | null; workspace: string | null }>("get_startup_args"),
};

// ---------------------------------------------------------------- 监听

export function onFileChanged(cb: (e: FileChangedEvent) => void): Promise<UnlistenFn> {
  return listen<FileChangedEvent>("file-changed", (ev) => cb(ev.payload));
}

export const watcher = {
  /** initial 传前端刚读到的 (mtime, size)，避免"首次发现文件"被误报为外部修改 */
  watch: (path: string, initial?: { mtimeMs: number; size: number }) =>
    invoke<void>("watch_file", {
      path,
      initial: initial ? [initial.mtimeMs, initial.size] : null,
    }),
  unwatch: (path: string) => invoke<void>("unwatch_file", { path }),
  markSelfWrite: (path: string, mtimeMs: number, size: number) =>
    invoke<void>("mark_self_write", { path, mtimeMs, size }),
};

// ---------------------------------------------------------------- 对话框

export const MD_FILTER = [
  { name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "mdx"] },
  { name: "文本", extensions: ["txt", "text", "log"] },
  { name: "全部文件", extensions: ["*"] },
];

export async function pickFiles(): Promise<string[]> {
  const r = await openDialog({ multiple: true, filters: MD_FILTER });
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

export async function pickFolder(): Promise<string | null> {
  const r = await openDialog({ directory: true, multiple: false });
  return typeof r === "string" ? r : null;
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  const r = await saveDialog({ defaultPath: defaultName, filters: MD_FILTER });
  return r ?? null;
}

// ---------------------------------------------------------------- 其它

export async function openExternal(url: string): Promise<void> {
  try {
    const mod = await import("@tauri-apps/plugin-opener");
    await mod.openUrl(url);
  } catch (err) {
    console.error("打开外部链接失败", err);
  }
}

/**
 * 在系统文件管理器里定位并选中该项（Windows 上是"打开所在文件夹"）。
 *
 * 走自己的 `reveal_path` 命令而不是 opener 插件：插件在路径不存在时只给一个
 * 含义模糊的错误，前端只能显示"打开失败"。自己的命令会退回打开所在目录，
 * 并返回可读说明（例如"文件已不存在，改为打开所在文件夹：…"）。
 *
 * 返回值为空字符串表示正常，非空表示降级提示，应展示给用户。
 */
export async function revealInFileManager(path: string): Promise<string> {
  return invoke<string>("reveal_path", { path });
}

/**
 * 把本地绝对路径转成 WebView 能加载的 asset URL（预览里的本地图片）。
 *
 * **必须用 Tauri 的 convertFileSrc**，不能自己拼：
 *   - Windows / Android：`http://asset.localhost/<路径>`
 *   - macOS / Linux / iOS：`asset://localhost/<路径>`
 * 早期实现硬编码了前者，在 macOS 上图片会全部加载失败。
 */
export function assetUrl(absPath: string): string {
  try {
    // convertFileSrc 是同步的，且只在 Tauri 运行时存在
    return convertFileSrc(absPath);
  } catch {
    return absPath;
  }
}
