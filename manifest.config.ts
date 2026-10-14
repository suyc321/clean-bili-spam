/**
 * 扩展 manifest 配置：权限、页面范围与各入口声明。
 *
 * 隐私边界（verify-build.mjs 会自动断言）：
 * - 权限仅 storage，不申请 host_permissions；
 * - 内容脚本只注入 B 站三个域名。
 */
import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

/** 插件图标清单（public/icons 下的 PNG，源文件见 assets/branding/icon.svg 与 icon-16.svg）。 */
const ICONS = {
  "16": "icons/icon-16.png",
  "32": "icons/icon-32.png",
  "48": "icons/icon-48.png",
  "128": "icons/icon-128.png",
};

export default defineManifest({
  manifest_version: 3,
  name: "B站内容净化助手",
  // 版本号只在 package.json 维护一份。
  version: pkg.version,
  description: "在 B 站网页上提示值得复核的账号，并由你配置的 AI 给出概率；是否处理由你决定。",
  icons: ICONS,
  permissions: ["storage"],
  /**
   * 可选主机权限：仅服务于用户自配的 AI 判定接口（BYOK）。
   * 安装时不授予任何域名；用户在设置页开启 AI 并保存时，
   * 才会通过 chrome.permissions.request 按其填写的域名逐个请求授权。
   */
  optional_host_permissions: ["https://*/*"],
  /**
   * 可选权限：读取 bili_jct（CSRF）cookie。
   * B 站把它设成 HttpOnly，document.cookie 读不到，而拉黑接口必须带它。
   * 安装时不授予；用户首次点「拉黑」时随接口授权一起申请。
   */
  optional_permissions: ["cookies"],
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: [
        "https://www.bilibili.com/*",
        "https://search.bilibili.com/*",
        "https://space.bilibili.com/*",
      ],
      js: ["src/content/content-script.ts"],
      // document_start：推荐流格子一插入就能盖，不必等页面空闲。
      run_at: "document_start",
    },
  ],
  action: {
    default_title: "B站内容净化助手",
    default_popup: "popup.html",
    default_icon: ICONS,
  },
  options_page: "options.html",
});
