import { useDocs, untitledPath } from "../store/docs";
import { useSettings } from "../store/settings";
import { useUi, registerCommands, confirmAction, showMessage } from "../store/ui";
import {
  basename,
  fs,
  openExternal,
  pickFiles,
  pickFolder,
  pickSavePath,
} from "../services/fs";
import { nextThemeOfSameMode, toggleMode } from "../services/themes";
import { saveToastText, shouldAnnounceSave } from "../services/saveNotice";
import { createFolder, createMarkdownFile, deletePath, renamePath } from "./fileOps";
import type { Doc } from "../types";

const ui = () => useUi.getState();
const docs = () => useDocs.getState();
const settings = () => useSettings.getState();

const doc = (): Doc | null => docs().active();

function requireDoc(): Doc | null {
  const d = doc();
  if (!d) ui().toast("当前没有打开的文档");
  return d;
}

// ------------------------------------------------------------------ 打开 / 新建

export async function openPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    const d = await docs().openFile(p, { silent: true });
    if (!d) {
      ui().toast(`打开失败：${basename(p)}`);
      continue;
    }
    settings().pushRecent(d.path);
  }
}

async function openFilesCommand(): Promise<void> {
  const paths = await pickFiles();
  if (paths.length) await openPaths(paths);
}

async function openFolderCommand(): Promise<void> {
  const dir = await pickFolder();
  if (!dir) return;
  settings().update({ workspace: dir });
  ui().setSidebar(true);
  ui().setSidebarTab("files");
  ui().bumpTree();
  ui().toast(`已打开文件夹：${basename(dir)}`);
}

/** 新建 markdown 文件。dir 由文件树右键菜单传入（在哪个文件夹上新建）。 */
export async function newFileCommand(dir?: string): Promise<void> {
  // 没有工作区时退化成内存里的"未命名"文档，Save 时再问路径
  if (!dir && !settings().workspace) {
    await docs().newDoc(untitledPath());
    return;
  }
  await createMarkdownFile(dir);
}

export async function newFolderCommand(dir?: string): Promise<void> {
  await createFolder(dir);
}

// ------------------------------------------------------------------ 保存

