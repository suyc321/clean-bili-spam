/**
 * AI 判定客户端：调用用户自带的 OpenAI 兼容接口（BYOK）。
 *
 * 隐私与安全边界：
 * - 发送账号昵称、简介、最多 20 条投稿标题及其发布时间文本；开启「补全账号信息」后另带粉丝数与投稿数。
 *   不含 UID、URL、Cookie 或浏览历史；
 * - 默认关闭。开启并完成域名授权后，内容脚本会对还没有结论的新账号自动发起请求，卡片上也可以再点一次；
 * - 模型输出必须匹配固定 JSON Schema，插件不展示自由生成的结论；
 * - 任何失败都向上抛错。调用方不写入结论，这次复核视为未取得判定。
 */
import { z } from "zod";
import { DEFAULT_JUDGMENT_CRITERIA } from "../domain/settings";
import type {
  AccountProfileRecord,
  AiApiFormat,
  AiReviewRecord,
  ExtensionSettings,
  VideoObservationRecord,
} from "../domain/types";
import {
  isOpenCodeEndpoint,
  normalizeOpenCodeModelId,
  openCodeSessionId,
  resolveOpenCodeModelsUrl,
  resolveOpenCodeRequestUrl,
} from "./opencode-endpoint";

/**
 * 提示词版本：改动 system/user 提示词时必须递增，并写入 AI 审计记录。
 *
 * 为什么需要：AI 结论本身不可回归——同一输入两次结果可能不同，
 * 无法写测试钉住行为。若连提示词版本也不记，换过一次提示词之后就完全无法
 * 对比两次结论差异，也无法解释历史审计里的结论是用什么口径得出的。
 */
/**
 * 版本历史：
 *   rv1 — 初版：六分类 + 概率 + 理由 + 证据不足项。
 *   rv2 — 提示词补充「投稿/粉丝比」的解读指引，user 消息携带 followers
 *         与 archiveCount（需用户开启名片补全后才存在）。
 *   rv3 — 系统提示的自我称呼从「复核助手」改为「判定助手」。
 *         判定只由 AI 产出，不再把这次调用说成对前一次结论的复查。
 *   rv4 — 判定口径与输出契约拆开。口径在前，JSON 格式和类别枚举固定在后。
 *         用户可在设置里替换口径；未改时仍使用内置口径。
 */
export const REVIEW_PROMPT_VERSION = "rv4";

/** 单次复核请求的超时时间。 */
const AI_TIMEOUT_MS = 30_000;
/**
 * Anthropic 格式的 max_tokens 缺省值。
 *
 * 为什么必须有：该接口的 `max_tokens` 是必填项，不带会直接返回
 * HTTP 400 `max_tokens must be positive`（2026-09-26 真实接口实测）。
 * 思考会计入这个额度。4096 仍会被 step-3.7-flash 的思考占满，
 * 正文变成空的（stop_reason=max_tokens）。8192 在思考之后留下 JSON。
 */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8_192;
/** 提示词中携带的最大标题数量（控制成本与上下文长度）。 */
export const MAX_PROMPT_VIDEOS = 20;

/** 一组完整的 AI 接口配置（格式定义在 domain/types.ts，见 AiApiFormat）。 */
export interface AiEndpointConfig {
  aiEndpoint: string;
  aiApiKey: string;
  aiModel: string;
  /** 接口格式；缺省按 openai_chat 处理（保持旧配置可用）。 */
  aiFormat?: AiApiFormat;
  /** 是否在控制台打印请求与响应。缺省视为关闭。 */
  logAiExchange?: boolean;
  /**
   * 用户编写的判定口径。空或缺省时使用内置口径。
   * 不改变 JSON 格式和类别枚举。
   */
  aiJudgmentCriteria?: string;
}

/**
 * 格式的中文名（设置页下拉用）。
 *
 * 刻意用短名：下拉里放「OpenAI Chat Completions（/chat/completions）」这种
 * 长文案会把 select 撑爆、盖住右侧的列，选项列表本身也很难扫读。
 * 路径说明放在下拉下方一行常量文字里，选哪个都看得到。
 */
export const AI_FORMAT_LABELS: Record<AiApiFormat, string> = {
  openai_chat: "OpenAI Chat Completions",
  anthropic: "Anthropic Messages",
  responses: "OpenAI Responses（实验性）",
};

