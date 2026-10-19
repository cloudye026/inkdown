// 测试专用解析钩子。
//
// 项目源码按 bundler 约定写无扩展名导入（`from "./mdcore"`），Vite/tsc 都能解析，
// 但 Node 的 ESM 解析器要求显式扩展名。这里把无扩展名的相对导入补成 .ts，
// 避免为了跑测试而给生产代码到处加 `.ts` 后缀。
//
// 用法: node --import ./scripts/ts-resolve.mjs --test "scripts/*.test.mjs"

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL("./scripts/ts-resolve-hooks.mjs"));
