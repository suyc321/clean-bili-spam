// AI 判定测试：提示词、JSON 解析与请求客户端。
import { describe, expect, it, vi } from "vitest";
import type {
  AccountProfileRecord,
  VideoObservationRecord,
} from "../src/domain/types";
import { DEFAULT_JUDGMENT_CRITERIA } from "../src/domain/settings";
import {
  MAX_PROMPT_VIDEOS,
  buildReviewMessages,
  describeHttpFailure,
  extractJsonPayload,
  extractResponseText,
  promptVersionForCriteria,
  requestAiReview,
  testAiConnection,
  REVIEW_PROMPT_VERSION,
} from "../src/ai/review-client";

describe("AI 复核提示词", () => {
  // 提示词携带粉丝数与投稿数，供模型看投稿和粉丝的比例。
  it("存在名片数据时 user 消息携带粉丝数与投稿数", () => {
    const messages = buildReviewMessages(
      { ...makeProfile(), followers: 14_418, archiveCount: 103 },
      [makeVideo("标题甲")],
    );
    const user = JSON.parse(messages[1]!.content) as Record<string, unknown>;
    expect(user).toMatchObject({ followers: 14_418, archiveCount: 103 });
  });

  it("没有名片数据时不带这两个字段（不伪造 0）", () => {
    const messages = buildReviewMessages(makeProfile(), [makeVideo("标题甲")]);
    const user = JSON.parse(messages[1]!.content) as Record<string, unknown>;
    expect(user.followers).toBeUndefined();
    expect(user.archiveCount).toBeUndefined();
  });

  it("user 消息只包含昵称、简介、标题与发布时间文本", () => {
    const messages = buildReviewMessages(makeProfile(), [
      makeVideo("标题甲", "2小时前"),
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("你是 B 站内容质量判定助手");
    expect(messages[0]!.content).toContain("marketingProbability");
    expect(messages[0]!.content).toContain("uncertain");
    const system = messages[0]!.content;
    expect(system.indexOf("标题风格夸张")).toBeLessThan(
      system.indexOf("只输出一个 JSON"),
    );

    const user = JSON.parse(messages[1]!.content) as Record<string, unknown>;
    expect(user).toMatchObject({
      displayName: "测试账号",
      profileBio: "测试简介",
    });
    expect(user.videos).toEqual([{ title: "标题甲", publishedText: "2小时前" }]);
  });

  it("标题数量超过上限时截断", () => {
    const videos = Array.from({ length: 40 }, (_, index) =>
      makeVideo(`标题${index}`),
    );
    const messages = buildReviewMessages(makeProfile(), videos);
    const user = JSON.parse(messages[1]!.content) as {
      videos: unknown[];
    };
    expect(user.videos).toHaveLength(MAX_PROMPT_VIDEOS);
  });

  it("自定义口径替换内置标准，输出契约仍在其后", () => {
    const messages = buildReviewMessages(
      makeProfile(),
      [makeVideo("标题甲")],
      "把搬运号看得更重",
    );
    const system = messages[0]!.content;
    expect(system.startsWith("把搬运号看得更重\n")).toBe(true);
    expect(system).not.toContain("标题风格夸张");
    expect(system.indexOf("把搬运号看得更重")).toBeLessThan(
      system.indexOf("只输出一个 JSON"),
    );
    expect(system).toContain("marketingProbability");
  });

  it("空白口径回退到内置标准", () => {
    const messages = buildReviewMessages(
      makeProfile(),
      [makeVideo("标题甲")],
      "   ",
    );
    expect(messages[0]!.content.startsWith(DEFAULT_JUDGMENT_CRITERIA)).toBe(
      true,
    );
  });

  it("审计版本在未改口径时保持内置版本，改过则带摘要", () => {
    expect(promptVersionForCriteria(undefined)).toBe(REVIEW_PROMPT_VERSION);
    expect(promptVersionForCriteria("")).toBe(REVIEW_PROMPT_VERSION);
    expect(promptVersionForCriteria(DEFAULT_JUDGMENT_CRITERIA)).toBe(
      REVIEW_PROMPT_VERSION,
    );
    const custom = promptVersionForCriteria("把搬运号看得更重");
    expect(custom.startsWith(`${REVIEW_PROMPT_VERSION}+`)).toBe(true);
    expect(custom).not.toBe(REVIEW_PROMPT_VERSION);
  });
});

describe("AI 输出解析", () => {
  it("接受裸 JSON", () => {
    const payload = extractJsonPayload(
      '{"marketingProbability": 80, "category": "marketing", "reason": "理由", "insufficientData": []}',
    );
    expect(payload).toMatchObject({ marketingProbability: 80 });
  });

  it("接受代码围栏与夹杂说明文字的 JSON", () => {
    const text = [
      "以下是分析结果：",
      "```json",
      '{"marketingProbability": 10, "category": "normal", "reason": "正常", "insufficientData": []}',
      "```",
    ].join("\n");
    expect(extractJsonPayload(text)).toMatchObject({ category: "normal" });
  });

  it("没有 JSON 时抛错", () => {
    expect(() => extractJsonPayload("无法分析")).toThrow();
  });
});

describe("AI 复核请求客户端", () => {
  it("成功路径返回取整后的结构化结论", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '```json\n{"marketingProbability": 85.4, "category": "marketing", "reason": "标题模板化明显", "insufficientData": ["缺少评论区样本"]}\n```',
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const review = await requestAiReview(
      { aiEndpoint: "https://api.example.com/v1/", aiApiKey: "sk-test", aiModel: "test-model" },
      makeProfile(),
      [makeVideo("标题甲")],
      fetchImpl as unknown as typeof fetch,
    );

    expect(review).toMatchObject({
      accountKey: "uid:123",
      marketingProbability: 85,
      category: "marketing",
      model: "test-model",
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    // 尾部斜杠被归一化，路径拼接为 /chat/completions。
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("OpenCode Go 走 Anthropic 路径，并带上会话头与两种鉴权", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: '{"marketingProbability": 70, "category": "marketing", "reason": "理由", "insufficientData": []}',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await requestAiReview(
      {
        aiEndpoint: "https://opencode.ai/inference/go/anthropic",
        aiApiKey: "oc_sk_test",
        aiModel: "opencode-go/claude-haiku-5-5",
        aiFormat: "anthropic",
      },
      makeProfile(),
      [makeVideo("标题甲")],
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://opencode.ai/inference/go/anthropic/v1/messages",
    );
    // 网关只认裸模型 ID；配置里的 opencode-go/ 前缀会被去掉。
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "claude-haiku-5-5",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{32}$/u);
    expect(headers.authorization).toBe("Bearer oc_sk_test");
    expect(headers["x-api-key"]).toBe("oc_sk_test");
  });

  it("普通 Anthropic 地址不带 OpenCode 会话头", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: '{"marketingProbability": 10, "category": "normal", "reason": "正常", "insufficientData": []}',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await requestAiReview(
      {
        aiEndpoint: "https://api.anthropic.com/v1",
        aiApiKey: "sk-ant",
        aiModel: "claude-test",
        aiFormat: "anthropic",
      },
      makeProfile(),
      [makeVideo("标题甲")],
      fetchImpl as unknown as typeof fetch,
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-opencode-session"]).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("接口返回非 2xx 时抛错", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("oops", { status: 500 }));
    await expect(
      requestAiReview(
        { aiEndpoint: "https://api.example.com/v1", aiApiKey: "k", aiModel: "m" },
        makeProfile(),
        [makeVideo("标题甲")],
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("HTTP 500");
  });

  // 451 要给出可操作说明，方便换接口或自行打开主页。
  it("接口方拒绝请求（451）给出可操作的说明", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("blocked", { status: 451 }));
    await expect(
      requestAiReview(
        { aiEndpoint: "https://api.example.com/v1", aiApiKey: "k", aiModel: "m" },
        makeProfile(),
        [makeVideo("标题甲")],
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/接口方拒绝/);
  });

  it("额度不足与限流分别给出对应说明", () => {
    expect(describeHttpFailure(402).message).toContain("额度");
    expect(describeHttpFailure(429).message).toContain("限流");
  });

  it("鉴权失败提示检查 Key 与模型权限", () => {
    expect(describeHttpFailure(401).message).toContain("API Key");
    expect(describeHttpFailure(403).message).toContain("API Key");
  });

  it("404 提示检查地址与模型名", () => {
    expect(describeHttpFailure(404).message).toContain("模型名称");
  });

  it("5xx 归为服务端错误、其余 4xx 归为一般失败", () => {
    expect(describeHttpFailure(503).message).toContain("服务端错误");
    expect(describeHttpFailure(418).message).toContain("418");
  });

  it("Anthropic 格式把输出额度留到 8192，阶跃思考压在低档", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: '{"marketingProbability": 10, "category": "normal", "reason": "正常", "insufficientData": []}',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await requestAiReview(
      {
        aiEndpoint: "https://api.stepfun.com/step_plan/v1",
        aiApiKey: "k",
        aiModel: "step-3.7-flash",
        aiFormat: "anthropic",
      },
      makeProfile(),
      [makeVideo("标题甲")],
      fetchImpl as unknown as typeof fetch,
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      max_tokens: 8192,
      output_config: { effort: "low" },
    });
  });

  it("响应缺少文本内容时抛错", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    await expect(
      requestAiReview(
        { aiEndpoint: "https://api.example.com/v1", aiApiKey: "k", aiModel: "m" },
        makeProfile(),
        [makeVideo("标题甲")],
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("缺少文本内容");
  });
});

describe("AI 连通性测试", () => {
  const config = {
    aiEndpoint: "https://api.example.com/v1",
    aiApiKey: "sk-test",
    aiModel: "test-model",
  };

  it("接口返回 2xx 时不抛错", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    await expect(
      testAiConnection(config, fetchImpl as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    // 最小请求只带 model/max_tokens/ping，不携带任何账号数据（标题、昵称）。
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "test-model",
      max_tokens: 1,
      temperature: 0,
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("接口返回非 2xx 时抛错", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("denied", { status: 401 }));
    await expect(
      testAiConnection(config, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("HTTP 401");
  });
});


/** 构造最小账号资料。 */
function makeProfile(): AccountProfileRecord {
  return {
    accountKey: "uid:123",
    uid: "123",
    profileUrl: "https://space.bilibili.com/123",
    displayName: "测试账号",
    profileBio: "测试简介",
    firstSeenAtMs: 1_000,
    lastSeenAtMs: 2_000,
  };
}

/** 构造最小投稿观察记录。 */
function makeVideo(
  title: string,
  publishedText?: string,
  publishedAtMs = 1_000,
): VideoObservationRecord {
  return {
    videoKey: `BV${title}`,
    bvid: `BV${title}`,
    title,
    videoUrl: `https://www.bilibili.com/video/BV${title}`,
    ...(publishedText === undefined ? {} : { publishedText }),
    publishedAtMs,
    metricsRaw: [],
    accountKey: "uid:123",
    source: { pageKind: "home", adapterId: "test", adapterVersion: 1 },
    observedAtMs: 1_000,
    firstSeenAtMs: 1_000,
    lastSeenAtMs: 1_000,
    seenCount: 1,
  };
}

describe("主端点失败不再切换", () => {
  it("主端点返回 451 时直接失败，只请求一次", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("blocked", { status: 451 }),
    );
    await expect(
      requestAiReview(
        {
          aiEndpoint: "https://api.primary.example/v1",
          aiApiKey: "pk",
          aiModel: "primary-model",
        },
        makeProfile(),
        [makeVideo("标题甲")],
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
