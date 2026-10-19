// ts-resolve.mjs 实际注册的钩子实现。
//
// 两件事：
//   1) 无扩展名的相对导入补成 .ts（项目按 bundler 约定写 import，Node 要求显式扩展名）
//   2) 用 esbuild 转译 .ts / .tsx —— Node 原生只剥离类型，不处理 JSX，
//      所以 .tsx 组件必须转译才能被测试直接 import

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    for (const ext of [".ts", ".tsx"]) {
      try {
        return await nextResolve(`${specifier}${ext}`, context);
      } catch {
        // 继续试下一个扩展名
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const path = fileURLToPath(url);
    if (!existsSync(path)) throw new Error(`找不到文件: ${path}`);
    const source = readFileSync(path, "utf8");
    const { code } = transformSync(source, {
      loader: url.endsWith(".tsx") ? "tsx" : "ts",
      jsx: "automatic",
      format: "esm",
      target: "node22",
      sourcefile: path,
      // 源码里没有装饰器/emitDecoratorMetadata 需求，保持默认即可
    });
    return { format: "module", source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
