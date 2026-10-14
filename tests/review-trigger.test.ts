import { describe, expect, it } from "vitest";
import type {
  AccountKey,
  AccountProfileRecord,
  VideoObservationRecord,
} from "../src/domain/types";
import { detectReviewTriggers } from "../src/features/review-trigger";

const SELF: AccountKey = "uid:1001";

function profile(overrides: Partial<AccountProfileRecord> = {}): AccountProfileRecord {
  return {
    accountKey: SELF,
    uid: "1001",
    profileUrl: "https://space.bilibili.com/1001",
    firstSeenAtMs: 0,
    lastSeenAtMs: 0,
    ...overrides,
  };
}

/** 造一条投稿观察；发布时间以「距今多少毫秒」给出。 */
function video(
  videoKey: string,
  title: string,
  ageMs?: number,
): VideoObservationRecord {
  const now = NOW;
  return {
    videoKey,
    bvid: videoKey,
    title,
    videoUrl: `https://www.bilibili.com/video/${videoKey}`,
    metricsRaw: [],
    source: {
      pageKind: "home",
      adapterId: "bilibili-home-v1",
      adapterVersion: 1,
    },
    observedAtMs: now,
    accountKey: SELF,
    firstSeenAtMs: now,
    lastSeenAtMs: now,
    seenCount: 1,
    ...(ageMs === undefined ? {} : { publishedAtMs: now - ageMs }),
  };
}

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1_000;

describe("侵权免责声明触发器", () => {
  it("简介含「如有侵权，联系第一时间删除」时命中", () => {
    const hits = detectReviewTriggers({
      profile: profile({ profileBio: "如有侵权，联系第一时间删除！" }),
      videos: [video("BV1aa", "普通标题")],
      repostHistory: new Map(),
    });
    expect(hits.map((hit) => hit.signal)).toEqual(["repost-disclaimer"]);
  });

  it("各种免责写法都能命中", () => {
    const bios = [
      "侵删",
      "版权归原作者所有",
      "如不妥请联系删除",
      "不当之处请联系",
    ];
    for (const profileBio of bios) {
      const hits = detectReviewTriggers({
        profile: profile({ profileBio }),
        videos: [video("BV1aa", "普通标题")],
        repostHistory: new Map(),
      });
      expect(hits.some((hit) => hit.signal === "repost-disclaimer")).toBe(true);
    }
  });

  it("没有简介时不命中——无法判断与「没有免责」是两件事", () => {
    const hits = detectReviewTriggers({
      profile: profile(),
      videos: [video("BV1aa", "普通标题")],
      repostHistory: new Map(),
    });
    expect(hits).toEqual([]);
  });

  it("空简介与纯空白简介同样不命中", () => {
    for (const profileBio of ["", "   \n  "]) {
      const hits = detectReviewTriggers({
        profile: profile({ profileBio }),
        videos: [video("BV1aa", "普通标题")],
        repostHistory: new Map(),
      });
      expect(hits).toEqual([]);
    }
  });
});

describe("成套资源兜售触发器", () => {
  it("标题列物料构成时一条即中", () => {
    for (const title of [
      "某某课程L系列全套完整版 视频+字幕",
      "某动画 中英字幕 全集",
      "某纪录片 音频+绘本",
    ]) {
      const hits = detectReviewTriggers({
        profile: profile(),
        videos: [video("BV1aa", title)],
        repostHistory: new Map(),
      });
      expect(hits.map((hit) => hit.signal)).toContain("resource-trafficking");
    }
  });

  it("成套完整性声明与资源名词共现才中", () => {
    const hits = detectReviewTriggers({
      profile: profile(),
      videos: [video("BV1aa", "某课程 共120集全")],
      repostHistory: new Map(),
    });
    expect(hits.map((hit) => hit.signal)).toContain("resource-trafficking");
  });

  it("资源分发动作与网盘线索一条即中", () => {
    for (const title of [
      "某资料 网盘自取",
      "某资源 打包领取",
      "稀有纪录片 夸克网盘",
    ]) {
      const hits = detectReviewTriggers({
        profile: profile(),
        videos: [video("BV1aa", title)],
        repostHistory: new Map(),
      });
      expect(hits.map((hit) => hit.signal)).toContain("resource-trafficking");
    }
  });

  it("原创者的常规合集声明不命中", () => {
    // 「完整版」单独出现不算——原创者也说「全程完整版」。
    for (const title of [
      "我的做饭系列 完整版",
      "全程完整版！一期讲透三国",
      "本合集完结纪念",
      "某课程 完结撒花",
    ]) {
      const hits = detectReviewTriggers({
        profile: profile(),
        videos: [video("BV1aa", title)],
        repostHistory: new Map(),
      });
      expect(hits).toEqual([]);
    }
  });

  it("命中条数写进事实描述", () => {
    const hits = detectReviewTriggers({
      profile: profile(),
      videos: [
        video("BV1aa", "某课程 全套完整版 视频+字幕"),
        video("BV1bb", "某动画 中英字幕"),
        video("BV1cc", "普通投稿"),
      ],
      repostHistory: new Map(),
    });
    const trafficking = hits.find(
      (hit) => hit.signal === "resource-trafficking",
    );
    expect(trafficking?.detail).toContain("2 条");
  });

  it("一条投稿都没有时不命中", () => {
    const hits = detectReviewTriggers({
      profile: profile(),
      videos: [],
      repostHistory: new Map(),
    });
    expect(hits).toEqual([]);
  });
});

