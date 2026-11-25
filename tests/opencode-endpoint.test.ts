import { describe, expect, it } from "vitest";
import {
  isOpenCodeEndpoint,
  normalizeOpenCodeModelId,
  openCodeSessionId,
  resolveOpenCodeModelsUrl,
  resolveOpenCodeRequestUrl,
} from "../src/ai/opencode-endpoint";

describe("OpenCode 推理地址", () => {
  it("Go 订阅的三种协议都拼到官方路径", () => {
    const base = "https://opencode.ai/inference/go/anthropic";
    expect(resolveOpenCodeRequestUrl(base, "anthropic")).toBe(
      "https://opencode.ai/inference/go/anthropic/v1/messages",
    );
    expect(resolveOpenCodeRequestUrl(base, "openai_chat")).toBe(
      "https://opencode.ai/inference/go/openai/v1/chat/completions",
    );
    expect(resolveOpenCodeRequestUrl(base, "responses")).toBe(
      "https://opencode.ai/inference/go/openai/v1/responses",
    );
  });

  it("根地址、带 /v1、带完整路径都归一到同一个根", () => {
    const expected =
      "https://opencode.ai/inference/go/anthropic/v1/messages";
    for (const endpoint of [
      "https://opencode.ai/inference/go",
      "https://opencode.ai/inference/go/anthropic",
      "https://opencode.ai/inference/go/anthropic/v1",
      "https://opencode.ai/inference/go/anthropic/v1/messages",
      "https://opencode.ai/inference/go/anthropic/v1/messages/",
    ]) {
      expect(resolveOpenCodeRequestUrl(endpoint, "anthropic")).toBe(expected);
    }
  });

  it("按量付费地址不带 /go", () => {
    expect(
      resolveOpenCodeRequestUrl(
        "https://opencode.ai/inference/anthropic/v1",
        "anthropic",
      ),
    ).toBe("https://opencode.ai/inference/anthropic/v1/messages");
  });

  it("模型目录固定在网关根下的 /v1/models", () => {
    expect(
      resolveOpenCodeModelsUrl("https://opencode.ai/inference/go/anthropic"),
    ).toBe("https://opencode.ai/inference/go/v1/models");
    expect(resolveOpenCodeModelsUrl("https://opencode.ai/inference")).toBe(
      "https://opencode.ai/inference/v1/models",
    );
  });

  it("只认 opencode.ai 的 https 推理地址", () => {
    expect(isOpenCodeEndpoint("https://opencode.ai/inference/go")).toBe(true);
    expect(isOpenCodeEndpoint("https://opencode.ai/v1")).toBe(false);
    expect(isOpenCodeEndpoint("https://example.com/inference/go")).toBe(false);
    expect(isOpenCodeEndpoint("http://opencode.ai/inference/go")).toBe(false);
    expect(isOpenCodeEndpoint("not a url")).toBe(false);
  });

  it("会话 ID 稳定、带 ses_ 前缀且不含账号原文", () => {
    const first = openCodeSessionId("uid:123456789");
    const second = openCodeSessionId("uid:123456789");
    expect(first).toBe(second);
    expect(first.startsWith("ses_")).toBe(true);
    expect(first).toHaveLength(36);
    expect(first).not.toContain("uid:");
    expect(openCodeSessionId("uid:987654321")).not.toBe(first);
  });

  it("只去掉 OpenCode 地址下的 opencode-go/ 模型前缀", () => {
    expect(
      normalizeOpenCodeModelId(
        "opencode-go/claude-haiku-5-5",
        "https://opencode.ai/inference/go/anthropic",
      ),
    ).toBe("claude-haiku-5-5");
    expect(
      normalizeOpenCodeModelId(
        "claude-haiku-5-5",
        "https://opencode.ai/inference/go/anthropic",
      ),
    ).toBe("claude-haiku-5-5");
    expect(
      normalizeOpenCodeModelId(
        "opencode-go/claude-haiku-5-5",
        "https://api.anthropic.com/v1",
      ),
    ).toBe("opencode-go/claude-haiku-5-5");
  });
});
