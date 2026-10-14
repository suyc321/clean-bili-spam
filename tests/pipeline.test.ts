// 集成管线测试：用脱敏首页夹具走完整链路
// 适配器扫描 → 协议校验 → IndexedDB 入库 → 本地触发器判定 → 标签渲染。
// 夹具为手工构造的最小 DOM，不抓取真实 B 站页面。
//
// 改造后此文件覆盖的是「AI 之外」的整条链路：触发器是唯一还在本地跑的
// 判定逻辑，标签渲染消费的是三态判定（ai / triggered / none）。
import { beforeEach, describe, expect, it } from "vitest";
import { scanCurrentPage } from "../src/adapters/registry";
import type { ExtractedCard } from "../src/adapters/contract";
import type {
  AccountKey,
  AccountObservationInput,
} from "../src/domain/types";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import { parseRuntimeRequest } from "../src/messaging/protocol";
import { detectReviewTriggers } from "../src/features/review-trigger";
import {
  ingestObservation,
  getProfile,
  getVideosForAccount,
} from "../src/storage/database";
import { renderBadge } from "../src/content/badge-renderer";

/** 营销号矩阵夹具：两条标题党 + 强引流简介。 */
const MARKETING_UID = "100200300";
/** 正常垂直创作者夹具。 */
const NORMAL_UID = "556677889";
/** 成套资源兜售夹具：标题里带可下载物料清单，应命中触发器。 */
const TRAFFICKING_UID = "100200301";

