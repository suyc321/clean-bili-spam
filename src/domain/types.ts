/**
 * 领域类型定义：整个插件共享的核心数据模型。
 *
 * 本文件是所有层的类型基石，其他模块（采集、存储、消息、UI）
 * 都从这里引用类型。按工程的依赖规则，本目录不得依赖任何运行时代码。
 */

import type { BlockedEntry } from "../storage/blocked";

/**
 * AI 接口支持的 API 格式。
 *
 * 不同服务商的请求路径、鉴权头和响应字段不一样，所以格式做成配置项。
 * StepFun 的 step_plan/v1 + step-3.7-flash 上三种格式都可用。
 *
 * 实测结论（StepFun step_plan/v1 + step-3.7-flash）：
 * - `openai_chat`   `/chat/completions`，文本在 `choices[0].message.content`
 * - `anthropic`     `/v1/messages`，文本在 `content[].text`（需拼接）
 * - `responses`     `/responses`，**坑**：推理模型会把思维链也放进
 *                   `output[].content[].text`，取第一个 text 块拿到的是
 *                   自言自语而不是最终答案，需要跳过。
 */
export type AiApiFormat = "openai_chat" | "anthropic" | "responses";

/** 支持扫描的页面种类：首页/推荐页、搜索结果页、UP 主主页。 */
export type PageKind = "home" | "search" | "space";

/**
 * 本地触发器信号标识（实现见 features/review-trigger.ts）。
 *
 * 语义是「这里值得花一次 AI 判定」，不是「这是营销号」。命中只说明本地看到
 * 了一个便宜的事实信号，用户点不点复核由他决定，插件不代为指控。
 */
export type ReviewTriggerSignal =
  | "repost-disclaimer" // 简介含侵权免责声明
  | "resource-trafficking" // 投稿标题兜售成套可下载物料
  | "reposted-video" // 同一投稿也出现在其他账号名下
  | "burst-posting"; // 24 小时内投稿密集

/** 一次触发器命中：哪个信号 + 面向用户的事实性描述（不含结论）。 */
export interface ReviewTriggerHit {
  signal: ReviewTriggerSignal;
  detail: string;
}

/**
 * 账号当前的判定状态。
 *
 * 判定只由 AI 产出（`kind: "ai"`）。其余两态都是「还没有判定」：
 * - `triggered`：本地触发器命中，还没有未过期结论。徽章显示「值得复核」。
 *   AI 已配置时会进自动队列，不必等点击；
 * - `none`：没触发，也没有未过期结论。徽章显示「无判定」，弹出页写「尚无判定」。
 *   AI 已配置时同样进自动队列。
 */
export type ReviewOutcome =
  | { kind: "ai"; review: AiReviewRecord }
  | { kind: "triggered"; triggers: ReviewTriggerHit[] }
  | { kind: "none" };

/**
 * 账号主键。以稳定 UID 为唯一标识（而非昵称，昵称可改），
 * 模板字符串类型保证主键始终形如 `uid:12345`。
 */
export type AccountKey = `uid:${string}`;

/** 一次观察的来源信息，用于追踪数据由哪个页面适配器的哪个版本采集。 */
export interface ObservationSource {
  pageKind: PageKind;
  adapterId: string;
  adapterVersion: number;
}

/** 从页面提取出的单条视频观察（尚未落库的输入形态）。 */
export interface VideoObservationInput {
  /** 视频稳定键，当前使用 BVID。 */
  videoKey: string;
  /** 视频 BV 号。 */
  bvid: string;
  /** 标题文本（截断至 500 字符）。 */
  title: string;
  /** 视频页地址（已解析为绝对 URL）。 */
  videoUrl: string;
  /** 封面图地址（可选）。 */
  coverUrl?: string;
  /** 页面上展示的发布时间原文（如「3天前」）。 */
  publishedText?: string;
  /** 从发布时间原文换算出的时间戳（毫秒，可选）。 */
  publishedAtMs?: number;
  /** 页面上可见的原始统计文本（播放、弹幕等），只入库。 */
  metricsRaw: string[];
  source: ObservationSource;
  /** 本次观察到的时间戳（毫秒）。 */
  observedAtMs: number;
}

