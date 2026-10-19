#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 里摘出指定版本的段落，供 GitHub Release 的正文使用。
 *
 * 用法：node scripts/release-notes.mjs v0.3.0 > notes.md
 *
 * 为什么不用 GitHub 的自动发布说明：那只是把 commit 标题堆起来，
 * 对使用者没有信息量。发布说明应该是"这个版本改了什么、修了什么"，
 * 而这件事在 CHANGELOG 里已经认真写过了。
 *
 * 为什么写成脚本而不是 CI 里的 awk/sed 单行：这段逻辑要能本地测
 * （版本号格式、找不到段落、段落边界都在 `scripts/releaseNotes.test.mjs` 里）。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 标签 `v0.3.0` → `0.3.0`；已经是 `0.3.0` 就原样返回 */
export function normalizeVersion(tag) {
  return String(tag).trim().replace(/^v/i, "");
}

/**
 * 取 `## <version>` 到下一个 `## ` 之间的内容。
 * 找不到返回 null（调用方决定怎么兜底）。
 */
export function extractSection(changelog, version) {
  const ver = normalizeVersion(version);
  const lines = changelog.split("\n");
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^##\\s+v?${escape(ver)}\\s*$`);
  const out = [];
  let inside = false;

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (inside) break; // 到了下一节，收工
      if (heading.test(line)) {
        inside = true;
        continue;
      }
    }
    if (inside) out.push(line);
  }

  if (!inside) return null;
  const body = out.join("\n").trim();
  return body || null;
}

// 直接执行时才读文件、写 stdout；被测试 import 时不执行。
//
// 不能用 `file://${argv[1]}` 拼：Windows 上 argv[1] 是 `D:\x\y.mjs`，
// 拼出来是 `file://D:/x/y.mjs`，而 import.meta.url 是 `file:///D:/x/y.mjs`
// （三个斜杠）—— 两者永远不相等，脚本会静默什么都不做。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("用法：node scripts/release-notes.mjs <tag>");
    process.exit(2);
  }
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const section = extractSection(changelog, tag);
  if (section) {
    process.stdout.write(`${section}\n`);
  } else {
    // 兜底：宁可给一句实话，也不要空正文
    process.stdout.write(
      `本版本（${normalizeVersion(tag)}）的改动请见 [CHANGELOG](../blob/main/CHANGELOG.md)。\n`,
    );
  }
}
