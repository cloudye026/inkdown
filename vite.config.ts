import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;
// 1420 是 Tauri 模板默认端口，但这台机器上被系统策略占用（listen 直接 EACCES），
// 因此换成 5199；tauri.conf.json 的 devUrl 必须与这里保持一致。
const port = Number(process.env.TAURI_DEV_PORT ?? 5199);

/**
 * 版本号只有一个来源：package.json。
 *
 * 原来状态栏里是**硬编码**的 `MDDeveloper 0.1.0`，版本已经到 0.3.0 了它还写着 0.1.0
 * ——界面上显示了一个错误的事实。这里由 Vite 在构建时把 package.json 的 version
 * 注入成 `__APP_VERSION__`，从根上避免再对不上。
 */
const version: string = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(version),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
