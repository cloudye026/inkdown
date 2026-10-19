import type { Command } from "../types";
import { basename, relativeTo } from "./pathUtils";

/**
 * 搜索面板的候选结果构建（纯逻辑，可单测）。
 *
 * 面板只有**一个**：同一个输入框里既查命令也查文件。以前拆成"跳转"（文件）
 * 与"命令"两个面板、两个按钮，用起来要先想清楚"我要找的是文件还是功能"，
 * 而这两件事在用户脑子里本来就是一件事——"我要去某处"。
 *
 * 排序原则：**命令优先**。命令是固定的一小张表（十几条），命中即为强意图；
 * 文件可能有几千个，排在后面，靠模糊匹配分高者胜出。
 */

export type PaletteKind = "command" | "file";

export interface PaletteItem {
  /** 唯一的 React key：命令 id 与文件路径可能撞车，所以带上前缀 */
  key: string;
  kind: PaletteKind;
  title: string;
  /** 右侧灰字：命令是快捷键，文件是工作区内的相对路径 */
  sub: string;
  run: () => void | Promise<void>;
}

export interface PaletteInput {
  query: string;
  commands: readonly Command[];
  /** 工作区里收集到的 markdown 文件（绝对路径） */
  files: readonly string[];
  workspace: string | null;
  openFile: (path: string) => void;
  /** 文件结果上限，默认 200。命令在最前面，文件再多也只是滚动条变长 */
  fileLimit?: number;
}

export const DEFAULT_FILE_LIMIT = 200;

export function buildPaletteItems(input: PaletteInput): PaletteItem[] {
  const q = input.query.trim().toLowerCase();

  const commands: PaletteItem[] = input.commands
    .filter((c) => !q || matchesCommand(c, q))
    .map((c) => ({
      key: `cmd:${c.id}`,
      kind: "command" as const,
      title: c.title,
      sub: c.hint ?? "",
      run: () => c.run(),
    }));

  // 空查询只列命令：几千个文件铺一屏没有意义，也拖慢打开速度。
  // 没有工作区时同理——文件列表本来就该是空的，但这里再挡一次，
  // 免得调用方传进来一个"上一个工作区"的残留列表。
  if (!q || !input.workspace) return commands;

  const limit = input.fileLimit ?? DEFAULT_FILE_LIMIT;
  const files: PaletteItem[] = input.files
    .map((p) => ({ p, score: scoreMatch(relativeTo(input.workspace, p), q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ p }) => ({
      key: `file:${p}`,
      kind: "file" as const,
      title: basename(p) || p,
      sub: relativeTo(input.workspace, p),
      run: () => input.openFile(p),
    }));

  return [...commands, ...files];
}

function matchesCommand(c: Command, q: string): boolean {
  return c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
}

/**
 * 朴素但够用的模糊匹配：连续子串优先，字符按序出现也可命中。
 * 不引第三方库——这个场景下自研更容易控制排序手感。
 */
export function scoreMatch(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const direct = t.lastIndexOf(query);
  if (direct >= 0) {
    // 越靠后（文件名部分）权重越高，路径匹配权重低
    const slash = t.lastIndexOf("/");
    const inName = direct > slash;
    return 1000 + (inName ? 500 : 0) - direct;
  }
  let ti = 0;
  let score = 0;
  for (const ch of query) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    score += 10 - Math.min(9, found - ti);
    ti = found + 1;
  }
  return score;
}
