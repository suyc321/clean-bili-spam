/**
 * 应用编排层：把「写入观察 → 本地触发器判定 → 读 AI 结论 → 组装结果」
 * 串成完整用例，并组装设置页所需的面板状态。
 *
 * 本模块运行在 Service Worker 侧，是观察、反馈与 AI 结论的写入口。
 * 拉黑名单由内容脚本直接写入 chrome.storage.local，不经过这里。
 *
 * 判定由 AI 产出（`kind: "ai"`）。触发器命中只把结果标成
 * `kind: "triggered"`，不决定要不要调用。已配置时，没有未过期结论的
 * 新账号都会自动排队。未配置时徽章是「无判定」。
 */
import type {
  AccountAnalysis,
  AccountObservationInput,
  AccountKey,
  AccountProfileRecord,
  AiAuditEntry,
  AiReviewRecord,
  DashboardState,
  ExtensionSettings,
  ReviewOutcome,
  VideoObservationRecord,
} from "../domain/types";
import { detectReviewTriggers } from "../features/review-trigger";
import {
  MAX_PROMPT_VIDEOS,
  promptVersionForCriteria,
  requestAiReview,
  testAiConnection,
  listAiModels,
} from "../ai/review-client";
import {
  addAiAuditEntry,
  buildObservationExport,
  countObservedAccounts,
  getAccountsByVideoKeys,
  getAiAudit,
  getFreshAiReview,
  getProfile,
  getVideosForAccount,
  ingestObservation,
  putAiReview,
  pruneExpiredObservations,
} from "../storage/database";
import { getBlockedAccounts } from "../storage/blocked";
import {
  getCandidates,
  getIgnored,
  getSettings,
  getWhitelist,
} from "../storage/local-state";

// 过期清理需要遍历整个观察库，Service Worker 每次唤醒最多执行一次。
const PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
let lastPruneAtMs = 0;

/**
 * 昵称补全缓存：accountKey → 观察库里的昵称；null 表示库里也没有。
 *
 * 为什么需要：忽略名单在早期版本不存昵称（见 domain/types.ts 的 IgnoreEntry
 * 注释），设置页要显示名字只能回头查观察库。缓存把每个账号的查询压到
 * 「每次 Service Worker 生命周期一次」；SW 被回收后缓存随之清空，重查也只是
 * 几次 IndexedDB 点读。
 */
const displayNameCache = new Map<AccountKey, string | null>();

/**
 * 给缺昵称的名单条目补上名字。
 *
 * 只查 `displayName` 为 undefined 的条目；库里也查不到的保留 undefined，
 * 由界面回退成 "UID xxx"。刻意不写回存储：这是读路径，回填会让一次
 * dashboard.get 变成隐式写操作。
 */
async function fillMissingDisplayNames<
  T extends { accountKey: AccountKey; displayName?: string },
>(entries: readonly T[]): Promise<T[]> {
  const uncached = entries.filter(
    (entry) =>
      entry.displayName === undefined &&
      !displayNameCache.has(entry.accountKey),
  );
  if (uncached.length > 0) {
    await Promise.all(
      uncached.map(async (entry) => {
        const profile = await getProfile(entry.accountKey);
        displayNameCache.set(entry.accountKey, profile?.displayName ?? null);
      }),
    );
  }
  return entries.map((entry) => {
    if (entry.displayName !== undefined) {
      return entry;
    }
    const cached = displayNameCache.get(entry.accountKey);
    return cached === null || cached === undefined
      ? entry
      : { ...entry, displayName: cached };
  });
}

/** 节流包装：同一唤醒周期内重复 ingest 不再反复全库扫描过期数据。 */
async function pruneExpiredObservationsThrottled(
  cutoffMs: number,
): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAtMs < PRUNE_INTERVAL_MS) {
    return;
  }
  lastPruneAtMs = now;
  await pruneExpiredObservations(cutoffMs);
}

/**
 * 一次性读取三类处置名单，转成 Set 供逐账号 O(1) 查询。
 * 两个用例共用同一口径，避免 ingest 与 AI 判定读到不同的名单状态。
 */
async function readDispositionSets(): Promise<{
  whitelisted: Set<AccountKey>;
  ignored: Set<AccountKey>;
  candidate: Set<AccountKey>;
}> {
  const [whitelist, ignored, candidates] = await Promise.all([
    getWhitelist(),
    getIgnored(),
    getCandidates(),
  ]);
  return {
    whitelisted: new Set(whitelist.map((entry) => entry.accountKey)),
    ignored: new Set(ignored.map((entry) => entry.accountKey)),
    candidate: new Set(candidates.map((entry) => entry.accountKey)),
  };
}

