import { create } from "zustand";
import { fs, watcher } from "../services/fs";
import { scanHeadings } from "../services/markdown";
import type { Doc } from "../types";

interface DocsState {
  docs: Doc[];
  activePath: string | null;
  /**
   * 已打开文档的路径顺序。
   *
   * 存在的意义：`docs` 在**每次输入**时都会重建（text 变了），
   * 若组件订阅 `docs`，敲一个键就会让整棵树（含所有编辑器实例）重渲染。
   * 只关心"有哪些标签、顺序如何"的组件改订阅 `order`，
   * 它只在打开/关闭/改名时变化。
   */
  order: string[];

  active: () => Doc | null;
  findByPath: (path: string) => Doc | undefined;
  openFile: (path: string, opts?: { silent?: boolean }) => Promise<Doc | null>;
  newDoc: (path: string, text?: string) => Promise<Doc | null>;
  close: (path: string) => void;
  closeOthers: (path: string) => void;
  setActive: (path: string) => void;
  setText: (path: string, text: string) => void;
  save: (path: string) => Promise<boolean>;
  saveAll: () => Promise<number>;
  reload: (path: string, opts?: { keepConflict?: boolean }) => Promise<void>;
  applyExternalChange: (path: string, mtimeMs: number, size: number) => void;
  markMissing: (path: string, missing: boolean) => void;
  rekey: (oldPath: string, newPath: string) => void;
  /**
   * 把"未命名"文档正式落到某个路径上，保留撤销历史与光标位置。
   *
   * 返回 `{ conflict: true }` 表示该路径已经有标签打开了——
   * 这时绝不能把文档改成同一个路径，否则会出现两个指向同一文件的标签，
   * 各自的未保存状态还会互相打架。
   */
  adoptPath: (
    oldPath: string,
    newPath: string,
    meta: { mtimeMs: number; size: number },
  ) => { ok: boolean; reason?: string; existingPath?: string };
  setReadOnly: (path: string, readOnly: boolean) => void;
}

/** 生成唯一标签路径（未命名的临时文档） */
const untitledPath = () => `untitled:${Date.now()}-${Math.floor(Math.random() * 1000)}`;

/**
 * 路径比较用归一化键。
 * Windows 路径大小写不敏感、分隔符可能混用，直接 === 会把同一个文件当成两个，
 * 结果就是同一个文件开出两个标签（各自的未保存状态还会互相打架）。
 */
