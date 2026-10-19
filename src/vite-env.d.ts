/// <reference types="vite/client" />

/**
 * 构建时由 Vite 注入（见 vite.config.ts 的 `define`）。
 * 值来自 package.json 的 version —— 界面上不要写死版本号，
 * 否则会像以前那样出现"状态栏写着 0.1.0、实际已经是 0.3.0"。
 */
declare const __APP_VERSION__: string;
