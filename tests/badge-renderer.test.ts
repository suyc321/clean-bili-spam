// 标签渲染测试：三态判定各自的徽章文案与配色、渲染去重（面板保持）、
// 重绘触发、高风险分档、AI 未配置提示与无障碍属性。
import { beforeEach, describe, expect, it } from "vitest";
import type { ExtractedCard } from "../src/adapters/contract";
import type {
  AccountAnalysis,
  ExtensionSettings,
  ReviewTriggerHit,
} from "../src/domain/types";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import {
  isHighRisk,
  refreshAiUnavailable,
  removeAllBadges,
  renderBadge,
} from "../src/content/badge-renderer";

const KEY = "uid:123" as const;

/** 一条 AI 结论；probability 由调用方给。 */
function aiOutcome(marketingProbability: number): AccountAnalysis["review"] {
  return {
    kind: "ai",
    review: {
      accountKey: KEY,
      marketingProbability,
      category: "uncertain",
      reason: "标题模板化明显",
      insufficientData: [],
      model: "test-model",
      reviewedAtMs: 1_000,
    },
  };
}

describe("三态判定的徽章", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    refreshAiUnavailable([]);
  });

  it("首次渲染创建标签和隐藏面板，并携带可读的 aria 信息", () => {
    const card = makeCard();
    renderBadge(card, makeAnalysis(aiOutcome(40)), DEFAULT_SETTINGS, noop);

    const host = requireHost(card.mount.cardElement);
    const badge = host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    const panel = host.shadowRoot!.querySelector<HTMLDivElement>(".panel")!;

    expect(badge.textContent).toBe("AI 40%");
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(badge.getAttribute("aria-label")).toContain("AI 判定营销号概率 40%");
    expect(panel.hidden).toBe(true);
    expect(panel.getAttribute("role")).toBe("group");
  });

  it("无判定态显示中性徽章，而不是「低风险」", () => {
    const card = makeCard();
    renderBadge(
      card,
      makeAnalysis({ kind: "none" }),
      DEFAULT_SETTINGS,
      noop,
    );
    const badge = requireHost(card.mount.cardElement)
      .shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    expect(badge.textContent).toBe("⚪ 无判定");
    expect(badge.className).toContain("muted");
  });

  it("触发器命中显示「值得复核」", () => {
    const card = makeCard();
    const triggers: ReviewTriggerHit[] = [
      { signal: "resource-trafficking", detail: "有 1 条投稿标题在兜售成套可下载资源" },
    ];
    renderBadge(
      card,
      makeAnalysis({ kind: "triggered", triggers }),
      DEFAULT_SETTINGS,
      noop,
    );
    const badge = requireHost(card.mount.cardElement)
      .shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    expect(badge.textContent).toBe("🔎 值得复核");
    // 刻意用独立配色，不与高风险的红色系混淆。
    expect(badge.className).toContain("trigger");
    expect(badge.textContent).not.toMatch(/\d/);
    // 按钮默认底是浅灰。不写 .badge.trigger 的话，白字会落在 #f0f0f0 上。
    const stylesheet =
      requireHost(card.mount.cardElement).shadowRoot!.querySelector("style")
        ?.textContent ?? "";
    const triggerRule = /\.badge\.trigger\s*\{([^}]*)\}/.exec(stylesheet);
    expect(triggerRule).not.toBeNull();
    expect(triggerRule?.[1]).toMatch(/background:\s*#[0-9a-f]{6}/i);
    expect(triggerRule?.[1]).not.toContain("#c9343f");
    expect(triggerRule?.[1]).not.toContain("#f0f0f0");
  });

  it("AI 开启时提供复核按钮，结论以提示条展示", () => {
    const card = makeCard();
    const aiSettings: ExtensionSettings = {
      ...DEFAULT_SETTINGS,
      aiEnabled: true,
    };
    let reviewCalls = 0;
    const onAiReview = (): Promise<void> => {
      reviewCalls += 1;
      return Promise.resolve();
    };

    // 未复核：只有「AI 判定」按钮，无结论提示条。
    renderBadge(
      card,
      makeAnalysis({ kind: "triggered", triggers: [repostTrigger] }),
      aiSettings,
      noop,
      onAiReview,
    );
    const host = requireHost(card.mount.cardElement);
    expect(
      [...host.shadowRoot!.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("AI 判定"),
      ),
    ).toBe(true);
    expect(host.shadowRoot!.querySelector(".notice.ai-notice")).toBeNull();

    // 已判定：提示条展示模型与概率，按钮变为「重新判定」。
    renderBadge(card, makeAnalysis(aiOutcome(82)), aiSettings, noop, onAiReview);
    const aiNotice = host.shadowRoot!.querySelector(".notice.ai-notice")!;
    expect(aiNotice.textContent).toContain("82%");
    expect(aiNotice.textContent).toContain("test-model");
    expect(
      [...host.shadowRoot!.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("重新判定"),
      ),
    ).toBe(true);
  });

  it("AI 关闭时不显示复核按钮，面板说明功能未配置", () => {
    const card = makeCard();
    renderBadge(card, makeAnalysis(aiOutcome(82)), DEFAULT_SETTINGS, noop, noop);
    const host = requireHost(card.mount.cardElement);
    expect(
      [...host.shadowRoot!.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("AI 判定"),
      ),
    ).toBe(false);
    // 没有本地兜底：面板说明尚未配置 AI，徽章正文仍是「无判定」。
    host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!.click();
    expect(surfaceOf(host).textContent).toContain("尚未在设置页配置 AI 接口");
  });

  it("状态未变化时跳过重绘，保持用户展开的面板", () => {
    const card = makeCard();
    const analysis = makeAnalysis(aiOutcome(40));
    renderBadge(card, analysis, DEFAULT_SETTINGS, noop);

    const host = requireHost(card.mount.cardElement);
    const badge = host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    badge.click();
    expect(surfaceOf(host).querySelector<HTMLDivElement>(".panel")!.hidden).toBe(
      false,
    );

    renderBadge(card, analysis, DEFAULT_SETTINGS, noop);

    expect(surfaceOf(host).querySelector<HTMLDivElement>(".panel")!.hidden).toBe(
      false,
    );
  });

  it("判定结果变化时重绘标签并重置面板", () => {
    const card = makeCard();
    renderBadge(card, makeAnalysis(aiOutcome(40)), DEFAULT_SETTINGS, noop);
    const host = requireHost(card.mount.cardElement);
    host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!.click();

    renderBadge(card, makeAnalysis(aiOutcome(85)), DEFAULT_SETTINGS, noop);

    const badge = host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    expect(badge.textContent).toBe("AI 85%");
    expect(
      host.shadowRoot!.querySelector<HTMLDivElement>(".panel")!.hidden,
    ).toBe(true);
  });

  it("AI 概率分档由 isHighRisk 判定（弱化遮罩与徽章配色同一常量）", () => {
    expect(isHighRisk(makeAnalysis(aiOutcome(85)))).toBe(true);
    expect(isHighRisk(makeAnalysis(aiOutcome(79)))).toBe(false);
    expect(isHighRisk(undefined)).toBe(false);
  });

  it("removeAllBadges 移除所有宿主", () => {
    const card = makeCard();
    renderBadge(card, makeAnalysis(aiOutcome(40)), DEFAULT_SETTINGS, noop);
    removeAllBadges();
    expect(card.mount.cardElement.querySelector(".kcf-badge-host")).toBeNull();
  });

  it("展开面板时抬升宿主与卡片层级，关闭后还原", () => {
    const card = makeCard();
    renderBadge(card, makeAnalysis(aiOutcome(40)), DEFAULT_SETTINGS, noop);
    const host = requireHost(card.mount.cardElement);
    const badge = host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    const cardElement = card.mount.cardElement;

    // 渲染器会把静态定位的卡片改为 relative，但不动层级。
    expect(host.style.zIndex).toBe("");
    expect(cardElement.style.zIndex).toBe("");

    badge.click();
    // 抬升后高于页面上任何其他卡片宿主（默认 z-index 30）。
    expect(Number(host.style.zIndex)).toBeGreaterThan(30);
    expect(cardElement.style.zIndex).toBe(host.style.zIndex);

    badge.click();
    expect(host.style.zIndex).toBe("");
    expect(cardElement.style.zIndex).toBe("");
  });

  it("Esc 关闭面板时同样还原层级抬升", () => {
    const card = makeCard();
    renderBadge(card, makeAnalysis(aiOutcome(40)), DEFAULT_SETTINGS, noop);
    const host = requireHost(card.mount.cardElement);
    const badge = host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    const panel = host.shadowRoot!.querySelector<HTMLDivElement>(".panel")!;

    badge.click();
    expect(Number(host.style.zIndex)).toBeGreaterThan(30);

    panel.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(panel.hidden).toBe(true);
    expect(host.style.zIndex).toBe("");
    expect(card.mount.cardElement.style.zIndex).toBe("");
  });

  it("提供深度判定回调时面板出现「打开主页」按钮并触发回调", async () => {
    const card = makeCard();
    let opened = 0;
    renderBadge(
      card,
      makeAnalysis(aiOutcome(40)),
      DEFAULT_SETTINGS,
      noop,
      undefined,
      async () => {
        opened += 1;
      },
    );
    const host = requireHost(card.mount.cardElement);
    const badge = host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    const button = [
      ...host.shadowRoot!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent?.includes("深度判定"));
    expect(button).toBeDefined();

    badge.click();
    await button!.click();
    expect(opened).toBe(1);
  });

  it("不提供深度判定回调时不显示该按钮", () => {
    const card = makeCard();
    renderBadge(card, makeAnalysis(aiOutcome(40)), DEFAULT_SETTINGS, noop);
    const host = requireHost(card.mount.cardElement);
    const hasButton = [
      ...host.shadowRoot!.querySelectorAll("button"),
    ].some((item) => item.textContent?.includes("深度判定"));
    expect(hasButton).toBe(false);
  });

  it("AI 结论展示概率和理由", () => {
    const card = makeCard();
    renderBadge(card, makeAnalysis(aiOutcome(82)), DEFAULT_SETTINGS, noop);

    const host = requireHost(card.mount.cardElement);
    const badge = host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    expect(badge.textContent).toBe("AI 82%");
    expect(badge.className).toContain("high");
    expect(badge.getAttribute("aria-label")).toContain("AI 判定营销号概率 82%");

    badge.click();
    const primary = surfaceOf(host).querySelector(".notice.ai-notice.primary")!;
    expect(primary.textContent).toContain("82%");
    expect(primary.textContent).toContain("营销号概率");
  });

  // 模型声明的证据缺口展示在面板里，用户据此决定要不要打开主页。
  it("AI 自陈的证据不足项展示在面板里", () => {
    const card = makeCard();
    const review = aiOutcome(70);
    if (review.kind !== "ai") {
      return;
    }
    review.review.insufficientData = [
      "未获取账号粉丝量与互动数据",
      "未查看视频实际内容",
    ];
    renderBadge(card, makeAnalysis(review), DEFAULT_SETTINGS, noop);
    const host = requireHost(card.mount.cardElement);
    host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!.click();

    const gaps = surfaceOf(host).querySelector(".notice.ai-gaps");
    expect(gaps).not.toBeNull();
    expect(gaps!.textContent).toContain("证据不足");
    expect(gaps!.textContent).toContain("未获取账号粉丝量与互动数据");
    expect(gaps!.textContent).toContain("未查看视频实际内容");
  });

  it("AI 没有自陈证据缺口时不渲染该区块", () => {
    const card = makeCard();
    renderBadge(card, makeAnalysis(aiOutcome(70)), DEFAULT_SETTINGS, noop);
    const host = requireHost(card.mount.cardElement);
    host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!.click();
    expect(surfaceOf(host).querySelector(".notice.ai-gaps")).toBeNull();
  });

  it("AI 概率分档决定徽章配色（80/60 两档）", () => {
    const badgeClassOf = (probability: number): string => {
      const card = makeCard();
      renderBadge(card, makeAnalysis(aiOutcome(probability)), DEFAULT_SETTINGS, noop);
      return requireHost(card.mount.cardElement).shadowRoot!
        .querySelector<HTMLButtonElement>(".badge")!.className;
    };
    expect(badgeClassOf(85)).toContain("high");
    expect(badgeClassOf(65)).toContain("suspicious");
    expect(badgeClassOf(20)).toContain("low");
  });

  it("触发器命中时面板列出事实，且不给出任何结论性措辞", () => {
    const card = makeCard();
    const triggers: ReviewTriggerHit[] = [
      { signal: "repost-disclaimer", detail: "简介含侵权免责声明（搬运/切片号的典型自述）" },
      { signal: "burst-posting", detail: "24 小时内投稿不少于 5 条" },
    ];
    renderBadge(
      card,
      makeAnalysis({ kind: "triggered", triggers }),
      DEFAULT_SETTINGS,
      noop,
    );
    const host = requireHost(card.mount.cardElement);
    host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!.click();
    const text = surfaceOf(host).textContent ?? "";
    // 事实全部呈现。
    expect(text).toContain("简介含侵权免责声明");
    expect(text).toContain("24 小时内投稿不少于 5 条");
    // 但不构成判定。
    expect(text).toContain("这不构成判定");
    expect(text).not.toContain("疑似");
    expect(text).not.toContain("营销号概率");
  });

  it("展开后面板离开卡片，高度只受屏幕剩余空间限制", () => {
    const card = makeCard();
    renderBadge(card, makeAnalysis(aiOutcome(20)), DEFAULT_SETTINGS, noop);
    const host = requireHost(card.mount.cardElement);
    host.shadowRoot!.querySelector<HTMLButtonElement>(".badge")!.click();

    const floated = document
      .getElementById("kcf-panel-float")
      ?.shadowRoot?.querySelector<HTMLDivElement>(".panel");
    expect(floated).toBeDefined();
    expect(floated!.hidden).toBe(false);
    expect(floated!.style.position).toBe("fixed");
    expect(floated!.style.maxHeight.endsWith("px")).toBe(true);
    expect(host.shadowRoot!.querySelector(".panel")).toBeNull();
  });
});