function pathKey(p: string): string {
  if (p.startsWith("untitled:")) return p;
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 正在读取中的文件。
 * openFile 的 await 之前拿不到结果，而 React StrictMode 会重复执行启动 effect、
 * 用户也可能连点两次——没有这层保护就会并发读同一个文件并各插入一份文档。
 */
const inflight = new Map<string, Promise<Doc | null>>();

export const useDocs = create<DocsState>((set, get) => ({
  docs: [],
  activePath: null,
  order: [],

  active: () => {
    const { docs, activePath } = get();
    return docs.find((d) => d.path === activePath) ?? null;
  },

  findByPath: (path) => {
    const key = pathKey(path);
    return get().docs.find((d) => pathKey(d.path) === key);
  },

  async openFile(path, opts) {
    const existing = get().findByPath(path);
    if (existing) {
      set({ activePath: existing.path });
      return existing;
    }

    const key = pathKey(path);
    const pending = inflight.get(key);
    if (pending) return pending;

    const task = (async (): Promise<Doc | null> => {
      try {
        const res = await fs.read(path);
        // 读盘期间可能已经被别的调用插进来了，再确认一次
        const dup = get().findByPath(res.path);
        if (dup) {
          set({ activePath: dup.path });
          return dup;
        }
        const doc: Doc = {
          path: res.path,
          name: res.name,
          saved: res.text,
          text: res.text,
          encoding: res.encoding,
          bom: res.bom,
          eol: res.eol,
          diskMtimeMs: res.mtimeMs,
          openedMtimeMs: res.mtimeMs,
          readOnly: false,
          conflict: false,
          missing: false,
          outline: scanHeadings(res.text),
          loadVersion: 0,
          size: res.size,
        };
        set((s) => ({
          docs: [...s.docs, doc],
          activePath: doc.path,
          order: [...s.order, doc.path],
        }));
        void watcher
          .watch(doc.path, { mtimeMs: res.mtimeMs, size: res.size })
          .catch(() => undefined);
        return doc;
      } catch (err) {
        if (!opts?.silent) console.error("打开失败", path, err);
        return null;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, task);
    return task;
  },

  async newDoc(path, text = "") {
    const doc: Doc = {
      path,
      name: path.startsWith("untitled:") ? "未命名.md" : (path.split(/[\\/]/).pop() ?? path),
      saved: "",
      text,
      encoding: "UTF-8",
      bom: false,
      eol: null,
      diskMtimeMs: 0,
      openedMtimeMs: 0,
      readOnly: false,
      conflict: false,
      missing: false,
      outline: scanHeadings(text),
      loadVersion: 0,
      size: text.length,
    };
    set((s) => ({ docs: [...s.docs, doc], activePath: doc.path, order: [...s.order, doc.path] }));
    return doc;
  },

  close(path) {
    const doc = get().findByPath(path);
    void watcher.unwatch(path).catch(() => undefined);
    const remaining = get().docs.filter((d) => d.path !== path);
    const wasActive = get().activePath === path;
    const idx = get().docs.findIndex((d) => d.path === path);
    const fallback = remaining[Math.min(idx, remaining.length - 1)] ?? null;
    set({
      docs: remaining,
      order: remaining.map((d) => d.path),
      activePath: wasActive ? (fallback?.path ?? null) : get().activePath,
    });
    void doc;
  },

  closeOthers(path) {
    for (const d of get().docs) {
      if (d.path !== path) void watcher.unwatch(d.path).catch(() => undefined);
    }
    const keep = get().findByPath(path);
    set({
      docs: keep ? [keep] : [],
      order: keep ? [keep.path] : [],
      activePath: keep?.path ?? null,
    });
  },

  setActive: (path) => set({ activePath: path }),

  setText(path, text) {
    // 只更新文本，**不在输入路径上重算大纲**。
    //
    // 这里原来每次按键都调 scanHeadings（O(行数)）：大文档下每个字符都要
    // 扫一遍全文，输入会明显发滞。大纲只在真正显示时才需要，
    // 改由 Outline 组件按文本 memo 计算（不用大纲的人完全不需要付这个代价）。
    set((s) => ({
      docs: s.docs.map((d) => (d.path === path ? { ...d, text } : d)),
    }));
  },

  async save(path) {
    const doc = get().findByPath(path);
    if (!doc || doc.readOnly) return false;

    // 显式保存**永远真的写盘**。
    //
    // 这里以前有一句 `if (doc.text === doc.saved) return true;` 提前返回，
    // 对自动保存是省事，对用户按 Ctrl+S 却是灾难：一旦内存里的脏标记与磁盘状态
    // 不同步（例如文件曾被外部程序改动过），就会"提示已保存、实际没写"。
    // 用户要的是确定性，不是省一次 IO。自动保存那侧本来就会先判脏。
    try {
      const res = await fs.write(path, doc.text, {
        encoding: doc.encoding,
        bom: doc.bom,
        eol: doc.eol,
      });
      await watcher.markSelfWrite(path, res.mtimeMs, res.size).catch(() => undefined);
      set((s) => ({
        docs: s.docs.map((d) =>
          d.path === path
            ? {
                ...d,
                saved: d.text,
                diskMtimeMs: res.mtimeMs,
                openedMtimeMs: res.mtimeMs,
                size: res.size,
                conflict: false,
                missing: false,
              }
            : d,
        ),
      }));
      return true;
    } catch (err) {
      console.error("保存失败", path, err);
      throw err;
    }
  },

  async saveAll() {
    const dirty = get().docs.filter((d) => d.text !== d.saved && !d.readOnly);
    let ok = 0;
    for (const d of dirty) {
      try {
        await get().save(d.path);
        ok++;
      } catch {
        /* 单个失败不阻塞其余 */
      }
    }
    return ok;
  },

  async reload(path, opts) {
    try {
      const res = await fs.read(path);
      await watcher.markSelfWrite(path, res.mtimeMs, res.size).catch(() => undefined);
      set((s) => ({
        docs: s.docs.map((d) =>
          d.path === path
            ? {
                ...d,
                saved: res.text,
                text: res.text,
                encoding: res.encoding,
                bom: res.bom,
                eol: res.eol,
                diskMtimeMs: res.mtimeMs,
                openedMtimeMs: res.mtimeMs,
                size: res.size,
                conflict: opts?.keepConflict ? d.conflict : false,
                missing: false,
                outline: scanHeadings(res.text),
                // 内容被外部替换 → 通知编辑器更新（编辑器不再订阅 text）
                loadVersion: d.loadVersion + 1,
              }
            : d,
        ),
      }));
    } catch (err) {
      console.error("重新加载失败", path, err);
    }
  },

  applyExternalChange(path, mtimeMs, size) {
    set((s) => ({
      docs: s.docs.map((d) => {
        if (d.path !== path) return d;
        // 磁盘内容和我们上次写入的完全一致（大小相同）→ 忽略
        if (d.diskMtimeMs === mtimeMs && d.size === size) return d;
        const dirty = d.text !== d.saved;
        if (!dirty) {
          // 本地没有未保存改动：静默采纳磁盘内容
          void fs
            .read(path)
            .then((res) => {
              set((st) => ({
                docs: st.docs.map((x) =>
                  x.path === path
                    ? {
                        ...x,
                        saved: res.text,
                        text: res.text,
                        diskMtimeMs: res.mtimeMs,
                        openedMtimeMs: res.mtimeMs,
                        size: res.size,
                        encoding: res.encoding,
                        bom: res.bom,
                        eol: res.eol,
                        outline: scanHeadings(res.text),
                        missing: false,
                        // 静默采纳磁盘内容 → 也要让编辑器同步
                        loadVersion: x.loadVersion + 1,
                      }
                    : x,
                ),
              }));
            })
            .catch(() => undefined);
          return { ...d, diskMtimeMs: mtimeMs, size };
        }
        // 本地有未保存改动 → 交给用户决策，绝不静默覆盖任何一边
        return { ...d, conflict: true, diskMtimeMs: mtimeMs, size };
      }),
    }));
  },

  markMissing(path, missing) {
    set((s) => ({
      docs: s.docs.map((d) => (d.path === path ? { ...d, missing } : d)),
    }));
  },

  rekey(oldPath, newPath) {
    const doc = get().findByPath(oldPath);
    if (!doc) return;
    void watcher.unwatch(oldPath).catch(() => undefined);
    void watcher
      .watch(newPath, { mtimeMs: doc.diskMtimeMs, size: doc.size })
      .catch(() => undefined);
    set((s) => ({
      docs: s.docs.map((d) =>
        d.path === oldPath
          ? { ...d, path: newPath, name: newPath.split(/[\\/]/).pop() ?? d.name }
          : d,
      ),
      order: s.order.map((p) => (p === oldPath ? newPath : p)),
      activePath: s.activePath === oldPath ? newPath : s.activePath,
    }));
  },

  adoptPath(oldPath, newPath, meta) {
    // 目标路径已经有别的标签打开了 → 拒绝，让调用方去提示用户
    const existing = get().docs.find(
      (d) => pathKey(d.path) === pathKey(newPath) && d.path !== oldPath,
    );
    if (existing) {
      return { ok: false, reason: "该文件已经打开", existingPath: existing.path };
    }

    void watcher.unwatch(oldPath).catch(() => undefined);
    void watcher.watch(newPath, meta).catch(() => undefined);
    set((s) => ({
      docs: s.docs.map((d) =>
        d.path === oldPath
          ? {
              ...d,
              path: newPath,
              name: newPath.split(/[\\/]/).pop() ?? d.name,
              saved: d.text,
              diskMtimeMs: meta.mtimeMs,
              openedMtimeMs: meta.mtimeMs,
              size: meta.size,
              conflict: false,
              missing: false,
            }
          : d,
      ),
      order: s.order.map((p) => (p === oldPath ? newPath : p)),
      activePath: s.activePath === oldPath ? newPath : s.activePath,
    }));
    return { ok: true };
  },

  setReadOnly(path, readOnly) {
    set((s) => ({
      docs: s.docs.map((d) => (d.path === path ? { ...d, readOnly } : d)),
    }));
  },
}));

export { untitledPath };