/** 模型输出的固定结构；strict 模式拒绝多余字段。 */
const aiReviewPayloadSchema = z
  .object({
    marketingProbability: z.number().min(0).max(100),
    category: z.enum([
      "normal",
      "marketing",
      "repost",
      "ai_rewritten",
      "advertising",
      "uncertain",
    ]),
    reason: z.string().min(1).max(500),
    insufficientData: z.array(z.string().min(1).max(100)).max(10),
  })
  .strict();

/** OpenAI 兼容 chat/completions 的消息形态。 */
export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * 输出契约：角色、JSON 格式和六个类别。用户不能改。
 * 始终放在判定口径之后，避免用户文字把格式要求盖掉。
 */
const LOCKED_REVIEW_CONTRACT = [
  "你是 B 站内容质量判定助手。根据 UP 主的投稿标题、简介与发布节奏，",
  "判断该账号属于营销号或低质量内容矩阵的可能性。",
  "只输出一个 JSON 对象，不要输出任何其他文字，格式：",
  '{"marketingProbability": 0到100的整数, "category": "normal|marketing|repost|ai_rewritten|advertising|uncertain", "reason": "不超过100字的中文理由", "insufficientData": ["证据不足的方面"]}',
  "类别含义：normal 正常创作者；marketing 营销号/低质量矩阵；repost 搬运号；",
  "ai_rewritten 疑似AI洗稿；advertising 广告导流号；uncertain 证据不足。",
].join("");

/**
 * 实际采用的判定口径。空白视为内置标准。
 */
export function resolveJudgmentCriteria(criteria: string | undefined): string {
  const trimmed = criteria?.trim() ?? "";
  return trimmed === "" ? DEFAULT_JUDGMENT_CRITERIA : trimmed;
}

/**
 * 审计用的提示词版本。
 * 未改口径时只有内置版本；改过则在版本后加上这段口径的摘要。
 */
export function promptVersionForCriteria(criteria: string | undefined): string {
  const trimmed = criteria?.trim() ?? "";
  if (trimmed === "" || trimmed === DEFAULT_JUDGMENT_CRITERIA) {
    return REVIEW_PROMPT_VERSION;
  }
  return `${REVIEW_PROMPT_VERSION}+${criteriaDigest(trimmed)}`;
}

