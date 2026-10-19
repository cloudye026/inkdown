/**
 * 浮层定位（纯逻辑，可单测）。
 *
 * 主题选择面板既可能从顶栏的 ☾ 打开，也可能从状态栏右下角的主题名打开，
 * 所以位置不能写死：**贴着触发它的那个按钮弹出**。
 *
 * 两个容易出错的边界都在这里解决掉：
 *   - 靠右边的按钮（顶栏的设置、状态栏的主题名）如果不做钳制，面板会跑出屏幕；
 *   - 视口下半部分的锚点（状态栏）应该向上弹，否则面板会顶到窗口底部。
 *
 * 向上弹时用 `bottom` 而不是 `top`：面板高度取决于主题条目数，事先不知道，
 * 用 bottom 定位就不需要先量高度。
 */

export interface Anchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface PopoverPlacement {
  left: number;
  top?: number;
  bottom?: number;
  above: boolean;
}

/** 没有锚点（例如从命令面板打开）时的落点：顶栏下方靠右 */
export const DEFAULT_TOP = 46;

export function placePopover(opts: {
  anchor: Anchor | null;
  viewport: Viewport;
  width: number;
  margin?: number;
  gap?: number;
}): PopoverPlacement {
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 6;
  const { anchor, viewport, width } = opts;

  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const clampLeft = (left: number) => Math.min(Math.max(left, margin), maxLeft);

  if (!anchor) {
    return { left: maxLeft, top: DEFAULT_TOP, above: false };
  }

  const left = clampLeft(anchor.right - width);
  const above = anchor.top > viewport.height / 2;
  return above
    ? { left, bottom: viewport.height - anchor.top + gap, above }
    : { left, top: anchor.bottom + gap, above };
}

/** 从触发元素取锚点；拿不到（元素已卸载等）就返回 null，由调用方走默认落点 */
export function anchorOf(el: Element | null | undefined): Anchor | null {
  const r = el?.getBoundingClientRect();
  if (!r) return null;
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}
