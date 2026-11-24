/**
 * Service Worker：插件后台入口与消息路由。
 *
 * 职责边界：
 * - 写入观察库、设置与 AI 结论（经 application 层编排）；
 * - 拉黑名单不在这里写：内容脚本直接读写 chrome.storage.local；
 * - 所有入站消息先做来源校验，再做协议白名单校验；
 * - 写操作串行排队（IndexedDB 事务不能并发交错），读操作可并行。
 */
import { z } from "zod";
import {
  buildDashboardState,
  analyzeObservations,
  reviewAccountWithAi,
  reviewAccountsWithAi,
  testAiConfiguration,
  listConfiguredModels,
} from "../application/analyze-observations";
import { readBilibiliCsrf } from "../application/relation";
import {
  ACCOUNT_INFO_ORIGIN,
  fetchAccountCard,
} from "../api/account-card";
import {
  errorResponse,
  parseRuntimeRequest,
  successResponse,
  type RuntimeRequest,
} from "../messaging/protocol";
import {
  clearAiAudit,
  clearObservationDatabase,
  clearObservedAccounts,
  buildObservationExport,
} from "../storage/database";
import {
  createExportBundle,
  importBundle,
  patchSettings,
  resetUserData,
  setAccountDisposition,
} from "../storage/local-state";
import { clearBlockedAccounts } from "../storage/blocked";
import { forEachConcurrent } from "./concurrency";

// 写操作共享同一条 Promise 链：前一个写完成后才开始下一个，避免并发写坏数据。
let stateWriteQueue: Promise<void> = Promise.resolve();
// AI 判定单独串行：保留「一次只跑一个外发请求」的成本控制，但不占写队列，
// 否则一次最长 30 秒的接口调用会把所有读操作一起堵住。
let aiReviewQueue: Promise<void> = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  console.info("[B站内容净化助手] 插件已安装，所有识别数据默认保存在本地。");
});

/** 内容脚本推给弹出页的摘要。后台不处理，避免被协议校验记成错误。 */
function isContentSummaryMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "scope" in message &&
    message.scope === "kcf-content"
  );
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (isContentSummaryMessage(message)) {
    return undefined;
  }
  return handleMessage(message, sender);
});

/**
 * 消息处理总入口。
 * @returns 响应对象（chrome.runtime.sendMessage 的 Promise 结果）
 */
async function handleMessage(
  input: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  // 尽力提取 requestId，即使后续校验失败也能把错误配对回请求。
  const requestId =
    typeof input === "object" &&
    input !== null &&
    "requestId" in input &&
    typeof input.requestId === "string"
      ? input.requestId
      : "unknown";

  try {
    // 来源校验：只接受本扩展自身的消息，拒绝其他扩展或网页注入。
    if (sender.id !== chrome.runtime.id) {
      return {
        protocolVersion: 1,
        requestId,
        ok: false,
        error: {
          code: "INVALID_SENDER",
          message: "拒绝来自其他扩展的消息。",
          retryable: false,
        },
      };
    }
    const request = parseRuntimeRequest(input);
    const data = await runRequest(request);
    return successResponse(request.requestId, data);
  } catch (error) {
    console.error("[B站内容净化助手] 消息处理失败", error);
    return errorResponse(requestId, error);
  }
}

/**
 * 按读写性质调度请求：
 * - 读操作直接等待当前写队列后并行执行；
 * - 写操作追加到串行队列尾部，返回值即本操作的完成 Promise。
 */
async function runRequest(request: RuntimeRequest): Promise<unknown> {
  if (!requestWritesState(request)) {
    await stateWriteQueue;
    return routeRequest(request);
  }
  return withStateWrite(() => routeRequest(request));
}

/** 把一段状态写入追加到串行队列尾部。 */
function withStateWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = stateWriteQueue.then(operation);
  // 队列尾部吞掉错误（调用方自行处理 result），避免断链阻塞后续写。
  stateWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * AI 判定串行槽。
 *
 * 与写队列分开：外发请求最长 30 秒，批量入口最长 5 分钟，放进写队列会让
 * dashboard.get / relation.prepare / export 等读操作一起等待。这里只保证
 * 同一时间只有一个 AI 请求，成本控制与原来一致；真正的入库写入由
 * reviewAccountWithAi 通过 withStateWrite 单独锁住。
 */
