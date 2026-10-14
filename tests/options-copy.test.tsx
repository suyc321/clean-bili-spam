// 设置页文案：未配置时徽章显示「无判定」。
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
      candidates: [],
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

describe("设置页文案", () => {
  it("设置页有开始使用，并说明未配置时显示无判定", async () => {
    await act(async () => {
      root.render(<OptionsApp />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain("开始使用");
    expect(container.textContent).toContain("未配置时，卡片徽章显示「无判定」。");
    expect(container.textContent).toContain("判定标准");
    expect(container.textContent).toContain("恢复默认");
    expect(container.textContent).toContain("插入示例");
    expect(container.querySelector("#ai details")).not.toHaveProperty("open", true);
    expect(
      [...container.querySelectorAll("#ai details summary button")].map(
        (button) => button.textContent,
      ),
    ).toContain("展开");
    expect(container.textContent).not.toContain("备用接口");
  });
});
