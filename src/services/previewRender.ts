import { BlockCache, fingerprint } from "./blockCache";
import { escapeHtml } from "./mdcore";
import { highlight } from "./highlight";
import { normalizeTheme, themeDef, type ThemeId } from "./themes";

/**
 * 当前生效的主题 id。
 *
 * 优先用调用方传进来的值；只有没传时才回退到读 `<html data-theme>`。
 *
 * **为什么必须显式传**：`data-theme` 是 App 的 effect 里写的，而 React 的
 * effect 顺序是**子组件先跑、父组件后跑**——预览的 effect 会先执行，
 * 那时 `data-theme` 还是**上一个主题**。于是换主题后代码块沿用旧主题的
 * token 配色：切到浅色主题时，深色主题的浅色 token 压在浅底上几乎看不见，
 * 用户看到的就是"代码块颜色不对"。
 *
 * 主题注册表是唯一真源，且设置一改就同步更新，不受 effect 顺序影响。
 */
function activeThemeId(explicit?: ThemeId): ThemeId {
  if (explicit) return normalizeTheme(explicit);
  return normalizeTheme(document.documentElement.dataset.theme);
}

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;
/** Mermaid 的初始化参数，主题变化时需要重新初始化 */
let mermaidTheme: string | null = null;

/**
 * Mermaid 有 1MB+，必须懒加载：不用图表的人不该付出启动代价。
 *
 * 配色取自**主题注册表**而不是 `getComputedStyle`：
 * CSS 变量同样是 App 的 effect 之后才更新的，读它一样会拿到上一个主题的值。
 */
function getMermaid(id: ThemeId) {
  const def = themeDef(id);
  const key = `${def.id}|${def.swatch.accent}|${def.swatch.fg}|${def.swatch.elev}`;
  if (!mermaidReady || mermaidTheme !== key) {
    mermaidTheme = key;
    mermaidReady = import("mermaid")
      .then((mod) => {
        const mermaid = mod.default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: def.mode === "light" ? "default" : "dark",
          // 让图表的线条与文字跟随当前主题，而不是 Mermaid 自带的固定配色
          themeVariables: {
            primaryColor: def.swatch.accent,
            primaryTextColor: def.swatch.bg,
            primaryBorderColor: def.swatch.accent,
            lineColor: def.swatch.accent,
            textColor: def.swatch.fg,
            fontSize: "14px",
          },
          fontFamily: getComputedStyle(document.body).fontFamily,
          flowchart: { htmlLabels: false },
        });
        return mermaid;
      })
      .catch((err) => {
        mermaidReady = null;
        mermaidTheme = null;
        throw err;
      });
  }
  return mermaidReady;
}

/**
 * 让所有"按主题渲染"的缓存失效：Mermaid 初始化、代码高亮、图表。
 *
 * 为什么需要：代码高亮与图表都按**源码指纹**缓存，而同一段代码在
 * GitHub 深色与 Solarized 浅色下的配色完全不同。换主题若不清理，
 * 就会继续复用旧主题的高亮结果，表现为"界面换了、代码还是旧配色"。
 *
 * 调用点：settings store 的 update() 检测到主题变化时自动调用
 * （用动态 import 避免 settings → previewRender → highlight → settings 的环）。
 */
export function invalidatePreviewCaches(): void {
  mermaidReady = null;
  mermaidTheme = null;
  codeCache.clear();
  diagramCache.clear();
}

// ---------------------------------------------------------------- 结果缓存
//
// 预览每次更新都会重建整棵 DOM 树，但**大多数块的内容并没有变**。
// 没有缓存时，一边打字一边重新高亮所有代码块、重画所有图表
// （mermaid.render 要做布局计算，很贵），输入就会发滞。
//
// 指纹只跟内容有关，所以改哪个块就只重渲染那个块；其余直接复用上次的 DOM。

/** 类型：高亮后的 HTML 字符串（按 语言+源码 缓存） */
const codeCache = new BlockCache<string>(300);
/**
 * 类型：渲染好的图表**整块**（按 源码+主题 缓存）。
 *
 * 缓存整块而不是只缓存 <svg>：这样不依赖"能否从结果里查到 svg 节点"，
 * 图表的容器样式与 mermaid 生成的其它标记也一并复用。
 */
const diagramCache = new BlockCache<HTMLElement>(60);

export function previewCacheStats() {
  return { code: codeCache.stats, diagram: diagramCache.stats };
}

// ---------------------------------------------------------------- 主流程

