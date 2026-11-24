// 名片与合集属于外部数据：进入 observations.ingest 前必须按协议口径清洗，
// 否则一条空 BVID 或超长标题会让整批消息被 Zod 拒绝。
import { describe, expect, it } from "vitest";
import {
  cardFieldsOf,
  seasonVideosOf,
} from "../src/content/card-enrichment";
import { parseRuntimeRequest } from "../src/messaging/protocol";

describe("名片与合集数据清洗", () => {
  it("简介按协议上限裁剪，非法计数不提交", () => {
    const fields = cardFieldsOf({
      sign: "长".repeat(3_000),
      fans: -1,
      archiveCount: 12,
      officialVerifyType: 1,
      fetchedAtMs: 1,
    });

    expect(fields.profileBio).toHaveLength(2_000);
    expect(fields.profileFollowers).toBeUndefined();
    expect(fields.profileArchiveCount).toBe(12);
    expect(fields.profileCardFetched).toBe(true);
    expect(fields.profileOfficialVerifyType).toBe(1);
  });

  it("空白简介、浮点计数与未取到名片时保持缺省", () => {
    expect(cardFieldsOf(undefined)).toEqual({});
    expect(cardFieldsOf({ sign: "   ", fetchedAtMs: 1 })).toEqual({
      profileCardFetched: true,
    });
    expect(
      cardFieldsOf({
        sign: "",
        fans: 1.5,
        archiveCount: -2,
        officialVerifyType: 1.2,
        fetchedAtMs: 1,
      }),
    ).toEqual({ profileCardFetched: true });
  });

  it("合集视频过滤空 BVID、空标题与重复项，并裁剪标题", () => {
    const videos = seasonVideosOf({
      seasonVideos: [
        { bvid: "", title: "空 BVID" },
        { bvid: "av123", title: "旧 AV 号" },
        { bvid: "BVvalid1", title: "  " },
        {
          bvid: "BVvalid2",
          title: "标题".repeat(400),
          pubdate: 1_700_000_000,
          view: 10,
          danmaku: 2,
        },
        { bvid: "BVvalid2", title: "重复" },
        { bvid: "BVvalid3", title: "负数时间", pubdate: -1 },
      ],
    });

    expect(videos.map((video) => video.bvid)).toEqual([
      "BVvalid2",
      "BVvalid3",
    ]);
    expect(videos[0]?.title).toHaveLength(500);
    expect(videos[0]?.publishedAtMs).toBe(1_700_000_000_000);
    expect(videos[0]?.publishedText).toBeTruthy();
    expect(videos[0]?.metricsRaw).toEqual(["10", "2"]);
    expect(videos[1]?.publishedAtMs).toBeUndefined();
    expect(videos[1]?.publishedText).toBeUndefined();
  });

  it("清洗后的观察能通过消息协议校验", () => {
    const observation = {
      schemaVersion: 1 as const,
      accountKey: "uid:1" as const,
      uid: "1",
      profileUrl: "https://space.bilibili.com/1",
      ...cardFieldsOf({
        sign: "长".repeat(3_000),
        fans: 10,
        archiveCount: 20,
        fetchedAtMs: 1,
      }),
      videos: seasonVideosOf({
        seasonVideos: [
          {
            bvid: "BVvalid1",
            title: "标题".repeat(400),
            pubdate: 1_700_000_000,
          },
        ],
      }),
      missingFields: [],
      source: {
        pageKind: "space" as const,
        adapterId: "account-card",
        adapterVersion: 1,
      },
      observedAtMs: 1,
    };

    expect(() =>
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "card-enrichment-test",
        type: "observations.ingest",
        payload: { observations: [observation] },
      }),
    ).not.toThrow();
  });
});