function withAiReviewSlot<T>(operation: () => Promise<T>): Promise<T> {
  const result = aiReviewQueue.then(operation);
  aiReviewQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** 判断消息类型是否会产生状态写入。 */
function requestWritesState(request: RuntimeRequest): boolean {
  switch (request.type) {
    case "observations.ingest":
    case "settings.patch":
    case "account.disposition":
    case "import.commit":
    case "data.reset":
    case "audit.clear":
    case "observations.clear":
      return true;
    case "dashboard.get":
    case "export.create":
    case "accountCard.get": // 只读：批量取公开名片，不产生状态写入
    case "account.openProfile": // 只开一个新标签页，不碰本地状态
    case "relation.prepare": // 只读：返回 CSRF 令牌，不产生状态写入
    case "ai.config.test": // 只读连通性测试，不产生状态写入
    case "ai.models.list": // 只读：拉模型目录，不写入设置
    case "ai.review.run": // 主体是外发请求；入库写入由 withStateWrite 单独排队
    case "ai.review.batch": // 同上，批量逐个执行
    case "observation.export":
      return false;
    default:
      return assertNever(request);
  }
}

/** 按消息类型路由到应用层用例。 */
async function routeRequest(request: RuntimeRequest): Promise<unknown> {
  switch (request.type) {
    case "observations.ingest":
      return {
        analyses: await analyzeObservations(request.payload.observations),
      };
    case "dashboard.get":
      return buildDashboardState();
    case "settings.patch":
      return { settings: await patchSettings(request.payload.patch) };
    case "account.disposition": {
      await setAccountDisposition(request.payload);
      return buildDashboardState();
    }
    case "export.create":
      return { bundle: await createExportBundle() };
    case "import.commit":
      await importBundle(request.payload.bundle);
      return buildDashboardState();
    case "ai.review.run":
      // 内容脚本发起的 AI 判定（滚动自动排队或面板再判）：结论入库后按 ingest 同构返回。
      // 外发请求在写队列之外；只有入库写入经过 withStateWrite。
      return {
        analyses: await withAiReviewSlot(() =>
          reviewAccountWithAi(request.payload.accountKey, withStateWrite),
        ),
      };
    case "ai.review.batch":
      // 协议保留的批量入口。弹出页不走这里，而是逐个发 ai.review.run。
      return withAiReviewSlot(() =>
        reviewAccountsWithAi(request.payload.accountKeys, withStateWrite),
      );
    case "accountCard.get":
      return fetchAccountCards(request.payload.uids);
    case "account.openProfile":
      // 打开 UP 主主页。只有 SW 有 chrome.tabs；内容脚本里这个 API 不存在。
      // 地址由 UID 现场拼出，不接受调用方传入的 URL。
      await chrome.tabs.create({
        url: `https://space.bilibili.com/${request.payload.uid}`,
        active: true,
      });
      return { opened: true };
    case "relation.prepare":
      // 拉黑准备：读 HttpOnly 的 bili_jct 返回给内容脚本
      // （实际接口请求由内容脚本在页面上下文发起，规避 B 站风控 412）。
      // 失败时连同原因一起返回，让界面能区分「未授权」与「未登录」。
      return prepareCsrfResponse();
    case "ai.config.test":
      // 草稿配置优先（未保存先测试），缺省测已保存配置。
      return {
        ok: true,
        model: (await testAiConfiguration(request.payload.config)).model,
      };
    case "ai.models.list":
      return listConfiguredModels(request.payload);
    case "observation.export":
      return { bundle: await buildObservationExport() };
    case "data.reset":
      // 用户数据与观察库一起清空，保证「重置插件」的完整性。
      // 拉黑记录单独存在 storage/blocked，不在 local-state 的键集合里。
      await Promise.all([
        resetUserData(),
        clearObservationDatabase(),
        clearBlockedAccounts(),
      ]);
      return buildDashboardState();
    case "audit.clear":
      await clearAiAudit();
      return buildDashboardState();
    case "observations.clear":
      await clearObservedAccounts();
      return buildDashboardState();
    default:
      return assertNever(request);
  }
}

/**
 * 批量取 UP 主公开名片。
 *
 * 授权检查放在 SW：`chrome.permissions` 在内容脚本里不存在，早期实现放在
 * 内容脚本里会直接抛 TypeError（还会把整轮扫描带崩）。未授权时返回空结果，
 * 调用方据此跳过补全——这是显式开启的可选功能，不该弹权限提示打断浏览。
 */
/** accountCard.get 的返回项（与协议里的定义保持一致）。 */
interface CardPayload {
  name?: string;
  sign?: string;
  fans?: number;
  archiveCount?: number;
  officialVerifyType?: number;
  seasonVideos?: Array<{
    bvid: string;
    title: string;
    pubdate?: number;
    duration?: number;
    view?: number;
    danmaku?: number;
  }>;
}

/** 名片补全的并发上限：每个账号最多两次请求（名片 + 合集）。 */
const ACCOUNT_CARD_CONCURRENCY = 4;

async function fetchAccountCards(uids: readonly string[]): Promise<{
  cards: Record<string, CardPayload>;
}> {
  const granted = await chrome.permissions.contains({
    origins: [ACCOUNT_INFO_ORIGIN],
  });
  if (!granted) {
    return { cards: {} };
  }
  // 同一账号只请求一次；调用方可能把同一 UID 放进多个卡片。
  const unique = [...new Set(uids)];
  const cards: Record<string, CardPayload> = {};
  // 串行时 50 个账号最多 100 次网络往返，会把整轮扫描拖到几十秒。
  // 限流并发既缩短等待，也不至于一次打满 B 站接口。
  await forEachConcurrent(unique, ACCOUNT_CARD_CONCURRENCY, async (uid) => {
    try {
      const info = await fetchAccountCard(uid);
      if (info === null) {
        return;
      }
      cards[uid] = {
        ...(info.name === undefined ? {} : { name: info.name }),
        ...(info.sign === undefined ? {} : { sign: info.sign }),
        ...(info.fans === undefined ? {} : { fans: info.fans }),
        ...(info.archiveCount === undefined
          ? {}
          : { archiveCount: info.archiveCount }),
        ...(info.officialVerifyType === undefined
          ? {}
          : { officialVerifyType: info.officialVerifyType }),
        // 合集内投稿只在非空时透传，避免无意义地放大消息体。
        // seasonCount 当前不进入消息载荷（面板与提示词都没用它）。
        ...(info.seasonVideos.length === 0
          ? {}
          : { seasonVideos: info.seasonVideos }),
      };
    } catch (error) {
      // 单个账号失败不影响其余补全：这是可选增强。
      console.warn(
        `[B站内容净化助手] ${uid} 公开名片补全失败`,
        error,
      );
    }
  });
  return { cards };
}

/**
 * 读取 CSRF 令牌并组装 relation.prepare 的响应。
 * 取不到令牌时不抛错：内容脚本需要拿到原因来决定提示文案，
 * 而这里的失败属于预期的用户侧状态（未授权/未登录），不是系统错误。
 */
async function prepareCsrfResponse(): Promise<{
  csrf: string;
  reason?: "no-permission" | "no-cookie";
}> {
  const result = await readBilibiliCsrf();
  if (result.status === "ok") {
    return { csrf: result.csrf };
  }
  return { csrf: "", reason: result.status };
}

/** 穷举检查：新增消息类型而未补充路由时在编译期与运行期立即报错。 */
function assertNever(value: never): never {
  throw new z.ZodError([
    {
      code: "custom",
      path: ["type"],
      message: `未知消息类型：${String(value)}`,
      input: value,
    },
  ]);
}