/**
 * 给 Shiki 的输出补一个 `data-lang`，供 CSS 在代码块右上角显示语言名。
 *
 * 只在最外层 `<pre` 上加，并且原本已有 `data-lang` 时不动（降级块自带）。
 *
 * 语言名来自用户写的围栏信息串，两处要小心：
 *   1. **只保留安全的字符**（字母/数字与 `_ + # . -`）。否则
 *      ` ```js"onmouseover="alert(1) ` 这种写法会把整串（含引号）当语言名，
 *      虽然转义后不会真的注入，但右上角会显示成一串乱码；
 *   2. 仍然过一遍 escapeHtml，作为纵深防御。
 */
function withLangLabel(html: string, lang: string): string {
  const safe = lang
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_+#.-]/g, "")
    .slice(0, 24);
  if (!safe) return html;
  return html.replace(/<pre\b([^>]*)>/, (whole, attrs: string) =>
    /\bdata-lang=/.test(attrs) ? whole : `<pre${attrs} data-lang="${escapeHtml(safe)}">`,
  );
}

/**
 * 就地渲染：把已消毒 HTML 里的代码块换成 Shiki 高亮结果、把 mermaid 源码块换成 SVG。
 * 必须在 HTML 已经注入 DOM 之后调用，且只操作我们自己生成的节点。
 *
 * `themeId` **必须由调用方显式传入**（用设置里的值）。
 * 不传时会回退到读 `<html data-theme>`，但那个属性是 App 的 effect 里写的，
 * 而 React 的 effect 顺序是子先父后 —— 预览会读到上一个主题，换主题后代码块
 * 沿用旧配色。详见 activeThemeId 的注释。
 */
export async function enhancePreview(root: HTMLElement, themeId?: ThemeId): Promise<void> {
  const id = activeThemeId(themeId);

  // ---- 代码块：按"主题 + 内容指纹"复用高亮结果 ----
  // 键里必须带主题：同一段代码在不同主题下配色不同，
  // 只按内容做键会让换主题后继续复用旧配色。
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre.code-block"));
  await Promise.all(
    blocks.map(async (pre) => {
      const codeEl = pre.querySelector("code");
      if (!codeEl) return;
      const lang = pre.dataset.lang ?? "";
      const source = codeEl.textContent ?? "";
      const fp = `${id}\u0000${pre.dataset.fp ?? fingerprint(`${lang}\u0000${source}`)}`;

      // 已经被上一次增强替换成 Shiki 输出的块，不会再有 pre.code-block，
      // 所以这里只会处理"新出现的"块；命中缓存则直接换回上次的 HTML。
      const cached = codeCache.get(fp);
      if (cached !== undefined) {
        pre.outerHTML = cached;
        return;
      }

      try {
        const html = await highlight(source, lang, id);
        if (html) {
          // 贴上语言标签：预览里在代码块右上角显示（Typora 的做法）。
          // Shiki 的输出里没有语言信息，只能在这里补。
          const labelled = withLangLabel(html, lang);
          codeCache.set(fp, labelled);
          pre.outerHTML = labelled;
          return;
        }
      } catch {
        /* 降级为未高亮的代码块 */
      }
      if (lang) {
        pre.dataset.lang = lang;
        pre.classList.add("no-highlight");
      }
    }),
  );

  // ---- 图表：按"主题 + 内容指纹"复用已渲染的 SVG ----
  const diagrams = Array.from(root.querySelectorAll<HTMLElement>(".mermaid-src"));
  if (diagrams.length === 0) return;

  let mermaid: Awaited<ReturnType<typeof getMermaid>>;
  try {
    // 配色在 getMermaid 内部从主题注册表取 —— 不要在这里读 CSS 变量，
    // 那些变量也是 App 的 effect 之后才更新的，会拿到上一个主题的值。
    mermaid = await getMermaid(id);
  } catch (err) {
    for (const el of diagrams) {
      el.innerHTML = `<div class="mermaid-error">Mermaid 加载失败：${String(err)}</div>`;
    }
    return;
  }

  let seq = 0;
  for (const el of diagrams) {
    const source = el.textContent ?? "";
    const key = `${id}\u0000${el.dataset.fp ?? fingerprint(source)}`;

    const cached = diagramCache.get(key);
    if (cached) {
      // 克隆一份：缓存里的节点要留给后续复用，不能直接被搬走
      el.replaceWith(cached.cloneNode(true));
      continue;
    }

    const wrap = document.createElement("div");
    wrap.className = "mermaid-block";

    try {
      // securityLevel: "strict" 下 mermaid 不会执行脚本，输出可安全插入
      // id 只用序号：性能计时值会带小数点，不是合法 DOM id
      const { svg } = await mermaid.render(`mermaid-${++seq}-${Date.now()}`, source);
      wrap.innerHTML = svg;
      // 无论结果里有没有 <svg>，都把整块存起来——存不下就等于每次都要重画
      diagramCache.set(key, wrap.cloneNode(true) as HTMLElement);
      el.replaceWith(wrap);
    } catch (err) {
      el.className = "mermaid-error";
      el.textContent = `图表渲染失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