describe("完整识别管线（脱敏夹具）", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("适配器从夹具页提取卡片，观察批次通过协议校验", () => {
    mountFixturePage();
    const result = scanCurrentPage(document, new URL("https://www.bilibili.com/"));

    expect(result.health).toBe("healthy");
    // 10 张卡片：旧营销号 3 张 + 资源兜售 2 张 + 正常创作者 3 张 + 1 张缺作者链接。
    expect(result.cards).toHaveLength(9);
    expect(result.cards.filter((card) => card.accountKey === undefined)).toHaveLength(1);

    // 按账号分组构造观察批次，并验证消息协议接受该结构。
    const observations = groupForProtocol(result.cards);
    expect(observations).toHaveLength(3);
    for (const observation of observations) {
      expect(() =>
        parseRuntimeRequest({
          protocolVersion: 1,
          requestId: "pipeline-test",
          type: "observations.ingest",
          payload: { observations: [observation] },
        }),
      ).not.toThrow();
    }
  });

  it("入库、触发器判定与渲染串联：旧营销号原型无信号，资源兜售号命中", async () => {
    mountFixturePage();
    const result = scanCurrentPage(document, new URL("https://www.bilibili.com/"));
    const observations = groupForProtocol(result.cards);
    for (const observation of observations) {
      await ingestObservation(observation, 20);
    }

    // 旧「营销号」夹具（标题党 + 简介留联系方式 + 24h 内 3 条 + 低互动率）
    // 现在**一个触发器都不命中**。这不是漏测，而是改造成果的直接体现：
    // 它依赖的四类信号全是刻意裁掉的低精度信号——标题党词典与
    // 「商务合作VX:」正是历史上连出三个原创作者误报的来源，24h 内 3 条
    // 也够不到 ≥5 的门槛。这个账号现在只能靠 AI 判定。
    const marketingUid = `uid:${MARKETING_UID}` as AccountKey;
    const marketingProfile = await getProfile(marketingUid);
    expect(marketingProfile).toBeDefined();
    const marketingVideos = await getVideosForAccount(marketingUid);
    expect(marketingVideos).toHaveLength(3);
    expect(
      detectReviewTriggers({
        profile: marketingProfile!,
        videos: marketingVideos,
        repostHistory: new Map(),
      }),
    ).toEqual([]);

    // 资源兜售号：标题带「全套完整版 / 视频+字幕 / 网盘自取」→ 命中触发器。
    const traffickingUid = `uid:${TRAFFICKING_UID}` as AccountKey;
    const traffickingProfile = await getProfile(traffickingUid);
    const traffickingVideos = await getVideosForAccount(traffickingUid);
    expect(
      detectReviewTriggers({
        profile: traffickingProfile!,
        videos: traffickingVideos,
        repostHistory: new Map(),
      }).map((hit) => hit.signal),
    ).toEqual(["resource-trafficking"]);

    // 正常创作者：3 条菜谱投稿，时间跨度大、无本地信号 → 无判定。
    const normalUid = `uid:${NORMAL_UID}` as AccountKey;
    const normalProfile = await getProfile(normalUid);
    const normalVideos = await getVideosForAccount(normalUid);
    expect(
      detectReviewTriggers({
        profile: normalProfile!,
        videos: normalVideos,
        repostHistory: new Map(),
      }),
    ).toEqual([]);
  });

  it("三态判定分别渲染成不同的徽章文案", () => {
    mountFixturePage();
    const result = scanCurrentPage(document, new URL("https://www.bilibili.com/"));
    const card = result.cards.find(
      (item) => item.accountKey === `uid:${MARKETING_UID}`,
    )!;

    const badgeTextOf = (analysis: Parameters<typeof renderBadge>[1]): string => {
      document.body.replaceChildren();
      renderBadge(card, analysis, DEFAULT_SETTINGS, async () => {});
      const host = card.mount.cardElement.querySelector(".kcf-badge-host")!;
      return host.shadowRoot!.querySelector(".badge")!.textContent!;
    };

    const key = `uid:${MARKETING_UID}` as AccountKey;
    // 无账号信息：解析不出稳定 UID 的卡片。
    expect(badgeTextOf(undefined)).toContain("无账号信息");
    // AI 结论：唯一需要展示的判定。
    expect(
      badgeTextOf({
        accountKey: key,
        uid: MARKETING_UID,
        observedVideos: 3,
        hasBio: true,
        review: {
          kind: "ai",
          review: {
            accountKey: key,
            marketingProbability: 85,
            category: "marketing",
            reason: "成套兜售盗版资源",
            insufficientData: [],
            model: "test-model",
            reviewedAtMs: Date.now(),
          },
        },
        disposition: "none",
      }),
    ).toBe("AI 85%");
    // 触发器命中：只提示值得复核，不给分数或档位。
    expect(
      badgeTextOf({
        accountKey: key,
        uid: MARKETING_UID,
        observedVideos: 3,
        hasBio: true,
        review: {
          kind: "triggered",
          triggers: [{ signal: "burst-posting", detail: "24 小时内投稿不少于 5 条" }],
        },
        disposition: "none",
      }),
    ).toBe("🔎 值得复核");
    // 无判定：中性，不是「低风险」。
    expect(
      badgeTextOf({
        accountKey: key,
        uid: MARKETING_UID,
        observedVideos: 1,
        hasBio: false,
        review: { kind: "none" },
        disposition: "none",
      }),
    ).toBe("⚪ 无判定");
  });
});

