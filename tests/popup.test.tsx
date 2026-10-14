// Popup 组件测试：AI 概率徽章、行点击跳转、键盘可达与反馈记录流程。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageAccountSummary, PageSummary } from "../src/domain/types";
import { PopupApp, blockTargetsForBand } from "../src/popup/PopupApp";

/** 构造一份可直接喂给 PopupApp 的页面摘要。 */
function makeSummary(): PageSummary {
  return {
    pageKind: "home",
    scannedCards: 6,
    unresolvedCards: 0,
    adapterHealth: "healthy",
    adapterId: "bilibili-home",
    adapterVersion: 1,
    diagnostics: [
      { selectorKey: "video-card", status: "matched", count: 6 },
    ],
    aiEnabled: false,
    updatedAtMs: 1_700_000_000_000,
    accounts: [
      {
        accountKey: "uid:123",
        uid: "123",
        displayName: "测试账号甲",
        observedVideos: 1,
        aiUnavailable: false,
        review: {
          kind: "ai",
          review: {
            accountKey: "uid:123",
            marketingProbability: 82,
            category: "marketing",
            reason: "简介强引流且投稿标题成套兜售资源",
            insufficientData: [],
            model: "test-model",
            reviewedAtMs: 1_700_000_000_000,
          },
        },
        disposition: "none",
      },
    ],
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
/** 记录 chrome API 的调用，供断言。 */
let runtimeMessages: unknown[];
let createdTabs: { url?: string }[];

function chromeStub(): object {
  return {
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async () => makeSummary(),
      create: async (options: { url?: string }) => {
        createdTabs.push(options);
        return { id: 2 };
      },
    },
    runtime: {
      getManifest: () => ({ version: "0.4.0" }),
      sendMessage: async (message: unknown) => {
        runtimeMessages.push(message);
        return { protocolVersion: 1, requestId: "r", ok: true, data: {} };
      },
      openOptionsPage: async () => undefined,
      onMessage: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
  };
}

function installChromeStub(overrides: object = {}): void {
  runtimeMessages = [];
  createdTabs = [];
  vi.stubGlobal("chrome", { ...chromeStub(), ...overrides });
}

/** 渲染 PopupApp 并等待首次摘要加载完成。 */
async function renderPopup(): Promise<void> {
  await act(async () => {
    root.render(<PopupApp />);
  });
}

/** 模拟一次原生点击（冒泡到 document，与真实点击一致）。 */
function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  // React 需要该标志才会在 act 中刷新效果。
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  installChromeStub();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Popup 界面", () => {
  it("展示 AI 复核概率徽章与账号原因", async () => {
    await renderPopup();

    expect(container.textContent).toContain("82%");
    expect(container.textContent).not.toContain("AI 82%");
    const text = container.textContent ?? "";
    expect(text.indexOf("重新扫描")).toBeGreaterThan(-1);
    expect(text.indexOf("重新扫描")).toBeLessThan(text.indexOf("优先查看"));
    expect(container.textContent).toContain("简介强引流");
    expect(container.textContent).not.toContain("选择器诊断");
  });

  it("适配降级时把选择器诊断放在名单下面，并且默认收起", async () => {
    installChromeStub({
      tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async () => ({
          ...makeSummary(),
          adapterHealth: "degraded",
          diagnostics: [
            { selectorKey: "video-card", status: "missing", count: 0 },
          ],
        }),
        create: async (options: { url?: string }) => {
          createdTabs.push(options);
          return { id: 2 };
        },
      },
    });
    await renderPopup();
    expect(container.textContent).toContain("选择器诊断");
    expect(container.textContent).toContain("video-card");
    const text = container.textContent ?? "";
    expect(text.indexOf("优先查看")).toBeLessThan(text.indexOf("选择器诊断"));
    expect(container.querySelector("details.diagnostics")?.hasAttribute("open")).toBe(
      false,
    );
  });

  it("未配置 AI 时的提示独占操作区一整行，三个按钮同一行", () => {
    const css = readFileSync(resolve("src/popup/popup.css"), "utf8");
    expect(css).toMatch(
      /\.popup-actions\s+\.popup-notice[\s\S]*?grid-column:\s*1\s*\/\s*-1/,
    );
    expect(css).toContain(
      "grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr) minmax(0, 0.75fr)",
    );
    expect(css).not.toMatch(
      /\.popup-actions\s+\.button-wide[\s\S]*?grid-column:\s*1\s*\/\s*-1/,
    );
  });

function triggeredAccount(uid: string, observedVideos: number): PageAccountSummary {
  return {
    accountKey: `uid:${uid}`,
    uid,
    displayName: `账号${uid}`,
    observedVideos,
    aiUnavailable: false,
    review: {
      kind: "triggered",
      triggers: [
        { signal: "resource-trafficking", detail: "有 1 条投稿标题在兜售成套可下载资源" },
      ],
    },
    disposition: "none",
  };
}

function quietAccount(uid: string, observedVideos: number): PageAccountSummary {
  return {
    accountKey: `uid:${uid}`,
    uid,
    displayName: `账号${uid}`,
    observedVideos,
    aiUnavailable: false,
    review: { kind: "none" },
    disposition: "none",
  };
}

function reviewedAccount(
  uid: string,
  observedVideos: number,
  marketingProbability: number,
): PageAccountSummary {
  return {
    accountKey: `uid:${uid}`,
    uid,
    displayName: `账号${uid}`,
    observedVideos,
    aiUnavailable: false,
    review: {
      kind: "ai",
      review: {
        accountKey: `uid:${uid}`,
        marketingProbability,
        category: "normal",
        reason: "未发现营销特征",
        insufficientData: [],
        model: "test-model",
        reviewedAtMs: 1_700_000_000_000,
      },
    },
    disposition: "none",
  };
}

  it("批量复核优先本地触发器命中的账号，并带上尚未复核的", async () => {
    const summary: PageSummary = {
      ...makeSummary(),
      aiEnabled: true,
      accounts: [
        { ...triggeredAccount("A", 1) },
        { ...quietAccount("B", 2) },
        { ...triggeredAccount("C", 1) },
        { ...reviewedAccount("D", 5, 72) },
      ],
    };
    installChromeStub({
      tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async () => summary,
        create: async () => ({ id: 2 }),
      },
    });
    await renderPopup();

    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("AI 判定本页"),
    )!;
    // A、C 有本地信号，排在前面；B 尚无判定，也会送去复核；D 已有 AI 结论，跳过。
    expect(button.textContent).toContain("（3）");
    await act(async () => {
      click(button);
    });
    expect(runtimeMessages).toHaveLength(3);
    expect(runtimeMessages[0]).toMatchObject({
      type: "ai.review.run",
      payload: { accountKey: "uid:A" },
    });
    expect(runtimeMessages[1]).toMatchObject({
      type: "ai.review.run",
      payload: { accountKey: "uid:C" },
    });
    expect(runtimeMessages[2]).toMatchObject({
      type: "ai.review.run",
      payload: { accountKey: "uid:B" },
    });
  });

  it("点击账号行打开 UP 主空间页", async () => {
    await renderPopup();

    const row = container.querySelector(".account-row.clickable")!;
    click(row);

    expect(createdTabs).toEqual([
      { url: "https://space.bilibili.com/123" },
    ]);
  });

  it("Enter 键与点击等价（键盘可达）", async () => {
    await renderPopup();

    const row = container.querySelector<HTMLElement>(".account-row.clickable")!;
    await act(async () => {
      row.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(createdTabs).toEqual([
      { url: "https://space.bilibili.com/123" },
    ]);
  });
});

describe("批量拉黑名单", () => {
  it("只保留该档里未拉黑、不在白名单的账号", () => {
    const accounts: PageAccountSummary[] = [
      account("1", 90, "none"),
      account("2", 85, "whitelisted"),
      account("3", 70, "none"),
      account("4", 40, "none"),
    ];
    const blocked = new Set(["uid:1"]);
    expect(blockTargetsForBand(accounts, "high", blocked).map((item) => item.uid)).toEqual([]);
    expect(blockTargetsForBand(accounts, "suspicious", blocked).map((item) => item.uid)).toEqual([
      "3",
    ]);
  });
});

function account(
  uid: string,
  probability: number,
  disposition: PageAccountSummary["disposition"],
): PageAccountSummary {
  return {
    accountKey: `uid:${uid}`,
    uid,
    observedVideos: 1,
    aiUnavailable: false,
    disposition,
    review: {
      kind: "ai",
      review: {
        accountKey: `uid:${uid}`,
        marketingProbability: probability,
        category: "marketing",
        reason: "理由",
        insufficientData: [],
        model: "m",
        reviewedAtMs: 1,
      },
    },
  };
}