/** 从页面提取出的单账号观察批次（一批视频 + 账号资料），消息协议的载荷。 */
export interface AccountObservationInput {
  /** 数据结构版本，当前固定为 1，未来结构变更时递增。 */
  schemaVersion: 1;
  accountKey: AccountKey;
  uid: string;
  profileUrl: string;
  /** 昵称（可选，缺失时不写入）。 */
  displayName?: string;
  /** 简介原文（可选，缺失时不写入），站外引流特征的输入。 */
  profileBio?: string;
  /**
   * 粉丝数（可选，来自 UP 主公开名片接口）。
   * 与投稿数一起供面板展示，并写入 AI 提示词。
   */
  profileFollowers?: number;
  /** 投稿数（可选，同上）。 */
  profileArchiveCount?: number;
  /** 该账号是否取过公开名片（用于区分「无简介」与「没查过」）。 */
  profileCardFetched?: boolean;
  /** 认证类型：-1 无 / 0 个人 / 1 机构。 */
  profileOfficialVerifyType?: number;
  /** 本批观察到的视频列表（已按账号去重）。 */
  videos: VideoObservationInput[];
  /** 采集时缺失的字段清单，用于诊断适配器降级。 */
  missingFields: string[];
  source: ObservationSource;
  observedAtMs: number;
}

/** 账号资料在 IndexedDB 中的持久化记录。 */
export interface AccountProfileRecord {
  accountKey: AccountKey;
  uid: string;
  profileUrl: string;
  displayName?: string;
  profileBio?: string;
  /** 粉丝数 / 投稿数：来自公开名片，写库时不做任何判断。 */
  followers?: number;
  archiveCount?: number;
  /** 是否成功取过公开名片（false 表示没查过，不等于「无简介」）。 */
  cardFetched?: boolean;
  /** 认证类型：-1 无 / 0 个人 / 1 机构。 */
  officialVerifyType?: number;
  /** 首次观察到该账号的时间戳（合并观察时取历史最小值）。 */
  firstSeenAtMs: number;
  /** 最近一次观察到该账号的时间戳（合并观察时取历史最大值）。 */
  lastSeenAtMs: number;
}

/** 单条视频观察的持久化记录：在输入基础上补充合并统计字段。 */
export interface VideoObservationRecord extends VideoObservationInput {
  accountKey: AccountKey;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  /** 累计被观察到的次数（重复扫描同一卡片时递增）。 */
  seenCount: number;
}

/**
 * AI 判定结论（用户自带接口，BYOK）。
 *
 * 隐私边界：开启并完成域名授权后，会发送昵称、简介与投稿标题；结论持久化在本机。
 * AI 结论是插件**唯一**的判定来源——本地触发器只决定要不要发起复核。
 */
export interface AiReviewRecord {
  accountKey: AccountKey;
  /** 模型给出的营销号/低质量概率（0-100，已取整）。 */
  marketingProbability: number;
  /** 模型的分类结论（六分类 + 不确定）。 */
  category:
    | "normal"
    | "marketing"
    | "repost"
    | "ai_rewritten"
    | "advertising"
    | "uncertain";
  /** 模型给出的一句话中文理由。 */
  reason: string;
  /** 模型声明的证据不足项（如「缺少评论区样本」）。 */
  insufficientData: string[];
  /** 产生该结论的模型标识。 */
  model: string;
  /** 复核时间戳（毫秒），超过 TTL 的结论不再参与判定。 */
  reviewedAtMs: number;
}

/** 待处理清单条目：用户标记为「稍后人工复核」的账号。 */
export interface CandidateEntry {
  accountKey: AccountKey;
  uid: string;
  displayName?: string;
  /** 加入清单时的 AI 概率快照；未复核过则为空。 */
  aiProbability?: number;
  addedAtMs: number;
}

/** 白名单条目：用户确认为正常账号，命中后不再显示触发器角标。 */
export interface WhitelistEntry {
  accountKey: AccountKey;
  displayName?: string;
  addedAtMs: number;
}

/**
 * 忽略条目：用户选择不再对某账号显示提示。
 *
 * `displayName` 是后来补的：早期这个类型和写入分支都不存昵称，而处置消息的
 * 载荷里一直带着它（`account.disposition` 有 displayName 字段），只是被静默
 * 丢掉了。结果设置页的忽略名单只能把 accountKey 切一刀显示成 "UID xxx"，
 * 用户认不出是自己忽略过的哪个账号——白名单与待处理清单则一直有昵称。
 *
 * 必须是可选字段：旧数据（chrome.storage 里已存的条目）没有它，而
 * local-state 的 `readArray` / `parseArray` 在整数组校验失败时会**整数组
 * 回退为空**，设成必填会让用户已有的忽略名单静默清空。
 */
export interface IgnoreEntry {
  accountKey: AccountKey;
  displayName?: string;
  ignoredAtMs: number;
}

/**
 * AI 判定审计记录：每次外发请求的本地留痕。
 * AI 判定是插件唯一的外发数据路径，审计让「可解释、可问责」可被检验。
 * 只记录元数据（账号、模型、数量、结果），不记录发送内容本身。
 */