/** FNV-1a 32 位，八位十六进制。只用来区分不同口径，不作为安全摘要。 */
function criteriaDigest(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 构造复核请求的 system/user 提示词。
 *
 * system 先写判定口径，再写固定的 JSON 契约。
 * user 只携带判定所需的最小字段（标题 + 发布时间文本 + 简介）。
 */
export function buildReviewMessages(
  profile: Pick<
    AccountProfileRecord,
    "displayName" | "profileBio" | "followers" | "archiveCount"
  >,
  videos: Array<Pick<VideoObservationRecord, "title" | "publishedText">>,
  criteria?: string,
): ChatMessage[] {
  const system = `${resolveJudgmentCriteria(criteria)}\n${LOCKED_REVIEW_CONTRACT}`;

  const user = JSON.stringify({
    displayName: profile.displayName,
    profileBio: profile.profileBio,
    // 粉丝数与投稿数：让模型能判断「投稿/粉丝比」这个农场比例信号。
    // 这两个数只从 UP 主公开名片读取，且仅在用户开启补全后才存在。
    ...(profile.followers === undefined ? {} : { followers: profile.followers }),
    ...(profile.archiveCount === undefined
      ? {}
      : { archiveCount: profile.archiveCount }),
    videos: videos.slice(0, MAX_PROMPT_VIDEOS).map((video) => ({
      title: video.title,
      ...(video.publishedText === undefined
        ? {}
        : { publishedText: video.publishedText }),
    })),
  });

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * 从模型返回的文本中提取 JSON 载荷。
 * 兼容 ```json 代码围栏与夹杂说明文字的情况：取首个 { 到最后一个 }。
 */
export function extractJsonPayload(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("AI 返回内容中未找到 JSON 对象。");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    throw new Error("AI 返回的 JSON 无法解析。");
  }
}

/**
 * 把 HTTP 失败码翻译成可操作的中文说明。
 *
 * 逐个翻译状态码：用户要靠这段说明决定换接口、查 Key，还是稍后再试。
 *
 * 451 只说明接口方拒绝了这次请求。
 */
export function describeHttpFailure(status: number): Error {
  switch (status) {
    case 451:
      return new Error(
        "AI 接口方拒绝了本次请求（HTTP 451）。可能是接口侧的限制；可换个接口端点重试，或打开 UP 主页自行判断。本次没有得到判定。",
      );
    case 402:
      return new Error("AI 接口返回额度不足（HTTP 402），请检查接口余额或更换接口。");
    case 429:
      return new Error("AI 接口触发限流（HTTP 429），请稍后重试或更换接口。");
    case 401:
    case 403:
      return new Error(
        `AI 接口鉴权失败（HTTP ${status}），请检查 API Key 是否正确、是否有该模型的调用权限。`,
      );
    case 404:
      return new Error(
        "AI 接口地址不存在（HTTP 404），请确认接口地址与模型名称。",
      );
    default:
      return new Error(
        status >= 500
          ? `AI 接口服务端错误（HTTP ${status}），可稍后重试或更换接口。`
          : `AI 接口返回 HTTP ${status}。`,
      );
  }
}

/**
 * 发起一次 AI 判定请求并返回结构化结论。
 *
 * @param settings 插件设置（提供接口地址、Key 与模型名）
 * @param profile 账号资料（昵称与简介进入提示词）
 * @param videos 投稿观察记录（标题进入提示词，最多 20 条）
 * @param fetchImpl 可注入的 fetch 实现（测试用）
 * @throws Error 接口错误、超时、响应缺内容或输出不符合 Schema 时抛出
 */
export async function requestAiReview(
  settings: AiEndpointConfig,
  profile: AccountProfileRecord,
  videos: VideoObservationRecord[],
  fetchImpl: typeof fetch = fetch,
): Promise<AiReviewRecord> {
  return callOnce(
    {
      aiEndpoint: settings.aiEndpoint,
      aiApiKey: settings.aiApiKey,
      aiModel: settings.aiModel,
      aiFormat: settings.aiFormat,
      logAiExchange: settings.logAiExchange,
      aiJudgmentCriteria: settings.aiJudgmentCriteria,
    },
    profile,
    videos,
    fetchImpl,
  );
}

/**
 * 按格式拼出请求 URL。
 *
 * 用户可能填带路径的完整端点（如 `https://api.stepfun.com/step_plan/v1`），
 * 也可能直接填到 `/chat/completions` 或 `/messages`。因此：先看已填的地址
 * 是否**已以该格式的终点结尾**，是则原样用，否则拼上。
 */
function resolveRequestUrl(
  endpoint: string,
  format: AiApiFormat,
): string {
  // OpenCode 的协议前缀与通用拼接不同（/anthropic/v1/messages 等）。
  const openCodeUrl = resolveOpenCodeRequestUrl(endpoint, format);
  if (openCodeUrl !== undefined) {
    return openCodeUrl;
  }
  const base = endpoint.trim().replace(/\/+$/u, "");
  const suffix = format === "anthropic"
    ? "/messages"
    : format === "responses"
      ? "/responses"
      : "/chat/completions";
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

/** 按格式构造请求体与鉴权头。 */
function buildRequest(
  config: AiEndpointConfig,
  messages: ChatMessage[],
  maxTokens?: number,
  sessionId?: string,
): { url: string; headers: Record<string, string>; body: string } {
  const format = config.aiFormat ?? "openai_chat";
  const url = resolveRequestUrl(config.aiEndpoint, format);
  // 用户可能粘贴 OpenCode 配置里的 `opencode-go/<id>`，网关只认裸 ID。
  const model = normalizeOpenCodeModelId(
    config.aiModel.trim(),
    config.aiEndpoint,
  );
  const key = config.aiApiKey.trim();
  const openCode = isOpenCodeEndpoint(config.aiEndpoint);
  // Go 订阅缺少这个头会直接 400 MissingSessionID；非 OpenCode 地址不带。
  const sessionHeaders: Record<string, string> = openCode
    ? { "x-opencode-session": sessionId ?? openCodeSessionId("probe") }
    : {};

  if (format === "anthropic") {
    return {
      url,
      // Anthropic 原生用 x-api-key + anthropic-version，不是 Bearer。
      // OpenCode 两种鉴权都接受，额外带 Bearer，兼容只认 Authorization 的网关。
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        ...(openCode ? { authorization: `Bearer ${key}` } : {}),
        ...sessionHeaders,
      },
      body: JSON.stringify({
        model,
        // system 在 Anthropic 格式里是顶层字段，不在 messages 数组里。
        system: messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n"),
        messages: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({ role: message.role, content: message.content })),
        // max_tokens 必填：缺省会收到 400
        max_tokens: maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
        // 阶跃推理模型默认会长篇思考，简单判定压到低档，把额度留给 JSON。
        ...(isStepPlanEndpoint(config.aiEndpoint)
          ? { output_config: { effort: "low" } }
          : {}),
      }),
    };
  }

  if (format === "responses") {
    return {
      url,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...sessionHeaders,
      },
      body: JSON.stringify({
        model,
        // Responses 用 instructions + input，不用 messages 数组。
        instructions: messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n"),
        input: messages
          .filter((message) => message.role !== "system")
          .map((message) => message.content)
          .join("\n"),
        ...(maxTokens === undefined ? {} : { max_output_tokens: maxTokens }),
      }),
    };
  }

  return {
    url,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      ...sessionHeaders,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages,
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    }),
  };
}

