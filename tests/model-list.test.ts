import { describe, expect, it, vi } from "vitest";
import {
  listAiModels,
  modelsListUrl,
  parseModelIds,
} from "../src/ai/review-client";

describe("模型目录", () => {
  it("把基址拼成 /models，已经带上的不再重复", () => {
    expect(modelsListUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(modelsListUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(modelsListUrl("https://api.openai.com/v1/models")).toBe(
      "https://api.openai.com/v1/models",
    );
  });

  it("OpenCode 的模型目录在网关根下，不在协议前缀下", () => {
    expect(
      modelsListUrl("https://opencode.ai/inference/go/anthropic"),
    ).toBe("https://opencode.ai/inference/go/v1/models");
  });

  it("OpenCode 用 Anthropic 配置也能拉到模型目录", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ data: [{ id: "claude-haiku-5-5" }] }),
    );
    const models = await listAiModels(
      {
        aiEndpoint: "https://opencode.ai/inference/go/anthropic",
        aiApiKey: "oc_sk_test",
        aiFormat: "anthropic",
      },
      fetchImpl,
    );
    expect(models).toEqual(["claude-haiku-5-5"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://opencode.ai/inference/go/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: {
          "x-api-key": "oc_sk_test",
          "anthropic-version": "2023-06-01",
        },
      }),
    );
  });

  it("从 data.id 取出模型名并排序去重", () => {
    expect(
      parseModelIds({
        data: [{ id: "zeta" }, { id: "alpha" }, { id: "alpha" }, { id: "  " }],
      }),
    ).toEqual(["zeta", "alpha", "alpha"]);
  });

  it("OpenAI 兼容接口用 Bearer 请求 /models", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ data: [{ id: "step-1" }, { id: "step-2" }] }),
    );
    const models = await listAiModels(
      {
        aiEndpoint: "https://api.stepfun.com/v1",
        aiApiKey: "sk-test",
        aiFormat: "openai_chat",
      },
      fetchImpl,
    );
    expect(models).toEqual(["step-1", "step-2"]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.stepfun.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer sk-test" },
      }),
    );
  });

  it("Anthropic 用 x-api-key，并按 after_id 翻一页", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "claude-a" }],
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [{ id: "claude-b" }],
          has_more: false,
        }),
      );
    const models = await listAiModels(
      {
        aiEndpoint: "https://api.anthropic.com/v1",
        aiApiKey: "sk-ant",
        aiFormat: "anthropic",
      },
      fetchImpl,
    );
    expect(models).toEqual(["claude-a", "claude-b"]);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: {
          "x-api-key": "sk-ant",
          "anthropic-version": "2023-06-01",
        },
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://api.anthropic.com/v1/models?after_id=claude-a",
      expect.anything(),
    );
  });

  it("没有模型目录时说明可以直接手输", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    await expect(
      listAiModels(
        {
          aiEndpoint: "https://example.com/v1",
          aiApiKey: "sk",
          aiFormat: "openai_chat",
        },
        fetchImpl,
      ),
    ).rejects.toThrow("请直接输入模型名称");
  });

  it("Step Plan 的 x-api-key 被拒后，改用普通目录地址", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (url === "https://api.stepfun.com/v1/models") {
        return Response.json({ data: [{ id: "step-3.7-flash" }] });
      }
      return new Response("", { status: 401 });
    });
    const models = await listAiModels(
      {
        aiEndpoint: "https://api.stepfun.com/step_plan/v1",
        aiApiKey: "sk-plan",
        aiFormat: "anthropic",
      },
      fetchImpl,
    );
    expect(models).toEqual(["step-3.7-flash"]);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "https://api.stepfun.com/v1/models",
      expect.objectContaining({
        headers: { authorization: "Bearer sk-plan" },
      }),
    );
  });
});
