// 页面级扫描统计：健康度必须按整页已见卡片算，而不是按单轮候选子集。
import { describe, expect, it } from "vitest";
import type { ExtractedCard } from "../src/adapters/contract";
import type { AccountKey } from "../src/domain/types";
import { summarizePageCards } from "../src/content/page-stats";

/** 只关心身份是否解析成功，其余字段与统计无关。 */
function card(accountKey?: AccountKey): ExtractedCard {
  return { accountKey } as ExtractedCard;
}

describe("页面级扫描统计", () => {
  it("没有卡片时判为降级", () => {
    expect(summarizePageCards([])).toEqual({
      scannedCards: 0,
      unresolvedCards: 0,
      health: "degraded",
    });
  });

  it("整页只有一张失败卡片时才是降级", () => {
    expect(summarizePageCards([card()])).toEqual({
      scannedCards: 1,
      unresolvedCards: 1,
      health: "degraded",
    });
  });

  it("增量扫描里的一张失败卡片不会把整页判成降级", () => {
    // 模拟首页：100 张正常卡片 + 1 张没有作者链接的新卡片。
    // 旧实现只看这一张候选，会算成 1/1 = 100% 失败。
    const cards = [
      ...Array.from({ length: 100 }, (_, index) =>
        card(`uid:${index + 1}` as AccountKey),
      ),
      card(),
    ];
    expect(summarizePageCards(cards)).toEqual({
      scannedCards: 101,
      unresolvedCards: 1,
      health: "healthy",
    });
  });

  it("恰好一半失败仍算健康，超过一半才降级", () => {
    expect(
      summarizePageCards([card("uid:1" as AccountKey), card()]).health,
    ).toBe("healthy");
    expect(
      summarizePageCards([
        card("uid:1" as AccountKey),
        card(),
        card(),
      ]).health,
    ).toBe("degraded");
  });
});
