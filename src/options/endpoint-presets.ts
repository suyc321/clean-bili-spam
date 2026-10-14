import type { AiApiFormat } from "../domain/types";

/** 常见服务商的接口基址。插件会按格式在后面补上具体路径。 */
export interface EndpointPreset {
  name: string;
  endpoint: string;
  format: AiApiFormat;
}

export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [
  { name: "OpenAI", endpoint: "https://api.openai.com/v1", format: "openai_chat" },
  { name: "Anthropic", endpoint: "https://api.anthropic.com/v1", format: "anthropic" },
  {
    name: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
    format: "openai_chat",
  },
  { name: "xAI", endpoint: "https://api.x.ai/v1", format: "openai_chat" },
  { name: "Groq", endpoint: "https://api.groq.com/openai/v1", format: "openai_chat" },
  { name: "Mistral", endpoint: "https://api.mistral.ai/v1", format: "openai_chat" },
  { name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", format: "openai_chat" },
  { name: "DeepSeek", endpoint: "https://api.deepseek.com/v1", format: "openai_chat" },
  { name: "Kimi（月之暗面）", endpoint: "https://api.moonshot.cn/v1", format: "openai_chat" },
  { name: "智谱 GLM", endpoint: "https://open.bigmodel.cn/api/paas/v4", format: "openai_chat" },
  {
    name: "通义千问",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    format: "openai_chat",
  },
  {
    name: "豆包（火山方舟）",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    format: "openai_chat",
  },
  { name: "硅基流动", endpoint: "https://api.siliconflow.cn/v1", format: "openai_chat" },
  {
    name: "腾讯混元",
    endpoint: "https://api.hunyuan.cloud.tencent.com/v1",
    format: "openai_chat",
  },
  { name: "MiniMax", endpoint: "https://api.minimaxi.com/v1", format: "openai_chat" },
  { name: "阶跃星辰", endpoint: "https://api.stepfun.com/step_plan/v1", format: "anthropic" },
];
