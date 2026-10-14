// 合集视频 → 观察记录 → 触发器判定的端到端回归。
//
// 核心价值验证：首页一次只露 1 条投稿，靠 DOM 永远凑不齐触发器所需的
// 样本，所以「24 小时内 ≥5 条投稿」这类节奏信号在首页算不出来。
// 合集视频补上之后，同一账号的 burst-posting 触发器在首页就能命中——
// 不需要写任何新规则。这也是 AI 之外本地代码剩下的唯一职责。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearObservationDatabase,
  getVideosForAccount,
} from "../src/storage/database";
import { analyzeObservations } from "../src/application/analyze-observations";
import { detectReviewTriggers } from "../src/features/review-trigger";
import type { AccountObservationInput } from "../src/domain/types";

let storedValues: Record<string, unknown>;
const STORAGE_KEY = "kcf:settings:v1";

function installChromeStub(): void {
  storedValues = {};
  vi.stubGlobal("chrome", {
    permissions: { contains: async () => true },
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested.map((key) => [key, storedValues[key]]),
          );
        },
        set: async (values: Record<string, unknown>) => {
          Object.assign(storedValues, values);
        },
        remove: async (key: string) => {
          delete storedValues[key];
        },
      },
    },
  });
}

/**
 * 构造一个账号的观察批次：1 条 DOM 视频 + N 条合集视频。
 * 合集视频的时间戳按 daySpacing 排布，用于验证短期投稿频率能否算出。
 */
function makeObservation(input: {
  uid: string;
  domTitle: string;
  seasonTitles: string[];
  baseMs: number;
  daySpacingMs: number;
  views?: number[];
}): AccountObservationInput {
  const now = input.baseMs;
  const seasonVideos = input.seasonTitles.map((title, index) => ({
    videoKey: `BVseason${index}`,
    bvid: `BVseason${index}`,
    title,
    videoUrl: `https://www.bilibili.com/video/BVseason${index}`,
    publishedText: "1天前",
    publishedAtMs: now - index * input.daySpacingMs,
    metricsRaw: [
      String(input.views?.[index] ?? 10_000),
      String((input.views?.[index] ?? 10_000) / 100),
    ],
    source: { pageKind: "space" as const, adapterId: "account-card", adapterVersion: 1 },
    observedAtMs: now,
  }));
  return {
    schemaVersion: 1,
    accountKey: `uid:${input.uid}`,
    uid: input.uid,
    profileUrl: `https://space.bilibili.com/${input.uid}`,
    displayName: "合集账号",
    videos: [
      {
        videoKey: "BVdom001",
        bvid: "BVdom001",
        title: input.domTitle,
        videoUrl: "https://www.bilibili.com/video/BVdom001",
        publishedText: "1小时前",
        publishedAtMs: now,
        metricsRaw: ["10,000", "100"],
        source: { pageKind: "home" as const, adapterId: "feed-v1", adapterVersion: 1 },
        observedAtMs: now,
      },
      ...seasonVideos,
    ],
    missingFields: [],
    source: { pageKind: "home" as const, adapterId: "feed-v1", adapterVersion: 1 },
    observedAtMs: now,
  };
}

