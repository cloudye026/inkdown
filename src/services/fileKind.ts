/**
 * 按文件名判断该在文件树里画哪种图标。
 *
 * 单独抽成纯函数（不碰 DOM、不碰 React）是为了能单测：扩展名表最容易写错，
 * 而错了的表现只是"图标长得不对"，很难在界面上一眼发现。
 */

export type FileKind =
  | "markdown"
  | "image"
  | "code"
  | "data"
  | "text"
  | "other";

const BY_EXT: Record<string, FileKind> = {};

function put(kind: FileKind, exts: string): void {
  for (const e of exts.split(/\s+/).filter(Boolean)) BY_EXT[e] = kind;
}

put("markdown", "md markdown mdown mkd mdwn mdx");
put("image", "png jpg jpeg gif webp avif bmp ico tif tiff svg");
put(
  "code",
  // 脚本与编译型语言
  "ts tsx mts cts js jsx mjs cjs rs py pyi go java kt kts scala rb php " +
    "c h cc cpp cxx hpp hh cs swift lua dart ex exs erl hs ml clj fs " +
    // 标记与样式
    "css scss sass less styl html htm xhtml vue svelte astro " +
    // shell 与其它
    "sh bash zsh fish ps1 bat cmd sql graphql gql proto",
);
put("data", "json jsonc json5 yaml yml toml ini cfg conf env csv tsv properties lock plist");
put("text", "txt log rst adoc org tex");

const KNOWN_NAMES: Record<string, FileKind> = {
  dockerfile: "code",
  makefile: "code",
  "cmakelists.txt": "code",
  gemfile: "code",
  rakefile: "code",
  procfile: "code",
  readme: "markdown",
  license: "text",
  licence: "text",
  changelog: "markdown",
};

/** 取小写扩展名（不含点）；没有扩展名返回空串 */
export function extOf(name: string): string {
  const base = name.replace(/^.*[\\/]/, "");
  // `.gitignore` 这种以点开头的名字，点在最前面不算扩展名
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function fileKind(name: string): FileKind {
  const base = name.replace(/^.*[\\/]/, "").toLowerCase();
  if (!base) return "other";

  // 先按"完整名字"匹配（Dockerfile / Makefile 这类没有扩展名的）
  if (KNOWN_NAMES[base]) return KNOWN_NAMES[base]!;
  // README.md / LICENSE.txt 这类：主名命中已知名字也认
  const stem = base.replace(/\.[^.]+$/, "");
  if (KNOWN_NAMES[stem]) return KNOWN_NAMES[stem]!;

  const ext = extOf(base);
  if (ext && BY_EXT[ext]) return BY_EXT[ext]!;

  // 没有扩展名的点文件当配置（.gitignore / .editorconfig）
  if (base.startsWith(".")) return "data";
  return "other";
}

/**
 * 文件树里画在名字左边的图标种类。
 *
 * 文件夹按**展开状态**换图标（收起=合上的文件夹，展开=打开的文件夹），
 * 这样"哪些还能展开"不用靠猜。
 */
export type TreeIconKind =
  | "folder"
  | "folder-open"
  | "markdown"
  | "image"
  | "code"
  | "data"
  | "text"
  | "file";

export function treeIconKind(name: string, isDir: boolean, expanded?: boolean): TreeIconKind {
  if (isDir) return expanded ? "folder-open" : "folder";
  const kind = fileKind(name);
  return kind === "other" ? "file" : kind;
}
