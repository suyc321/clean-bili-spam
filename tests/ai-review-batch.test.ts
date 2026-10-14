// 批量 AI 复核测试：逐个调用、单个失败不中断、AI 未启用时抛错。
// 用 fake-indexeddb 预置账号观察，并 stub 全局 fetch 模拟 AI 接口。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearObservationDatabase,
  ingestObservation,
} from "../src/storage/database";
import { reviewAccountsWithAi } from "../src/application/analyze-observations";

const STORAGE_KEYS = {
  settings: "kcf:settings:v1",
  whitelist: "kcf:whitelist:v1",
  ignored: "kcf:ignored:v1",
  candidates: "kcf:candidates:v1",
};

let storedValues: Record<string, unknown>;

/** chrome.storage 内存桩：local-state 与设置读取都走它。 */
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

/** 预置一个带 3 条投稿的账号观察。 */
async function seedAccount(uid: string): Promise<void> {
  await ingestObservation(
    {
      schemaVersion: 1,
      accountKey: `uid:${uid}`,
      uid,
      profileUrl: `https://space.bilibili.com/${uid}`,
      displayName: `账号${uid}`,
      profileBio: "普通创作者简介",
      videos: ["甲", "乙", "丙"].map((label, index) => ({
        videoKey: `BVseed${uid}${index}`,
        bvid: `BVseed${uid}${index}`,
        title: `测试投稿${label}`,
        videoUrl: `https://www.bilibili.com/video/BVseed${uid}${index}`,
        metricsRaw: ["12.5万", "380"],
        source: { pageKind: "space", adapterId: "test", adapterVersion: 1 },
        observedAtMs: 1,
      })),
      missingFields: [],
      source: { pageKind: "space", adapterId: "test", adapterVersion: 1 },
      observedAtMs: 1,
    },
    20,
  );
}

/** 写入启用了 AI 的设置。 */
async function enableAi(
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: {
      showOnboarding: false,
      showBadges: true,
      automaticallyDimHighRisk: false,
      retentionDays: 90,
      maxVideosPerAccount: 20,
      aiEnabled: true,
      aiEndpoint: "https://api.example.com/v1",
      aiApiKey: "sk-test",
      aiModel: "test-model",
      ...overrides,
    },
  });
}

describe("批量 AI 复核", () => {
  beforeEach(async () => {
    installChromeStub();
    await clearObservationDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("逐个复核成功时返回全部分析结果", async () => {
    await enableAi();
    await seedAccount("1001");
    await seedAccount("1002");
    // 每次返回新的 Response：同一个 Response 的 body 只能被消费一次。
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '{"marketingProbability": 75, "category": "marketing", "reason": "模板化量产", "insufficientData": []}',
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const result = await reviewAccountsWithAi(["uid:1001", "uid:1002"]);
    expect(result.analyses).toHaveLength(2);
    expect(result.skipped).toBe(0);
    // 两个账号都拿到了 AI 结论：复核后判定态从触发器/无判定变为 ai。
    for (const analysis of result.analyses) {
      expect(analysis.review.kind).toBe("ai");
    }
    // AI 是唯一外发路径：每个账号一次请求。
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("单个账号失败（无观察/接口错误）不中断整批", async () => {
    await enableAi();
    await seedAccount("1001");
    // uid:1002 没有预置观察 → 应被跳过。
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        call += 1;
        // 第一个请求成功，第二个请求失败：验证失败也只跳过自己。
        return call === 1
          ? Promise.resolve(
              new Response(
                JSON.stringify({
                  choices: [
                    {
                      message: {
                        content: '{"marketingProbability": 40, "category": "uncertain", "reason": "证据不足", "insufficientData": []}',
                      },
                    },
                  ],
                }),
                { status: 200 },
              ),
            )
          : Promise.resolve(new Response("boom", { status: 500 }));
      }),
    );
    await seedAccount("1003");

    const result = await reviewAccountsWithAi(["uid:1001", "uid:1002", "uid:1003"]);
    expect(result.analyses).toHaveLength(1);
    expect(result.analyses[0]?.accountKey).toBe("uid:1001");
    expect(result.skipped).toBe(2);
    vi.unstubAllGlobals();
  });

  it("AI 未启用时直接抛错（调用方误用）", async () => {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: { aiEnabled: false },
    });
    await expect(reviewAccountsWithAi(["uid:1001"])).rejects.toThrow("AI 判定未启用");
  });
});
