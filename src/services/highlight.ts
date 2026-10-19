import { createHighlighter, bundledLanguages, type Highlighter } from "shiki";
import { normalizeTheme, themeDef, type ThemeId } from "./themes";

let highlighterPromise: Promise<Highlighter> | null = null;
/** 已经 loadTheme 过的 Shiki 主题，避免重复加载 */
const loadedThemes = new Set<string>();
const loaded = new Set<string>();

/** 首屏只预载最常见的语言，其余按需加载，避免拖慢启动 */
const PRELOAD = ["javascript", "typescript", "json", "bash", "html", "css", "markdown", "python"];

/**
 * 高亮初始化失败时只提示一次。
 *
 * 为什么要提示：Shiki 依赖 WASM，而**打包后的 CSP 会拦掉 WebAssembly 编译**
 * （`script-src` 少了 `'wasm-unsafe-eval'`）。这种失败在开发模式下不会出现
 * （dev 走外部开发服务器，CSP 不生效），只在安装包里表现为"代码全无高亮"，
 * 而且以前只写进 console —— 用户看不到，只能看到"没高亮"这个结果。
 */
let warned = false;
function warnOnce(reason: unknown): void {
  if (warned) return;
  warned = true;
  const detail = reason instanceof Error ? reason.message : String(reason);
  console.error("[highlight] 语法高亮不可用，已降级为纯文本：", detail);
  void import("../store/ui")
    .then(({ useUi }) => {
      useUi
        .getState()
        .toast(
          `语法高亮不可用，代码按纯文本显示。原因：${detail}\n（打包版常见原因：CSP 缺少 'wasm-unsafe-eval'）`,
        );
    })
    .catch(() => undefined);
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createWithFallback().catch((err) => {
      highlighterPromise = null;
      warnOnce(err);
      throw err;
    });
  }
  return highlighterPromise;
}

/**
 * 建高亮器：默认用 oniguruma（WASM，快、语法支持全）；
 * **WASM 不可用时退到纯 JS 正则引擎**。
 *
 * 为什么要兜底：CSP 的 `script-src` 少了 `'wasm-unsafe-eval'` 时，
 * `WebAssembly.instantiate` 会被直接拦掉，oniguruma 引擎整个起不来。
 * 那种情况下与其"代码全无高亮"，不如退到 JS 引擎——慢一些、语法覆盖少一些，
 * 但至少颜色还在。CSP 已放开 WASM，这层兜底用于应对更严格的环境
 * （企业策略、未来的 CSP 调整）。
 */
async function createWithFallback(): Promise<Highlighter> {
  const initial = themeDef(normalizeTheme(undefined)).shiki;
  try {
    return await createHighlighter({
      themes: [initial],
      langs: PRELOAD,
    });
  } catch (wasmErr) {
    try {
      const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
      const hl = await createHighlighter({
        themes: [initial],
        langs: PRELOAD,
        engine: createJavaScriptRegexEngine(),
      });
      console.warn("[highlight] WASM 引擎不可用，已改用 JS 正则引擎", wasmErr);
      return hl;
    } catch {
      // JS 引擎也不行 → 把原始错误抛出去，让调用方报错
      throw wasmErr;
    }
  }
}

function resolveLang(lang: string): string {
  const l = lang.trim().toLowerCase();
  if (!l) return "text";
  if (l in bundledLanguages) return l;
  const alias: Record<string, string> = {
    js: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    console: "bash",
    py: "python",
    yml: "yaml",
    rs: "rust",
    golang: "go",
    "c++": "cpp",
    "c#": "csharp",
    cs: "csharp",
    kt: "kotlin",
    text: "text",
    txt: "text",
    plain: "text",
  };
  const mapped = alias[l];
  if (mapped && mapped in bundledLanguages) return mapped;
  return "text";
}

/**
 * 用**当前主题对应的 Shiki 主题**高亮代码。
 *
 * 为什么不再用"浅深双主题 + CSS 变量切换"：那套只在"明暗两态"下成立。
 * 现在有 12 套主题（GitHub / Dracula / Nord / Solarized…），每套都有各自的
 * token 配色，只能按主题各出一份高亮结果——所以预览缓存里也把主题算进键。
 */
export async function highlight(
  code: string,
  lang: string,
  themeId?: ThemeId,
): Promise<string> {
  const id = resolveLang(lang);
  try {
    const def = themeDef(normalizeTheme(themeId));
    const hl = await getHighlighter();
    if (id !== "text" && !loaded.has(id)) {
      if (id in bundledLanguages) {
        await hl.loadLanguage(id as never);
        loaded.add(id);
      } else {
        return "";
      }
    }
    if (!loadedThemes.has(def.shiki)) {
      await hl.loadTheme(def.shiki as never);
      loadedThemes.add(def.shiki);
    }
    return hl.codeToHtml(code, {
      lang: id,
      theme: def.shiki,
      // 修正官方配色里在浅底上过淡的 token 色（保持色相、只调亮度）。
      // 表里的色值都经过测试校验：不得是背景色，否则会把 background-color 一起改坏。
      ...(def.codeColorFixes ? { colorReplacements: def.codeColorFixes } : {}),
    });
  } catch (err) {
    warnOnce(err);
    return "";
  }
}

/** 预览区首次渲染前预热，避免第一眼看到未高亮的代码块 */
export function warmupHighlighter(): void {
  void getHighlighter().catch(() => undefined);
}
