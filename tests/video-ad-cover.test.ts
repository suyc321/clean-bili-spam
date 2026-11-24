// 视频播放页广告：用 2026-11 真实页面抓到的 DOM 结构做脱敏夹具。
// 关键点：
// - .ad-report 覆盖右侧广告卡、右下横幅、简介下方 strip 广告；
// - 活动横幅 .video-resource-list .activity-m-v1 没有链接，必须单独匹配；
// - .video-page-special-card-small 是右侧课程/特殊推广卡；
// - 只在 /video/ 路径处理，避免影响其他 www 页面。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isVideoPagePath,
  syncAdCovers,
} from "../src/content/feed-ad-cover";

const VIDEO_PATH = "/video/BV1xx411c7xx/";

function coverOf(element: HTMLElement): Element | null {
  return element.querySelector('.kcf-card-cover[data-kind="ad"]');
}

function mountAdFixture(): {
  adReports: HTMLElement[];
  activity: HTMLElement;
  special: HTMLElement;
  normal: HTMLElement;
} {
  document.body.innerHTML = `
    <div class="ad-report ad-floor-exp right-bottom-banner">
      <a href="https://www.bilibili.com/blackboard/era/example.html">右下横幅</a>
    </div>
    <div class="ad-report strip-ad left-banner">
      <a href="https://cm.bilibili.com/cm/api/fees/pc/sync/v2">strip 广告</a>
    </div>
    <div class="ad-report">
      <a href="https://cm.bilibili.com/cm/api/fees/pc/sync/v2">右侧广告卡</a>
    </div>

    <div class="video-resource-list">
      <div class="video-resource-list__item">
        <div class="activity-m-v1 act-now">
          <div class="inside-wrp">
            <div class="left"><b>来分享你的兴趣人生经营日志吧！</b></div>
            <div class="right"><div class="inside-bg clickable">活动图</div></div>
          </div>
        </div>
      </div>
    </div>

    <div class="recommend-list-v1">
      <div class="rec-list">
        <div class="video-page-special-card-small">
          <div class="card-box">
            <a href="https://www.bilibili.com/cheese/play/ss30644525">课程推广</a>
          </div>
        </div>
        <div class="video-page-card-small">
          <a href="https://www.bilibili.com/video/BV1normal">普通推荐</a>
        </div>
      </div>
    </div>
  `;
  return {
    adReports: [
      ...document.querySelectorAll<HTMLElement>(".ad-report"),
    ],
    activity: document.querySelector<HTMLElement>(".activity-m-v1")!,
    special: document.querySelector<HTMLElement>(
      ".video-page-special-card-small",
    )!,
    normal: document.querySelector<HTMLElement>(".video-page-card-small")!,
  };
}

describe("视频播放页广告", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("只把 /video/ 路径视为视频播放页", () => {
    expect(isVideoPagePath("/video/BV1xx411c7xx/")).toBe(true);
    expect(isVideoPagePath("/video/BV1xx411c7xx")).toBe(true);
    expect(isVideoPagePath("/")).toBe(false);
    expect(isVideoPagePath("/bangumi/play/ep819278")).toBe(false);
    expect(isVideoPagePath("/video")).toBe(false);
  });

  it("遮挡三种 .ad-report 广告位", () => {
    const { adReports } = mountAdFixture();
    syncAdCovers(document, "cover", "dark", VIDEO_PATH);

    expect(adReports).toHaveLength(3);
    for (const ad of adReports) {
      const cover = coverOf(ad);
      expect(cover).not.toBeNull();
      expect(cover?.shadowRoot?.textContent).toContain("已遮挡广告/强插");
    }
  });

  it("遮挡内部没有链接的活动横幅", () => {
    const { activity } = mountAdFixture();
    syncAdCovers(document, "cover", "dark", VIDEO_PATH);
    expect(coverOf(activity)).not.toBeNull();
  });

  it("遮挡 special 推广卡，但不动普通推荐卡", () => {
    const { special, normal } = mountAdFixture();
    syncAdCovers(document, "cover", "dark", VIDEO_PATH);
    expect(coverOf(special)).not.toBeNull();
    expect(coverOf(normal)).toBeNull();
  });

  it("非视频页不处理这些广告", () => {
    mountAdFixture();
    syncAdCovers(document, "cover", "dark", "/");
    expect(document.querySelector(".kcf-card-cover")).toBeNull();
  });

  it("直接隐藏后父容器可恢复，关闭档还原", () => {
    const { adReports, activity, special } = mountAdFixture();
    const firstAd = adReports[0]!;

    syncAdCovers(document, "remove", "dark", VIDEO_PATH);
    expect(firstAd.style.display).toBe("none");
    expect(activity.style.display).toBe("none");
    expect(special.style.display).toBe("none");
    expect(coverOf(firstAd)).toBeNull();

    syncAdCovers(document, "off", "dark", VIDEO_PATH);
    expect(firstAd.style.display).toBe("");
    expect(activity.style.display).toBe("");
    expect(special.style.display).toBe("");
  });

  it("遮挡档切到隐藏档时拆掉遮罩，切回遮挡档重新盖上", () => {
    const { adReports } = mountAdFixture();
    const firstAd = adReports[0]!;

    syncAdCovers(document, "cover", "dark", VIDEO_PATH);
    expect(coverOf(firstAd)).not.toBeNull();

    syncAdCovers(document, "remove", "dark", VIDEO_PATH);
    expect(coverOf(firstAd)).toBeNull();
    expect(firstAd.style.display).toBe("none");

    syncAdCovers(document, "cover", "dark", VIDEO_PATH);
    expect(firstAd.style.display).toBe("");
    expect(coverOf(firstAd)).not.toBeNull();
  });
});