async function saveCommand(): Promise<void> {
  const d = doc();
  if (!d) return;
  try {
    if (d.path.startsWith("untitled:")) {
      const target = await pickSavePath(d.name);
      if (!target) return;
      // 原子保存后把标签原地"落盘"，保留撤销历史与滚动位置
      const res = await fs.write(target, d.text, { encoding: "UTF-8", bom: false, eol: null });
      const adopted = docs().adoptPath(d.path, target, { mtimeMs: res.mtimeMs, size: res.size });
      if (!adopted.ok) {
        // 目标已经有标签打开：保持"未命名"标签不变，避免出现两个指向同一文件的标签
        await showMessage(
          "该文件已经打开",
          `${basename(target)} 已经作为标签打开了。\n\n` +
            "可以切换到那个标签继续编辑，或者换一个文件名保存。",
        );
        return;
      }
      settings().pushRecent(target);
      ui().bumpTree();
      ui().toast(`已保存到 ${basename(target)}`);
      return;
    }
    // 显式保存必须"报告成功 == 真的写了盘"。
    // save() 返回 false 时（只读文档等）绝不能弹"已保存"。
    //
    // 但**没有改动时的重复保存不再弹提示**：用户连按 Ctrl+S 时，
    // 每次都弹一遍"已保存"没有任何信息量（写盘照旧，见 store/docs.ts）。
    const before = { dirty: d.text !== d.saved, conflict: d.conflict };
    const ok = await docs().save(d.path);
    if (!ok) {
      ui().toast("未保存：当前文档是只读状态");
      return;
    }
    const saved = docs().findByPath(d.path) ?? d;
    if (shouldAnnounceSave(before)) {
      ui().toast(saveToastText(saved));
    }
  } catch (err) {
    ui().toast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function saveAsCommand(): Promise<void> {
  const d = requireDoc();
  if (!d) return;
  const target = await pickSavePath(d.name);
  if (!target) return;
  try {
    await fs.write(target, d.text, { encoding: d.encoding, bom: d.bom, eol: d.eol });
    // 文件已经写成功了，但标签可能打不开——必须区分这两种结果，
    // 否则会出现"提示另存成功、界面上却看不到那个文件"。
    const opened = await docs().openFile(target, { silent: true });
    settings().pushRecent(target);
    ui().bumpTree();
    if (!opened) {
      await showMessage(
        "已保存，但打开失败",
        `内容已写入 ${basename(target)}，但无法把它打开成标签，请检查文件权限。`,
      );
      return;
    }
    ui().toast(`已另存为 ${basename(target)}`);
  } catch (err) {
    ui().toast(`另存失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function saveAllCommand(): Promise<void> {
  const n = await docs().saveAll();
  ui().toast(n > 0 ? `已保存 ${n} 个文件` : "没有需要保存的改动");
}

// ------------------------------------------------------------------ 视图

/**
 * 切换主题。
 *
 * 点一次在**同明暗模式**的主题之间轮换（深色→另一个深色），
 * 想换明暗就用设置面板或状态栏右键——这样"换主题"不会把习惯深色的人
 * 突然甩到刺眼的浅色上。
 *
 * 缓存清理不用在这里做：settings.update 检测到主题变化会自己清。
 */
function toggleThemeCommand(): void {
  settings().update({ theme: nextThemeOfSameMode(settings().theme) });
}

function togglePreviewCommand(): void {
  const s = settings();
  s.update({ viewMode: s.viewMode === "edit" ? "preview" : "edit" });
}

function toggleSidebarCommand(): void {
  ui().toggleSidebar();
}

function toggleTypewriterCommand(): void {
  settings().update({ typewriterMode: !settings().typewriterMode });
}

function zoomCommand(delta: number): void {
  const s = settings();
  const size = Math.min(28, Math.max(11, s.editorSize + delta));
  const psize = Math.min(28, Math.max(11, s.previewSize + delta));
  s.update({ editorSize: size, previewSize: psize });
}

function resetZoomCommand(): void {
  settings().update({ editorSize: 16, previewSize: 16, measure: 46 });
}

// ------------------------------------------------------------------ 格式

/**
 * 顶栏的格式按钮删掉之后，这些操作必须仍然够得着，所以它们全部登记成命令，
 * 可以在搜索面板里按名字找到（输入"加粗""自检"）。
 *
 * 走的是编辑器已经监听的 `inkdown:format` 事件——同一个通道，
 * 只是发起点从按钮变成了面板。
 */
function dispatchToEditor(event: string, detail?: string): void {
  // 这些命令作用在编辑器上，而预览视图下编辑器是藏起来的。先切回编辑视图；
  // 派发放下一帧，让 React 先把编辑视图渲染出来（编辑器那侧用实时状态判断，
  // 所以就算事件早到也不会被丢掉，见 MarkdownEditor 的 isActiveEditor）。
  if (settings().viewMode !== "edit") settings().update({ viewMode: "edit" });
  window.requestAnimationFrame(() => {
    window.dispatchEvent(
      detail === undefined ? new CustomEvent(event) : new CustomEvent(event, { detail }),
    );
  });
}

function formatCommand(kind: string): void {
  dispatchToEditor("inkdown:format", kind);
}

function requireDocThenFormat(kind: string): () => void {
  return () => {
    if (!requireDoc()) return;
    formatCommand(kind);
  };
}

// ------------------------------------------------------------------ 文件操作

async function renameActiveCommand(): Promise<void> {
  const d = requireDoc();
  if (!d) return;
  if (d.path.startsWith("untitled:")) {
    ui().toast('未命名文档请用「另存为」指定路径');
    return;
  }
  await renamePath(d.path);
}

async function trashActiveCommand(): Promise<void> {
  const d = requireDoc();
  if (!d) return;
  // 未落盘的临时文档直接从标签里去掉，不走回收站
  if (d.path.startsWith("untitled:")) {
    const ok = await confirmAction("关闭未命名文档", `${d.name} 还没有保存到磁盘，关闭后内容会丢失。`, {
      danger: true,
      confirmText: "关闭",
    });
    if (ok) docs().close(d.path);
    return;
  }
  await deletePath(d.path);
}

async function copyPathCommand(): Promise<void> {
  const d = requireDoc();
  if (!d) return;
  try {
    await navigator.clipboard.writeText(d.path);
    ui().toast("路径已复制");
  } catch {
    ui().toast(d.path);
  }
}

// ------------------------------------------------------------------ 注册

let registered = false;

export function bootstrapCommands(): void {
  if (registered) return;
  registered = true;

  registerCommands([
    // 文件
    { id: "file.open", title: "打开文件…", hint: "Ctrl+O", run: openFilesCommand },
    { id: "file.openFolder", title: "打开文件夹…", hint: "Ctrl+Shift+O", run: openFolderCommand },
    { id: "file.new", title: "新建文件", hint: "Ctrl+N", run: newFileCommand },
    { id: "file.newFolder", title: "新建文件夹", run: newFolderCommand },
    { id: "file.save", title: "保存", hint: "Ctrl+S", run: saveCommand },
    { id: "file.saveAs", title: "另存为…", hint: "Ctrl+Shift+S", run: saveAsCommand },
    { id: "file.saveAll", title: "保存全部", run: saveAllCommand },
    { id: "file.rename", title: "重命名当前文件", run: renameActiveCommand },
    { id: "file.trash", title: "删除当前文件（回收站）", run: trashActiveCommand },
    { id: "file.copyPath", title: "复制文件路径", run: copyPathCommand },

    // 导航
    {
      id: "goto.search",
      title: "搜索（命令与工作区文件）",
      hint: "Ctrl+P",
      run: () => ui().openPalette(),
    },
    {
      id: "goto.outline",
      title: "切换到大纲",
      run: () => {
        ui().setSidebar(true);
        ui().setSidebarTab("outline");
      },
    },

    // 视图
    {
      id: "view.theme",
      title: "选择主题…",
      run: () => ui().openThemePicker(null),
    },
    {
      id: "view.themeNext",
      title: "主题：换一种（同色系）",
      run: toggleThemeCommand,
    },
    {
      id: "view.themeMode",
      title: "主题：换明暗（浅色 ↔ 深色）",
      run: () => settings().update({ theme: toggleMode(settings().theme) }),
    },
    { id: "view.edit", title: "编辑视图", run: () => settings().update({ viewMode: "edit" }) },
    { id: "view.preview", title: "预览视图", hint: "Ctrl+Shift+V", run: togglePreviewCommand },
    // 侧栏没有独立的快捷键：Ctrl+B 归编辑器（加粗），这里不再谎报一个按了没反应的组合
    { id: "view.sidebar", title: "显示/隐藏侧栏", run: toggleSidebarCommand },
    { id: "view.typewriter", title: "打字机模式", run: toggleTypewriterCommand },
    { id: "view.zoomIn", title: "放大字号", hint: "Ctrl+=", run: () => zoomCommand(1) },
    { id: "view.zoomOut", title: "缩小字号", hint: "Ctrl+-", run: () => zoomCommand(-1) },
    { id: "view.zoomReset", title: "重置字号", hint: "Ctrl+0", run: resetZoomCommand },
    { id: "view.settings", title: "设置…", hint: "Ctrl+,", run: () => ui().setSettingsOpen(true) },

    // 阅读
    {
      id: "read.exportHtml",
      title: "导出为 HTML",
      run: async () => {
        const d = requireDoc();
        if (!d) return;
        const { exportHtml } = await import("../services/export");
        await exportHtml(d);
      },
    },
    {
      id: "read.openInBrowser",
      title: "在默认浏览器中预览",
      run: async () => {
        const d = requireDoc();
        if (!d) return;
        const { previewInBrowser } = await import("../services/export");
        await previewInBrowser(d);
      },
    },
    {
      id: "read.openExternal",
      title: "用系统默认程序打开当前文件",
      run: async () => {
        const d = requireDoc();
        if (!d) return;
        await openExternal(`file://${d.path.replace(/\\/g, "/")}`);
      },
    },

    // 编辑
    {
      id: "edit.find",
      title: "在当前文件中查找",
      hint: "Ctrl+F",
      run: () => dispatchToEditor("inkdown:find"),
    },
    // 这些原来是顶栏的图标按钮（B / I / 🔗 / <> / ❝ / ⇤ / ≣ / ✓）。
    // 按钮删掉不等于功能删掉：登记成命令后，搜索面板里输入名字就能用。
    { id: "edit.bold", title: "加粗", hint: "Ctrl+B", run: requireDocThenFormat("bold") },
    { id: "edit.italic", title: "斜体", hint: "Ctrl+I", run: requireDocThenFormat("italic") },
    { id: "edit.code", title: "行内代码", run: requireDocThenFormat("code") },
    { id: "edit.link", title: "插入链接", hint: "Ctrl+K", run: requireDocThenFormat("link") },
    { id: "edit.quote", title: "引用", run: requireDocThenFormat("quote") },
    { id: "edit.ul", title: "无序列表", run: requireDocThenFormat("ul") },
    { id: "edit.ol", title: "有序列表", run: requireDocThenFormat("ol") },
    {
      id: "edit.outdent",
      title: "整段贴左（去掉行首多余缩进）",
      run: requireDocThenFormat("outdent"),
    },
    {
      id: "edit.fillList",
      title: "列表补标记（给缺「- 」的行补上）",
      run: requireDocThenFormat("fillList"),
    },
    {
      id: "edit.check",
      title: "结构自检（代码块围栏是否闭合）",
      run: requireDocThenFormat("check"),
    },
  ]);
}