/** 空操作回调：测试中不需要真正处理处置请求。 */
function noop(): Promise<void> {
  return Promise.resolve();
}

/** 展开后面板在视口层；关闭后回到卡片 Shadow Root。 */
function surfaceOf(host: HTMLElement): ParentNode {
  const floated = document
    .getElementById("kcf-panel-float")
    ?.shadowRoot?.querySelector(".panel");
  if (floated?.parentNode !== null && floated?.parentNode !== undefined) {
    return floated.parentNode;
  }
  return host.shadowRoot!;
}

/** 获取卡片上已创建的标签宿主；未创建或 Shadow 缺失时直接失败。 */
function requireHost(cardElement: HTMLElement): HTMLElement {
  const host = cardElement.querySelector<HTMLElement>(".kcf-badge-host");
  if (host === null || host.shadowRoot === null) {
    throw new Error("标签宿主尚未创建。");
  }
  return host;
}

/** 构造最小可渲染的卡片（含挂载点并已插入文档）。 */
function makeCard(): ExtractedCard {
  const cardElement = document.createElement("div");
  const anchorElement = document.createElement("a");
  cardElement.append(anchorElement);
  document.body.append(cardElement);
  return {
    cardKey: "test:BV1:uid:123",
    accountKey: KEY,
    uid: "123",
    uidSource: "card",
    displayName: "测试账号",
    profileUrl: "https://space.bilibili.com/123",
    video: {
      videoKey: "BV1",
      bvid: "BV1",
      title: "测试标题",
      videoUrl: "https://www.bilibili.com/video/BV1",
      metricsRaw: [],
      source: { pageKind: "home", adapterId: "test", adapterVersion: 1 },
      observedAtMs: 1_000,
    },
    missingFields: [],
    source: { pageKind: "home", adapterId: "test", adapterVersion: 1 },
    mount: { cardElement, anchorElement },
  };
}

