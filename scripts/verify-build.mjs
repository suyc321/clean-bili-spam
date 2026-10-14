/**
 * 构建产物自检：每次构建后校验 dist/ 是否符合隐私与结构承诺。
 *
 * 断言项：
 * - 权限严格为 storage，且无 host_permissions；
 * - 内容脚本域名范围未被扩大；
 * - Service Worker 与 Content Script 是两个独立入口，没有互相混入；
 * - popup.html / options.html 存在；
 * - 设置页 select 的深色背景没有用 background 简写（会把箭头平铺满下拉框）。
 * 任何一项失败即抛错，npm run verify 链路随之中断。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(projectRoot, "dist");
const manifestPath = resolve(distRoot, "manifest.json");

assert(existsSync(manifestPath), "缺少 dist/manifest.json，请先运行构建。");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert(manifest.manifest_version === 3, "构建产物必须使用 Manifest V3。");
// 权限承诺：必需权限只允许 storage，防止依赖升级悄悄引入新权限。
assert(
  JSON.stringify(manifest.permissions) === JSON.stringify(["storage"]),
  "MVP 权限必须严格限制为 storage。",
);
assert(
  manifest.host_permissions === undefined ||
    manifest.host_permissions.length === 0,
  "不应声明必需的 host_permissions。",
);
// 可选主机权限：只允许通配 https 声明（供用户自选 AI 接口域名时
// 运行时逐个授权），且安装时默认不授予任何域名。
const optionalHosts = manifest.optional_host_permissions ?? [];
assert(
  optionalHosts.length === 0 ||
    (optionalHosts.length === 1 && optionalHosts[0] === "https://*/*"),
  "optional_host_permissions 只允许声明 https://*/*。",
);

// 域名承诺：内容脚本只允许注入 B 站三个域名。
const expectedMatches = [
  "https://www.bilibili.com/*",
  "https://search.bilibili.com/*",
  "https://space.bilibili.com/*",
].sort();
const contentScripts = manifest.content_scripts;
assert(
  Array.isArray(contentScripts) && contentScripts.length === 1,
  "必须且只能生成一个静态内容脚本声明。",
);
assert(
  JSON.stringify([...contentScripts[0].matches].sort()) ===
    JSON.stringify(expectedMatches),
  "内容脚本域名范围发生了意外变化。",
);

// CRXJS 会为两个入口生成 loader 文件，先解析 loader 再定位真实 bundle。
const workerLoaderRelative = manifest.background?.service_worker;
const contentLoaderRelative = contentScripts[0]?.js?.[0];
assert(
  typeof workerLoaderRelative === "string",
  "manifest 缺少后台 Service Worker。",
);
assert(
  typeof contentLoaderRelative === "string",
  "manifest 缺少 Content Script。",
);