describe("合集视频让首页也能算出多样本特征", () => {
  beforeEach(async () => {
    installChromeStub();
    await clearObservationDatabase();
  });

  it("日更账号的 24 小时投稿频率可以算出（首页单条 DOM 永远算不出）", async () => {
    const now = Date.now();
    const hour = 3_600_000;
    // 1 条 DOM 视频 + 4 条合集视频，全部落在同一天内
    const observation = makeObservation({
      uid: "7001",
      domTitle: "完了，今天的功德又笑没了！！！①",
      seasonTitles: [
        "完了，今天的功德又笑没了！！！②",
        "完了，今天的功德又笑没了！！！③",
        "完了，今天的功德又笑没了！！！④",
        "完了，今天的功德又笑没了！！！⑤",
      ],
      baseMs: now,
      daySpacingMs: hour * 5,
      views: [50_000, 20_000, 10_000, 5_000, 1_000],
    });
    const analyses = await analyzeObservations([observation]);

    // 关键断言：5 条投稿全部落库，burst-posting 触发器因此命中
    // （24 小时内 ≥5 条）。没有合集视频时只有 1 条带时间的样本，恒为 0。
    expect(analyses[0]!.observedVideos).toBe(5);
    expect(analyses[0]!.review.kind).toBe("triggered");
    if (analyses[0]!.review.kind !== "triggered") {
      return;
    }
    expect(analyses[0]!.review.triggers.map((hit) => hit.signal)).toContain(
      "burst-posting",
    );
  });

  it("只有 1 条带时间的投稿时不命中密集投稿", () => {
    const now = Date.now();
    const videos = [
      {
        videoKey: "BVonly001",
        bvid: "BVonly001",
        title: "某条孤零零的投稿",
        videoUrl: "https://www.bilibili.com/video/BVonly001",
        publishedAtMs: now,
        metricsRaw: ["10,000", "100"],
        source: {
          pageKind: "home" as const,
          adapterId: "feed-v1",
          adapterVersion: 1,
        },
        observedAtMs: now,
        accountKey: "uid:7002" as const,
        firstSeenAtMs: now,
        lastSeenAtMs: now,
        seenCount: 1,
      },
    ];
    // 只有 1 条带发布时间的样本，任何需要时间窗的触发器都无从算起。
    const triggers = detectReviewTriggers({
      profile: {
        accountKey: "uid:7002",
        uid: "7002",
        profileUrl: "https://space.bilibili.com/7002",
        firstSeenAtMs: now,
        lastSeenAtMs: now,
      },
      videos: videos as Parameters<typeof detectReviewTriggers>[0]["videos"],
      repostHistory: new Map(),
    });
    expect(triggers).toEqual([]);
  });

  it("合集视频与 DOM 采集的同一条投稿天然去重", async () => {
    const now = Date.now();
    // 合集里故意放一条与 DOM 相同的 videoKey
    const observation: AccountObservationInput = {
      schemaVersion: 1,
      accountKey: "uid:7003",
      uid: "7003",
      profileUrl: "https://space.bilibili.com/7003",
      displayName: "去重账号",
      videos: [
        {
          videoKey: "BVdup001",
          bvid: "BVdup001",
          title: "同一条投稿的 DOM 版本",
          videoUrl: "https://www.bilibili.com/video/BVdup001",
          publishedText: "1天前",
          publishedAtMs: now - 86_400_000,
          metricsRaw: ["10,000", "100"],
          source: { pageKind: "home" as const, adapterId: "feed-v1", adapterVersion: 1 },
          observedAtMs: now,
        },
        {
          videoKey: "BVdup001",
          bvid: "BVdup001",
          title: "同一条投稿的合集版本",
          videoUrl: "https://www.bilibili.com/video/BVdup001",
          publishedAtMs: now - 86_400_000,
          metricsRaw: ["10,000", "100"],
          source: { pageKind: "space" as const, adapterId: "account-card", adapterVersion: 1 },
          observedAtMs: now,
        },
        {
          videoKey: "BVdup002",
          bvid: "BVdup002",
          title: "另一条投稿",
          videoUrl: "https://www.bilibili.com/video/BVdup002",
          publishedAtMs: now - 2 * 86_400_000,
          metricsRaw: ["10,000", "100"],
          source: { pageKind: "space" as const, adapterId: "account-card", adapterVersion: 1 },
          observedAtMs: now,
        },
      ],
      missingFields: [],
      source: { pageKind: "home" as const, adapterId: "feed-v1", adapterVersion: 1 },
      observedAtMs: now,
    };
    await analyzeObservations([observation]);
    const stored = await getVideosForAccount("uid:7003");
    // 记录 ID 是 accountKey:videoKey，同一条投稿只应有一条记录。
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((v) => v.videoKey)).size).toBe(2);
  });

  it("合集来源的观察带 source.adapterId=account-card，便于区分数据来源", async () => {
    const now = Date.now();
    const observation = makeObservation({
      uid: "7004",
      domTitle: "DOM 标题",
      seasonTitles: ["合集标题甲", "合集标题乙"],
      baseMs: now,
      daySpacingMs: 86_400_000,
    });
    await analyzeObservations([observation]);
    const stored = await getVideosForAccount("uid:7004");
    const fromCard = stored.filter((v) => v.source.adapterId === "account-card");
    const fromDom = stored.filter((v) => v.source.adapterId !== "account-card");
    expect(fromCard).toHaveLength(2);
    expect(fromDom).toHaveLength(1);
    // 合集记录的 pageKind 标为 space（合集本质属于空间页内容）。
    expect(fromCard.every((v) => v.source.pageKind === "space")).toBe(true);
  });
});

