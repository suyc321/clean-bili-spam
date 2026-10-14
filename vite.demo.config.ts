/**
 * 演示页构建配置：与扩展构建相互独立，
 * 仅打包 demo/ 目录，产物输出到 dist-demo。
 */
import { defineConfig } from "vite";

export default defineConfig({
  root: "demo",
  build: {
    outDir: "../dist-demo",
    emptyOutDir: true,
  },
});