/**
 * 从不同格式的响应里取出模型输出的文本。
 *
 * Responses 格式的坑（2026-09-26 实测）：推理模型会把思维链也放进
 * `output[].content[].text`，第一个 text 块是「首先判断是不是营销概率
 * 很低啊……」这类自言自语，不是最终答案。因此这里跳过以推理性开头、
 * 或明显不含 JSON 的块，优先返回能解出 JSON 的那一块。
 */
export function extractResponseText(
  data: unknown,
  format: AiApiFormat,
): string | null {
  if (format === "anthropic") {
    const blocks = (data as { content?: Array<{ type?: string; text?: string }> })
      ?.content;
    if (!Array.isArray(blocks)) {
      return null;
    }
    const text = blocks
      .filter((block) => block.type === undefined || block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    return text === "" ? null : text;
  }

  if (format === "responses") {
    const output = (data as {
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    })?.output;
    if (!Array.isArray(output)) {
      return null;
    }
    const candidates = output
      .flatMap((item) => item.content ?? [])
      .map((block) => block.text ?? "")
      .filter((text) => text !== "");
    if (candidates.length === 0) {
      return null;
    }
    // 优先选能解出 JSON 的那一块，绕开混在里面的思维链。
    // 注意 extractJsonPayload 找不到 JSON 时是**抛错**而不是返回 null，
    // 因此要包 try/catch——否则这里会把异常冒到调用方。
    const withJson = candidates.find((text) => {
      try {
        return extractJsonPayload(text) !== null;
      } catch {
        return false;
      }
    });
    return withJson ?? candidates[candidates.length - 1] ?? null;
  }

  const openai = data as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = openai.choices?.[0]?.message?.content;
  return typeof content === "string" && content !== "" ? content : null;
}

/** 响应里没有正文时，记下结构，方便区分「思考占满」和「格式认错」。不含正文。 */
function describeModelPayload(data: unknown): string {
  if (typeof data !== "object" || data === null) {
    return `类型 ${typeof data}`;
  }
  const record = data as Record<string, unknown>;
  const stop =
    typeof record.stop_reason === "string" ? record.stop_reason : "无";
  const content = record.content;
  let blocks = "无 content";
  if (typeof content === "string") {
    blocks = `content 字符串 ${content.length} 字`;
  } else if (Array.isArray(content)) {
    blocks =
      content.length === 0
        ? "content 为空数组"
        : content
            .map((block) => {
              if (typeof block !== "object" || block === null) {
                return typeof block;
              }
              const item = block as { type?: unknown; text?: unknown; thinking?: unknown };
              const type = typeof item.type === "string" ? item.type : "无type";
              const length =
                typeof item.text === "string"
                  ? item.text.length
                  : typeof item.thinking === "string"
                    ? item.thinking.length
                    : 0;
              return `${type}:${length}`;
            })
            .join(",");
  }
  const choices = Array.isArray(record.choices)
    ? `，另有 choices ${record.choices.length} 条`
    : "";
  return `stop_reason=${stop}，${blocks}${choices}`;
}

/** 解析失败时只留开头一小段，避免把整段回复刷进弹窗。 */
function clipModelText(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`;
}

/** 用一组端点配置发起一次复核；失败即抛，不做重试。 */
async function callOnce(
  config: AiEndpointConfig,
  profile: AccountProfileRecord,
  videos: VideoObservationRecord[],
  fetchImpl: typeof fetch,
): Promise<AiReviewRecord> {
  const messages = buildReviewMessages(
    profile,
    videos,
    config.aiJudgmentCriteria,
  );
  const request = buildRequest(
    config,
    messages,
    undefined,
    // 同一账号复用会话 ID，便于网关归并与提示词缓存命中。
    openCodeSessionId(profile.accountKey),
  );
  // 仅在用户于设置页打开「打印判定往来」时，才在 finally 里把请求与响应打到后台控制台。
  let responsePayload: unknown;

  // 超时保护：卡死的接口不能一直占着 Service Worker。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw describeHttpFailure(response.status);
    }
    const data: unknown = await response.json();
    responsePayload = data;
    const content = extractResponseText(data, config.aiFormat ?? "openai_chat");
    if (content === null) {
      throw new Error(
        `AI 接口响应缺少文本内容（${describeModelPayload(data)}）。`,
      );
    }
    let parsed: unknown;
    try {
      parsed = extractJsonPayload(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 返回的 JSON 无法解析。";
      throw new Error(`${message} 返回开头：${clipModelText(content)}`);
    }
    const payload = aiReviewPayloadSchema.parse(parsed);
    return {
      accountKey: profile.accountKey,
      marketingProbability: Math.round(payload.marketingProbability),
      category: payload.category,
      reason: payload.reason,
      insufficientData: payload.insufficientData,
      model: config.aiModel.trim(),
      reviewedAtMs: Date.now(),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("AI 接口请求超时。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (fetchImpl === fetch && config.logAiExchange === true) {
      console.log(
        `[B站内容净化助手] AI 请求与响应\n${JSON.stringify({ messages, response: responsePayload }, null, 2)}`,
      );
    }
  }
}

/**
 * 拉取服务商模型目录。
 *
 * 地址约定与复核请求一致：设置里保存的是基址（如 `https://api.openai.com/v1`），
 * 这里在后面接 `/models`。OpenAI 兼容格式用 Bearer，Anthropic 用 `x-api-key`。
 * 阶跃 Step Plan（`/step_plan/`）的目录接口不认 `x-api-key`，401 时改用 Bearer，
 * 仍失败则改问同一域名下的 `/v1/models`。只跟随同一地址上的 `after_id` 翻页。
 *
 * @throws Error 鉴权失败、没有该接口或返回体无法识别时抛出
 */
export async function listAiModels(
  settings: Pick<AiEndpointConfig, "aiEndpoint" | "aiApiKey" | "aiFormat">,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  let lastAuthStatus: number | undefined;
  for (const attempt of modelListAttempts(settings)) {
    const ids = new Set<string>();
    let url: string | undefined = attempt.url;
    let rejected = false;
    for (let page = 0; page < 5 && url !== undefined; page += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: attempt.headers,
          signal: controller.signal,
        });
        if (
          page === 0 &&
          (response.status === 401 ||
            response.status === 403 ||
            response.status === 404)
        ) {
          if (response.status !== 404) {
            lastAuthStatus = response.status;
          }
          rejected = true;
          break;
        }
        if (response.status === 404) {
          break;
        }
        if (!response.ok) {
          throw describeHttpFailure(response.status);
        }
        const payload: unknown = await response.json();
        for (const id of parseModelIds(payload)) {
          ids.add(id);
        }
        url = nextModelsPage(url, payload);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("获取模型列表超时。");
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    if (rejected) {
      continue;
    }
    if (ids.size === 0) {
      throw new Error("接口没有返回可用的模型名称。");
    }
    return [...ids].sort((left, right) => left.localeCompare(right));
  }
  if (isStepPlanEndpoint(settings.aiEndpoint)) {
    throw new Error(
      "Step Plan 的地址没有模型目录，所以会显示鉴权失败。密钥不一定填错了，请直接输入模型名称，例如 step-3.7-flash。",
    );
  }
  if (lastAuthStatus !== undefined) {
    throw describeHttpFailure(lastAuthStatus);
  }
  throw new Error("该接口没有提供模型列表（HTTP 404）。请直接输入模型名称。");
}

/** 阶跃 Step Plan 用专用路径，模型目录和普通 `/v1` 不是同一个接口。 */
function isStepPlanEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint.trim());
    return (
      url.hostname === "api.stepfun.com" && url.pathname.includes("/step_plan")
    );
  } catch {
    return false;
  }
}