export interface AiAuditEntry {
  /** 审计主键：`${createdAtMs}:${accountKey}`。 */
  id: string;
  accountKey: AccountKey;
  uid: string;
  displayName?: string;
  model: string;
  /** 实际请求的接口源（仅 origin，不含路径与 Key）。 */
  endpointOrigin: string;
  /** 发送的标题数量。 */
  sentVideoCount: number;
  /**
   * 本次使用的提示词版本（见 ai/review-client 的 REVIEW_PROMPT_VERSION）。
   * 用户改过判定口径时，后面会加上这段口径的摘要，便于区分同版本下的不同标准。
   * AI 结论本身不可回归，记下版本才能解释历史结论是用什么口径得出的。
   */
  promptVersion: string;
  /** 产出结论时实际使用的接口源（仅 origin）。 */
  effectiveEndpointOrigin?: string;
  outcome: "success" | "error";
  /** 成功时的营销号概率。 */
  marketingProbability?: number;
  /** 失败时的错误摘要。 */
  errorMessage?: string;
  createdAtMs: number;
}

/**
 * 观察数据导出结构（v1）：用户对自己的观察数据拥有完整所有权。
 * 包含敏感字段（标题、简介），导出必须经用户显式确认。
 */
export interface ObservationExportV1 {
  formatVersion: 1;
  exportedAtMs: number;
  profiles: AccountProfileRecord[];
  videos: VideoObservationRecord[];
}

/**
 * 推荐流广告和强插卡片的处理方式。
 * `off` 不处理；`cover` 盖遮罩；`remove` 直接从页面隐藏（等价于广告拦截器的
 * 元素隐藏规则，节点保留，切回其他档时恢复显示）。
 */
export type FeedAdMode = "off" | "cover" | "remove";

/**
 * 卡片遮罩颜色。三档都保证遮罩接近不透明、标签文字对比可读。
 * 用户显式选择后不再跟随系统深色模式：遮罩是功能层不是氛围层。
 */
export type CoverColor = "dark" | "light" | "gray";

/** 用户可调整的插件设置。 */
export interface ExtensionSettings {
  /**
   * 是否在页面上显示标签。
   * AI 概率的 60/80 分档只影响徽章颜色和弱化遮罩，见 content/badge-renderer.ts。
   */
  showBadges: boolean;
  /**
   * 是否对高风险内容叠加弱化遮罩（默认关闭）。
   * 「高风险」= AI 概率 ≥80，与徽章配色的 high 档同一常量。
   */
  automaticallyDimHighRisk: boolean;
  /**
   * 推荐流里商业广告和强插卡片的处理方式（默认遮挡）。
   *
   * 首页推荐流里，普通投稿在 `.bili-feed-card` 中且链接含 `/video/`。
   * 官方强插是 `.floor-single-card`，没有投稿链接。`cover` 盖住后者，
   * 以及推荐流里同样没有投稿链接的商业广告；`remove` 直接把它们从页面隐藏。
   */
  feedAdMode: FeedAdMode;
  /**
   * 卡片遮罩颜色（默认纯黑）。
   * 广告遮挡与高风险弱化共用同一套遮罩，颜色也同源。
   */
  coverColor: CoverColor;
  /** 本地观察数据的保留天数（7-365）。 */
  retentionDays: number;
  /** 每个账号最多保留的投稿观察条数（5-50）。 */
  maxVideosPerAccount: number;
  /** 是否显示设置页的首次使用引导。 */
  showOnboarding: boolean;
  /**
   * AI 判定开关（默认关闭）。
   *
   * 判定由这里产出。未配置时卡片徽章显示「无判定」，弹出页账号行显示「尚无判定」。
   * 开启并完成域名授权后，健康扫描扫到且还没有未过期结论的新账号会自动判定；
   * 卡片上也可以再点一次。
   */
  aiEnabled: boolean;
  /** OpenAI 兼容接口地址（如 https://api.openai.com/v1）。 */
  aiEndpoint: string;
  /** 接口 API Key，仅保存在本机，不会出现在导出文件之外的位置。 */
  aiApiKey: string;
  /** 模型名称（如 gpt-4o-mini、glm-4-flash）。 */
  aiModel: string;
  /**
   * 接口格式：`openai_chat` / `anthropic` / `responses`。
   *
   * 决定请求怎么拼、鉴权头怎么写、响应从哪个字段取。
   * 缺省 `openai_chat`。
   */
  aiFormat: AiApiFormat;
  /**
   * 用户编写的判定口径。空字符串表示使用内置默认。
   *
   * 只替换「什么样的账号该被标出」。JSON 格式和六个类别由代码固定，不在这里。
   * 这段文字会和昵称、简介、投稿标题一起发到用户填写的接口。
   */
  aiJudgmentCriteria: string;
  /**
   * 是否补全 UP 主公开信息（默认关闭）。
   *
   * 开启后，扫描到已知 UID 的卡片时会读取该 UP 的公开名片（简介、粉丝数、
   * 投稿数）。这是**只读公开数据**，不上传任何用户数据，但属于新增网络行为，
   * 因此必须由用户显式开启。
   *
   * 首页卡片解析不到简介，「侵权免责声明」在首页需要这份简介。
   * 粉丝数与投稿数交给面板和 AI。
   */
  enrichAccountInfo: boolean;
  /**
   * 是否在 Service Worker 控制台打印每次判定的请求与响应（默认开启）。
   * 只影响这条调试输出，不改变判定请求本身。
   */
  logAiExchange: boolean;
}

