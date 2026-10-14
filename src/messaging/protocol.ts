/**
 * 运行时消息协议：Content Script / Popup / Options 与 Service Worker 之间
 * 的全部通信都走这里定义的类型化通道。
 *
 * 安全设计：
 * - 使用 Zod strict schema 白名单所有消息类型与字段，未知字段直接拒绝；
 * - 协议不接受任意 URL、选择器、脚本或接口路径，杜绝被注入通用网络能力；
 * - 载荷长度全部设上限，防止超大消息拖垮 Service Worker。
 */
import { z } from "zod";
import { MAX_JUDGMENT_CRITERIA_LENGTH } from "../domain/settings";
import type {
  AccountAnalysis,
  AccountKey,
  AccountObservationInput,
  AiApiFormat,
  DashboardState,
  ExportBundleV1,
  ExtensionSettings,
  ObservationExportV1,
} from "../domain/types";
/** 账号主键校验：必须形如 `uid:数字`。 */
const accountKeySchema = z.custom<AccountKey>(
  (value) => typeof value === "string" && /^uid:\d+$/u.test(value),
);

/** 观察来源校验：页面种类 + 适配器标识与版本。 */
const sourceSchema = z
  .object({
    pageKind: z.enum(["home", "search", "space"]),
    adapterId: z.string().min(1).max(100),
    adapterVersion: z.number().int().positive(),
  })
  .strict();

/** 单条视频观察校验：字段长度与数量均设上限。 */
const videoObservationSchema = z
  .object({
    videoKey: z.string().min(1).max(100),
    bvid: z.string().regex(/^BV[0-9A-Za-z]+$/u),
    title: z.string().min(1).max(500),
    videoUrl: z.string().url().max(2_000),
    coverUrl: z.string().url().max(2_000).optional(),
    publishedText: z.string().max(100).optional(),
    publishedAtMs: z.number().int().nonnegative().optional(),
    metricsRaw: z.array(z.string().max(100)).max(12),
    source: sourceSchema,
    observedAtMs: z.number().int().nonnegative(),
  })
  .strict();

/** 单账号观察批次校验：一批最多 50 条视频观察。 */
const accountObservationSchema: z.ZodType<AccountObservationInput> = z
  .object({
    schemaVersion: z.literal(1),
    accountKey: accountKeySchema,
    uid: z.string().regex(/^\d+$/u),
    profileUrl: z.string().url().max(2_000),
    displayName: z.string().max(200).optional(),
    profileBio: z.string().max(2_000).optional(),
    // UP 主公开名片补充字段（仅当用户在设置页开启补全后才带）。
    // 粉丝/投稿数不做越界裁剪：这两个数是事实数据，上游接口已限定范围。
    profileFollowers: z.number().int().nonnegative().optional(),
    profileArchiveCount: z.number().int().nonnegative().optional(),
    profileCardFetched: z.boolean().optional(),
    profileOfficialVerifyType: z.number().int().optional(),
    videos: z.array(videoObservationSchema).min(1).max(50),
    missingFields: z.array(z.string().max(100)).max(30),
    source: sourceSchema,
    observedAtMs: z.number().int().nonnegative(),
  })
  .strict();

/** 设置补丁校验：全部字段可选，仅允许声明的设置项（含 AI 配置）。 */
const settingsPatchSchema = z
  .object({
    showBadges: z.boolean().optional(),
    automaticallyDimHighRisk: z.boolean().optional(),
    feedAdMode: z.enum(["off", "cover", "remove"]).optional(),
    coverColor: z.enum(["dark", "light", "gray"]).optional(),
    retentionDays: z.number().optional(),
    maxVideosPerAccount: z.number().optional(),
    showOnboarding: z.boolean().optional(),
    aiEnabled: z.boolean().optional(),
    aiEndpoint: z.string().max(2_000).optional(),
    aiApiKey: z.string().max(500).optional(),
    aiModel: z.string().max(200).optional(),
    aiFormat: z.enum(["openai_chat", "anthropic", "responses"]).optional(),
    aiJudgmentCriteria: z.string().max(MAX_JUDGMENT_CRITERIA_LENGTH).optional(),
    enrichAccountInfo: z.boolean().optional(),
    logAiExchange: z.boolean().optional(),
  })
  .strict();

/**
 * 全部消息类型的判别联合。
 * 每种消息都要求 protocolVersion=1 与 requestId，便于响应配对与未来协议升级。
 */