const repostTrigger: ReviewTriggerHit = {
  signal: "repost-disclaimer",
  detail: "简介含侵权免责声明",
};

/** 构造指定判定态与处置状态的分析结果。 */
function makeAnalysis(
  review: AccountAnalysis["review"],
  disposition: AccountAnalysis["disposition"] = "none",
): AccountAnalysis {
  return {
    accountKey: KEY,
    uid: "123",
    displayName: "测试账号",
    observedVideos: 5,
    hasBio: true,
    review,
    disposition,
  };
}

// AI 判定失败态：判定只由 AI 产出，失败后账号没有任何结论。
// 不加标记的话，徽章与「本地没触发」的中性灰长得一样，用户会误读成「没问题」。
describe("AI 判定失败的徽章", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("复核失败的账号徽章显示「AI 未取得结论」并使用降级配色", () => {
    refreshAiUnavailable(["uid:123"]);
    const card = makeCard();
    renderBadge(
      card,
      makeAnalysis({ kind: "none" }),
      DEFAULT_SETTINGS,
      noop,
    );
    const badge = requireHost(card.mount.cardElement)
      .shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    expect(badge.textContent).toBe("⚪ AI 未取得结论");
    expect(badge.className).toContain("degraded");
    // 读屏用户也能听出区别。
    expect(badge.getAttribute("aria-label")).toContain("AI 判定未取得结论");
  });

  it("未失败的账号不受影响", () => {
    refreshAiUnavailable([]);
    const card = makeCard();
    renderBadge(
      card,
      makeAnalysis({ kind: "none" }),
      DEFAULT_SETTINGS,
      noop,
    );
    const badge = requireHost(card.mount.cardElement)
      .shadowRoot!.querySelector<HTMLButtonElement>(".badge")!;
    expect(badge.textContent).toBe("⚪ 无判定");
    expect(badge.className).not.toContain("degraded");
  });
});
