import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TopBar } from "./components/TopBar";
import { Tabs } from "./components/Tabs";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { PreviewPane } from "./components/PreviewPane";
import type { PreviewHandle } from "./components/PreviewPane";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsDialog } from "./components/SettingsDialog";
import { ThemePicker } from "./components/ThemePicker";
import { ToastHost, Welcome } from "./components/Welcome";
import { ModalDialog } from "./components/ModalDialog";
import { ContextMenu } from "./components/ContextMenu";
import { MarkdownEditor, type EditorHandle } from "./editor/MarkdownEditor";
import { bootstrapCommands, openPaths } from "./commands";
import { buildMenuItems, closeDoc } from "./commands/fileOps";
import { useDocs } from "./store/docs";
import { applySettingsToDom, useSettings } from "./store/settings";
import { runCommand, useUi } from "./store/ui";
import { fs, onFileChanged } from "./services/fs";
import { warmupHighlighter } from "./services/highlight";
import { createTrailingThrottle } from "./services/mdcore";
import { useDebouncedEffect } from "./hooks/useDebouncedEffect";
import type { CursorInfo } from "./types";

const EMPTY_CURSOR: CursorInfo = { line: 1, col: 1, selectionLength: 0 };

/** 滚动同步的节流窗口：约每帧一次，且结束时补发最后一次位置 */
const SCROLL_THROTTLE_MS = 16;

