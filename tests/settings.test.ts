// 设置归一化：缺省补全、空白修剪、未声明字段丢弃、数值裁剪。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_JUDGMENT_CRITERIA,
  DEFAULT_SETTINGS,
  MAX_JUDGMENT_CRITERIA_LENGTH,
  normalizeSettings,
} from "../src/domain/settings";

describe("设置归一化", () => {
  it("旧版本设置缺少 showOnboarding 时补默认值", () => {
    const normalized = normalizeSettings({
      showBadges: true,
      automaticallyDimHighRisk: false,
      retentionDays: 90,
      maxVideosPerAccount: 20,
    });

    expect(normalized.showOnboarding).toBe(true);
    expect(normalized).toEqual(DEFAULT_SETTINGS);
  });

  it("保留用户显式关闭的引导开关", () => {
    const normalized = normalizeSettings({ showOnboarding: false });
    expect(normalized.showOnboarding).toBe(false);
  });

  it("AI 复核默认关闭，配置字段默认为空", () => {
    const normalized = normalizeSettings({});
    expect(normalized.aiEnabled).toBe(false);
    expect(normalized.aiEndpoint).toBe("");
    expect(normalized.aiApiKey).toBe("");
    expect(normalized.aiModel).toBe("");
    expect(normalized.feedAdMode).toBe("cover");
    expect(normalized.coverColor).toBe("dark");
    expect(normalized.logAiExchange).toBe(false);
  });

  it("显式开启判定往来打印时保留", () => {
    expect(normalizeSettings({ logAiExchange: true }).logAiExchange).toBe(
      true,
    );
  });

  it("广告处理三档与遮罩颜色保留显式选择", () => {
    const normalized = normalizeSettings({
      feedAdMode: "remove",
      coverColor: "gray",
    });
    expect(normalized.feedAdMode).toBe("remove");
    expect(normalized.coverColor).toBe("gray");
  });

  it("非法档位与颜色回退默认", () => {
    const normalized = normalizeSettings({
      feedAdMode: "nuke" as never,
      coverColor: "pink" as never,
    });
    expect(normalized.feedAdMode).toBe("cover");
    expect(normalized.coverColor).toBe("dark");
  });

  it("旧版布尔开关 coverFeedAds 迁移为三档", () => {
    expect(normalizeSettings({ coverFeedAds: false }).feedAdMode).toBe("off");
    expect(normalizeSettings({ coverFeedAds: true }).feedAdMode).toBe("cover");
    // 新字段优先：新旧同时存在时按新字段，不重复迁移。
    expect(
      normalizeSettings({ feedAdMode: "remove", coverFeedAds: false })
        .feedAdMode,
    ).toBe("remove");
  });

  it("AI 配置字符串统一去首尾空白", () => {
    const normalized = normalizeSettings({
      aiEnabled: true,
      aiEndpoint: "  https://api.openai.com/v1 ",
      aiApiKey: " sk-x ",
      aiModel: " glm-4-flash ",
    });
    expect(normalized.aiEnabled).toBe(true);
    expect(normalized.aiEndpoint).toBe("https://api.openai.com/v1");
    expect(normalized.aiApiKey).toBe("sk-x");
    expect(normalized.aiModel).toBe("glm-4-flash");
  });

  it("已移除的第二接口字段不会进入归一化结果", () => {
    const normalized = normalizeSettings({
      aiEnabled: true,
      aiEndpoint: "https://api.openai.com/v1",
      aiApiKey: "sk-x",
      aiModel: "gpt-4o-mini",
      ...({
        aiFallbackEnabled: true,
        aiFallbackEndpoint: "https://example.invalid/v1",
        aiFallbackApiKey: "old-key",
        aiFallbackModel: "old-model",
        aiFallbackFormat: "anthropic",
      } as Record<string, unknown>),
    } as Parameters<typeof normalizeSettings>[0]);
    expect(normalized.aiEndpoint).toBe("https://api.openai.com/v1");
    expect(normalized.aiApiKey).toBe("sk-x");
    expect(normalized.aiModel).toBe("gpt-4o-mini");
    expect(normalized).not.toHaveProperty("aiFallbackEnabled");
    expect(normalized).not.toHaveProperty("aiFallbackApiKey");
  });

  it("未声明的字段不会进入归一化结果", () => {
    const normalized = normalizeSettings({
      ...({ leftover: 1 } as Record<string, unknown>),
    } as Parameters<typeof normalizeSettings>[0]);
    expect(normalized).toEqual(DEFAULT_SETTINGS);
    expect("leftover" in normalized).toBe(false);
  });

  it("保留天数和投稿上限裁剪到允许范围", () => {
    const normalized = normalizeSettings({
      retentionDays: 1_000,
      maxVideosPerAccount: 1,
    });
    expect(normalized.retentionDays).toBe(365);
    expect(normalized.maxVideosPerAccount).toBe(5);
  });

  it("判定口径空白或与内置相同都存成空字符串，超长则截断", () => {
    expect(normalizeSettings({}).aiJudgmentCriteria).toBe("");
    expect(
      normalizeSettings({ aiJudgmentCriteria: `  ${DEFAULT_JUDGMENT_CRITERIA}  ` })
        .aiJudgmentCriteria,
    ).toBe("");
    expect(
      normalizeSettings({ aiJudgmentCriteria: "把搬运号看得更重" })
        .aiJudgmentCriteria,
    ).toBe("把搬运号看得更重");
    const long = "标".repeat(MAX_JUDGMENT_CRITERIA_LENGTH + 20);
    expect(
      normalizeSettings({ aiJudgmentCriteria: long }).aiJudgmentCriteria,
    ).toHaveLength(MAX_JUDGMENT_CRITERIA_LENGTH);
  });
});
