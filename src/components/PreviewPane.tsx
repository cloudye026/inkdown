import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useDocs } from "../store/docs";
import { useSettings } from "../store/settings";
import { openExternal } from "../services/fs";
import { renderMarkdown } from "../services/markdown";
import {
  computePreviewScrollTop,
  contentOffset,
  createTrailingThrottle,
  pickAnchorAtLine,
} from "../services/mdcore";
import { applyPreview } from "../services/previewApply";
import { useUi } from "../store/ui";

/** 父组件可以命令预览跳到某个源码行 */
export interface PreviewHandle {
  /** @param line 0 基源码行号（与大纲项一致） */
  scrollToLine: (line: number) => void;
}

/** 预览里的标题锚点 */
interface PreviewAnchor {
  /** 0 基源码行号（来自 data-line） */
  line: number;
  /** 相对**滚动内容顶部**的像素位置 */
  offsetTop: number;
}

/**
 * 量出所有标题锚点相对滚动内容的位置。
 *
 * **不能用 `el.offsetTop`**：`.pane-preview` 是 `position: static`，
 * 于是标题的 `offsetParent` 会一路找到 `BODY`，`offsetTop` 里混进了
 * 标题栏 + 标签栏的高度（实测偏 72px）。后果：
 *   - 点大纲跳转会**越过**目标标题，目标被顶到视口外面；
 *   - 编辑器→预览的滚动同步也整体偏移，只是插值把它掩盖得不明显。
 *
 * 改用 getBoundingClientRect 相对滚动容器测量，与祖先是否定位无关。
 */
function measureAnchors(host: HTMLElement, content: HTMLElement): PreviewAnchor[] {
  const hostTop = host.getBoundingClientRect().top;
  const scrollTop = host.scrollTop;
  return Array.from(content.querySelectorAll<HTMLElement>("[data-line]")).map((el) => ({
    line: Number(el.dataset.line ?? "0"),
    offsetTop: contentOffset(el.getBoundingClientRect().top, hostTop, scrollTop),
  }));
}

interface Props {
  path: string;
  /** 编辑器里当前可见的首行（1 基）；null 表示还没收到滚动事件 */
  scrollLine: number | null;
  /** 编辑器滚动比例 0–1，无标题文档靠它同步 */
  scrollRatio: number;
  /** 文档总行数，用于最后一段的插值 */
  totalLines: number;
  /** 由编辑器滚动驱动：把预览滚到对应的标题附近 */
  /** 预览滚动时上报"当前正在读的标题行"（0 基），用于点亮大纲 */
  onVisibleLine?: (line: number) => void;
}

