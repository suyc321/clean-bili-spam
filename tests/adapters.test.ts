// 页面适配器测试：使用脱敏的最小 DOM 夹具验证首页、搜索与空间页的
// 卡片提取、UID 污染防护与降级行为，不在线抓取真实页面。
import { beforeEach, describe, expect, it } from "vitest";
import { scanCurrentPage } from "../src/adapters/registry";

describe("B站页面适配器", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = "<head></head><body></body>";
  });

  it("提取首页视频卡片的 BVID、UID、标题和原始统计文本", () => {
    document.body.innerHTML = `
      <article class="bili-video-card">
        <a href="https://www.bilibili.com/video/BV1Ab411c7xY">
          <img alt="备用标题" src="https://i0.hdslb.com/example.jpg" />
        </a>
        <a
          class="bili-video-card__info--tit"
          title="这是一个普通科技视频"
          href="https://www.bilibili.com/video/BV1Ab411c7xY"
        >这是一个普通科技视频</a>
        <a
          class="bili-video-card__info--owner"
          href="https://space.bilibili.com/123456"
        ><span class="bili-video-card__info--author" title="测试UP">测试UP</span></a>
        <span class="bili-video-card__info--date">2小时前</span>
        <span class="bili-video-card__stats--text">1.2万</span>
        <span class="bili-video-card__stats--text">340</span>
      </article>
    `;

    const result = scanCurrentPage(
      document,
      new URL("https://www.bilibili.com/"),
      new Date(2026, 6, 31, 12).getTime(),
    );

    expect(result.health).toBe("healthy");
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({
      accountKey: "uid:123456",
      uid: "123456",
      uidSource: "card",
      displayName: "测试UP",
      video: {
        bvid: "BV1Ab411c7xY",
        title: "这是一个普通科技视频",
        metricsRaw: ["1.2万", "340"],
      },
    });
  });

  it("搜索用户模块中的视频可以回退到模块级 UID", () => {
    document.body.innerHTML = `
      <section class="video-card-content">
        <a href="//space.bilibili.com/789012" title="模块UP">模块UP</a>
        <article class="bili-video-card">
          <a
            class="bili-video-card__info--tit"
            title="模块内视频"
            href="//www.bilibili.com/video/BV9xy4y1Z7Q2"
          >模块内视频</a>
        </article>
      </section>
    `;

    const result = scanCurrentPage(
      document,
      new URL("https://search.bilibili.com/all?keyword=test"),
    );

    expect(result.cards[0]).toMatchObject({
      accountKey: "uid:789012",
      uidSource: "search-module",
      displayName: "模块UP",
    });
  });

  it("UP主页卡片从当前 URL 获得 UID，并读取主页资料", () => {
    document.body.innerHTML = `
      <header>
        <div class="nickname">主页UP</div>
        <div class="sign header-sign">专注科技内容</div>
      </header>
      <article class="bili-video-card">
        <a class="bili-cover-card" href="/video/BV7Qw411N7mA">
          <img class="b-img__inner" alt="主页视频" src="https://i0.hdslb.com/cover.jpg" />
        </a>
        <a class="bili-video-card__title" title="主页视频" href="/video/BV7Qw411N7mA">主页视频</a>
        <span class="bili-video-card__subtitle">07-30</span>
      </article>
    `;

    const result = scanCurrentPage(
      document,
      new URL("https://space.bilibili.com/87654321/video"),
    );

    expect(result.cards[0]).toMatchObject({
      accountKey: "uid:87654321",
      uidSource: "space-url",
      displayName: "主页UP",
      profileBio: "专注科技内容",
    });
  });

  it("不会把页面顶部登录用户链接误当成视频作者", () => {
    document.body.innerHTML = `
      <header><a href="https://space.bilibili.com/999">当前登录用户</a></header>
      <article class="bili-video-card">
        <a title="没有作者的视频" href="https://www.bilibili.com/video/BV1xx411c7xx">
          没有作者的视频
        </a>
      </article>
    `;

    const result = scanCurrentPage(
      document,
      new URL("https://www.bilibili.com/"),
    );

    expect(result.health).toBe("degraded");
    expect(result.cards[0]?.accountKey).toBeUndefined();
    expect(result.cards[0]?.uidSource).toBe("missing");
  });

  it("同一卡片中多个视频锚点只生成一条卡片结果", () => {
    document.body.innerHTML = `
      <article class="bili-video-card">
        <a href="/video/BV1Ab411c7xY"><img alt="重复锚点测试" /></a>
        <a title="重复锚点测试" href="/video/BV1Ab411c7xY">重复锚点测试</a>
        <a href="//space.bilibili.com/123">作者</a>
      </article>
    `;

    const result = scanCurrentPage(
      document,
      new URL("https://www.bilibili.com/"),
    );
    expect(result.cards).toHaveLength(1);
  });

  it("增量扫描遇到推荐流外壳时读取里面的视频卡", () => {
    document.body.innerHTML = `
      <div class="bili-feed-card">
        <article class="bili-video-card is-rcmd">
          <a href="https://www.bilibili.com/video/BV1Ab411c7xY">封面</a>
          <a class="bili-video-card__info--tit" title="推荐流新视频" href="https://www.bilibili.com/video/BV1Ab411c7xY">推荐流新视频</a>
          <a class="bili-video-card__info--owner" href="https://space.bilibili.com/654321">
            <span class="bili-video-card__info--author" title="新UP">新UP</span>
          </a>
        </article>
      </div>
    `;
    const wrapper = document.querySelector(".bili-feed-card");
    expect(wrapper).not.toBeNull();

    const result = scanCurrentPage(
      document,
      new URL("https://www.bilibili.com/"),
      Date.now(),
      [wrapper!],
    );

    expect(result.health).toBe("healthy");
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({
      accountKey: "uid:654321",
      displayName: "新UP",
    });
  });
});
