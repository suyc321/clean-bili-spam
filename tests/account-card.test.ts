// UP 主公开名片补全测试：字段路径、稀疏合并语义、比值信号、失败静默。
//
// 关键背景（2026-09-25 实测）：`x/web-interface/card` 的投稿数在
// `data.archive_count` 而不是 `data.card.archive_count`，认证信息是对象
// （official_verify.type）而不是数字 Official——这两处都踩过坑，故钉住。
import { describe, expect, it, vi } from "vitest";
import {
  archiveToFansRatio,
  clearCardCache,
  fetchAccountCard,
} from "../src/api/account-card";

/** 构造名片接口的成功响应。 */
function cardResponse(overrides: {
  sign?: string;
  fans?: number;
  archive_count?: number;
  attention?: number;
  verifyType?: number;
  verifyDesc?: string;
  code?: number;
}): Response {
  return new Response(
    JSON.stringify({
      code: overrides.code ?? 0,
      data: {
        // 投稿数在 data 层，不在 card 层——这是实测的字段位置。
        archive_count: overrides.archive_count,
        card: {
          name: "测试账号",
          sign: overrides.sign,
          fans: overrides.fans,
          attention: overrides.attention,
          Official: { role: 1, title: "" },
          official_verify: {
            type: overrides.verifyType,
            desc: overrides.verifyDesc,
          },
        },
      },
    }),
    { status: 200 },
  );
}

