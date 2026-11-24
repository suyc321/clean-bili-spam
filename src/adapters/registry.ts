/**
 * 适配器注册表：按 URL 匹配选择当前页面应使用的适配器。
 *
 * 新增页面支持时在这里注册新适配器即可，扫描与渲染逻辑无需改动。
 */
import type { AdapterScanResult, PageAdapter } from "./contract";
import { createCardAdapter } from "./bilibili/create-card-scan";

/** 首页适配器只处理首页推荐流，不接管视频页/番剧页/专栏页等其他 www 路径。 */
const HOME_PATHS = new Set(["/", "/index.html"]);

/** 全部已注册适配器；顺序即匹配优先级（先注册先匹配）。 */
const adapters: PageAdapter[] = [
  // UP 主主页：直接信任页面地址中的 UID，可读取昵称与签名。
  createCardAdapter({
    id: "bilibili-space-v1",
    version: 1,
    pageKind: "space",
    matches: (url) => url.hostname === "space.bilibili.com",
    allowSpacePageFallback: true,
  }),
  // 搜索结果页：卡片缺少作者链接时，可向上在搜索模块内查找。
  createCardAdapter({
    id: "bilibili-search-v1",
    version: 1,
    pageKind: "search",
    matches: (url) => url.hostname === "search.bilibili.com",
    allowSearchModuleFallback: true,
  }),
  // 首页/推荐页：只信任卡片内部的作者链接，防止顶部登录用户污染。
  // 必须限定路径：视频页的相关推荐也用 .bili-video-card，套用首页适配器
  // 会把它们当成首页观察入库，并在弹出页误报「适配降级」。
  createCardAdapter({
    id: "bilibili-home-v1",
    version: 1,
    pageKind: "home",
    matches: (url) =>
      url.hostname === "www.bilibili.com" && HOME_PATHS.has(url.pathname),
  }),
];

/**
 * 扫描当前页面。
 * @param candidateCards 增量扫描的候选卡片；省略时全量扫描
 * @returns 匹配适配器的扫描结果；无匹配时返回 unsupported 且不带任何卡片
 */
export function scanCurrentPage(
  document: Document,
  url: URL,
  nowMs = Date.now(),
  candidateCards?: Iterable<Element>,
): AdapterScanResult {
  const adapter = adapters.find((candidate) =>
    candidate.matches(url, document),
  );
  if (adapter === undefined) {
    return {
      adapterId: "unsupported",
      adapterVersion: 1,
      pageKind: "home",
      health: "unsupported",
      cards: [],
      diagnostics: [
        {
          selectorKey: "page-adapter",
          status: "missing",
        },
      ],
    };
  }
  return adapter.scan(document, url, nowMs, candidateCards);
}

/** 返回已注册适配器列表的只读视图（供诊断与测试使用）。 */
export function getRegisteredAdapters(): readonly PageAdapter[] {
  return adapters;
}