describe("同一投稿多账号发布触发器", () => {
  it("投稿的 BV 也出现在其他账号名下时命中", () => {
    const hits = detectReviewTriggers({
      profile: profile(),
      videos: [video("BV1shared", "热播剧第 12 集")],
      repostHistory: new Map([["BV1shared", ["uid:1001", "uid:2002"]]]),
    });
    expect(hits.map((hit) => hit.signal)).toEqual(["reposted-video"]);
  });

  it("历史里只有自己时不算——不能把自己当成「其他账号」", () => {
    const hits = detectReviewTriggers({
      profile: profile(),
      videos: [video("BV1own", "自己的投稿")],
      repostHistory: new Map([["BV1own", ["uid:1001", "uid:1001"]]]),
    });
    expect(hits).toEqual([]);
  });

  it("投稿没有历史记录时不命中", () => {
    const hits = detectReviewTriggers({
      profile: profile(),
      videos: [video("BV1new", "刚看到的投稿")],
      repostHistory: new Map(),
    });
    expect(hits).toEqual([]);
  });

  it("多条投稿被搬运时按条数陈述", () => {
    const hits = detectReviewTriggers({
      profile: profile(),
      videos: [
        video("BV1a", "第一条"),
        video("BV1b", "第二条"),
        video("BV1c", "没被搬运的第三条"),
      ],
      repostHistory: new Map([
        ["BV1a", ["uid:1001", "uid:3003"]],
        ["BV1b", ["uid:1001", "uid:4004"]],
      ]),
    });
    const reposted = hits.find((hit) => hit.signal === "reposted-video");
    expect(reposted?.detail).toContain("2 条");
  });
});

describe("24 小时密集投稿触发器", () => {
  it("24 小时内 5 条时命中", () => {
    const videos = Array.from({ length: 5 }, (_, index) =>
      video(`BV1burst${index}`, `随手拍${index}`, (index + 1) * HOUR),
    );
    const hits = detectReviewTriggers({
      profile: profile(),
      videos,
      repostHistory: new Map(),
    });
    expect(hits.map((hit) => hit.signal)).toEqual(["burst-posting"]);
  });

  it("4 条不命中", () => {
    const videos = Array.from({ length: 4 }, (_, index) =>
      video(`BV1slow${index}`, `随手拍${index}`, (index + 1) * HOUR),
    );
    const hits = detectReviewTriggers({
      profile: profile(),
      videos,
      repostHistory: new Map(),
    });
    expect(hits).toEqual([]);
  });

  it("5 条但跨出 24 小时窗口不命中", () => {
    // 每 8 小时一条：任意 24 小时窗口最多容纳 3 条。
    const videos = Array.from({ length: 5 }, (_, index) =>
      video(`BV1wide${index}`, `随手拍${index}`, index * 8 * HOUR),
    );
    const hits = detectReviewTriggers({
      profile: profile(),
      videos,
      repostHistory: new Map(),
    });
    expect(hits).toEqual([]);
  });

  it("没有可解析发布时间的投稿不参与判定", () => {
    const videos = [
      video("BV1x", "无时间1"),
      video("BV1y", "无时间2"),
      video("BV1z", "无时间3"),
      video("BV1w", "无时间4"),
      video("BV1v", "无时间5"),
    ];
    const hits = detectReviewTriggers({
      profile: profile(),
      videos,
      repostHistory: new Map(),
    });
    expect(hits).toEqual([]);
  });

  it("窗口按最大条数计，不受投稿顺序影响", () => {
    // 打乱顺序传入，五条都在 1-5 小时内，窗口应取满 5 条。
    const videos = [
      video("BV1e", "第5条", 5 * HOUR),
      video("BV1a", "第1条", HOUR),
      video("BV1d", "第4条", 4 * HOUR),
      video("BV1b", "第2条", 2 * HOUR),
      video("BV1c", "第3条", 3 * HOUR),
    ];
    const hits = detectReviewTriggers({
      profile: profile(),
      videos,
      repostHistory: new Map(),
    });
    const burst = hits.find((hit) => hit.signal === "burst-posting");
    expect(burst?.detail).toContain("5 条");
  });
});

describe("多条信号同时命中", () => {
  it("全部命中时按固定顺序返回，且每条都只陈述事实", () => {
    const videos = [
      ...Array.from({ length: 5 }, (_, index) =>
        video(`BV1burst${index}`, `某课程 全套完整版 视频+字幕`, (index + 1) * HOUR),
      ),
      video("BV1shared", "也在别人名下"),
    ];
    const hits = detectReviewTriggers({
      profile: profile({ profileBio: "如有侵权，联系第一时间删除！" }),
      videos,
      repostHistory: new Map([["BV1shared", ["uid:1001", "uid:2002"]]]),
    });
    expect(hits.map((hit) => hit.signal)).toEqual([
      "repost-disclaimer",
      "resource-trafficking",
      "reposted-video",
      "burst-posting",
    ]);
    // 事实描述里不得出现结论性措辞。
    for (const hit of hits) {
      expect(hit.detail).not.toMatch(/营销号|搬运号|疑似|矩阵|高风险/);
    }
  });
});
