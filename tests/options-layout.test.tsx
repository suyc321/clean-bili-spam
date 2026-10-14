// 设置页：标题下的分段控件，下面一块内容，不铺满屏幕。
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import type { DashboardState } from "../src/domain/types";
import { OptionsApp } from "../src/options/OptionsApp";

vi.mock("../src/messaging/protocol", () => ({
  sendRuntimeRequest: vi.fn(async (type: string) => {
    if (type !== "dashboard.get") {
      throw new Error(`测试未实现 ${type}`);
    }
    const state: DashboardState = {
      settings: DEFAULT_SETTINGS,
      whitelist: [],
      ignored: [],
      candidates: [
        {
          accountKey: "uid:42",
          uid: "42",
          displayName: "折叠测试账号",
          addedAtMs: 1_000,
        },
      ],
      observedAccountCount: 0,
      aiAudit: [],
      blockedAccounts: [],
    };
    return state;
  }),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("chrome", {
    permissions: {
      contains: async () => false,
      request: async () => false,
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderOptions(): Promise<void> {
  await act(async () => {
    root.render(<OptionsApp />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("设置页布局", () => {
  it("标题下两项分段，默认把页面、AI 和授权放在一起", async () => {
    await renderOptions();
    const labels = [...container.querySelectorAll("nav button")].map(
      (button) => button.textContent,
    );
    expect(labels).toEqual(["设置", "名单"]);
    expect(container.textContent).toContain("显示标签");
    expect(container.textContent).toContain("广告和强插");
    expect(container.textContent).toContain("直接隐藏");
    expect(container.textContent).toContain("遮罩颜色");
    expect(container.querySelector("#ai")).not.toBeNull();
    expect(container.textContent).toContain("拉黑授权");
    expect(container.textContent).not.toContain("待处理");
    expect(container.textContent).not.toContain("备用接口");
  });

  it("切到名单后看到待处理", async () => {
    await renderOptions();
    const lists = [...container.querySelectorAll("nav button")].find(
      (button) => button.textContent === "名单",
    );
    await act(async () => {
      lists?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("待处理");
    expect(container.textContent).toContain("导入导出");
    expect(container.querySelector("#ai")).toBeNull();
  });

  it("名单列表默认展开，折叠按钮可收起再展开", async () => {
    await renderOptions();
    const lists = [...container.querySelectorAll("nav button")].find(
      (button) => button.textContent === "名单",
    );
    await act(async () => {
      lists?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const fold = container.querySelector<HTMLDetailsElement>(
      "#candidates details.audit-fold",
    );
    expect(fold).not.toBeNull();
    expect(fold!.open).toBe(true);
    expect(container.textContent).toContain("折叠测试账号");
    // 标题进卡片：summary 里带计数，右侧是折叠按钮。
    const summary = fold!.querySelector("summary")!;
    expect(summary.textContent).toContain("待处理（1）");
    const toggleButton = [...summary.querySelectorAll("button")].find(
      (button) => button.textContent === "折叠",
    );
    expect(toggleButton).toBeDefined();

    await act(async () => {
      toggleButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fold!.open).toBe(false);

    const expandButton = [...summary.querySelectorAll("button")].find(
      (button) => button.textContent === "展开",
    );
    expect(expandButton).toBeDefined();
    await act(async () => {
      expandButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fold!.open).toBe(true);
  });

  it("判定标准与判定记录默认折叠", async () => {
    await renderOptions();
    const folds = [
      ...container.querySelectorAll<HTMLDetailsElement>(
        "#ai details.audit-fold",
      ),
    ];
    expect(folds.length).toBeGreaterThanOrEqual(2);
    for (const fold of folds) {
      expect(fold.open).toBe(false);
    }
  });
});
