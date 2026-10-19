import { dirname, basename } from "./fs";

/** 预览区用到的样式，导出时内联进去，保证单文件 HTML 自包含 */
import previewCss from "../styles/preview.css?inline";
import katexCss from "katex/dist/katex.min.css?inline";
import githubCss from "github-markdown-css/github-markdown.css?inline";

export interface ExportableDoc {
  path: string;
  name: string;
  text: string;
}

/**
 * 在离屏容器里走一遍真实渲染管线（marked → 消毒 → Shiki → Mermaid），
 * 再连同样式一起导出，避免"导出结果和预览长得不一样"。
 */
export async function renderToStandaloneHtml(doc: ExportableDoc): Promise<string> {
  const { renderMarkdown } = await import("./markdown");
  const { enhancePreview } = await import("./previewRender");

  const holder = document.createElement("div");
  holder.style.position = "fixed";
  holder.style.left = "-10000px";
  holder.style.top = "0";
  holder.style.width = "820px";
  holder.className = "markdown-body";
  document.body.appendChild(holder);

  try {
    const { html } = renderMarkdown(doc.text, {
      docDir: dirname(doc.path),
      breakOnSingleNewline: true,
    });
    holder.innerHTML = html;
    await enhancePreview(holder);
    await new Promise((r) => requestAnimationFrame(r));

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(doc.name)}</title>
<style>
${katexCss}
${githubCss}
${previewCss}
/* Shiki 双主题：导出时固定用暗色变量，保证在任何阅读器里有颜色 */
.shiki, .shiki span {
  color: var(--shiki-dark, var(--shiki)) !important;
  background-color: var(--shiki-dark-bg, var(--shiki-bg)) !important;
}
.markdown-body .shiki {
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 12px 14px;
  overflow: auto;
  background-color: #f6f8fa !important;
}
body {
  --fg: #1f2328;
  --preview-size: 16px;
  --preview-line-height: 1.85;
  --preview-font: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  margin: 0;
  padding: 36px 16px 90px;
  background: #ffffff;
}
.markdown-body { max-width: 46em; margin: 0 auto; }
</style>
</head>
<body>
<article class="markdown-body">
${holder.innerHTML}
</article>
</body>
</html>`;
  } finally {
    holder.remove();
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export async function exportHtml(doc: ExportableDoc): Promise<string | null> {
  const { pickSavePath, fs } = await import("./fs");
  const defaultName = basename(doc.path).replace(/\.(md|markdown|mdown|mkd|mdx)$/i, ".html");
  const target = await pickSavePath(defaultName);
  if (!target) return null;
  const html = await renderToStandaloneHtml(doc);
  await fs.write(target, html, { encoding: "UTF-8", bom: false, eol: null });
  return target;
}

/** 导出到临时目录并用系统浏览器打开——比自研打印预览省事且效果一致 */
export async function previewInBrowser(doc: ExportableDoc): Promise<void> {
  const { openExternal, fs } = await import("./fs");
  const { tempDir } = await import("@tauri-apps/api/path");
  const html = await renderToStandaloneHtml(doc);
  const dir = (await tempDir()).replace(/[\\/]$/, "");
  const target = `${dir}\\inkdown-preview-${Date.now()}.html`;
  await fs.write(target, html, { encoding: "UTF-8", bom: false, eol: null });
  await openExternal(`file://${target.replace(/\\/g, "/")}`);
}
