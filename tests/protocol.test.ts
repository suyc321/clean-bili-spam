// 消息协议测试：验证 Zod 白名单拒绝通用网络/脚本能力，
// 并锁定观察上报与设置补丁的字段结构。
import { describe, expect, it } from "vitest";
import { parseRuntimeRequest } from "../src/messaging/protocol";

describe("运行时消息协议", () => {
  it("拒绝未声明的通用网络请求消息", () => {
    expect(() =>
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-1",
        type: "fetch",
        payload: {
          url: "https://example.com",
        },
      }),
    ).toThrow();
  });

  it("拒绝携带任意选择器或脚本的设置消息", () => {
    expect(() =>
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-2",
        type: "settings.patch",
        payload: {
          patch: {
            showBadges: true,
            selector: "*",
            script: "alert(1)",
          },
        },
      }),
    ).toThrow();
  });

  it("接受最小 dashboard 查询", () => {
    expect(
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-3",
        type: "dashboard.get",
        payload: {},
      }).type,
    ).toBe("dashboard.get");
  });

  it("接受不含冗余字段的观察上报", () => {
    const request = parseRuntimeRequest({
      protocolVersion: 1,
      requestId: "request-4",
      type: "observations.ingest",
      payload: {
        observations: [
          {
            schemaVersion: 1,
            accountKey: "uid:123",
            uid: "123",
            profileUrl: "https://space.bilibili.com/123",
            videos: [
              {
                videoKey: "BV1xx411c7mD",
                bvid: "BV1xx411c7mD",
                title: "测试标题",
                videoUrl: "https://www.bilibili.com/video/BV1xx411c7mD",
                metricsRaw: [],
                source: {
                  pageKind: "home",
                  adapterId: "bilibili-home-v1",
                  adapterVersion: 1,
                },
                observedAtMs: 1_000,
              },
            ],
            missingFields: [],
            source: {
              pageKind: "home",
              adapterId: "bilibili-home-v1",
              adapterVersion: 1,
            },
            observedAtMs: 1_000,
          },
        ],
      },
    });
    expect(request.type).toBe("observations.ingest");
  });

  it("拒绝携带未声明 idempotencyKey 等额外字段的观察上报", () => {
    expect(() =>
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-5",
        type: "observations.ingest",
        payload: {
          observations: [
            {
              schemaVersion: 1,
              idempotencyKey: "stale-field",
              accountKey: "uid:123",
              uid: "123",
              profileUrl: "https://space.bilibili.com/123",
              videos: [],
              missingFields: [],
              source: {
                pageKind: "home",
                adapterId: "bilibili-home-v1",
                adapterVersion: 1,
              },
              observedAtMs: 1_000,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("接受 showOnboarding 设置补丁并拒绝未知字段", () => {
    expect(
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-6",
        type: "settings.patch",
        payload: { patch: { showOnboarding: false } },
      }).type,
    ).toBe("settings.patch");

    expect(() =>
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-7",
        type: "settings.patch",
        payload: { patch: { showOnboarding: "yes" } },
      }),
    ).toThrow();
  });

  it("接受 AI 复核请求并拒绝载荷中的注入字段", () => {
    expect(
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-8",
        type: "ai.review.run",
        payload: { accountKey: "uid:123" },
      }).type,
    ).toBe("ai.review.run");

    expect(() =>
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-9",
        type: "ai.review.run",
        // 白名单外注入任意端点必须被拒绝：AI 请求只允许走设置页配置的接口。
        payload: {
          accountKey: "uid:123",
          endpoint: "https://evil.example.com",
        },
      }),
    ).toThrow();
  });

  it("接受带草稿配置的 AI 连通性测试，拒绝非法配置", () => {
    expect(
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-11",
        type: "ai.config.test",
        payload: {
          config: {
            aiEndpoint: "https://api.openai.com/v1",
            aiApiKey: "sk-test",
            aiModel: "gpt-4o-mini",
          },
        },
      }).type,
    ).toBe("ai.config.test");

    // 空字符串的草稿配置应被拒绝（测试一个没填完的配置没有意义）。
    expect(() =>
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-12",
        type: "ai.config.test",
        payload: {
          config: { aiEndpoint: "", aiApiKey: "k", aiModel: "m" },
        },
      }),
    ).toThrow();

    // 无 config 时也合法（测试已保存配置）。
    expect(
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-13",
        type: "ai.config.test",
        payload: {},
      }).type,
    ).toBe("ai.config.test");
  });

  it("接受批量 AI 复核，拒绝空列表、超限与重复账号", () => {
    const tenKeys = Array.from({ length: 10 }, (_, index) => `uid:${index}`);
    expect(
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-20",
        type: "ai.review.batch",
        payload: { accountKeys: tenKeys },
      }).type,
    ).toBe("ai.review.batch");

    // 空列表无意义。
    expect(() =>
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-21",
        type: "ai.review.batch",
        payload: { accountKeys: [] },
      }),
    ).toThrow();

    // 超过 10 个：避免单条消息触发过量外发请求。
    expect(() =>
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-22",
        type: "ai.review.batch",
        payload: {
          accountKeys: [...tenKeys, "uid:extra"],
        },
      }),
    ).toThrow();

    // 重复账号会被 schema 拒绝（调用方应先去重）。
    expect(() =>
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-23",
        type: "ai.review.batch",
        payload: { accountKeys: ["uid:1", "uid:1"] },
      }),
    ).toThrow();
  });

  it("接受 AI 配置的设置补丁", () => {
    expect(
      parseRuntimeRequest({
        protocolVersion: 1,
        requestId: "request-10",
        type: "settings.patch",
        payload: {
          patch: {
            aiEnabled: true,
            aiEndpoint: "https://api.openai.com/v1",
            aiApiKey: "sk-test",
            aiModel: "gpt-4o-mini",
          },
        },
      }).type,
    ).toBe("settings.patch");
  });
});
