/**
 * 处理首页 feed 和视频播放页里的商业广告、官方强插与推广位：
 * 遮挡或直接从页面隐藏。
 *
 * 首页 feed：
 * - 普通投稿在 `.bili-feed-card` 里，链接含 `/video/`；
 * - 商业广告也在 `.bili-feed-card` 里，但点击地址是 `cm.bilibili.com`；
 * - 番剧、国创、综艺、课堂、直播这些官方强插是 `.floor-single-card` /
 *   `.bili-live-card`，没有投稿链接。
 *
 * 视频播放页（2026-11 实测）：
 * - `.ad-report`：右侧广告卡、右下方横幅、简介下方 strip 广告。class 前缀
 *   稳定，是视频页最可靠的广告标记；
 * - `.video-resource-list .activity-m-v1`：简介下方的活动横幅。它没有
 *   `.ad-report`，内部也没有链接，必须单独匹配；
 * - `.video-page-special-card-small`：右侧推荐流里的课程/特殊推广卡。
 * 视频页只在 pathname 以 `/video/` 开头时处理，避免影响其他 www 页面。
 *
 * 「直接隐藏」等价于广告拦截器的元素隐藏规则：节点保留（display: none），
 * 切回其他档位时恢复。首页 feed 是 CSS Grid，视频页广告隐藏后父容器会
 * 自动塌陷，不会留下明显空洞。
 */
import type { CoverColor, FeedAdMode } from "../domain/types";
import { ensureCardCover, removeCardCover, setCardHidden } from "./card-cover";

/** 首页推荐流格子、分区强插格子，以及独立的直播卡。 */
const CARD_SELECTOR = ".bili-feed-card, .floor-single-card, .bili-live-card";

/** 视频播放页的广告容器。 */
const VIDEO_AD_SELECTOR =
  ".ad-report, .video-resource-list .activity-m-v1, .video-page-special-card-small";

/** 监听新增节点时使用的合并选择器（首页 + 视频页）。 */
export const AD_COVER_SELECTOR = `${CARD_SELECTOR}, ${VIDEO_AD_SELECTOR}`;

/** 当前路径是否为视频播放页。 */
export function isVideoPagePath(pathname: string): boolean {
  return pathname.startsWith("/video/");
}

/**
 * 这张首页推荐位是不是强插，而不是普通投稿。
 *
 * 已经有链接，且没有任何一个指向 `/video/`，才处理。
 * 带投稿链接的格子保持原样；没有链接的空壳也不动。
 * display: none 不影响链接查询，隐藏中的卡片仍能正确识别。
 */
export function isForcedFeedCard(card: HTMLElement): boolean {
  if (!card.matches(CARD_SELECTOR)) {
    return false;
  }
  const hrefs = [...card.querySelectorAll("a[href]")].map(
    (anchor) => anchor.getAttribute("href") ?? "",
  );
  if (hrefs.length === 0) {
    return false;
  }
  return hrefs.every((href) => !href.includes("/video/"));
}

/** 按档位处理单个广告元素：遮挡、隐藏或恢复。 */
function applyAdMode(
  element: HTMLElement,
  mode: FeedAdMode,
  color: CoverColor,
): void {
  if (mode === "cover") {
    setCardHidden(element, false);
    ensureCardCover(element, {
      kind: "ad",
      color,
      label: "已遮挡广告/强插",
    });
  } else if (mode === "remove") {
    removeCardCover(element, "ad");
    setCardHidden(element, true);
  } else {
    removeCardCover(element, "ad");
    setCardHidden(element, false);
  }
}

/** 收集 root 自身及后代中匹配选择器的元素。 */
function collectMatches(
  root: ParentNode,
  selector: string,
): HTMLElement[] {
  const elements: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(selector)) {
    elements.push(root);
  }
  elements.push(...root.querySelectorAll<HTMLElement>(selector));
  return elements;
}

/** 首页 feed：只处理「有链接且没有投稿链接」的推荐位。 */
function syncFeedCards(
  root: ParentNode,
  mode: FeedAdMode,
  color: CoverColor,
): void {
  for (const card of collectMatches(root, CARD_SELECTOR)) {
    if (!isForcedFeedCard(card)) {
      removeCardCover(card, "ad");
      continue;
    }
    applyAdMode(card, mode, color);
  }
}

/**
 * 按档位同步广告处理。
 *
 * 首页 feed 始终处理；视频页广告只在 `/video/` 页面处理。视频页的
 * 选择器本身就是广告标记，不再套用首页「必须有链接」的规则——活动横幅
 * 内部可能没有任何链接。
 *
 * @param pathname 当前页面路径，默认取 location.pathname（测试可显式传入）
 */
export function syncAdCovers(
  root: ParentNode,
  mode: FeedAdMode,
  color: CoverColor,
  pathname: string = location.pathname,
): void {
  syncFeedCards(root, mode, color);
  if (!isVideoPagePath(pathname)) {
    return;
  }
  for (const ad of collectMatches(root, VIDEO_AD_SELECTOR)) {
    applyAdMode(ad, mode, color);
  }
}