const requestSchema = z.discriminatedUnion("type", [
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("observations.ingest"),
      payload: z
        .object({
          observations: z.array(accountObservationSchema).min(1).max(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("dashboard.get"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("settings.patch"),
      payload: z.object({ patch: settingsPatchSchema }).strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("account.disposition"),
      payload: z
        .object({
          accountKey: accountKeySchema,
          uid: z.string().regex(/^\d+$/u),
          displayName: z.string().max(200).optional(),
          aiProbability: z.number().min(0).max(100).optional(),
          disposition: z.enum(["whitelisted", "ignored", "candidate"]),
          selected: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("ai.review.run"),
      payload: z
        .object({
          accountKey: accountKeySchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("ai.review.batch"),
      // 一次最多 10 个账号。空列表、超限、重复 key 由 schema 拒绝，不截断。
      // 弹出页「判定本页」不发这条消息，而是逐个发 ai.review.run。
      payload: z
        .object({
          accountKeys: z
            .array(accountKeySchema)
            .min(1)
            .max(10)
            .refine((keys) => new Set(keys).size === keys.length, {
              message: "accountKeys 不允许重复",
            }),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      // 批量取 UP 主公开名片。必须走 SW：授权检查要 chrome.permissions，
      // 而内容脚本没有这个 API（内容脚本里调它会直接抛 TypeError）。
      type: z.literal("accountCard.get"),
      payload: z
        .object({
          uids: z
            .array(z.string().regex(/^\d+$/u))
            .min(1)
            .max(50),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      // 打开 UP 主主页（标签面板的「深度判定」）。
      // 为什么必须走 SW：内容脚本没有 chrome.tabs（在内容脚本里调
      // chrome.tabs.create 会抛 "Cannot read properties of undefined
      // (reading 'create')"，按钮点了没有任何反应）。
      // 载荷刻意只收 UID 不收 URL——协议不接受任意 URL，地址由 SW 按
      // UID 现场拼出，内容脚本无法借此打开别的域名。
      type: z.literal("account.openProfile"),
      payload: z
        .object({
          uid: z.string().regex(/^\d+$/u),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      // 拉黑准备：SW 读取 HttpOnly 的 bili_jct 并返回。
      // 实际的接口请求由内容脚本在页面上下文发起（与用户手动拉黑一致，
      // 同源、同 cookie、同 UA——SW 发请求会被 B 站风控 412 拦截）。
      type: z.literal("relation.prepare"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("export.create"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("import.commit"),
      payload: z.object({ bundle: z.unknown() }).strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("ai.config.test"),
      // config 缺省时测试已保存的配置；提供时测试草稿配置（不落盘）。
      payload: z
        .object({
          config: z
            .object({
              aiEndpoint: z.string().min(1).max(2_000),
              aiApiKey: z.string().min(1).max(500),
              aiModel: z.string().min(1).max(200),
              // 草稿配置也要带格式，否则「填好→测通→再保存」测的是另一种格式
              aiFormat: z
                .enum(["openai_chat", "anthropic", "responses"])
                .optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      // 用草稿里的地址和密钥拉模型目录。不落盘，也不要求已经填模型名。
      type: z.literal("ai.models.list"),
      payload: z
        .object({
          aiEndpoint: z.string().min(1).max(2_000),
          aiApiKey: z.string().min(1).max(500),
          aiFormat: z
            .enum(["openai_chat", "anthropic", "responses"])
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("observation.export"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("data.reset"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("audit.clear"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: z.string().min(1).max(100),
      type: z.literal("observations.clear"),
      payload: z.object({}).strict(),
    })
    .strict(),
]);

/** 已通过校验的运行时请求类型。 */
export type RuntimeRequest = z.infer<typeof requestSchema>;
/** 所有消息类型的字面量联合。 */
export type RequestType = RuntimeRequest["type"];

/**
 * 消息类型到载荷/响应的映射表。
 * 发送方通过 sendRuntimeRequest 的泛型获得完全类型化的收发体验。
 */
export interface RequestMap {
  "observations.ingest": {
    payload: { observations: AccountObservationInput[] };
    response: { analyses: AccountAnalysis[] };
  };
  "dashboard.get": {
    payload: Record<string, never>;
    response: DashboardState;
  };
  "settings.patch": {
    payload: { patch: Partial<ExtensionSettings> };
    response: { settings: ExtensionSettings };
  };
  "account.disposition": {
    payload: {
      accountKey: AccountKey;
      uid: string;
      displayName?: string;
      aiProbability?: number;
      disposition: "whitelisted" | "ignored" | "candidate";
      selected: boolean;
    };
    response: DashboardState;
  };
  "export.create": {
    payload: Record<string, never>;
    response: { bundle: ExportBundleV1 };
  };
  "import.commit": {
    payload: { bundle: unknown };
    response: DashboardState;
  };
  "data.reset": {
    payload: Record<string, never>;
    response: DashboardState;
  };
  /** 只清空判定日志。 */
  "audit.clear": {
    payload: Record<string, never>;
    response: DashboardState;
  };
  /** 清空观察账号、投稿和已缓存的 AI 结论。设置和名单保留。 */
  "observations.clear": {
    payload: Record<string, never>;
    response: DashboardState;
  };
  /**
   * AI 判定：Service Worker 从本地库取该账号数据，调用用户配置的接口，
   * 返回与 ingest 相同结构的分析结果。自动排队和面板再判都走这条消息。
   */
  "ai.review.run": {
    payload: { accountKey: AccountKey };
    response: { analyses: AccountAnalysis[] };
  };
  /**
   * 批量 AI 判定：一次最多 10 个账号。
   * 弹出页不使用这条消息，逐个调用 `ai.review.run`。
   */
  "ai.review.batch": {
    payload: { accountKeys: AccountKey[] };
    response: {
      /** 成功复核的账号分析（失败/无数据的账号被跳过）。 */
      analyses: AccountAnalysis[];
      /** 被跳过的账号数（无本地观察或 AI 调用失败）。 */
      skipped: number;
    };
  };
  /**
   * 批量取 UP 主公开名片（简介/粉丝数/投稿数）。
   * 由 SW 执行：内部先检查 api.bilibili.com 主机权限，未授权则返回空。
   * 只读公开数据，不上传任何用户数据。
   */
  "accountCard.get": {
    payload: { uids: string[] };
    response: {
      /** uid → 名片字段；取不到的 uid 不出现在结果里。 */
      cards: Record<
        string,
        {
          name?: string;
          sign?: string;
          fans?: number;
          archiveCount?: number;
          officialVerifyType?: number;
          /** 合集数量（0 表示没有合集）。 */
          seasonCount?: number;
          /**
           * 从合集拿到的投稿：作为额外观察记录入库，让首页也能算出
           * 投稿频率、模板相似度、主题跨度、互动率这些需要多样本的信号。
           */
          seasonVideos?: Array<{
            bvid: string;
            title: string;
            pubdate?: number;
            duration?: number;
            view?: number;
            danmaku?: number;
          }>;
        }
      >;
    };
  };
  /** 打开 UP 主主页（标签面板的「深度判定」）。由 SW 代开标签页。 */
  "account.openProfile": {
    payload: { uid: string };
    response: { opened: boolean };
  };
  /** 拉黑准备：返回读取到的 CSRF 令牌（SW 用 chrome.cookies 读）。 */
  "relation.prepare": {
    payload: { /* 空 */ };
    response: {
      csrf: string;
      /**
       * 取不到令牌时的原因。界面据此给出可操作的提示，
       * 而不是笼统的「请刷新页面」——未授权与未登录的处置方式完全不同。
       */
      reason?: "no-permission" | "no-cookie";
    };
  };
  /** AI 接口连通性测试：可带草稿配置（不落盘），缺省测已保存配置。 */
  "ai.config.test": {
    payload: {
      config?: {
        aiEndpoint: string;
        aiApiKey: string;
        aiModel: string;
        /** 草稿配置的格式；缺省按 openai_chat。 */
        aiFormat?: AiApiFormat;
      };
    };
    response: { ok: true; model: string };
  };
  /** 用地址和密钥拉取模型目录。结果不写入设置。 */
  "ai.models.list": {
    payload: {
      aiEndpoint: string;
      aiApiKey: string;
      aiFormat?: AiApiFormat;
    };
    response: { models: string[] };
  };
  /** 导出全部观察数据（含标题与简介，需用户显式确认）。 */
  "observation.export": {
    payload: Record<string, never>;
    response: { bundle: ObservationExportV1 };
  };
}

/** 统一的错误响应结构；error.code 为固定枚举便于调用方分支处理。 */
export type RuntimeResponse<T> =
  | {
      protocolVersion: 1;
      requestId: string;
      ok: true;
      data: T;
    }
  | {
      protocolVersion: 1;
      requestId: string;
      ok: false;
      error: {
        code:
          | "INVALID_MESSAGE"
          | "UNSUPPORTED_VERSION"
          | "INVALID_SENDER"
          | "STORAGE_FAILURE"
          | "INTERNAL_ERROR";
        message: string;
        retryable: boolean;
      };
    };

/**
 * 校验并解析一条原始消息。
 * @throws z.ZodError 当消息不符合白名单时抛出
 */
export function parseRuntimeRequest(input: unknown): RuntimeRequest {
  return requestSchema.parse(input);
}

/**
 * 发送一条类型化请求到 Service Worker 并等待响应。
 * @throws Error 当响应为错误响应时抛出（携带错误消息）
 */
export async function sendRuntimeRequest<T extends keyof RequestMap>(
  type: T,
  payload: RequestMap[T]["payload"],
): Promise<RequestMap[T]["response"]> {
  const requestId = crypto.randomUUID();
  const response = (await chrome.runtime.sendMessage({
    protocolVersion: 1,
    requestId,
    type,
    payload,
  })) as RuntimeResponse<RequestMap[T]["response"]>;

  if (response.ok) {
    return response.data;
  }
  throw new Error(response.error.message);
}

/** 构造成功响应。 */
export function successResponse<T>(
  requestId: string,
  data: T,
): RuntimeResponse<T> {
  return {
    protocolVersion: 1,
    requestId,
    ok: true,
    data,
  };
}

/**
 * 构造错误响应。
 * Zod 校验失败归类为 INVALID_MESSAGE，其余一律按内部错误处理，
 * 避免向调用方泄露内部实现细节。
 */
export function errorResponse(
  requestId: string,
  error: unknown,
): RuntimeResponse<never> {
  return {
    protocolVersion: 1,
    requestId,
    ok: false,
    error: {
      code: error instanceof z.ZodError ? "INVALID_MESSAGE" : "INTERNAL_ERROR",
      message:
        error instanceof Error ? error.message : "发生未知错误，请稍后重试。",
      retryable: false,
    },
  };
}
