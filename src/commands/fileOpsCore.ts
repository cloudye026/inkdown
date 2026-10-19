/**
 * 新建流程的可注入实现。
 *
 * 为什么要单独抽一层：这段逻辑里最容易出错的就是"重名怎么办"，
 * 而它天然依赖文件系统、对话框和 store——直接写就变成"只能靠手点验证"。
 * 把依赖作为参数传进来，就能在 Node 里对着**假文件系统**跑完整分支：
 * 重名提示、建议名重试、非法名拒绝、路径穿越拦截。
 *
 * fileOps.ts 负责把真实依赖（Tauri fs / 应用内对话框 / store）接进来。
 */

import { checkFileName, joinPath } from "../services/pathUtils";

export interface OpResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

/** 新建流程需要的全部外部能力 */
export interface FileOpDeps {
  /** 当前工作区（没打开文件夹时为 null） */
  workspace: () => string | null;
  exists: (path: string) => Promise<boolean>;
  createFile: (path: string) => Promise<void>;
  createDir: (path: string) => Promise<void>;
  /** 打开某文件为标签，返回是否成功 */
  openFile: (path: string) => Promise<boolean>;
  /** 文本输入对话框；取消返回 null */
  prompt: (
    title: string,
    opts: {
      label?: string;
      value: string;
      placeholder?: string;
      confirmText?: string;
      validate?: (v: string) => string | null;
    },
  ) => Promise<string | null>;
  /** 确认对话框 */
  confirm: (
    title: string,
    message: string,
    opts?: { danger?: boolean; confirmText?: string },
  ) => Promise<boolean>;
  /** 只有一个"知道了"的提示 */
  notify: (title: string, message: string) => Promise<void>;
  /** 新建成功后的收尾：刷新文件树 / 记入最近 / 提示 */
  afterCreate: (path: string) => void;
}

/** 异步的重名探测：todo.md → todo-2.md → todo-3.md … */
export async function findFreeName(
  target: string,
  exists: (p: string) => Promise<boolean>,
): Promise<string | null> {
  const base = target.replace(/\\/g, "/").split("/").pop() ?? target;
  const dir = target.slice(0, target.length - base.length).replace(/[\\/]+$/, "");
  const m = /^(.*?)(\.[^.]+)?$/.exec(base);
  const stem = m?.[1] ?? base;
  const ext = m?.[2] ?? "";
  for (let n = 2; n <= 100; n++) {
    const candidate = joinPath(dir, `${stem}-${n}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  return null;
}

/**
 * 新建 markdown 文件。
 * 重名处理原则：**绝不静默失败**——要么明确提示重名，要么给出可用的建议名。
 */
export async function createMarkdownFile(deps: FileOpDeps, dir?: string): Promise<OpResult> {
  const baseDir = dir ?? deps.workspace();
  if (!baseDir) {
    await deps.notify("无法新建", "还没有打开文件夹。先用 Ctrl+Shift+O 打开一个文件夹。");
    return { ok: false, reason: "没有工作区" };
  }

  let suggested = "未命名.md";

  for (let attempt = 0; attempt < 20; attempt++) {
    const input = await deps.prompt("新建 Markdown 文件", {
      label: `位置：${baseDir}`,
      value: suggested,
      placeholder: "例如 会议记录.md，或 notes/todo.md",
      confirmText: "创建",
      validate: (v) => {
        const check = checkFileName(v, { requireMd: true });
        return check.ok ? null : (check.reason ?? "名称不合法");
      },
    });
    if (input === null) return { ok: false, reason: "已取消" };

    const check = checkFileName(input, { requireMd: true });
    if (!check.ok) {
      await deps.notify("名称不合法", check.reason ?? "请重新输入");
      suggested = input;
      continue;
    }

    const target = joinPath(baseDir, check.normalized);

    // 重名：明确告知 + 给建议名 + 允许直接打开已有文件
    if (await deps.exists(target)) {
      const free = await findFreeName(target, deps.exists);
      const name = target.replace(/\\/g, "/").split("/").pop() ?? target;
      const openExisting = await deps.confirm(
        "同名文件已存在",
        `${name} 在这个文件夹里已经存在。\n\n` +
          (free
            ? `选「打开已有文件」直接编辑它；选「取消」后可以改成 ${free.replace(/\\/g, "/").split("/").pop()}。`
            : "选「打开已有文件」直接编辑它。"),
        { confirmText: "打开已有文件" },
      );
      if (openExisting) {
        await deps.openFile(target);
        deps.afterCreate(target);
        return { ok: true, path: target };
      }
      suggested = free ? (free.replace(/\\/g, "/").split("/").pop() ?? input) : input;
      continue;
    }

    try {
      await deps.createFile(target);
      const opened = await deps.openFile(target);
      deps.afterCreate(target);
      if (!opened) {
        await deps.notify("创建后打开失败", `文件已创建：${target}\n但读取失败，请检查文件权限。`);
      }
      return { ok: true, path: target };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await deps.notify("创建失败", reason);
      return { ok: false, reason };
    }
  }

  return { ok: false, reason: "多次重名，已放弃" };
}

export async function createFolder(deps: FileOpDeps, dir?: string): Promise<OpResult> {
  const baseDir = dir ?? deps.workspace();
  if (!baseDir) {
    await deps.notify("无法新建", "还没有打开文件夹。");
    return { ok: false, reason: "没有工作区" };
  }

  const input = await deps.prompt("新建文件夹", {
    label: `位置：${baseDir}`,
    value: "新文件夹",
    confirmText: "创建",
    validate: (v) => {
      const check = checkFileName(v);
      return check.ok ? null : (check.reason ?? "名称不合法");
    },
  });
  if (input === null) return { ok: false, reason: "已取消" };

  const check = checkFileName(input);
  if (!check.ok) {
    await deps.notify("名称不合法", check.reason ?? "");
    return { ok: false, reason: check.reason };
  }

  const target = joinPath(baseDir, check.normalized);
  try {
    if (await deps.exists(target)) {
      await deps.notify("同名文件夹已存在", `${check.normalized} 已经存在，换个名字吧。`);
      return { ok: false, reason: "同名文件夹已存在" };
    }
    await deps.createDir(target);
    deps.afterCreate(target);
    return { ok: true, path: target };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await deps.notify("创建失败", reason);
    return { ok: false, reason };
  }
}