/** 模型目录的候选请求。第一条按格式鉴权，后面是同一服务商的退路。 */
function modelListAttempts(
  settings: Pick<AiEndpointConfig, "aiEndpoint" | "aiApiKey" | "aiFormat">,
): Array<{ url: string; headers: Record<string, string> }> {
  const format = settings.aiFormat ?? "openai_chat";
  const key = settings.aiApiKey.trim();
  const bearer = { authorization: `Bearer ${key}` };
  const anthropic = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };
  const primaryUrl = modelsListUrl(settings.aiEndpoint);
  const attempts = [
    {
      url: primaryUrl,
      headers: format === "anthropic" ? anthropic : bearer,
    },
  ];
  if (format === "anthropic") {
    attempts.push({ url: primaryUrl, headers: bearer });
  }
  if (isStepPlanEndpoint(settings.aiEndpoint)) {
    attempts.push({
      url: "https://api.stepfun.com/v1/models",
      headers: bearer,
    });
  }
  return attempts;
}

/** 把设置页保存的基址拼成模型目录地址。已经以 `/models` 结尾则原样使用。 */
export function modelsListUrl(endpoint: string): string {
  // OpenCode 的目录不在协议前缀下（`.../anthropic/models` 是 404）。
  const openCodeUrl = resolveOpenCodeModelsUrl(endpoint);
  if (openCodeUrl !== undefined) {
    return openCodeUrl;
  }
  const base = endpoint.trim().replace(/\/+$/u, "");
  return base.endsWith("/models") ? base : `${base}/models`;
}