/** 处置优先级：白名单 > 忽略 > 待处理 > 无。 */
function resolveDisposition(
  accountKey: AccountKey,
  lists: Awaited<ReturnType<typeof readDispositionSets>>,
): AccountAnalysis["disposition"] {
  if (lists.whitelisted.has(accountKey)) return "whitelisted";
  if (lists.ignored.has(accountKey)) return "ignored";
  if (lists.candidate.has(accountKey)) return "candidate";
  return "none";
}


/**
 * 组装分析结果的唯一入口：本地触发器、未过期的 AI 结论与处置状态在此
 * 一次性聚齐，保证 ingest 与 AI 判定两条调用路径产出结构一致的结果。
 *
 * 判定优先级固定：**未过期的 AI 结论** > 本地触发器 > 无判定。
 * 用户手动点过复核之后，触发器角标就让位给 AI 概率——再显示「值得复核」
 * 会让人以为还没复核过。
 */
async function buildAccountAnalysis(input: {
  accountKey: AccountKey;
  uid: string;
  profile: AccountProfileRecord;
  videos: VideoObservationRecord[];
  dispositionLists: Awaited<ReturnType<typeof readDispositionSets>>;
  aiReview?: AiReviewRecord;
  triggers: ReturnType<typeof detectReviewTriggers>;
}): Promise<AccountAnalysis> {
  const review: ReviewOutcome =
    input.aiReview !== undefined
      ? { kind: "ai", review: input.aiReview }
      : input.triggers.length > 0
        ? { kind: "triggered", triggers: input.triggers }
        : { kind: "none" };

  return {
    accountKey: input.accountKey,
    uid: input.uid,
    ...(input.profile.displayName === undefined
      ? {}
      : { displayName: input.profile.displayName }),
    // 名片数据：透传给 UI，并已由 review-client 写进 AI 提示词。
    ...(input.profile.followers === undefined
      ? {}
      : { followers: input.profile.followers }),
    ...(input.profile.archiveCount === undefined
      ? {}
      : { archiveCount: input.profile.archiveCount }),
    observedVideos: input.videos.length,
    hasBio:
      input.profile.profileBio !== undefined &&
      input.profile.profileBio.trim().length > 0,
    review,
    disposition: resolveDisposition(input.accountKey, input.dispositionLists),
  };
}

/**
 * 处理一批观察：入库合并、跑触发器、读取 AI 结论并返回分析结果。
 *
 * 名单（白名单/忽略/待处理）在批次开始时一次性读取，
 * 供全部观察共享，减少存储往返。
 *
 * @param observations 内容脚本提交的观察批次
 * @returns 与输入顺序一致的账号分析结果
 */
export async function analyzeObservations(
  observations: AccountObservationInput[],
): Promise<AccountAnalysis[]> {
  const [settings, dispositionLists] = await Promise.all([
    getSettings(),
    readDispositionSets(),
  ]);
  const analyses: AccountAnalysis[] = [];
  await pruneExpiredObservationsThrottled(
    Date.now() - settings.retentionDays * 24 * 60 * 60 * 1_000,
  );

  // 本地触发器用的跨账号证据。
  // 必须**先全部入库再查搬运历史**——否则同一批次里 A、B 互发同一视频时，
  // 先入库的一方还看不到另一方，会漏判（信息流同屏就能出现两个搬运号）。
  const ingested: Array<{
    observation: AccountObservationInput;
    profile: AccountProfileRecord;
    videos: VideoObservationRecord[];
  }> = [];

  for (const observation of observations) {
    const result = await ingestObservation(
      observation,
      settings.maxVideosPerAccount,
    );
    // 失效昵称缓存：账号可能是「先被忽略、之后才被观察到昵称」，
    // 不清缓存会让设置页一直显示 UID，直到 Service Worker 被回收。
    displayNameCache.delete(observation.accountKey);
    ingested.push({
      observation,
      profile: result.profile,
      videos: result.videos,
    });
  }

  const repostHistory = await getAccountsByVideoKeys(
    ingested.flatMap((entry) => entry.videos.map((video) => video.videoKey)),
  );

  for (const entry of ingested) {
    const { observation, profile, videos } = entry;
    // 读取未过期的 AI 判定结论。
    const aiReview = await getFreshAiReview(observation.accountKey);
    analyses.push(
      await buildAccountAnalysis({
        accountKey: observation.accountKey,
        uid: observation.uid,
        profile,
        videos,
        dispositionLists,
        aiReview,
        triggers: detectReviewTriggers({
          profile,
          videos,
          repostHistory,
        }),
      }),
    );
  }
  return analyses;
}

