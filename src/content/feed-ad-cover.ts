/**
 * 处理首页里的商业广告和官方强插：遮挡或直接隐藏。
 *
 * 普通投稿在 `.bili-feed-card` 里，链接含 `/video/`。
 * 商业广告也在 `.bili-feed-card` 里，但点击地址是 `cm.bilibili.com`，
 * 接口条目是 `goto: "ad"`。
 * 番剧、国创、综艺、课堂、直播这些官方强插是另一套节点
 * `.floor-single-card`，数据来自 `index/ogv/rcmd`、直播分区和
 * `/pugv/app/web/floor/switch`，链接是 `/bangumi/play/`、`live.bilibili.com`
 * 或 `/cheese/play/`，没有投稿链接。
 *
 * 「直接隐藏」等价于广告拦截器的元素隐藏规则：节点保留（display: none），
 * 切回其他档位时恢复。feed 是 CSS Grid，隐藏后自动补位不留空洞。
 */
import type { CoverColor, FeedAdMode } from "../domain/types";
import { ensureCardCover, removeCardCover, setCardHidden } from "./card-cover";

/** 推荐流格子，以及分区强插格子。 */
const CARD_SELECTOR = ".bili-feed-card, .floor-single-card";

/**
 * 这张推荐位是不是强插，而不是普通投稿。
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

/**
 * 按档位同步广告处理：遮挡则补遮罩，隐藏则 display: none，关闭则全部还原。
 * 根节点本身是推荐位时也算。
 */
export function syncFeedAdCovers(
  root: ParentNode,
  mode: FeedAdMode,
  color: CoverColor,
): void {
  const cards: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.matches(CARD_SELECTOR)) {
    cards.push(root);
  }
  cards.push(...root.querySelectorAll<HTMLElement>(CARD_SELECTOR));
  for (const card of cards) {
    if (!isForcedFeedCard(card)) {
      removeCardCover(card, "ad");
      continue;
    }
    if (mode === "cover") {
      setCardHidden(card, false);
      ensureCardCover(card, { kind: "ad", color, label: "已遮挡广告" });
    } else if (mode === "remove") {
      removeCardCover(card, "ad");
      setCardHidden(card, true);
    } else {
      removeCardCover(card, "ad");
      setCardHidden(card, false);
    }
  }
}
