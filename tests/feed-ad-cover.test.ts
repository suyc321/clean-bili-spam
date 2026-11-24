import { afterEach, describe, expect, it } from "vitest";
import {
  isForcedFeedCard,
  syncAdCovers,
} from "../src/content/feed-ad-cover";

function feedCard(className: string, html: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

describe("推荐流强插卡片", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("商业广告推荐位没有投稿链接", () => {
    const element = feedCard(
      "bili-feed-card",
      '<div class="bili-video-card"><a href="//cm.bilibili.com/cm/api/fees/pc/sync/v2?p=ad_card">广告</a></div>',
    );
    expect(isForcedFeedCard(element)).toBe(true);
  });

  it("直播推荐位没有投稿链接", () => {
    const element = feedCard(
      "bili-feed-card",
      '<div class="bili-live-card"><a href="//live.bilibili.com/123">直播</a></div>',
    );
    expect(isForcedFeedCard(element)).toBe(true);
  });

  it("独立直播卡也会被遮挡", () => {
    const live = feedCard(
      "bili-live-card",
      '<a href="https://live.bilibili.com/1000001">直播</a>',
    );
    syncAdCovers(document, "cover", "dark");
    expect(
      live.querySelector('.kcf-card-cover[data-kind="ad"]'),
    ).not.toBeNull();
  });

  it("番剧强插是 floor-single-card，指向番剧播放页", () => {
    const element = feedCard(
      "floor-single-card",
      '<a href="https://www.bilibili.com/bangumi/play/ep819278"><span class="floor-title">番剧</span></a>',
    );
    expect(isForcedFeedCard(element)).toBe(true);
  });

  it("课堂强插指向课堂播放页", () => {
    const element = feedCard(
      "floor-single-card",
      '<a href="https://m.bilibili.com/cheese/play/ss68"><span class="floor-title">课堂</span></a>',
    );
    expect(isForcedFeedCard(element)).toBe(true);
  });

  it("带 /video/ 的投稿不是强插", () => {
    const element = feedCard(
      "bili-feed-card",
      '<a href="https://www.bilibili.com/video/BV1xx411c7mD">视频</a><span>番剧</span>',
    );
    expect(isForcedFeedCard(element)).toBe(false);
  });

  it("没有链接的空壳不是强插，推荐位以外的链接也不算", () => {
    expect(isForcedFeedCard(feedCard("bili-feed-card", ""))).toBe(false);
    const nav = feedCard(
      "channel-link",
      '<a href="//live.bilibili.com">直播</a>',
    );
    expect(isForcedFeedCard(nav)).toBe(false);
  });

  it("遮挡档盖住强插，关闭档拆掉，投稿卡不动", () => {
    const ad = feedCard(
      "bili-feed-card",
      '<a href="https://cm.bilibili.com/cm/api/fees/pc/sync/v2?p=ad_card">广告</a>',
    );
    const live = feedCard(
      "floor-single-card",
      '<a href="https://live.bilibili.com/1000001"><span class="floor-title">直播</span></a>',
    );
    const video = feedCard(
      "bili-feed-card",
      '<a href="https://www.bilibili.com/video/BV1xx411c7mD">视频</a>',
    );

    syncAdCovers(document, "cover", "dark");
    expect(
      ad.querySelector('.kcf-card-cover[data-kind="ad"]')?.shadowRoot
        ?.textContent,
    ).toContain("已遮挡广告/强插");
    expect(live.querySelector('.kcf-card-cover[data-kind="ad"]')).not.toBeNull();
    expect(video.querySelector(".kcf-card-cover")).toBeNull();

    syncAdCovers(document, "cover", "dark");
    expect(ad.querySelectorAll(".kcf-card-cover")).toHaveLength(1);

    syncAdCovers(document, "off", "dark");
    expect(ad.querySelector(".kcf-card-cover")).toBeNull();
    expect(live.querySelector(".kcf-card-cover")).toBeNull();
  });

  it("直接隐藏档把强插设为 display:none，切档后恢复显示", () => {
    const ad = feedCard(
      "bili-feed-card",
      '<a href="https://cm.bilibili.com/cm/api/fees/pc/sync/v2?p=ad_card">广告</a>',
    );
    const video = feedCard(
      "bili-feed-card",
      '<a href="https://www.bilibili.com/video/BV1xx411c7mD">视频</a>',
    );

    syncAdCovers(document, "remove", "dark");
    expect(ad.style.display).toBe("none");
    expect(ad.querySelector(".kcf-card-cover")).toBeNull();
    expect(video.style.display).toBe("");

    // 隐藏中仍能识别链接：切回遮挡档时同一张卡盖上遮罩并恢复显示。
    syncAdCovers(document, "cover", "dark");
    expect(ad.style.display).toBe("");
    expect(ad.querySelector('.kcf-card-cover[data-kind="ad"]')).not.toBeNull();

    syncAdCovers(document, "off", "dark");
    expect(ad.style.display).toBe("");
    expect(ad.querySelector(".kcf-card-cover")).toBeNull();
  });

  it("遮罩颜色写进宿主，换色时重建", () => {
    const ad = feedCard(
      "bili-feed-card",
      '<a href="https://cm.bilibili.com/cm/api/fees/pc/sync/v2?p=ad_card">广告</a>',
    );
    syncAdCovers(document, "cover", "light");
    const host = ad.querySelector<HTMLElement>(".kcf-card-cover");
    expect(host?.dataset.color).toBe("light");

    syncAdCovers(document, "cover", "gray");
    const rebuilt = ad.querySelector<HTMLElement>(".kcf-card-cover");
    expect(rebuilt?.dataset.color).toBe("gray");
    expect(rebuilt).not.toBe(host);
  });

  it("直接同步推荐位本身也能盖上", () => {
    const ad = feedCard(
      "bili-feed-card",
      '<a href="https://cm.bilibili.com/cm/api/fees/pc/sync/v2?p=ad_card">广告</a>',
    );
    syncAdCovers(ad, "cover", "dark");
    expect(ad.querySelector(".kcf-card-cover")).not.toBeNull();
  });
});
