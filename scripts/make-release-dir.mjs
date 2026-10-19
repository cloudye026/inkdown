// 整理一份「可直接拖到 GitHub Release 里」的本地发布包。
//
// 用途：CI 还没跑通、或者想手动传的时候，把 Windows 的三个安装包 + 校验和 + 发布说明
// 放在 dist-release/ 里，网页上直接拖进去即可。
// 目录写进 .gitignore —— 它是构建产物，不该进仓库。
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

const OUT = "dist-release";
const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;

const SOURCES = [
  "src-tauri/target/release/bundle/nsis/Inkdown_" + VERSION + "_x64-setup.exe",
  "src-tauri/target/release/bundle/msi/Inkdown_" + VERSION + "_x64_en-US.msi",
  "src-tauri/target/release/Inkdown.exe",
];

mkdirSync(OUT, { recursive: true });

const copied = [];
for (const src of SOURCES) {
  try {
    const dest = join(OUT, basename(src));
    copyFileSync(src, dest);
    copied.push(dest);
  } catch {
    console.warn(`  跳过（不存在）：${src}`);
  }
}

if (copied.length === 0) {
  console.error("没有可发布的文件，先跑一次 npm run app:build");
  process.exit(1);
}

const sums = copied.map((f) => {
  const hash = createHash("sha256").update(readFileSync(f)).digest("hex");
  return `${hash}  ${basename(f)}`;
});
writeFileSync(join(OUT, "SHA256SUMS.txt"), sums.join("\n") + "\n", "utf8");

// 发布说明：直接复用 CI 用的那段逻辑，保证两边一致
const notes = execFileSync(process.execPath, ["scripts/release-notes.mjs", `v${VERSION}`], {
  encoding: "utf8",
});
writeFileSync(join(OUT, "RELEASE_NOTES.md"), notes, "utf8");

console.log(`  ${OUT}/ 已就绪（版本 ${VERSION}）：`);
for (const f of readdirSync(OUT)) {
  const kb = Math.round(statSync(join(OUT, f)).size / 1024);
  console.log(`    ${f.padEnd(38)} ${String(kb).padStart(6)} KB`);
}
console.log("");
console.log("  手动发布：在 GitHub 建一个 v" + VERSION + " 的 Release，" +
  "把上面这些文件拖进去（SHA256SUMS.txt 与 RELEASE_NOTES.md 也一起传）。");