export const PreviewPane = forwardRef<PreviewHandle, Props>(function PreviewPane(
  { path, scrollLine, scrollRatio, totalLines, onVisibleLine }: Props,
  ref,
) {
  const onVisibleLineRef = useRef(onVisibleLine);
  onVisibleLineRef.current = onVisibleLine;
  const text = useDocs((s) => s.findByPath(path)?.text ?? "");
  const breakOnSingleNewline = useSettings((s) => s.breakOnSingleNewline);
  const syncScroll = useSettings((s) => s.syncScroll);
  const theme = useSettings((s) => s.theme);
  const toast = useUi((s) => s.toast);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [renderId, setRenderId] = useState(0);
  const programmatic = useRef(false);

  /**
   * 预览用**防抖后**的文本渲染。
   *
   * 单次 renderMarkdown 是同步的，实测：短文约 4ms、带 10 个代码块约 14ms、
   * 大文档可达 29ms——都发生在按键的处理路径上，再加上 DOM 重建、
   * Shiki 重新高亮、Mermaid 重画，打字就会卡顿、抖动，空格这种高频键最明显。
   *
   * 切换到另一份文档时立即更新（否则会短暂显示上一份文档的内容）。
   */
  const [deferredText, setDeferredText] = useState(text);
  const lastPath = useRef(path);
  const previewDelay = useSettings((s) => s.previewDelayMs);

  useEffect(() => {
    if (lastPath.current !== path) {
      lastPath.current = path;
      setDeferredText(text);
      return;
    }
    if (text === deferredText) return;
    const timer = window.setTimeout(() => setDeferredText(text), previewDelay);
    return () => window.clearTimeout(timer);
  }, [text, path, previewDelay, deferredText]);

  const docDir = useMemo(() => {
    const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return i > 0 ? path.slice(0, i) : null;
  }, [path]);

  const { html } = useMemo(
    () => renderMarkdown(deferredText, { docDir, breakOnSingleNewline }),
    [deferredText, docDir, breakOnSingleNewline],
  );

  // 注入 HTML 后再做异步增强（Shiki 高亮 / Mermaid 图表）。
  //
  // 这里做**增量更新**：只替换真正变化的那几块，而不是每次把整棵子树重建。
  // 整棵重建实测 19–33ms（大文档更久），而它跑在输入路径上，
  // 表现就是打字/回车时的卡顿感。
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    let cancelled = false;
    // 主题**显式传给服务**：不能让它去读 <html data-theme>——那个属性由 App 的
    // effect 写入，而 React 的 effect 是子先父后，这里会读到上一个主题。
    // "主题变化要整棵重建"由 applyPreview 自己判断（放服务里才能被单测覆盖）。
    void applyPreview(content, html, { theme }).then(() => {
      if (!cancelled) setRenderId((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [html, theme]);

  // 链接与图片点击：外部链接交给系统浏览器，站内锚点自己处理
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const onClick = (ev: MouseEvent) => {
      const anchor = (ev.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        ev.preventDefault();
        const target = content.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (/^https?:|^mailto:/i.test(href)) {
        ev.preventDefault();
        void openExternal(href);
        return;
      }
      ev.preventDefault();
      toast("相对路径链接暂不支持跳转");
    };
    content.addEventListener("click", onClick);
    return () => content.removeEventListener("click", onClick);
  }, [html, toast]);

  // 编辑器 → 预览 的滚动同步
  useEffect(() => {
    if (!syncScroll || scrollLine == null) return;
    const host = hostRef.current;
    const content = contentRef.current;
    if (!host || !content) return;

    // 标题锚点：行号 + 相对滚动容器的像素位置。
    // 没有标题时算法会自动退化为按比例同步（以前是直接 return，表现为完全不动）。
    const anchors = measureAnchors(host, content);

    const target = computePreviewScrollTop({
      line: scrollLine,
      totalLines,
      ratio: scrollRatio,
      anchors,
      contentHeight: content.scrollHeight,
      viewportHeight: host.clientHeight,
    });

    programmatic.current = true;
    host.scrollTop = target;
    window.setTimeout(() => {
      programmatic.current = false;
    }, 60);
  }, [scrollLine, scrollRatio, totalLines, syncScroll, renderId]);

  /**
   * 预览 → 大纲 的反向同步：读到哪里，大纲就高亮到哪一节。
   *
   * 「预览视图」下编辑器是隐藏的，光标不会动，所以大纲原先一直停在
   * 切过来的那一刻。阅读长文档时无法知道自己身在何处。
   * 这里按"视口顶部上方最近的标题"上报，节流到 ~80ms，滚动时不掉帧。
   */
  const reportVisible = useMemo(
    () =>
      createTrailingThrottle<number>(
        (line) => {
          onVisibleLineRef.current?.(line);
        },
        80,
        {
          now: () => performance.now(),
          setTimer: (fn, ms) => window.setTimeout(fn, ms),
        },
      ),
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    const content = contentRef.current;
    if (!host || !content) return;

    const onScroll = () => {
      // 程序化滚动（同步 / 大纲跳转）不反向上报，否则会和编辑器互相推
      if (programmatic.current) return;
      const anchors = measureAnchors(host, content);
      if (anchors.length === 0) return;
      // 视口顶部下方 1/4 处作为判定线，比贴在顶边更符合"正在读这一节"的直觉
      const probe = host.scrollTop + host.clientHeight * 0.25;
      let best = anchors[0]!;
      for (const a of anchors) {
        if (a.offsetTop <= probe) best = a;
        else break;
      }
      reportVisible(best.line);
    };

    host.addEventListener("scroll", onScroll, { passive: true });
    return () => host.removeEventListener("scroll", onScroll);
  }, [reportVisible, renderId]);

  /**
   * 供父组件调用：把预览滚到某个源码行对应的标题。
   *
   * 为什么需要它：点大纲原先只让**编辑器**跳转，而「预览视图」下编辑器是
   * display:none —— 滚动一个隐藏元素什么都看不见，用户的感受就是
   * "点大纲没反应"。现在编辑器与预览各自响应，哪边可见哪边就动。
   */
  useImperativeHandle(
    ref,
    () => ({
      scrollToLine(line: number) {
        const host = hostRef.current;
        const content = contentRef.current;
        if (!host || !content) return;

        programmatic.current = true;
        /** 上一次设定的 scrollTop，用于判断"用户是否已经自己滚走了" */
        let applied = -1;

        const apply = () => {
          // 用户在我们校正的间隙里自己滚动了 → 不要把他拽回来
          if (applied >= 0 && Math.abs(host.scrollTop - applied) > 2) return;
          const hit = pickAnchorAtLine(measureAnchors(host, content), line);
          if (!hit) return;
          applied = Math.max(0, hit.offsetTop - 16);
          host.scrollTop = applied;
        };

        apply();
        // 布局在这一帧之后还可能变：图片刚加载、Shiki 刚把代码块换掉，
        // 都会改变高度，一次测量常常偏掉几百像素（表现为"跳到半路"）。
        // 下一帧与 120ms 后各校正一次，稳定且几乎无感。
        requestAnimationFrame(apply);
        window.setTimeout(apply, 120);
        window.setTimeout(() => {
          programmatic.current = false;
        }, 320);
      },
    }),
    [],
  );

  return (
    <div className="pane pane-preview" ref={hostRef}>
      <div className="preview-scroll">
        <article className="markdown-body" ref={contentRef} />
      </div>
    </div>
  );
});