// 回归测试：跨账号视频泄漏。
//
// 2026-09-26 实测事故：groupObservations 里把 `accountCards.map` 误写成
// `cards.map`，导致每个账号都带上整批所有账号的投稿，10 个真实账号全部
// 被判 65 分高风险（搬运 +30、矩阵簇 +25）。这里在编排层钉住不变量：
// 两个账号投稿完全不重叠时，绝不允许出现语料级贡献。
describe("跨账号投稿不得互相泄漏", () => {
  beforeEach(async () => {
    installChromeStub();
    await clearObservationDatabase();
  });

  it("两个账号投稿不重叠时不触发搬运与矩阵簇", async () => {
    const now = Date.now();
    const day = 86_400_000;
    // 标题必须**真正不同**：若两个账号都写「XX投稿标题第N条」这种同构句式，
    // 矩阵簇规则会正确命中（那正是它该干的事），测的就不是泄漏了。
    const make = (uid: string, titles: string[]): AccountObservationInput => ({
      schemaVersion: 1,
      accountKey: `uid:${uid}`,
      uid,
      profileUrl: `https://space.bilibili.com/${uid}`,
      displayName: `账号${uid}`,
      videos: titles.map((title, index) => ({
        videoKey: `${uid}-${index}`,
        bvid: `${uid}-${index}`,
        title,
        videoUrl: `https://www.bilibili.com/video/${uid}-${index}`,
        publishedText: `${index + 1}天前`,
        publishedAtMs: now - (index + 1) * day,
        metricsRaw: ["10,000", "100"],
        source: {
          pageKind: "home" as const,
          adapterId: "feed-v1",
          adapterVersion: 1,
        },
        observedAtMs: now,
      })),
      missingFields: [],
      source: {
        pageKind: "home" as const,
        adapterId: "feed-v1",
        adapterVersion: 1,
      },
      observedAtMs: now,
    });

    const analyses = await analyzeObservations([
      make("8001", [
        "红烧肉要炖多久才软烂",
        "清蒸鲈鱼如何去腥不放料酒",
        "糖醋排骨炒糖色的火候控制",
      ]),
      make("8002", [
        "苏联雷达在冷战时期的部署逻辑",
        "越战美军直升机维护成本分析",
        "波斯湾战争中防空导弹的误判率",
      ]),
    ]);
    for (const analysis of analyses) {
      // 三个账号各自只有少量投稿、无任何保留的触发器特征 → 无判定。
      // 三者都没有跨账号共享 BV，因此 reposted-video 也不命中。
      expect(analysis.review.kind).toBe("none");
    }
  });

  it("每个账号只保留自己的投稿（按 accountKey 隔离）", async () => {
    const now = Date.now();
    const make = (uid: string, prefix: string): AccountObservationInput => ({
      schemaVersion: 1,
      accountKey: `uid:${uid}`,
      uid,
      profileUrl: `https://space.bilibili.com/${uid}`,
      videos: [1, 2].map((n) => ({
        videoKey: `${prefix}${n}`,
        bvid: `${prefix}${n}`,
        title: `${prefix}投稿${n}`,
        videoUrl: `https://www.bilibili.com/video/${prefix}${n}`,
        publishedAtMs: now - n * 86_400_000,
        metricsRaw: ["10,000", "100"],
        source: {
          pageKind: "home" as const,
          adapterId: "feed-v1",
          adapterVersion: 1,
        },
        observedAtMs: now,
      })),
      missingFields: [],
      source: {
        pageKind: "home" as const,
        adapterId: "feed-v1",
        adapterVersion: 1,
      },
      observedAtMs: now,
    });
    await analyzeObservations([make("8003", "CCC"), make("8004", "DDD")]);
    const first = await getVideosForAccount("uid:8003");
    const second = await getVideosForAccount("uid:8004");
    expect(first.map((v) => v.videoKey).sort()).toEqual(["CCC1", "CCC2"]);
    expect(second.map((v) => v.videoKey).sort()).toEqual(["DDD1", "DDD2"]);
  });
});
