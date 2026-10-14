/**
 * Vitest 测试配置：jsdom 环境模拟 DOM，
 * setup.ts 引入 fake-indexeddb 模拟 IndexedDB。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      enabled: false
    }
  }
});