export default function App() {
  // 只订阅**路径顺序**与活动路径，不订阅 docs：
  // docs 在每次输入时都会重建，订阅它会让敲一个键就重渲染整棵树
  // （包括所有编辑器实例）——这是输入发滞的主要来源之一。
  const order = useDocs((s) => s.order);
  const activePath = useDocs((s) => s.activePath);

  // 以下都只订阅**原始值**：Zustand 用 Object.is 比较，
  // 字符串/数字/布尔不变就不会触发重渲染。这样输入时只有真正相关的组件更新，
  // 而不是整棵树（含所有编辑器实例）一起重渲染。
  const activeText = useDocs((s) =>
    s.activePath ? (s.docs.find((d) => d.path === s.activePath)?.text ?? "") : "",
  );
  const activeName = useDocs((s) =>
    s.activePath ? (s.docs.find((d) => d.path === s.activePath)?.name ?? "") : "",
  );
  const activeConflict = useDocs((s) =>
    s.activePath ? (s.docs.find((d) => d.path === s.activePath)?.conflict ?? false) : false,
  );
  const activeMissing = useDocs((s) =>
    s.activePath ? (s.docs.find((d) => d.path === s.activePath)?.missing ?? false) : false,
  );
  const activeLineCount = useMemo(() => activeText.split("\n").length, [activeText]);
  const settings = useSettings();
  /** 编辑 / 预览整幅切换（不再左右对照） */
  const viewMode = settings.viewMode;
  const sidebarVisible = useUi((s) => s.sidebarVisible);
  const toast = useUi((s) => s.toast);

  const [cursor, setCursor] = useState<CursorInfo>(EMPTY_CURSOR);
  /** 编辑器滚动位置：行号 + 比例。行号用于按标题锚点对齐，比例用于无标题文档 */
  const [scrollLine, setScrollLine] = useState<number | null>(null);
  const [scrollRatio, setScrollRatio] = useState(0);
  /**
   * 预览里正在读的标题行（**1 基**，与 cursor.line 同口径）。
   * 「预览视图」下没有光标可跟，用它点亮大纲，否则大纲会一直停在切换那一刻。
   */
  const [previewLine, setPreviewLine] = useState(1);
  const [dropping, setDropping] = useState(false);
  const [booted, setBooted] = useState(false);

  const editors = useRef(new Map<string, EditorHandle>());
  /** 预览的命令式接口：点大纲时也要让预览跳转（预览视图下编辑器是隐藏的） */
  const previewRef = useRef<PreviewHandle | null>(null);
  const scrollTimer = useRef<number | null>(null);
  const bootedOnce = useRef(false);

  const activeDocCount = order.length;
  /** 没有活动文档时编辑器就是唯一可看的地方，别切到空白的预览 */
  const showEditor = viewMode === "edit" || !activePath;

  // ---------------------------------------------------------------- 启动
  useEffect(() => {
    bootstrapCommands();
    void warmupHighlighter();

    // 已保存的设置可能缺失新字段，合并一次默认值
    applySettingsToDom(useSettings.getState());

    // StrictMode 会重复执行 effect：启动只做一次，否则会重复打开文件
    if (bootedOnce.current) return;
    bootedOnce.current = true;

    // 恢复上次会话
    const s = useSettings.getState();
    void (async () => {
      // 命令行参数优先于会话恢复：`inkdown.exe note.md` 应直接打开该文件，
      // `--workspace <目录>` 则直接进入那个工作区（也是"双击关联文件"的关键）
      const cli = await fs.startupArgs().catch(() => null);
      if (cli?.workspace) {
        useSettings.getState().update({ workspace: cli.workspace });
        useUi.getState().setSidebar(true);
        useUi.getState().setSidebarTab("files");
        useUi.getState().bumpTree();
      }
      if (cli?.file) {
        await openPaths([cli.file]);
        setBooted(true);
        return;
      }
      if (s.lastSession?.path && (await fs.exists(s.lastSession.path).catch(() => false))) {
        await openPaths([s.lastSession.path]);
      }
      setBooted(true);
    })();

    return () => {
      const st = useDocs.getState();
      const line = editors.current.get(st.activePath ?? "")?.currentLine() ?? 1;
      useSettings.getState().update({
        lastSession: st.activePath ? { path: st.activePath, line } : null,
      });
    };
  }, []);

  // 主题 / 字号 / 字体变化 → 写进 CSS 变量
  useEffect(() => {
    applySettingsToDom(settings);
  }, [settings]);

  // 切换文档时清掉上一份文档的滚动位置：
  // 否则预览会先按旧行号跳一次，看起来就是"没同步"
  useEffect(() => {
    setScrollLine(null);
    setScrollRatio(0);
  }, [activePath]);

  // ---------------------------------------------------------------- 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        // 按"最上面那层先关"的顺序：搜索面板 → 主题选择 → 设置抽屉
        const ui = useUi.getState();
        if (ui.paletteOpen) ui.closePalette();
        else if (ui.themePicker) ui.closeThemePicker();
        else if (ui.settingsOpen) ui.setSettingsOpen(false);
        return;
      }
      if (!mod) {
        if (e.key === "F11") {
          e.preventDefault();
          void getCurrentWindow().isFullscreen().then((f) => getCurrentWindow().setFullscreen(!f));
        } else if (e.key === "F5") {
          // WebView 默认拿 F5 重新加载整个前端——未保存的改动会一起没。
          // 文件树右键菜单里写的 F5 就是"刷新树"，这里把它接过来。
          e.preventDefault();
          if (useSettings.getState().workspace) {
            useUi.getState().bumpTree();
            toast("文件树已刷新");
          }
        }
        return;
      }
      const shift = e.shiftKey;
      // 这些组合交给编辑器自己处理（加粗/斜体/查找/保存），不要在这里抢
      if (!shift && ["b", "i", "f", "s", "k"].includes(e.key.toLowerCase())) return;

      switch (e.key.toLowerCase()) {
        case "o":
          e.preventDefault();
          void runCommand(shift ? "file.openFolder" : "file.open");
          break;
        case "n":
          e.preventDefault();
          void runCommand("file.new");
          break;
        case "p":
          // Ctrl+P / Ctrl+Shift+P 都打开同一个搜索面板：它本来就同时搜命令与文件，
          // 以前"跳转 / 命令"两个入口的区分对用户没有意义。
          e.preventDefault();
          useUi.getState().openPalette();
          break;
        case "v":
          if (shift) {
            e.preventDefault();
            void runCommand("view.preview");
          }
          break;
        case ",":
          e.preventDefault();
          useUi.getState().setSettingsOpen(true);
          break;
        case "=":
        case "+":
          e.preventDefault();
          void runCommand("view.zoomIn");
          break;
        case "-":
          e.preventDefault();
          void runCommand("view.zoomOut");
          break;
        case "0":
          e.preventDefault();
          void runCommand("view.zoomReset");
          break;
        case "w":
          if (activePath) {
            e.preventDefault();
            void closeDoc(activePath);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePath]);

  // ---------------------------------------------------------------- 拖入文件
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDropping(true);
    };
    const onDragLeave = () => setDropping(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDropping(false);
      const paths = Array.from(e.dataTransfer?.files ?? [])
        .map((f) => (f as File & { path?: string }).path)
        .filter((p): p is string => Boolean(p));
      if (paths.length) void openPaths(paths);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // Tauri 原生文件拖放（WebView 不会把真实路径给到 HTML5 drop）
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "over") setDropping(true);
          else if (event.payload.type === "leave") setDropping(false);
          else if (event.payload.type === "drop") {
            setDropping(false);
            if (event.payload.paths.length) void openPaths(event.payload.paths);
          }
        });
      } catch {
        /* 浏览器环境下忽略 */
      }
    })();
    return () => unlisten?.();
  }, []);

  // ---------------------------------------------------------------- 外部变更
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void onFileChanged((e) => {
      const doc = useDocs.getState().findByPath(e.path);
      if (!doc) return;
      const dirty = doc.text !== doc.saved;
      useDocs.getState().applyExternalChange(e.path, e.mtimeMs, e.size);
      const after = useDocs.getState().findByPath(e.path);
      if (after?.conflict) {
        toast(`「${after.name}」在磁盘上被修改了，且本地有未保存改动`);
      } else if (dirty) {
        toast(`「${doc.name}」在磁盘上被修改，已标记为冲突`);
      } else {
        toast(`「${doc.name}」已从磁盘重新载入`);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [toast]);

  // ---------------------------------------------------------------- 自动保存
  const autoSaveKey = activePath ? `${activePath}:${activeText.length}` : "none";
  useDebouncedEffect(
    async () => {
      const st = useDocs.getState();
      const d = activePath ? st.findByPath(activePath) : null;
      if (!d || d.text === d.saved || d.readOnly) return;
      try {
        await st.save(d.path);
      } catch {
        toast("自动保存失败，请手动 Ctrl+S");
      }
    },
    [autoSaveKey],
    settings.autoSaveDelayMs,
    settings.autoSave && Boolean(activePath),
  );

  // ---------------------------------------------------------------- 回调
  const handleOpenFile = useCallback((path: string) => {
    void useDocs.getState().openFile(path);
    useSettings.getState().pushRecent(path);
  }, []);

  const handleReady = useCallback((path: string, handle: EditorHandle) => {
    editors.current.set(path, handle);
  }, []);

  const handleJumpLine = useCallback(
    (line: number) => {
      if (!activePath) return;
      // 编辑与预览是**互斥**的两块（同一时刻只有一边可见）：
      // 原来只滚编辑器，于是在「预览视图」下点大纲毫无反应
      // —— 滚的是一个 display:none 的编辑器。
      if (showEditor) {
        editors.current.get(activePath)?.scrollToLine(line + 1);
        return;
      }
      // 预览视图：同时点亮所点的这一节。
      // 程序化滚动被有意排除在"反向上报"之外（否则会和编辑器互相推），
      // 所以这里得自己把高亮挪过去，不然它会停在上一节。
      setPreviewLine(line + 1);
      previewRef.current?.scrollToLine(line);
    },
    [activePath, showEditor],
  );

  /**
   * 编辑器滚动 → 预览同步。
   *
   * 用带尾补发的节流：滚动停下时的最后一个事件经常落在节流窗口内，
   * 直接丢弃会让预览停在倒数第二个位置（差最后一点），所以窗口结束时补发一次。
   */
  const pushScroll = useMemo(
    () =>
      createTrailingThrottle<{ line: number; ratio: number }>(
        (value) => {
          setScrollLine(value.line);
          setScrollRatio(value.ratio);
        },
        SCROLL_THROTTLE_MS,
        {
          now: () => performance.now(),
          setTimer: (fn, ms) => window.setTimeout(fn, ms),
        },
      ),
    [],
  );

  const handleEditorScroll = useCallback(
    (line: number, ratio: number) => pushScroll({ line, ratio }),
    [pushScroll],
  );

  // 卸载时清掉待补发的定时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (scrollTimer.current !== null) window.clearTimeout(scrollTimer.current);
    };
  }, []);

  const stats = useMemo(() => {
    const text = activeText;
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
    const words = (text.match(/[A-Za-z0-9_'-]+/g) ?? []).length;
    return { words: cjk + words, chars: text.length };
  }, [activeText]);

  return (
    <div className="app">
      <TopBar />
      {activeConflict && activePath ? <ConflictBanner path={activePath} name={activeName} /> : null}
      {activeMissing && activePath ? <MissingBanner path={activePath} name={activeName} /> : null}

      <div className="app-body">
        {sidebarVisible ? (
          <Sidebar
            width={settings.sidebarWidth}
            onWidthChange={(w) => useSettings.getState().update({ sidebarWidth: w })}
            onOpenFile={handleOpenFile}
            currentLine={showEditor ? cursor.line : previewLine}
            onJumpLine={handleJumpLine}
          />
        ) : null}

        <div className="main-col">
          <Tabs onActivate={(p) => useDocs.getState().setActive(p)} />

          {booted && activeDocCount === 0 ? (
            <Welcome onDropPaths={(paths) => void openPaths(paths.filter(Boolean))} dropping={dropping} />
          ) : (
            <div className="panes">
              {/* 编辑与预览**互斥**：同一时刻只有一边占满整个工作区。
                  编辑器实例始终挂载（切到预览时只是 display:none），这样切回编辑时
                  光标位置与撤销历史都还在——重建实例会把这些全丢掉。
                  预览则按需挂载，切过去时用编辑器上报的行号对齐。 */}
              <div
                className="pane pane-editor"
                style={showEditor ? undefined : { display: "none" }}
              >
                {order.map((p) => (
                  <MarkdownEditor
                    key={p}
                    path={p}
                    visible={p === activePath && showEditor}
                    onCursor={setCursor}
                    onScrollLine={handleEditorScroll}
                    onReady={handleReady}
                  />
                ))}
                {activeDocCount === 0 ? <div className="welcome">正在恢复会话…</div> : null}
              </div>

              {showEditor ? null : (
                <PreviewPane
                  ref={previewRef}
                  path={activePath}
                  scrollLine={scrollLine}
                  scrollRatio={scrollRatio}
                  totalLines={activeLineCount}
                  onVisibleLine={(line) => setPreviewLine(line + 1)}
                />
              )}
            </div>
          )}

          <StatusBar cursor={cursor} wordCount={stats.words} charCount={stats.chars} />
        </div>
      </div>

      <CommandPalette onOpenFile={handleOpenFile} />
      <SettingsDialog />
      <ThemePicker />
      <ContextMenuHost />
      <ModalDialog />
      <ToastHost />
    </div>
  );
}

/** 右键菜单：菜单项按当前右键目标现算，菜单本身由 ContextMenu 负责交互 */
function ContextMenuHost() {
  const menu = useUi((s) => s.contextMenu);
  const items = useMemo(
    () => (menu ? buildMenuItems(menu.target, menu.isDir) : []),
    [menu],
  );
  if (!menu) return null;
  return (
    <ContextMenu
      items={items}
      separators={buildSeparators(items.map((i) => i.label))}
    />
  );
}

/** 分组之间画分隔线：按语义分组，而不是写死索引 */
function buildSeparators(labels: string[]): number[] {
  const seps: number[] = [];
  const boundaryAfter = ["在此新建文件夹", "用系统默认程序打开", "打开文件夹…", "关闭全部标签"];
  labels.forEach((label, i) => {
    if (i < labels.length - 1 && boundaryAfter.includes(label)) seps.push(i + 1);
  });
  return seps;
}

// ---------------------------------------------------------------- 冲突提示

function ConflictBanner({ path, name }: { path: string; name: string }) {
  const toast = useUi((s) => s.toast);
  return (
    <div className="banner danger">
      <span>
        「{name}」在磁盘上被其他程序修改了，而你本地也有未保存的改动 —— 两边都没有被覆盖。
      </span>
      <span className="spacer" />
      <button
        onClick={() => {
          void useDocs.getState().reload(path);
          toast("已载入磁盘上的版本，本地改动已丢弃");
        }}
      >
        载入磁盘版本
      </button>
      <button
        onClick={() => {
          useDocs.setState({
            docs: useDocs.getState().docs.map((d) =>
              d.path === path ? { ...d, conflict: false } : d,
            ),
          });
          toast("保留本地版本；再次保存会覆盖磁盘内容");
        }}
      >
        保留我的版本
      </button>
    </div>
  );
}

function MissingBanner({ path, name }: { path: string; name: string }) {
  return (
    <div className="banner">
      <span>「{name}」在磁盘上已不存在（被移动或删除）。</span>
      <span className="spacer" />
      <button onClick={() => useDocs.getState().markMissing(path, false)}>知道了</button>
    </div>
  );
}