/** 构造脱敏首页夹具：营销号矩阵、正常创作者与一张缺作者的卡片。 */
function mountFixturePage(): void {
  document.body.innerHTML = `
    <div class="feed">
      ${videoCard({
        bvid: "BV1FIXT001",
        title: "震惊！这款手机竟然一夜彻底炸了",
        author: "数码揭秘君",
        uid: MARKETING_UID,
        date: "2小时前",
        stats: ["27.5万", "88"],
      })}
      ${videoCard({
        bvid: "BV1FIXT002",
        title: "速看！再不看就删了真相竟然是这样",
        author: "数码揭秘君",
        uid: MARKETING_UID,
        date: "5小时前",
        stats: ["18.2万", "102"],
      })}
      ${videoCard({
        bvid: "BV1FIXT007",
        title: "必看！这款手机的秘密终于曝光了",
        author: "数码揭秘君",
        uid: MARKETING_UID,
        date: "6小时前",
        stats: ["9.9万", "77"],
      })}
      ${videoCard({
        bvid: "BV1FIXT101",
        title: "某某课程L系列全套完整版 视频+字幕",
        author: "资源分享君",
        uid: TRAFFICKING_UID,
        date: "1天前",
        stats: ["8,432", "612"],
      })}
      ${videoCard({
        bvid: "BV1FIXT102",
        title: "某纪录片 完结版 未删减 网盘自取",
        author: "资源分享君",
        uid: TRAFFICKING_UID,
        date: "2天前",
        stats: ["3,120", "45"],
      })}
      ${videoCard({
        bvid: "BV1FIXT003",
        title: "红烧肉的正宗家常做法",
        author: "老王做菜",
        uid: NORMAL_UID,
        date: "1天前",
        stats: ["8,432", "612"],
      })}
      ${videoCard({
        bvid: "BV1FIXT004",
        title: "清蒸鲈鱼的家常做法",
        author: "老王做菜",
        uid: NORMAL_UID,
        date: "3天前",
        stats: ["1.2万", "890"],
      })}
      ${videoCard({
        bvid: "BV1FIXT006",
        title: "鱼香肉丝的家常做法",
        author: "老王做菜",
        uid: NORMAL_UID,
        date: "5天前",
        stats: ["2,345", "410"],
      })}
      ${videoCard({
        bvid: "BV1FIXT005",
        title: "没有作者信息的卡片",
        stats: ["999", "10"],
      })}
    </div>
  `;
}

/** 生成单张与 B 站首页结构一致的卡片 HTML（类名与适配器选择器对应）。 */
function videoCard(item: {
  bvid: string;
  title: string;
  author?: string;
  uid?: string;
  date?: string;
  stats: string[];
}): string {
  const owner = item.author === undefined
    ? ""
    : `<a class="bili-video-card__info--owner" href="//space.bilibili.com/${item.uid}">
        <span class="bili-video-card__info--author" title="${item.author}">${item.author}</span>
      </a>`;
  return `
    <div class="bili-video-card">
      <a href="//www.bilibili.com/video/${item.bvid}" title="${item.title}"></a>
      <div class="bili-video-card__info--tit" title="${item.title}">${item.title}</div>
      <div class="bili-video-card__info--date">${item.date ?? ""}</div>
      ${item.stats.map((value) => `<span class="bili-video-card__stats--text">${value}</span>`).join("")}
      ${owner}
    </div>
  `;
}

/**
 * 把扫描结果按账号聚合成观察批次（与 content-script 的
 * groupObservations 同口径），并补齐营销号简介以触发引流规则。
 */
function groupForProtocol(cards: ExtractedCard[]): AccountObservationInput[] {
  const resolved = cards.filter(
    (card): card is ExtractedCard & {
      accountKey: AccountKey;
      uid: string;
      profileUrl: string;
    } =>
      card.accountKey !== undefined &&
      card.uid !== undefined &&
      card.profileUrl !== undefined,
  );
  const grouped = new Map<AccountKey, typeof resolved>();
  for (const card of resolved) {
    const current = grouped.get(card.accountKey) ?? [];
    current.push(card);
    grouped.set(card.accountKey, current);
  }
  return [...grouped.entries()].map(([accountKey, accountCards]) => {
    const first = accountCards[0]!;
    return {
      schemaVersion: 1,
      accountKey,
      uid: first.uid,
      profileUrl: first.profileUrl,
      displayName: first.displayName,
      // 模拟空间页采集到的简介：营销号强引流，正常创作者普通简介。
      profileBio:
        accountKey === `uid:${MARKETING_UID}`
          ? "商务合作VX: shuma66666 加群领资料"
          : accountKey === `uid:${TRAFFICKING_UID}`
            ? "各类学习资料持续更新"
            : "专注家常菜谱十年",
      videos: accountCards.map((card) => card.video),
      missingFields: [...new Set(accountCards.flatMap((card) => card.missingFields))],
      source: first.source,
      observedAtMs: Date.now(),
    };
  });
}