/** 设置页与数据面板所需的完整本地状态。 */
export interface DashboardState {
  settings: ExtensionSettings;
  whitelist: WhitelistEntry[];
  ignored: IgnoreEntry[];
  candidates: CandidateEntry[];
  /** 累计观察过的账号数量（IndexedDB 统计）。 */
  observedAccountCount: number;
  /** AI 判定审计（按时间降序，最近在前）。 */
  aiAudit: AiAuditEntry[];
  /** 拉黑记录（按时间降序），供设置页审计；取消拉黑需在 B 站页面面板操作。 */
  blockedAccounts: BlockedEntry[];
}

/** Popup 展示的单账号摘要（按 AI 概率与触发器排序前的原始形态）。 */
export interface PageAccountSummary {
  accountKey: AccountKey;
  uid: string;
  displayName?: string;
  /** 已观察到的投稿条数。 */
  observedVideos: number;
  /** 当前判定状态：AI 结论 / 已触发待复核 / 无判定。 */
  review: ReviewOutcome;
  /** AI 判定失败过（接口限流、鉴权失败等），本次没有得到结论。 */
  aiUnavailable: boolean;
  /** 该账号当前的处置状态。 */
  disposition: "none" | "whitelisted" | "ignored" | "candidate";
}

/** 单次页面扫描的汇总结果，供 Popup 查询与诊断导出。 */
export interface PageSummary {
  pageKind: PageKind;
  /** 扫描到的视频卡片总数。 */
  scannedCards: number;
  /** 未能解析出稳定 UID 的卡片数量。 */
  unresolvedCards: number;
  /** 适配器健康度：正常 / 降级 / 页面不支持。 */
  adapterHealth: "healthy" | "degraded" | "unsupported";
  /** 产出本次扫描的适配器标识与版本。 */
  adapterId: string;
  adapterVersion: number;
  /** 各选择器的匹配诊断，用于排查页面改版问题（不含隐私数据）。 */
  diagnostics: PageDiagnostic[];
  accounts: PageAccountSummary[];
  /** AI 判定是否已配置启用（Popup 据此显示批量复核入口）。 */
  aiEnabled: boolean;
  updatedAtMs: number;
}

/** 单个选择器的诊断信息（适配器内部自检结果）。 */
export interface PageDiagnostic {
  selectorKey: string;
  status: "matched" | "fallback" | "missing" | "parse-failed";
  /** 匹配到的元素数量（可选）。 */
  count?: number;
}

/** 单个账号的完整分析结果（判定 + 处置状态），消息协议的返回形态。 */
export interface AccountAnalysis {
  accountKey: AccountKey;
  uid: string;
  displayName?: string;
  /**
   * 粉丝数 / 投稿数：来自 UP 主公开名片（需用户在设置页开启补全）。
   * 喂给 AI 提示词，让模型能判断「投稿/粉丝比」这个农场比例信号。
   */
  followers?: number;
  archiveCount?: number;
  /** 累计观察到的投稿条数。 */
  observedVideos: number;
  /** 是否拿到简介文本。 */
  hasBio: boolean;
  /** 当前判定状态。 */
  review: ReviewOutcome;
  disposition: "none" | "whitelisted" | "ignored" | "candidate";
}

/** 配置导出文件的结构（v1）。默认不包含投稿观察数据库。 */
export interface ExportBundleV1 {
  formatVersion: 1;
  exportedAtMs: number;
  settings: ExtensionSettings;
  whitelist: WhitelistEntry[];
  ignored: IgnoreEntry[];
  candidates: CandidateEntry[];
}
