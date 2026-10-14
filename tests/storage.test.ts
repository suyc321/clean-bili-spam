// IndexedDB 存储测试：幂等 upsert、乱序稀疏合并、
// 统计去重有界、账号级数量裁剪与过期清理。
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AccountObservationInput,
} from "../src/domain/types";
import {
  clearObservationDatabase,
  countObservedAccounts,
  getVideosForAccount,
  ingestObservation,
  pruneExpiredObservations,
} from "../src/storage/database";

describe("本地观察数据库", () => {
  beforeEach(async () => {
    await clearObservationDatabase();
  });

  it("相同账号和 BVID 使用幂等 upsert，并累计观察次数", async () => {
    const observation = createObservation(["BV1"]);
    await ingestObservation(observation, 20);
    await ingestObservation(
      { ...observation, observedAtMs: observation.observedAtMs + 1_000 },
      20,
    );

    const videos = await getVideosForAccount("uid:123");
    expect(videos).toHaveLength(1);
    expect(videos[0]?.seenCount).toBe(2);
    expect(videos[0]?.firstSeenAtMs).toBe(observation.observedAtMs);
  });

  it("乱序稀疏观察不会覆盖较新且更丰富的账号与投稿字段", async () => {
    const richObservation = createObservation(["BV1"]);
    richObservation.observedAtMs = 2_000;
    richObservation.displayName = "较新名称";
    richObservation.profileBio = "较新的简介";
    richObservation.videos[0] = {
      ...richObservation.videos[0]!,
      title: "较新的标题",
      coverUrl: "https://i0.hdslb.com/bfs/archive/new-cover.jpg",
      publishedText: "2026-07-30",
      publishedAtMs: 1_900,
      metricsRaw: ["12万播放", "300评论"],
      observedAtMs: 2_000,
    };
    await ingestObservation(richObservation, 20);

    const sparseOlderObservation = createObservation(["BV1"]);
    sparseOlderObservation.displayName = "较旧名称";
    sparseOlderObservation.videos[0] = {
      ...sparseOlderObservation.videos[0]!,
      title: "较旧的标题",
      metricsRaw: ["10万播放"],
      observedAtMs: 1_000,
    };
    const result = await ingestObservation(sparseOlderObservation, 20);
    const storedVideo = result.videos[0];

    expect(result.profile).toMatchObject({
      displayName: "较新名称",
      profileBio: "较新的简介",
      firstSeenAtMs: 1_000,
      lastSeenAtMs: 2_000,
    });
    expect(storedVideo).toMatchObject({
      title: "较新的标题",
      coverUrl: "https://i0.hdslb.com/bfs/archive/new-cover.jpg",
      publishedText: "2026-07-30",
      publishedAtMs: 1_900,
      firstSeenAtMs: 1_000,
      lastSeenAtMs: 2_000,
      seenCount: 2,
    });
    expect(storedVideo?.metricsRaw).toEqual(
      expect.arrayContaining(["12万播放", "300评论", "10万播放"]),
    );
  });

  it("变化中的统计文本去重合并后保持有界", async () => {
    const older = createObservation(["BV1"]);
    older.videos[0] = {
      ...older.videos[0]!,
      metricsRaw: Array.from({ length: 20 }, (_, index) => `旧指标-${index}`),
    };
    await ingestObservation(older, 20);

    const newer = createObservation(["BV1"]);
    newer.observedAtMs = 2_000;
    newer.videos[0] = {
      ...newer.videos[0]!,
      metricsRaw: Array.from({ length: 12 }, (_, index) => `新指标-${index}`),
      observedAtMs: 2_000,
    };
    const result = await ingestObservation(newer, 20);

    expect(result.videos[0]?.metricsRaw).toHaveLength(24);
    expect(result.videos[0]?.metricsRaw).toEqual(
      expect.arrayContaining(
        Array.from({ length: 12 }, (_, index) => `新指标-${index}`),
      ),
    );
  });

  it("按账号限制最多保留的投稿数量", async () => {
    await ingestObservation(createObservation(["BV1", "BV2", "BV3"]), 2);
    const videos = await getVideosForAccount("uid:123");

    expect(videos).toHaveLength(2);
    expect(videos.map((video) => video.bvid)).toEqual(["BV3", "BV2"]);
  });

  it("按照保留期限删除过期账号、投稿和评估缓存", async () => {
    await ingestObservation(createObservation(["BV1"]), 20);
    await pruneExpiredObservations(2_000);

    expect(await getVideosForAccount("uid:123")).toHaveLength(0);
    expect(await countObservedAccounts()).toBe(0);
  });
});

// 构造最小合法的账号观察输入（供各合并场景复用与覆盖字段）。
function createObservation(bvids: string[]): AccountObservationInput {
  const observedAtMs = 1_000;
  return {
    schemaVersion: 1,
    accountKey: "uid:123",
    uid: "123",
    profileUrl: "https://space.bilibili.com/123",
    displayName: "测试账号",
    videos: bvids.map((bvid, index) => ({
      videoKey: bvid,
      bvid,
      title: `测试视频 ${index}`,
      videoUrl: `https://www.bilibili.com/video/${bvid}`,
      metricsRaw: [],
      source: {
        pageKind: "home",
        adapterId: "test",
        adapterVersion: 1,
      },
      observedAtMs: observedAtMs + index,
    })),
    missingFields: ["profileBio"],
    source: {
      pageKind: "home",
      adapterId: "test",
      adapterVersion: 1,
    },
    observedAtMs,
  };
}
