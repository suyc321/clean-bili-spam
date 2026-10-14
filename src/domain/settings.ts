/**
 * 设置默认值与归一化。
 *
 * 所有从存储或导入文件读到的设置都必须经过 normalizeSettings：
 * 缺失字段补默认值，数值裁剪到允许范围。
 */
import type { CoverColor, ExtensionSettings, FeedAdMode } from "./types";

/** 出厂默认设置。 */
export const DEFAULT_SETTINGS: ExtensionSettings = {
  showBadges: true,
  automaticallyDimHighRisk: false, // 弱化默认关闭：只影响 AI 概率 ≥80 的展示
  feedAdMode: "cover", // 广告和强插默认遮挡：盖住推荐位里没有投稿链接的卡片
  coverColor: "dark", // 遮罩默认纯黑，与早期广告遮挡一致
  retentionDays: 90,
  maxVideosPerAccount: 20,
  showOnboarding: true,
  aiEnabled: false, // AI 判定默认关闭：涉及外部接口与隐私，必须用户显式开启
  aiEndpoint: "",
  aiApiKey: "",
  aiModel: "",
  // 格式缺省 openai_chat：旧配置没有这个字段，缺省即可继续用
  aiFormat: "openai_chat",
  aiJudgmentCriteria: "", // 空字符串：使用内置判定口径
  enrichAccountInfo: false, // 只读公开名片：新增网络行为，默认关闭
  logAiExchange: false, // 后台控制台打印完整请求与响应：含用户数据，默认关闭，排查问题时再开
};

/** 判定口径的长度上限，避免把单次判定的上下文撑得过长。 */
export const MAX_JUDGMENT_CRITERIA_LENGTH = 2_000;

/**
 * 内置判定口径。设置项为空或与这段文字完全相同时，按未修改处理。
 * 输出格式和类别枚举不在这里，见 ai/review-client 的固定契约。
 */
export const DEFAULT_JUDGMENT_CRITERIA = [
  "注意：标题风格夸张不等于营销号；正常创作者也可能有商务合作声明；",
  "投稿数远多于粉丝数（比值高）是内容农场的典型特征，但也可能是刚起步的新号；",
  "概率必须反映真实的不确定程度，证据不足时选择 uncertain 并列出不足项。",
].join("");

/** 合法的接口格式集合（旧数据里出现别的值要回退到缺省）。 */
const AI_FORMATS = new Set<string>(["openai_chat", "anthropic", "responses"]);

const FEED_AD_MODES = new Set<string>(["off", "cover", "remove"]);
const COVER_COLORS = new Set<string>(["dark", "light", "gray"]);

/** 归一化接口格式：非法或缺失一律回退 openai_chat。 */
function normalizeAiFormat(
  value: string | undefined,
): "openai_chat" | "anthropic" | "responses" {
  return value !== undefined && AI_FORMATS.has(value)
    ? (value as "openai_chat" | "anthropic" | "responses")
    : "openai_chat";
}

/**
 * 归一化广告处理档位。
 * 旧版本只有布尔开关 coverFeedAds：true 迁移为遮挡，false 迁移为不处理。
 */
function normalizeFeedAdMode(
  value: string | undefined,
  legacyCoverFeedAds: boolean | undefined,
): FeedAdMode {
  if (value !== undefined && FEED_AD_MODES.has(value)) {
    return value as FeedAdMode;
  }
  if (legacyCoverFeedAds !== undefined) {
    return legacyCoverFeedAds ? "cover" : "off";
  }
  return DEFAULT_SETTINGS.feedAdMode;
}

/** 归一化遮罩颜色：非法或缺失一律回退默认。 */
function normalizeCoverColor(value: string | undefined): CoverColor {
  return value !== undefined && COVER_COLORS.has(value)
    ? (value as CoverColor)
    : DEFAULT_SETTINGS.coverColor;
}

/**
 * 将任意（可能残缺或越界的）设置输入归一化为合法设置。
 *
 * @param input 部分设置，可能来自旧版本存储或导入文件
 * @returns 补全默认值并裁剪范围后的完整设置
 */
export function normalizeSettings(
  input: Partial<ExtensionSettings> & { coverFeedAds?: boolean },
): ExtensionSettings {
  return {
    showBadges: input.showBadges ?? DEFAULT_SETTINGS.showBadges,
    automaticallyDimHighRisk:
      input.automaticallyDimHighRisk ??
      DEFAULT_SETTINGS.automaticallyDimHighRisk,
    feedAdMode: normalizeFeedAdMode(input.feedAdMode, input.coverFeedAds),
    coverColor: normalizeCoverColor(input.coverColor),
    retentionDays: clampInteger(
      input.retentionDays ?? DEFAULT_SETTINGS.retentionDays,
      7,
      365,
    ),
    maxVideosPerAccount: clampInteger(
      input.maxVideosPerAccount ?? DEFAULT_SETTINGS.maxVideosPerAccount,
      5,
      50,
    ),
    showOnboarding:
      input.showOnboarding ?? DEFAULT_SETTINGS.showOnboarding,
    // AI 配置：布尔默认关闭；字符串统一去首尾空白，留空表示未配置。
    aiEnabled: input.aiEnabled ?? DEFAULT_SETTINGS.aiEnabled,
    aiEndpoint: input.aiEndpoint?.trim() ?? DEFAULT_SETTINGS.aiEndpoint,
    aiApiKey: input.aiApiKey?.trim() ?? DEFAULT_SETTINGS.aiApiKey,
    aiModel: input.aiModel?.trim() ?? DEFAULT_SETTINGS.aiModel,
    aiFormat: normalizeAiFormat(input.aiFormat),
    aiJudgmentCriteria: normalizeJudgmentCriteria(input.aiJudgmentCriteria),
    enrichAccountInfo:
      input.enrichAccountInfo ?? DEFAULT_SETTINGS.enrichAccountInfo,
    logAiExchange: input.logAiExchange ?? DEFAULT_SETTINGS.logAiExchange,
  };
}

/**
 * 归一化判定口径。
 * 空白、与内置标准完全相同，都存成空字符串，表示使用内置标准。
 */
function normalizeJudgmentCriteria(value: string | undefined): string {
  const trimmed = (value ?? "").trim().slice(0, MAX_JUDGMENT_CRITERIA_LENGTH);
  if (trimmed === "" || trimmed === DEFAULT_JUDGMENT_CRITERIA) {
    return "";
  }
  return trimmed;
}

/** 四舍五入后裁剪到 [min, max] 区间。 */
function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
