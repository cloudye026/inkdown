/**
 * 路径与文件名处理（纯函数，可在 Node 里单测）。
 *
 * 这里放的是最容易出错、又最难靠肉眼发现的部分：Windows 分隔符混用、
 * 非法字符、把用户输入的 `notes/todo.md` 正确装进工作区。
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 组装路径，按目录已有的分隔符风格统一。
 *
 * 名字里可能带子目录（`notes/todo.md`），必须把内部分隔符也换成同一种风格：
 * 否则会拼出 `D:\ws\notes/todo.md` 这种混用路径——文件系统能接受，
 * 但路径比较、标签去重和界面显示都会变得难以预料。
 */
export function joinPath(dir: string, name: string): string {
  const useBackslash = dir.includes("\\");
  const sep = useBackslash ? "\\" : "/";
  const trimmed = dir.replace(/[\\/]+$/, "");
  const cleaned = name.replace(/^[\\/]+/, "").replace(/[\\/]/g, sep);
  return `${trimmed}${sep}${cleaned}`;
}

export function basename(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i < 0 ? norm : norm.slice(i + 1);
}

/**
 * 取父目录。**保留原有的分隔符风格**——
 * 如果这里统一转成正斜杠，后续 joinPath 会误判路径风格，
 * 在 Windows 上拼出 `D:\ws/sub/a-2.md` 这种混用路径。
 */
export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return "";
  if (i === 0) return p.slice(0, 1);
  const head = p.slice(0, i);
  // 盘符根：C: → C:\
  if (/^[a-zA-Z]:$/.test(head)) return `${head}\\`;
  return head;
}

/** 去掉 markdown 扩展名（用于导出文件名、标题建议） */
export function stem(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i <= 0 ? b : b.slice(0, i);
}

export interface NameCheck {
  ok: boolean;
  /** 失败原因，直接可以显示给用户 */
  reason?: string;
  /** 规范化后的名字（去掉首尾空格、统一分隔符） */
  normalized: string;
}

/**
 * 校验用户输入的文件/文件夹名。
 *
 * 允许 `notes/todo.md` 这样的相对路径（含子目录），逐段校验。
 * 返回可显示的具体原因——"新建失败"这种提示等于没提示。
 */
export function checkFileName(raw: string, opts: { requireMd?: boolean } = {}): NameCheck {
  // 整体去掉首尾空格（用户很容易手滑打上），所以"以空格结尾"不算错误；
  // 但**以点结尾**会被 Windows 静默截断（"a." → "a"），必须拦下来。
  const normalized = raw.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");

  if (!normalized) return { ok: false, reason: "名称不能为空", normalized };

  const segments = normalized.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      return { ok: false, reason: `「${seg || "(空)"}」不是合法的名称`, normalized };
    }
    // eslint-disable-next-line no-control-regex
    const illegal = /[<>:"|?*\u0000-\u001f]/.exec(seg);
    if (illegal) {
      return { ok: false, reason: `名称不能包含 ${illegal[0]} 字符`, normalized };
    }
    if (seg.endsWith(".")) {
      return { ok: false, reason: "名称不能以句点结尾（Windows 会把它静默截断）", normalized };
    }
    if (WINDOWS_RESERVED.test(seg)) {
      return { ok: false, reason: `「${seg}」是系统保留名称`, normalized };
    }
  }

  const last = segments[segments.length - 1] ?? "";
  if (opts.requireMd && !/\.(md|markdown|mdown|mkd|mdx)$/i.test(last)) {
    return { ok: false, reason: "请使用 .md 扩展名", normalized };
  }
  return { ok: true, normalized };
}

/**
 * 重名时给出可用的建议名：todo.md → todo-2.md → todo-3.md
 * 仍然占用就继续往后找（上限 200，避免病态情况卡住）。
 */
export function suggestFreeName(
  target: string,
  exists: (p: string) => boolean,
): string | null {
  const dir = dirname(target);
  const base = basename(target);
  const m = /^(.*?)(\.[^.]+)?$/.exec(base);
  const stemPart = m?.[1] ?? base;
  const ext = m?.[2] ?? "";

  for (let n = 2; n <= 200; n++) {
    const candidate = joinPath(dir, `${stemPart}-${n}${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return null;
}

/** 工作区内的短路径，列表里显示用 */
export function relativeTo(root: string | null, p: string): string {
  if (!root) return p;
  const a = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const b = p.replace(/\\/g, "/");
  return b.startsWith(`${a}/`) ? b.slice(a.length + 1) : b;
}