describe("UP 主公开名片", () => {
  it("从正确的层级取到简介、粉丝数与投稿数", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      cardResponse({ sign: "这个人很神秘", fans: 10_895_795, archive_count: 264 }),
    );
    const info = await fetchAccountCard("12345678", fetchImpl as unknown as typeof fetch);
    expect(info).toMatchObject({
      mid: "uid:12345678",
      sign: "这个人很神秘",
      fans: 10_895_795,
      archiveCount: 264,
    });
    // 只读公开数据：不带凭证、不跨域上传任何用户数据。
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("mid=12345678");
    expect(init.credentials).toBe("omit");
  });

  it("空串简介也要保留（表示该 UP 确实没写简介）", async () => {
    clearCardCache();
    const fetchImpl = vi.fn().mockResolvedValue(
      cardResponse({ sign: "", fans: 14_418, archive_count: 103 }),
    );
    const info = await fetchAccountCard("3493114830391296", fetchImpl as unknown as typeof fetch);
    // 「无简介」与「没查过」是两回事：前者是可用信号，后者由 cardFetched 表达。
    expect(info?.sign).toBe("");
  });

  it("认证类型取自 official_verify.type（-1 无 / 0 个人 / 1 机构）", async () => {
    clearCardCache();
    const fetchImpl = vi.fn().mockResolvedValue(
      cardResponse({ sign: "x", fans: 1, archive_count: 1, verifyType: 1 }),
    );
    const info = await fetchAccountCard("1", fetchImpl as unknown as typeof fetch);
    expect(info?.officialVerifyType).toBe(1);
  });

  it("投稿/粉丝比反映农场比例（不设阈值，只出原始值）", () => {
    const creator = {
      mid: "uid:a" as const,
      fans: 10_895_795,
      archiveCount: 264,
      seasonVideos: [],
      fetchedAtMs: 1,
    };
    const farm = {
      mid: "uid:b" as const,
      fans: 14_418,
      archiveCount: 103,
      seasonVideos: [],
      fetchedAtMs: 1,
    };
    // 农场账号的投稿/粉丝比高出两个数量级以上。
    const creatorRatio = archiveToFansRatio(creator)!;
    const farmRatio = archiveToFansRatio(farm)!;
    expect(farmRatio / creatorRatio).toBeGreaterThan(100);
  });

  it("缺粉丝数或投稿数时返回 null", () => {
    expect(
      archiveToFansRatio({
        mid: "uid:a" as const, archiveCount: 10, seasonVideos: [], fetchedAtMs: 1,
      }),
    ).toBeNull();
    expect(
      archiveToFansRatio({
        mid: "uid:a" as const, fans: 0, archiveCount: 10,
        seasonVideos: [], fetchedAtMs: 1,
      }),
    ).toBeNull();
  });

  it("接口返回 code≠0 时静默返回 null", async () => {
    clearCardCache();
    const fetchImpl = vi.fn()
      .mockResolvedValue(cardResponse({ code: -404 }));
    expect(
      await fetchAccountCard("1", fetchImpl as unknown as typeof fetch),
    ).toBeNull();
  });

  it("网络失败时静默返回 null（不打断浏览）", async () => {
    clearCardCache();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    expect(
      await fetchAccountCard("1", fetchImpl as unknown as typeof fetch),
    ).toBeNull();
  });

  it("同一账号在保鲜期内只请求一轮（名片 + 合集共 2 个请求）", async () => {
    clearCardCache();
    // 一次补全是两个请求（名片 + 合集列表），mock 按 URL 分别应答。
    const fetchImpl = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("seasons")
          ? new Response(
              JSON.stringify({ code: 0, data: { items_lists: { seasons_list: [] } } }),
              { status: 200 },
            )
          : cardResponse({ sign: "s", fans: 1, archive_count: 1 }),
      ),
    );
    await fetchAccountCard("42", fetchImpl as unknown as typeof fetch);
    // 第二次命中缓存，不再发任何请求。
    await fetchAccountCard("42", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("合集视频按 bvid 去重，且只取需要的字段", async () => {
    clearCardCache();
    const fetchImpl = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("seasons")
          ? new Response(
              JSON.stringify({
                code: 0,
                data: {
                  items_lists: {
                    seasons_list: [
                      {
                        meta: { season_id: 1, name: "合集甲", total: 3 },
                        archives: [
                          { bvid: "BV1", title: "标题一", pubdate: 1_700_000_000,
                            duration: 60, stat: { view: 100, danmaku: 5 } },
                          // 同一个 BV 出现在第二个合集里——应去重
                          { bvid: "BV1", title: "标题一", pubdate: 1_700_000_000 },
                        ],
                      },
                      {
                        meta: { season_id: 2, name: "合集乙", total: 2 },
                        archives: [
                          { bvid: "BV2", title: "标题二", pubdate: 1_700_100_000,
                            duration: 30, stat: { view: 200, danmaku: 0 } },
                        ],
                      },
                    ],
                  },
                },
              }),
              { status: 200 },
            )
          : cardResponse({ sign: "s", fans: 10, archive_count: 2 }),
      ),
    );
    const info = await fetchAccountCard("42", fetchImpl as unknown as typeof fetch);
    expect(info?.seasonCount).toBe(2);
    expect(info?.seasonVideos).toHaveLength(2);
    expect(info?.seasonVideos[0]).toMatchObject({
      bvid: "BV1", title: "标题一", pubdate: 1_700_000_000,
      duration: 60, view: 100, danmaku: 5,
    });
  });

  it("合集接口失败不影响名片（仍返回名片数据）", async () => {
    clearCardCache();
    const fetchImpl = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("seasons")
          ? new Response("boom", { status: 500 })
          : cardResponse({ sign: "有简介", fans: 999, archive_count: 5 }),
      ),
    );
    const info = await fetchAccountCard("42", fetchImpl as unknown as typeof fetch);
    expect(info?.sign).toBe("有简介");
    expect(info?.fans).toBe(999);
    expect(info?.seasonVideos).toEqual([]);
    expect(info?.seasonCount).toBe(0);
  });

  it("合集接口返回 -352 风控时静默降级", async () => {
    clearCardCache();
    const fetchImpl = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("seasons")
          ? new Response(JSON.stringify({ code: -352, message: "-352" }), { status: 200 })
          : cardResponse({ sign: "s", fans: 1, archive_count: 1 }),
      ),
    );
    const info = await fetchAccountCard("42", fetchImpl as unknown as typeof fetch);
    expect(info?.seasonVideos).toEqual([]);
  });
});
