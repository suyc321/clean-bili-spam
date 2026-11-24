import { describe, expect, it } from "vitest";
import { accountsNeedingAutoReview } from "../src/content/auto-review";
import type { AccountAnalysis, AccountKey } from "../src/domain/types";

function analysis(
  accountKey: AccountKey,
  kind: AccountAnalysis["review"]["kind"],
  disposition: AccountAnalysis["disposition"] = "none",
): AccountAnalysis {
  return {
    accountKey,
    uid: accountKey.slice(4),
    observedVideos: 1,
    hasBio: false,
    review:
      kind === "ai"
        ? {
            kind: "ai",
            review: {
              accountKey,
              marketingProbability: 80,
              category: "marketing",
              reason: "测试",
              insufficientData: [],
              model: "test",
              reviewedAtMs: 1,
            },
          }
        : kind === "triggered"
          ? { kind: "triggered", triggers: [] }
          : { kind: "none" },
    disposition,
  };
}

describe("滚动后的自动判定人选", () => {
  it("跳过已有结论、排队中和重复出现的账号", () => {
    const analyses = new Map<AccountKey, AccountAnalysis>([
      ["uid:1", analysis("uid:1", "none")],
      ["uid:2", analysis("uid:2", "ai")],
      ["uid:3", analysis("uid:3", "triggered")],
    ]);
    const selected = accountsNeedingAutoReview(
      ["uid:1", "uid:1", "uid:2", "uid:3", "uid:4"],
      analyses,
      new Set(["uid:3"]),
    );
    expect(selected).toEqual(["uid:1"]);
  });

  it("跳过白名单与忽略账号，但保留待处理账号", () => {
    const analyses = new Map<AccountKey, AccountAnalysis>([
      ["uid:1", analysis("uid:1", "none", "whitelisted")],
      ["uid:2", analysis("uid:2", "triggered", "ignored")],
      ["uid:3", analysis("uid:3", "none", "candidate")],
      ["uid:4", analysis("uid:4", "none", "none")],
    ]);
    expect(
      accountsNeedingAutoReview(
        ["uid:1", "uid:2", "uid:3", "uid:4"],
        analyses,
        new Set(),
      ),
    ).toEqual(["uid:3", "uid:4"]);
  });
});