/** 从 `{ data: [{ id }] }` 里取出非空模型名。认不出结构时抛错。 */
export function parseModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw new Error("模型列表格式无法识别。");
  }
  const data = (payload as { data: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("模型列表格式无法识别。");
  }
  const ids: string[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null || !("id" in item)) {
      continue;
    }
    const id = (item as { id: unknown }).id;
    if (typeof id === "string" && id.trim() !== "") {
      ids.push(id.trim());
    }
  }
  return ids;
}

/** Anthropic 用 has_more + after_id 翻页。没有更多页时返回 undefined。 */
function nextModelsPage(currentUrl: string, payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const record = payload as { has_more?: unknown; data?: unknown };
  if (record.has_more !== true || !Array.isArray(record.data)) {
    return undefined;
  }
  const last = record.data.at(-1);
  if (typeof last !== "object" || last === null || !("id" in last)) {
    return undefined;
  }
  const afterId = (last as { id: unknown }).id;
  if (typeof afterId !== "string" || afterId.trim() === "") {
    return undefined;
  }
  const [base, query] = currentUrl.split("?");
  const params = new URLSearchParams(query ?? "");
  params.set("after_id", afterId.trim());
  return `${base}?${params.toString()}`;
}

/**
 * AI 接口连通性测试：发送一次最小补全请求（max_tokens=1）。
 * 只验证地址、Key 与模型名可用，不涉及任何账号数据。
 *
 * @throws Error 未配置或接口不可达时抛出
 */
export async function testAiConnection(
  settings: AiEndpointConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const request = buildRequest(
    settings,
    [{ role: "user", content: "ping" }],
    // 连通性测试只要最小的成功响应：max_tokens=1（Anthropic 同名参数）。
    1,
    // 测试请求不属于任何账号，用固定种子生成一次性会话 ID。
    openCodeSessionId("connection-test"),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw describeHttpFailure(response.status);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("AI 接口请求超时。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
