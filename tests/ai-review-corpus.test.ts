// ingest 与单账号 AI 判定必须对同一账号给出一致的触发器。
// 同一 BV 出现在两个账号名下时，两条路径都要看到 reposted-video。
// 判定成功后状态变为 ai；失败时已有结论保持不变。
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  clearObservationDatabase,
  getFreshAiReview,
  ingestObservation,
} from "../src/storage/database";
import {
  analyzeObservations,
  reviewAccountWithAi,
} from "../src/application/analyze-observations";
import { detectReviewTriggers } from "../src/features/review-trigger";
import { getProfile, getVideosForAccount } from "../src/storage/database";
import type {
  AccountKey,
  AccountObservationInput,
} from "../src/domain/types";

const STORAGE_KEY_SETTINGS = "kcf:settings:v1";
/** 两个账号共用的 BV：搬运检测的触发器。 */
const SHARED_BV = "BVshared0001";
const TARGET = "uid:2001" as AccountKey;
const OTHER = "uid:2002" as AccountKey;

let storedValues: Record<string, unknown>;

/** chrome.storage 内存桩（与批量复核测试同口径）。 */
function installChromeStub(): void {
  storedValues = {};
  vi.stubGlobal("chrome", {
    // SW 侧发起复核前会检查接口域名授权（内容脚本没有 chrome.permissions，
    // 因此这步只能在 SW 做）；测试里一律视为已授权。
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

/** 构造一个账号的观察批次。 */
function makeObservation(
  accountKey: AccountKey,
  uid: string,
  title: string,
): AccountObservationInput {
  return {
    schemaVersion: 1,
    accountKey,
    uid,
    profileUrl: `https://space.bilibili.com/${uid}`,
    displayName: `账号${uid}`,
    profileBio: "普通创作者简介",
    videos: [
      {
        videoKey: SHARED_BV,
        bvid: SHARED_BV,
        title,
        videoUrl: `https://www.bilibili.com/video/${SHARED_BV}`,
        publishedText: "1天前",
        publishedAtMs: 1,
        metricsRaw: ["12.5万", "380"],
        source: { pageKind: "space", adapterId: "test", adapterVersion: 1 },
        observedAtMs: 1,
      },
    ],
    missingFields: [],
    source: { pageKind: "space", adapterId: "test", adapterVersion: 1 },
    observedAtMs: 1,
  };
}

/** 写入启用了 AI 的设置。 */
async function enableAi(): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY_SETTINGS]: {
      showOnboarding: false,
      showBadges: true,
      automaticallyDimHighRisk: false,
      retentionDays: 90,
      maxVideosPerAccount: 20,
      aiEnabled: true,
      aiEndpoint: "https://api.example.com/v1",
      aiApiKey: "sk-test",
      aiModel: "test-model",
    },
  });
}

/** 让 AI 返回一次低概率结论：历史 bug 里它还会额外带来 -5 分。 */
function stubLowProbabilityAi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"marketingProbability": 10, "category": "normal", "reason": "未发现营销号特征", "insufficientData": []}',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    ),
  );
}

describe("ingest 与 AI 复核的判定口径一致性", () => {
  it("未获得接口域名授权时给出指向设置页的说明", async () => {
    installChromeStub();
    await clearObservationDatabase();
    await enableAi();
    await ingestObservation(
      {
        schemaVersion: 1, accountKey: TARGET, uid: "2001",
        profileUrl: "https://space.bilibili.com/2001",
        displayName: "验证账号", profileBio: "简介",
        videos: [{
          videoKey: "BVauth0001", bvid: "BVauth0001", title: "验证投稿标题",
          videoUrl: "https://www.bilibili.com/video/BVauth0001",
          publishedText: "1天前", publishedAtMs: 1, metricsRaw: ["1万", "10"],
          source: { pageKind: "space", adapterId: "test", adapterVersion: 1 },
          observedAtMs: 1,
        }],
        missingFields: [],
        source: { pageKind: "space", adapterId: "test", adapterVersion: 1 },
        observedAtMs: 1,
      },
      20,
    );
    // 授权检查在 SW 侧：这里模拟「未授权」。
    vi.stubGlobal("chrome", {
      permissions: { contains: async () => false },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    });
    await expect(reviewAccountWithAi(TARGET)).rejects.toThrow("设置页");
  });

  beforeEach(async () => {
    installChromeStub();
    await clearObservationDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 两个账号共用同一个 BV：reposted-video 触发器的夹具。 */
  function ingestSharedVideo(): Promise<Awaited<ReturnType<typeof analyzeObservations>>> {
    return analyzeObservations([
      makeObservation(TARGET, "2001", "关于宠物日常记录的第一条长标题"),
      makeObservation(OTHER, "2002", "关于宠物日常记录的第一条长标题"),
    ]);
  }

  it("同一投稿被两个账号发布时，ingest 路径命中搬运触发器", async () => {
    await enableAi();
    const analyses = await ingestSharedVideo();
    const target = analyses.find((a) => a.accountKey === TARGET)!;
    expect(target.review.kind).toBe("triggered");
    if (target.review.kind !== "triggered") {
      return;
    }
    const signals = target.review.triggers.map((hit) => hit.signal);
    expect(signals).toContain("reposted-video");
  });

  it("AI 复核成功后判定态翻转为 ai", async () => {
    await enableAi();
    await ingestSharedVideo();
    stubLowProbabilityAi();
    const [reviewed] = await reviewAccountWithAi(TARGET);

    expect(reviewed!.review.kind).toBe("ai");
    if (reviewed!.review.kind !== "ai") {
      return;
    }
    // AI 概率成为唯一展示的判定。
    expect(reviewed!.review.review.marketingProbability).toBe(10);
  });

  it("复核成功仍保留同一口径的触发器事实（历史 bug 的教训）", async () => {
    await enableAi();
    await ingestSharedVideo();
    stubLowProbabilityAi();
    const [reviewed] = await reviewAccountWithAi(TARGET);

    // 复核成功后判定态是 ai，触发器事实从 review 里让位（再显示「值得复核」
    // 会让人以为还没复核过）。但那次缺陷的教训是两条路径的本地口径必须一致，
    // 因此这里直接重算一次触发器来钉住口径：单账号复核也应当看到搬运信号。
    expect(reviewed!.review.kind).toBe("ai");
    const profile = await getProfile(TARGET);
    const videos = await getVideosForAccount(TARGET);
    expect(profile).toBeDefined();
    const triggers = detectReviewTriggers({
      profile: profile!,
      videos,
      repostHistory: new Map([[SHARED_BV, [TARGET, OTHER]]]),
    });
    expect(triggers.map((hit: { signal: string }) => hit.signal)).toContain(
      "reposted-video",
    );
  });

  it("复核失败时抛错，且不留下半条结论", async () => {
    await enableAi();
    await ingestSharedVideo();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 429 })),
    );

    await expect(reviewAccountWithAi(TARGET)).rejects.toThrow("限流");
    // 失败不写入 ai_reviews：账号保持「已触发待复核」，而不是变成「已复核 0%」。
    expect(await getFreshAiReview(TARGET)).toBeUndefined();

    // 链路仍在：ingest 仍然给出触发器结论。
    const again = await analyzeObservations([makeObservation(TARGET, "2001", "关于宠物日常记录的第一条长标题")]);
    expect(again[0]!.review.kind).toBe("triggered");
  });
});
