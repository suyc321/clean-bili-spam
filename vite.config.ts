/**
 * Vite 主构建配置：CRXJS 读取 manifest 并自动处理
 * Content Script / Service Worker / 扩展页面的多入口打包。
 */
import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import manifest from "./manifest.config.ts";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    // 不生成 sourcemap：CRXJS 会把 .map 写进 web_accessible_resources，
    // 任何 B 站页面都能探测扩展并读取源码映射。本地调试用 `npm run dev`。
    sourcemap: false
  }
});
