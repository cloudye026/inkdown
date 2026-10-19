// 检查 README 里有没有"依赖 markdown 解析、却落在原始 HTML 块里"的语法。
//
// 为什么在意：GitHub 对 raw HTML **块**内部的内容不做 markdown 处理，
// 于是 `<div align="center">` 里的 `# 标题` 或 `[链接](x)` 会原样显示成文字。
import { readFileSync } from "node:fs";

const lines = readFileSync("README.md", "utf8").split("\n");

/** 这些标签一旦单独成行出现，就开始一个 HTML 块 */
const BLOCK_OPEN = /^<(div|p|h[1-6]|table|figure|details)\b/gi;
/** 同一行里可能既开又闭（`<p>…</p>`），所以按行统计净值 */
function netBlocks(line) {
  // 注意：正则**必须带 g**。不带的 `match` 返回 [整串, 捕获组, …]，
  // 长度是 2 而不是 1 —— 我第一版就是这么把每个开标签数成两个的。
  const opens = (line.match(BLOCK_OPEN) || []).length;
  const closes = (line.match(/^<\/(div|p|h[1-6]|table|figure|details)>|<\/(p|h1|h2|h3|h4)>/gi) || [])
    .length;
  return opens - closes;
}

let depth = 0;
let issues = 0;
lines.forEach((raw, i) => {
  const line = raw.trim();
  const startDepth = depth;
  depth = Math.max(0, depth + netBlocks(line));

  if (startDepth > 0) {
    if (/^#{1,6}\s/.test(line)) {
      console.log(`  ✖ 行 ${i + 1}：HTML 块里的 markdown 标题 → ${line.slice(0, 50)}`);
      issues++;
    }
    if (/^\[[^\]]+\]\([^)]+\)/.test(line)) {
      console.log(`  ✖ 行 ${i + 1}：HTML 块里的 markdown 链接 → ${line.slice(0, 50)}`);
      issues++;
    }
    if (/^\s*[-*+]\s/.test(raw) && !/^<(ul|ol|li)/i.test(line)) {
      console.log(`  ✖ 行 ${i + 1}：HTML 块里的 markdown 列表 → ${line.slice(0, 50)}`);
      issues++;
    }
  }
});

console.log(issues === 0 ? "  ✔ 没有依赖 markdown 解析的语法落在 HTML 块里" : `  共 ${issues} 处需要改成 HTML`);
process.exit(issues === 0 ? 0 : 1);
