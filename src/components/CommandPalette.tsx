import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { fs } from "../services/fs";
import { buildPaletteItems } from "../services/palette";
import { useSettings } from "../store/settings";
import { useUi, listCommands } from "../store/ui";

interface Props {
  onOpenFile: (path: string) => void;
}

/**
 * 一个面板，同时搜命令与文件。
 *
 * 以前是"跳转（Ctrl+P）"和"命令（Ctrl+Shift+P）"两个入口：用户得先判断
 * 自己想找的东西算文件还是算功能。现在合并成一个搜索框——先列命令，
 * 输入关键字后命令与文件一起匹配，命令永远排在文件前面（见 services/palette.ts）。
 */
export function CommandPalette({ onOpenFile }: Props) {
  const open = useUi((s) => s.paletteOpen);
  const close = useUi((s) => s.closePalette);
  const workspace = useSettings((s) => s.workspace);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    inputRef.current?.focus();
  }, [open]);

  // 工作区文件列表：打开面板时才递归收集一次
  useEffect(() => {
    if (!open || !workspace) return;
    let cancelled = false;
    setLoadingFiles(true);
    fs.collectMarkdown(workspace, 4000)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspace]);

  const commands = useMemo(() => listCommands(), [open]);

  const items = useMemo(
    () => buildPaletteItems({ query, commands, files, workspace, openFile: onOpenFile }),
    [query, commands, files, workspace, onOpenFile],
  );

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  const commit = (i: number) => {
    const item = items[i];
    if (!item) return;
    close();
    void item.run();
  };

  const noWorkspace = !workspace;

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="搜索命令与文件…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              commit(index);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        <div className="palette-list">
          {loadingFiles && items.length === 0 ? (
            <div className="palette-empty">正在收集文件…</div>
          ) : items.length === 0 ? (
            <div className="palette-empty">
              没有匹配结果
              {noWorkspace ? (
                <>
                  <br />
                  还没有打开文件夹，现在只能搜命令
                </>
              ) : null}
            </div>
          ) : (
            items.map((item, i) => (
              <Fragment key={item.key}>
                {item.kind !== items[i - 1]?.kind ? (
                  <div className="palette-section">{item.kind === "command" ? "命令" : "文件"}</div>
                ) : null}
                <button
                  className={`palette-item${i === index ? " active" : ""}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => commit(i)}
                >
                  <span className="title">{item.title}</span>
                  {item.sub ? <span className="sub">{item.sub}</span> : null}
                </button>
              </Fragment>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