const workerLoaderPath = resolveArtifact(workerLoaderRelative);
const contentLoaderPath = resolveArtifact(contentLoaderRelative);
const workerLoader = readFileSync(workerLoaderPath, "utf8");
const contentLoader = readFileSync(contentLoaderPath, "utf8");
const workerTargetRelative = capture(
  workerLoader,
  /import\s*["'](.+?\.js)["']/u,
  "无法从 Service Worker loader 解析实际入口。",
);
const contentTargetRelative = capture(
  contentLoader,
  /chrome\.runtime\.getURL\(["'](.+?\.js)["']\)/u,
  "无法从 Content Script loader 解析实际入口。",
);
const workerTargetPath = resolveArtifact(workerTargetRelative);
const contentTargetPath = resolveArtifact(contentTargetRelative);

assert(
  workerTargetPath !== contentTargetPath,
  "Service Worker 与 Content Script 错误地指向同一 bundle。",
);

// 入口隔离检查：SW 不得混入 MutationObserver（页面逻辑），
// Content Script 不得混入 onInstalled（后台逻辑）。
const workerBundle = readFileSync(workerTargetPath, "utf8");
const contentBundle = readFileSync(contentTargetPath, "utf8");
assert(
  workerBundle.includes("onInstalled"),
  "Service Worker bundle 缺少后台安装监听器。",
);
assert(
  !workerBundle.includes("MutationObserver"),
  "Service Worker bundle 疑似混入 Content Script 代码。",
);
assert(
  contentBundle.includes("MutationObserver"),
  "Content Script bundle 缺少页面变化观察逻辑。",
);
assert(
  !contentBundle.includes("onInstalled"),
  "Content Script bundle 疑似混入 Service Worker 代码。",
);
// 内容脚本可用的 chrome API 是一个受限子集：只有 runtime 的少数方法、
// storage、i18n。chrome.tabs / chrome.permissions / chrome.cookies 都不存在，
// 调到的就是一个 undefined，点击类按钮表现为「没反应 + 控制台一条 TypeError」。
// 这三者的检查逻辑都已挪到 SW，这里守住「别再写回来」。
// （生产构建会剥掉注释，因此 bundle 里的 chrome.tabs 只会来自真实调用。）
for (const unavailable of ["chrome.tabs", "chrome.permissions", "chrome.cookies"]) {
  assert(
    !contentBundle.includes(unavailable),
    `Content Script bundle 里出现了 ${unavailable}——内容脚本没有这个 API，` +
      "请改为发消息给 Service Worker 执行。",
  );
}

for (const uiPage of ["popup.html", "options.html"]) {
  assert(existsSync(resolveArtifact(uiPage)), `缺少 ${uiPage}。`);
}

checkSelectDarkBackground();

console.log(
  [
    "构建产物自检通过",
    `权限: ${manifest.permissions.join(", ")}`,
    `Service Worker: ${relativeToDist(workerTargetPath)}`,
    `Content Script: ${relativeToDist(contentTargetPath)}`,
  ].join("\n"),
);

/**
 * 设置页 select 的深色背景回归守卫。
 *
 * 背景（真实缺陷）：深色模式里 `.field select` 的覆盖规则曾写成
 * `background: #17181c`。`background` 是简写，一写下去就把
 * background-image 置为 none、background-repeat 置为 repeat、
 * background-position 置为 0% 0%；紧随其后补回箭头的那条规则只覆盖
 * image，repeat 与 position 留着不回——箭头 SVG 于是平铺满整个下拉框，
 * 深色模式下糊成一片斜纹，选项文字被压在底下。
 *
 * jsdom 不做真实样式计算、单测也摸不到 CSS，因此在这里直接查发布的产物：
 * 从 options.html 找到它引用的样式表，再断言深色块里没有这条简写。
 */
function checkSelectDarkBackground() {
  const optionsHtml = readFileSync(resolveArtifact("options.html"), "utf8");
  const cssHref = capture(
    optionsHtml,
    /<link[^>]+rel="stylesheet"[^>]+href="([^"]+\.css)"/u,
    "无法从 options.html 解析样式表地址。",
  );
  const css = readFileSync(
    resolveArtifact(cssHref.replace(/^\//u, "")),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  // 产物是压缩过的：`prefers-color-scheme: dark` 会被压成 `:dark`，
  // 因此不能用字面量查找，得容忍空白差异。
  const mediaMatch = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/u.exec(css);
  assert(
    mediaMatch !== null,
    "设置页样式表缺少深色模式块，选择器深色背景无从校验。",
  );
  const darkBlock = balancedBlock(css, mediaMatch.index);

  // 把深色块拆成「选择器 + 声明体」。样式表没有嵌套规则，按 } 切分即可。
  const shorthand = /(?:^|[;{\s])background\s*:/;
  for (const chunk of darkBlock.split("}")) {
    const open = chunk.indexOf("{");
    if (open === -1) continue;
    const selectors = chunk
      .slice(0, open)
      .split(",")
      .map((part) => part.trim());
    if (!selectors.includes(".field select")) continue;
    const body = chunk.slice(open + 1);
    assert(
      !shorthand.test(body),
      `深色模式里 ${selectors.join(" / ")} 用了 background 简写，` +
        "会重置 background-repeat 与 background-position，使箭头 SVG 平铺满下拉框。",
    );
  }
}

/** 从某个位置的下一个 { 开始，按花括号配平取出整块正文。 */
function balancedBlock(source, from) {
  const open = source.indexOf("{", from);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error("花括号没有闭合。");
}

/** 校验产物路径未越出 dist 目录且文件存在。 */
function resolveArtifact(relativePath) {
  const absolutePath = resolve(distRoot, relativePath);
  const pathFromDist = relative(distRoot, absolutePath);
  assert(
    !pathFromDist.startsWith("..") && !isAbsolute(pathFromDist),
    `构建产物路径越界：${relativePath}`,
  );
  assert(existsSync(absolutePath), `构建产物不存在：${relativePath}`);
  return absolutePath;
}

function relativeToDist(absolutePath) {
  return relative(distRoot, absolutePath).replaceAll("\\", "/");
}

/** 从文本中按正则提取第一个捕获组，失败即断言中止。 */
function capture(value, pattern, failureMessage) {
  const match = pattern.exec(value);
  assert(match?.[1] !== undefined, failureMessage);
  return match[1];
}

/** 断言工具：条件不成立时抛出带说明的错误。 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
