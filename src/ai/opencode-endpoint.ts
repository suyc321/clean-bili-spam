/**
 * OpenCode 推理网关的地址与请求头适配。
 *
 * OpenCode 的接口不是普通的「基址 + 固定路径」：
 * - Go / Go Plus 订阅：`https://opencode.ai/inference/go`
 * - 按量付费：`https://opencode.ai/inference`
 * 同一根下按协议分前缀（官方 Console 文档，2026-11 核对）：
 *   Anthropic Messages → `/anthropic/v1/messages`
 *   OpenAI Chat        → `/openai/v1/chat/completions`
 *   OpenAI Responses   → `/openai/v1/responses`
 * 模型目录固定在 `<root>/v1/models`，不带协议前缀。
 *
 * 两个容易踩的坑：
 * - 用户界面里填写的「请求地址」通常是 `.../go/anthropic`（Claude 兼容基址），
 *   直接拼 `/messages` 会得到并不存在的 `.../anthropic/messages`；
 * - Go 要求每个请求带 `x-opencode-session`，缺失时返回 400 MissingSessionID。
 *   这里按账号生成稳定会话 ID（只含哈希，不含 UID 原文）。
 */
import type { AiApiFormat } from "../domain/types";

/** OpenCode 推理网关的域名（文档只使用不带 www 的写法）。 */
const OPENCODE_HOST = "opencode.ai";
/** 网关根路径的第一段。 */
const INFERENCE_SEGMENT = "inference";
/** Go 订阅在根路径下的产品段。 */
const GO_SEGMENT = "go";

/** 各协议在网关根下的固定路径。 */
const REQUEST_PATHS: Record<AiApiFormat, string> = {
  anthropic: "/anthropic/v1/messages",
  openai_chat: "/openai/v1/chat/completions",
  responses: "/openai/v1/responses",
};

/**
 * 提取 OpenCode 网关根（`https://opencode.ai/inference[/go]`）。
 *
 * 接受用户可能填写的各种形态：根地址、带协议段（`/anthropic`）、带 `/v1`，
 * 甚至已经填了完整请求路径。只要 host 与首段匹配，就归一化到同一个根。
 *
 * @returns 归一化后的根；不是 OpenCode 推理地址时返回 undefined
 */
export function openCodeRoot(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== OPENCODE_HOST) {
    return undefined;
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments[0] !== INFERENCE_SEGMENT) {
    return undefined;
  }
  return segments[1] === GO_SEGMENT
    ? `${url.origin}/${INFERENCE_SEGMENT}/${GO_SEGMENT}`
    : `${url.origin}/${INFERENCE_SEGMENT}`;
}

/** 是否为 OpenCode 推理网关地址。 */
export function isOpenCodeEndpoint(endpoint: string): boolean {
  return openCodeRoot(endpoint) !== undefined;
}

/**
 * 按协议拼出完整请求地址。
 * @returns 完整 URL；不是 OpenCode 地址时返回 undefined，交给通用拼接逻辑
 */
export function resolveOpenCodeRequestUrl(
  endpoint: string,
  format: AiApiFormat,
): string | undefined {
  const root = openCodeRoot(endpoint);
  return root === undefined ? undefined : `${root}${REQUEST_PATHS[format]}`;
}

/**
 * OpenCode 的模型目录地址：`<root>/v1/models`。
 * 不能沿用通用逻辑（在基址后补 `/models`），否则会得到 404 的
 * `.../anthropic/models`。
 */
export function resolveOpenCodeModelsUrl(
  endpoint: string,
): string | undefined {
  const root = openCodeRoot(endpoint);
  return root === undefined ? undefined : `${root}/v1/models`;
}

/**
 * 归一化模型名。
 *
 * OpenCode 自己的配置文件用 `opencode-go/<model-id>` 指代模型，用户很容易
 * 直接把它复制到本插件。网关接口只认裸 ID，因此在 OpenCode 地址下去掉这个
 * 前缀；其他地址原样返回。
 */
export function normalizeOpenCodeModelId(
  model: string,
  endpoint: string,
): string {
  const prefix = "opencode-go/";
  return isOpenCodeEndpoint(endpoint) && model.startsWith(prefix)
    ? model.slice(prefix.length)
    : model;
}

/**
 * 生成稳定的会话 ID（`ses_` + 32 位十六进制）。
 *
 * 同一账号的多次判定复用同一个 ID，便于网关归并会话；ID 由账号键哈希得到，
 * 不携带 UID 原文。四个不同种子保证长度足够、分布稳定。
 */
export function openCodeSessionId(seed: string): string {
  const parts = [seed, `#${seed}`, `##${seed}`, `###${seed}`].map(fnv1aHex);
  return `ses_${parts.join("")}`;
}

/** FNV-1a 32 位哈希（八位十六进制）。 */
function fnv1aHex(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
