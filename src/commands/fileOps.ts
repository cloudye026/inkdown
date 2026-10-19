/**
 * 文件操作（新建 / 重命名 / 删除 / 定位）。
 *
 * 抽成独立模块的原因：文件树右键菜单、命令面板、快捷键都要用同一套逻辑。
 * 新建流程本身在 fileOpsCore.ts 里（依赖可注入，能对着假文件系统单测），
 * 这里只负责把真实依赖接进去。
 */

import { fs, basename, dirname, joinPath, revealInFileManager } from "../services/fs";
import { checkFileName, suggestFreeName } from "../services/pathUtils";
import { useDocs } from "../store/docs";
import { useSettings } from "../store/settings";
import { confirmAction, promptText, showMessage, useUi } from "../store/ui";
import {
  createFolder as coreCreateFolder,
  createMarkdownFile as coreCreateMarkdownFile,
  type FileOpDeps,
  type OpResult,
} from "./fileOpsCore";

export type { OpResult };

const ui = () => useUi.getState();
const docs = () => useDocs.getState();

/** 把真实能力接进新建流程：Tauri fs + 应用内对话框 + store */
const deps: FileOpDeps = {
  workspace: () => useSettings.getState().workspace,
  exists: (path) => fs.exists(path),
  createFile: (path) => fs.createFile(path),
  createDir: (path) => fs.createDir(path),
  openFile: async (path) => Boolean(await docs().openFile(path, { silent: true })),
  prompt: (title, opts) => promptText(title, opts),
  confirm: (title, message, opts) => confirmAction(title, message, opts),
  notify: (title, message) => showMessage(title, message),
  afterCreate: (path) => {
    useSettings.getState().pushRecent(path);
    ui().bumpTree();
    ui().toast(`已创建 ${basename(path)}`);
  },
};

/**
 * 在工作区（或指定目录）里新建 markdown 文件。
 * 重名处理原则：**绝不静默失败**——要么明确提示，要么给出可用的建议名。
 */
export function createMarkdownFile(dir?: string): Promise<OpResult> {
  return coreCreateMarkdownFile(deps, dir);
}

export function createFolder(dir?: string): Promise<OpResult> {
  return coreCreateFolder(deps, dir);
}

export async function renamePath(path: string): Promise<OpResult> {
  const oldName = basename(path);

  const input = await promptText("重命名", {
    label: path,
    value: oldName,
    confirmText: "重命名",
    validate: (v) => {
      const check = checkFileName(v);
      return check.ok ? null : (check.reason ?? "名称不合法");
    },
  });
  if (input === null) return { ok: false, reason: "已取消" };
  if (input === oldName) return { ok: false, reason: "名称未改变" };

  const check = checkFileName(input);
  if (!check.ok) {
    await showMessage("名称不合法", check.reason ?? "");
    return { ok: false, reason: check.reason };
  }

  const target = joinPath(dirname(path), check.normalized);
  try {
    if (await fs.exists(target)) {
      await showMessage("同名已存在", `${check.normalized} 已经存在，换个名字吧。`);
      return { ok: false, reason: "同名已存在" };
    }
    // 目标路径已经有标签打开了也不能改：会出现两个指向同一文件的标签
    const alreadyOpen = docs().docs.find(
      (d) => d.path !== path && d.path.toLowerCase() === target.toLowerCase(),
    );
    if (alreadyOpen) {
      await showMessage(
        "该文件已经打开",
        `${check.normalized} 已经作为标签打开了，先关掉它再重命名。`,
      );
      return { ok: false, reason: "该文件已打开" };
    }
    await fs.rename(path, target);
    // 打开着的标签跟着改名，否则会指向一个已不存在的路径
    docs().rekey(path, target);
    useSettings.getState().pushRecent(target);
    ui().bumpTree();
    ui().toast(`已重命名为 ${basename(target)}`);
    return { ok: true, path: target };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await showMessage("重命名失败", reason);
    return { ok: false, reason };
  }
}

/**
 * 删除：移入系统回收站，不是永久删除。
 * 有未保存改动时额外警告——这是不可逆操作里最容易被忽略的一种。
 */
