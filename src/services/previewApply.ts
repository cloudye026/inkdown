/**
 * 预览内容的应用流程：**注入 HTML → 增量更新 → 异步增强**。
 *
 * 为什么单独抽成模块、而不是留在 PreviewPane 组件里：
 *   1. 这段逻辑（增量 diff + 主题切换时的强制重建）是**出过 bug 的地方**
 *      ——换主题后代码块沿用旧配色 —— 但藏在组件里就无法用单测覆盖；
 *   2. 组件只该负责"订阅状态、把值传下来"，DOM 操作属于服务层。
 *
 * 现在测试可以直接调用 `applyPreview`，走的就是生产路径。
 */

import { commonEdges } from "./blockCache";
import { enhancePreview } from "./previewRender";
import type { ThemeId } from "./themes";

/** 上一次渲染的快照：节点序列 + 对应的原始 HTML（用于增量对比） */
let lastBlocks: { content: HTMLElement; nodes: Node[]; htmls: string[] } | null = null;

/**
 * 每个预览容器**上一次用哪个主题增强过**。
 *
 * 放在服务里而不是组件里：这样"主题变化 → 必须整棵重建"这条规则
 * 能被单测完整覆盖。判断逻辑留在组件里就只能靠人工验证，
 * 而这正是当初漏掉这个 bug 的原因之一。
 *
 * 用 WeakMap 是为了容器被卸载后能自动回收。
 */
const lastThemeByContent = new WeakMap<HTMLElement, string>();

/** 清掉增量对比的基线（换文档、或需要强制重建时用） */
export function resetPreviewBaseline(content?: HTMLElement): void {
  lastBlocks = null;
  if (content) lastThemeByContent.delete(content);
}

/**
 * 增量更新预览 DOM：只替换真正变化的那几块。
 *
 * 做法：把这次的 HTML 解析成节点序列，与**上次的原始 HTML 数组**比较，
 * 取公共前缀/后缀定位"变化的中间段"，只替换那一段。
 *
 * 为什么必须保存"上次的原始 HTML"：DOM 里的节点可能已经被 Shiki 高亮、
 * 或被 Mermaid 换成了 SVG，拿它去和新的原始 HTML 比会处处不相等，
 * diff 就完全失效（等于每次都整棵重建）。
 *
 * @param force 强制整棵重建。**主题切换时必须用**：那时 HTML 一个字都没变，
 *   但 DOM 里已经是上一个主题的高亮结果（`.shiki` 而不是 `pre.code-block`），
 *   增量更新会判定"无需改动"，增强阶段也就找不到可处理的块 ——
 *   代码块会一直沿用旧主题的配色。
 */
export function patchBlocks(content: HTMLElement, nextHtml: string, force = false): void {
  const parser = document.createElement("div");
  parser.innerHTML = nextHtml;
  const nextNodes = Array.from(parser.childNodes);
  const nextHtmls = nextNodes.map((n) => (n as HTMLElement).outerHTML ?? "");

  const prev = lastBlocks;
  if (
    force ||
    !prev ||
    prev.content !== content ||
    prev.nodes.length !== content.childNodes.length
  ) {
    content.innerHTML = nextHtml;
    lastBlocks = { content, nodes: Array.from(content.childNodes), htmls: nextHtmls };
    return;
  }

  const { prefix, suffix } = commonEdges(prev.htmls, nextHtmls);
  const changedFrom = prefix;
  const changedTo = prev.htmls.length - suffix;
  const nextTo = nextHtmls.length - suffix;

  if (changedFrom === changedTo && changedFrom === nextTo) return; // 毫无变化

  // 以"变化段之后仍要保留的第一个节点"为插入基准
  const reference = content.childNodes[changedTo] ?? null;

  for (let i = changedFrom; i < changedTo; i++) {
    const node = content.childNodes[changedFrom];
    if (node) content.removeChild(node);
  }
  for (let i = changedFrom; i < nextTo; i++) {
    const node = nextNodes[i];
    if (node) content.insertBefore(node, reference);
  }

  lastBlocks = { content, nodes: Array.from(content.childNodes), htmls: nextHtmls };
}

export interface ApplyPreviewOptions {
  /** 当前主题。**必须显式传**，不能让它去读 DOM（见 enhancePreview 的注释） */
  theme: ThemeId;
  /**
   * 是否强制整棵重建。
   *
   * **一般不用传**：服务自己会比对"上一次增强用的主题"，变了就自动重建。
   * 只有确实需要无条件重建时才显式给 true。
   */
  force?: boolean;
}

/**
 * 把渲染好的 HTML 应用到预览容器，并完成异步增强。
 *
 * **主题变化时会自动整棵重建**（调用方不用操心）：
 * 第一次增强后 DOM 里已经没有 `pre.code-block`（被 Shiki 输出替换），
 * 若不重建，增量更新会判"HTML 没变、无需改动"，增强阶段也就没有块可处理，
 * 代码块会一直沿用旧主题的配色。
 *
 * 返回增强完成的 Promise，调用方可以据此触发重排（滚动同步依赖它）。
 */
export async function applyPreview(
  content: HTMLElement,
  html: string,
  opts: ApplyPreviewOptions,
): Promise<void> {
  const prevTheme = lastThemeByContent.get(content);
  // 主题变了、或从没渲染过 → 必须重建
  const force = opts.force ?? (prevTheme !== opts.theme);
  lastThemeByContent.set(content, opts.theme);

  patchBlocks(content, html, force);
  await enhancePreview(content, opts.theme);
}