/**
 * 手动触发的 AI 判定用例：从本地库取账号数据，调用用户配置的
 * 接口，把结论入库并重新组装判定。
 *
 * 失败语义：任何一步失败都抛错（由消息层转错误响应），不写入新结论。
 *
 * @returns 包含该账号最新分析结果的单元素数组（与 ingest 响应同构）
 */
export async function reviewAccountWithAi(
  accountKey: AccountKey,
): Promise<AccountAnalysis[]> {
  const settings = await getSettings();
  if (!settings.aiEnabled) {
    throw new Error("AI 判定未启用，请先在设置页开启并完成配置。");
  }
  // 域名授权检查必须放在 SW：内容脚本没有 chrome.permissions，放在那里每次
  // 都会抛 TypeError，再被内容脚本的 catch 吞成一条提示——看起来像接口失败，
  // 实际请求根本没发出去。授权是在设置页保存配置的用户手势内完成的。
  const aiOrigin = safeOrigin(settings.aiEndpoint);
  if (aiOrigin !== "") {
    const granted = await chrome.permissions.contains({
      origins: [`${aiOrigin}/*`],
    });
    if (!granted) {
      throw new Error(
        "尚未获得 AI 接口域名授权。请在插件设置页保存 AI 配置以完成授权。",
      );
    }
  }
  if (
    settings.aiEndpoint === "" ||
    settings.aiApiKey === "" ||
    settings.aiModel === ""
  ) {
    throw new Error(
      "AI 判定配置不完整，请先在设置页填写接口地址、API Key 与模型名称。",
    );
  }
  const profile = await getProfile(accountKey);
  if (profile === undefined) {
    throw new Error("本地还没有该账号的观察数据，请先在 B 站页面浏览其卡片。");
  }
  const videos = await getVideosForAccount(accountKey);
  if (videos.length === 0) {
    throw new Error("本地没有该账号的投稿观察，无法发起 AI 判定。");
  }

  // 审计留痕：无论成败都记录本次外发的元数据（不含发送内容）。
  const auditBase = {
    id: `${Date.now()}:${accountKey}`,
    accountKey,
    uid: profile.uid,
    ...(profile.displayName === undefined
      ? {}
      : { displayName: profile.displayName }),
    model: settings.aiModel,
    endpointOrigin: safeOrigin(settings.aiEndpoint),
    sentVideoCount: Math.min(videos.length, MAX_PROMPT_VIDEOS),
    promptVersion: promptVersionForCriteria(settings.aiJudgmentCriteria),
    createdAtMs: Date.now(),
  };

  // 调用外部接口并落库；成功后才组装带 AI 结论的分析结果。
  let aiReview!: Awaited<ReturnType<typeof requestAiReview>>;
  try {
    aiReview = await requestAiReview(settings, profile, videos);
    await putAiReview(aiReview);
    await addAiAuditEntry({
      ...auditBase,
      outcome: "success",
      marketingProbability: aiReview.marketingProbability,
      model: aiReview.model,
      effectiveEndpointOrigin: safeOrigin(settings.aiEndpoint),
    });
  } catch (error) {
    await addAiAuditEntry({
      ...auditBase,
      outcome: "error",
      errorMessage:
        error instanceof Error ? error.message.slice(0, 200) : "未知错误",
    }).catch(() => undefined);
    throw error;
  }

  // 处置名单一次性读取（与 analyzeObservations 共用同一口径）。
  const dispositionLists = await readDispositionSets();
  // 触发器仍然要算：复核成功后面板上方的「为什么提示你复核」还应该有依据。
  // 单账号复核只查自己的 BV 历史，reposted-video 因此完整可算。
  const repostHistory = await getAccountsByVideoKeys(
    videos.map((video) => video.videoKey),
  );

  return [
    await buildAccountAnalysis({
      accountKey,
      uid: profile.uid,
      profile,
      videos,
      dispositionLists,
      aiReview,
      triggers: detectReviewTriggers({ profile, videos, repostHistory }),
    }),
  ];
}

/** 提取接口地址的 origin；非法地址返回空串（仅用于审计展示）。 */
function safeOrigin(endpoint: string): string {
  try {
    return new URL(endpoint.trim()).origin;
  } catch {
    return "";
  }
}

/**
 * 批量 AI 判定：对一批账号依次调用 AI 并组装结果。
 *
 * 协议里的批量入口。弹出页「判定本页」不调用它，而是逐个发
 * `ai.review.run`，以便每完成一个就更新进度。清单由调用方筛好。
 *
 * 失败语义与单账号版一致但**不抛错**：某个账号没有本地观察、AI 调用失败
 * 或超时，都只计入 skipped 并继续处理其余账号——批量操作不应因单个失败
 * 整体中断，且不影响其他账号已有的结论。AI 未启用/未授权仍然抛错
 * （这属于调用方误用）。
 *
 * @param accountKeys 账号清单（调用方已去重，最多 10 个）
 * @returns 成功复核的分析结果与被跳过的账号数
 */