export async function deletePath(path: string): Promise<boolean> {
  const name = basename(path);
  const doc = docs().findByPath(path);
  const dirty = doc ? doc.text !== doc.saved : false;

  const ok = await confirmAction(
    "移入回收站",
    dirty
      ? `${name} 有未保存的改动，删除后这些改动会一起丢失。\n\n确定移入回收站？`
      : `确定把 ${name} 移入回收站？之后还能从回收站还原。`,
    { danger: true, confirmText: "移入回收站" },
  );
  if (!ok) return false;

  try {
    await fs.trash(path);
    docs().close(path);
    ui().bumpTree();
    ui().toast(`已移入回收站：${name}`);
    return true;
  } catch (err) {
    await showMessage("删除失败", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export async function revealPath(path: string): Promise<void> {
  try {
    // 返回非空表示降级（例如文件已不存在，改为打开所在目录），要告诉用户
    const notice = await revealInFileManager(path);
    if (notice) ui().toast(notice);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // 把具体路径一起显示出来：用户能直接看出是哪一个路径出的问题
    ui().toast(`打开所在文件夹失败：${reason}\n${path}`);
  }
}

/**
 * 关闭标签。有未保存改动时先问一次。
 *
 * 不要用 window.confirm：WebView2 静默禁用它，返回 false，
 * 表现为"有未保存改动的标签永远关不掉"。
 */
export async function closeDoc(path: string): Promise<boolean> {
  const doc = docs().findByPath(path);
  if (!doc) return true;
  if (doc.text !== doc.saved) {
    const ok = await confirmAction(
      "有未保存的改动",
      `${doc.name} 有未保存的改动，关闭后这些改动会丢失。`,
      { danger: true, confirmText: "不保存并关闭" },
    );
    if (!ok) return false;
  }
  docs().close(path);
  return true;
}

/** 供重名建议单测复用的同步实现（与 freeName 行为一致，只是存在性判断由调用方提供） */
export function suggestFree(target: string, exists: (p: string) => boolean): string | null {
  return suggestFreeName(target, exists);
}

// ---------------------------------------------------------------- 右键菜单

/** ContextMenu 组件需要的菜单项形状（不 import 组件，避免 store/service 依赖 UI） */
export interface MenuEntry {
  label: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

const isMarkdown = (p: string) => /\.(md|markdown|mdown|mkd|mdx)$/i.test(p);

/** 菜单里要跑的命令：延迟取 store，避免模块循环依赖 */
function runCommandSafe(id: string): void {
  void import("../store/ui").then((m) => m.runCommand(id));
}

/** 关闭标签时跑命令（关闭其它/全部由 store 直接完成） */
function closeOthers(path: string): void {
  docs().closeOthers(path);
}

function closeAll(): void {
  for (const d of [...docs().docs]) docs().close(d.path);
}

/**
 * 按右键目标组装菜单。
 * `path` 为 null 表示点在空白处 → 针对工作区根目录操作。
 * 未命名文档（untitled:）没有真实路径，只给"另存为/关闭"。
 */
export function buildMenuItems(path: string | null, isDir: boolean): MenuEntry[] {
  const ws = useSettings.getState().workspace;
  const dirForNew = path ? (isDir ? path : dirname(path)) : ws;

  // 未落盘的临时文档
  if (path && path.startsWith("untitled:")) {
    const temp = path;
    return [
      { label: "另存为…", hint: "Ctrl+Shift+S", run: () => runCommandSafe("file.saveAs") },
      { label: "关闭", hint: "Ctrl+W", run: () => void closeDoc(temp) },
      { label: "关闭其它标签", run: () => closeOthers(temp) },
      { label: "关闭全部标签", run: closeAll },
    ];
  }

  if (!path) {
    return [
      { label: "新建 Markdown 文件", run: () => void createMarkdownFile(dirForNew ?? undefined) },
      { label: "新建文件夹", run: () => void createFolder(dirForNew ?? undefined) },
      { label: "刷新", hint: "F5", run: () => ui().bumpTree() },
      { label: "打开文件夹…", run: () => runCommandSafe("file.openFolder") },
    ];
  }

  if (isDir) {
    return [
      { label: "在此新建文件", run: () => void createMarkdownFile(path) },
      { label: "在此新建文件夹", run: () => void createFolder(path) },
      { label: "重命名…", hint: "F2", run: () => void renamePath(path) },
      { label: "删除（回收站）", hint: "Del", danger: true, run: () => void deletePath(path) },
      { label: "在文件管理器中打开", run: () => void revealPath(path) },
      { label: "复制路径", run: () => void copyText(path) },
    ];
  }

  const items: MenuEntry[] = [];
  if (isMarkdown(path)) {
    items.push({ label: "打开", run: () => void docs().openFile(path) });
  }
  items.push({ label: "用系统默认程序打开", run: () => void openWithSystem(path) });
  if (isMarkdown(path)) {
    items.push({ label: "重命名…", hint: "F2", run: () => void renamePath(path) });
  }
  items.push(
    { label: "删除（回收站）", hint: "Del", danger: true, run: () => void deletePath(path) },
    { label: "在文件管理器中显示", run: () => void revealPath(path) },
    { label: "复制路径", run: () => void copyText(path) },
  );
  return items;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    ui().toast("路径已复制");
  } catch {
    ui().toast(text);
  }
}

async function openWithSystem(path: string): Promise<void> {
  const { openPath } = await import("@tauri-apps/plugin-opener");
  try {
    await openPath(path);
  } catch (err) {
    await showMessage("打开失败", err instanceof Error ? err.message : String(err));
  }
}