export async function reviewAccountsWithAi(
  accountKeys: readonly AccountKey[],
): Promise<{ analyses: AccountAnalysis[]; skipped: number }> {
  const settings = await getSettings();
  if (!settings.aiEnabled) {
    throw new Error("AI 判定未启用，请先在设置页开启并完成配置。");
  }
  // 域名授权检查必须放在 SW：内容脚本没有 chrome.permissions，放在那里每次
  // 都会抛 TypeError，再被内容脚本的 catch 吞成一条提示——看起来像接口失败，
  // 实际请求根本没发出去。授权是在设置页保存配置的用户手势内完成的。
  const aiOrigin = safeOrigin(settings.aiEndpoint);
  if (aiOrigin !== "") {
    const granted = await chrome.permissions.contains({
      origins: [`${aiOrigin}/*`],
    });
    if (!granted) {
      throw new Error(
        "尚未获得 AI 接口域名授权。请在插件设置页保存 AI 配置以完成授权。",
      );
    }
  }

  const analyses: AccountAnalysis[] = [];
  let skipped = 0;
  for (const accountKey of accountKeys) {
    try {
      analyses.push(...(await reviewAccountWithAi(accountKey)));
    } catch (error) {
      // 单个账号失败不中断整批，但必须留下原因：以前这里空 catch，
      // 页面控制台和弹窗都看不到，按钮会一直停在「判定中」。
      const message = error instanceof Error ? error.message : "判定失败";
      console.error(`[B站内容净化助手] ${accountKey} 判定失败：${message}`);
      skipped += 1;
    }
  }
  return { analyses, skipped };
}

/**
 * 组装设置页/数据面板所需的完整本地状态。
 * @returns 设置、三份名单、累计观察账号数与 AI 审计
 */
export async function buildDashboardState(): Promise<DashboardState> {
  const [settings, whitelist, ignored, candidates, observedAccountCount, aiAudit, blockedAccounts] =
    await Promise.all([
      getSettings(),
      getWhitelist(),
      getIgnored(),
      getCandidates(),
      countObservedAccounts(),
      getAiAudit(),
      getBlockedAccounts(),
    ]);
  return {
    settings,
    // 昵称回填：白名单/待处理一直有存，忽略名单是后来才补的（旧条目没有），
    // 三份统一走同一条路，顺带兼容任何历史缺失。
    whitelist: await fillMissingDisplayNames(whitelist),
    ignored: await fillMissingDisplayNames(ignored),
    candidates: await fillMissingDisplayNames(candidates),
    observedAccountCount,
    aiAudit,
    blockedAccounts,
  };
}

/**
 * AI 接口连通性测试：发送一次最小补全请求。
 *
 * @param config 草稿配置（设置页未保存时先行测试）；缺省时测试已保存配置
 * @throws Error 配置不完整或接口不可达时抛出
 */
export async function testAiConfiguration(config?: {
  aiEndpoint: string;
  aiApiKey: string;
  aiModel: string;
}): Promise<{ ok: true; model: string }> {
  let effective = config;
  if (effective === undefined) {
    const settings = await getSettings();
    if (!settings.aiEnabled) {
      throw new Error("AI 判定未启用。");
    }
    effective = {
      aiEndpoint: settings.aiEndpoint,
      aiApiKey: settings.aiApiKey,
      aiModel: settings.aiModel,
    };
  }
  if (
    effective.aiEndpoint.trim() === "" ||
    effective.aiApiKey.trim() === "" ||
    effective.aiModel.trim() === ""
  ) {
    throw new Error("配置不完整，请填写接口地址、API Key 与模型名称。");
  }
  await testAiConnection(effective);
  return { ok: true, model: effective.aiModel.trim() };
}

/**
 * 用草稿里的地址和密钥拉取模型目录。不要求已经填模型名，也不写入设置。
 *
 * @throws Error 地址或密钥为空、或接口不可用时抛出
 */
export async function listConfiguredModels(config: {
  aiEndpoint: string;
  aiApiKey: string;
  aiFormat?: ExtensionSettings["aiFormat"];
}): Promise<{ models: string[] }> {
  if (config.aiEndpoint.trim() === "" || config.aiApiKey.trim() === "") {
    throw new Error("请先填写接口地址和 API Key。");
  }
  return { models: await listAiModels(config) };
}
