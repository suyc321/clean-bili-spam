/**
 * Content Script：页面扫描调度、观察上报与标签渲染的协调者。
 *
 * 职责边界：扫描 DOM、渲染标签，观察与判定经 Service Worker 完成。
 * 拉黑是例外：名单直接读写 chrome.storage.local，关系接口在页面上下文发起
 * （扩展后台发同样的请求会被 B 站 412）。CSRF 仍由 Service Worker 读取。
 */
import { scanCurrentPage } from "../adapters/registry";
import type { ExtractedCard } from "../adapters/contract";
import type {
  AccountAnalysis,
  AccountKey,
  AccountObservationInput,
  ExtensionSettings,
  PageAccountSummary,
  PageSummary,
  VideoObservationInput,
} from "../domain/types";
import { DEFAULT_SETTINGS, normalizeSettings } from "../domain/settings";
import { sendRuntimeRequest } from "../messaging/protocol";
import {
  fetchRelationAttribute,
  isBlockedAttribute,
  modifyRelation,
} from "../api/relation";
import { describeCsrfFailure } from "../application/relation";
import {
  addBlockedAccount,
  getBlockedAccounts,
  isBlocked,
  removeBlockedAccount,
} from "../storage/blocked";
import {
  isHighRisk,
  refreshAiUnavailable,
  refreshBlockedAccounts,
  removeAllBadges,
  renderBadge,
  type BadgeAction,
} from "./badge-renderer";
import { accountsNeedingAutoReview } from "./auto-review";
import {
  cardFieldsOf,
  seasonVideosOf,
  type CardPayload,
} from "./card-enrichment";
import { ensureCardCover, removeCardCover } from "./card-cover";
import { syncFeedAdCovers } from "./feed-ad-cover";
import { summarizePageCards } from "./page-stats";

/** 最近一次扫描结果，AI 判定写回后用来重算弹出页摘要。 */
let lastScanResult: ReturnType<typeof scanCurrentPage> | undefined;
/** 自动判定队列。滚动会连续冒出账号，一次只跑一个，避免打满接口。 */
const autoReviewQueue: AccountKey[] = [];
const autoReviewQueued = new Set<AccountKey>();
let autoReviewActive = 0;
const analyses = new Map<AccountKey, AccountAnalysis>();
/** 已处理卡片的签名表：签名未变化的卡片不重复提交。 */
let processedCards = new WeakMap<HTMLElement, string>();
/**
 * 增量扫描的待处理卡片集合：MutationObserver 收集的新增卡片元素。
 * 全量扫描（force / 路由变化）时清空。
 */
const pendingCards = new Set<HTMLElement>();
/**
 * 本页面已见卡片的登记表：增量扫描只处理新卡片，
 * 但标签渲染与页面摘要必须始终覆盖整页，因此登记每次扫描到的卡片。
 * 路由变化时清空。
 */
const renderedCards = new Map<HTMLElement, ExtractedCard>();
/** 设置缓存；Service Worker 不可达时退回默认值。 */
let settings: ExtensionSettings = DEFAULT_SETTINGS;
/** 本地设置读到之前不盖，避免把用户关掉的遮罩先闪一下。 */
let coverReady = false;
/** 最近一次扫描的页面摘要，供 Popup 查询。 */
let summary: PageSummary = {
  pageKind: "home",
  scannedCards: 0,
  unresolvedCards: 0,
  adapterHealth: "unsupported",
  adapterId: "unsupported",
  adapterVersion: 0,
  diagnostics: [],
  accounts: [],
  aiEnabled: false,
  updatedAtMs: Date.now(),
};
/** 防抖定时器句柄。 */
let scanTimer: number | undefined;
/** 扫描互斥标记：扫描进行中时新请求置 scanAgain 稍后补扫。 */
let scanRunning = false;
let scanAgain = false;
/** 上次扫描时的页面地址，用于识别 SPA 路由变化。 */
let previousUrl = location.href;
/**
 * 设置刚从存储更新，下一轮扫描必须全量重绘。
 * 扫描进行中收到变更时，补扫会被收成增量；这个标记保证遮罩和徽章仍会刷新。
 */
let pendingSettingsRefresh = false;
/** 与 local-state 的设置键一致。内容脚本只听变更，不写存储。 */
const SETTINGS_STORAGE_KEY = "kcf:settings:v1";

void initialize();

/** 初始化：先按本地开关盖广告，再扫描、入库和判定。 */
async function initialize(): Promise<void> {
  observePageChanges();
  registerContentMessages();
  observeSettingsChanges();
  try {
    // 设置只从本地读：dashboard.get 会顺带读判定日志、观察库统计和三份名单，
    // 内容脚本只用得到设置与拉黑 key，没必要每次页面加载都付这份开销。
    const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    const raw = stored[SETTINGS_STORAGE_KEY];
    settings = normalizeSettings(
      typeof raw === "object" && raw !== null
        ? (raw as Partial<ExtensionSettings>)
        : {},
    );
  } catch (error) {
    console.warn("[B站内容净化助手] 无法读取设置，使用默认值。", error);
  }
  coverReady = true;
  syncFeedAdCovers(document, settings.feedAdMode, settings.coverColor);
  // 同步本地拉黑记录，让面板按钮显示「取消拉黑」状态。
  try {
    refreshBlockedAccounts(
      (await getBlockedAccounts()).map((entry) => entry.accountKey),
    );
  } catch (error) {
    console.warn("[B站内容净化助手] 无法读取拉黑记录。", error);
  }

  syncFeedAdCovers(document, settings.feedAdMode, settings.coverColor);
  await scanAndRender(true);
}

const WATCHED_CARD_SELECTOR =
  ".bili-video-card, .bili-live-card, .bili-feed-card, .floor-single-card";
const FEED_COVER_SELECTOR =
  ".bili-feed-card, .floor-single-card, .bili-live-card";

/** 新格子或链接一出现就盖，不等待扫描防抖。 */
function refreshFeedCoverFrom(node: Node): void {
  if (!coverReady || !(node instanceof Element)) {
    return;
  }
  const seen = new Set<HTMLElement>();
  const refresh = (card: Element | null): void => {
    if (!(card instanceof HTMLElement) || seen.has(card)) {
      return;
    }
    if (!card.matches(FEED_COVER_SELECTOR)) {
      return;
    }
    seen.add(card);
    syncFeedAdCovers(card, settings.feedAdMode, settings.coverColor);
  };
  refresh(node);
  refresh(node.closest(FEED_COVER_SELECTOR));
  for (const card of node.querySelectorAll(FEED_COVER_SELECTOR)) {
    refresh(card);
  }
}

/** 监听页面变化：新格子先盖广告，扫描仍走防抖。 */
function observePageChanges(): void {
  const root = document.documentElement;
  if (root === null) {
    return;
  }
  const observer = new MutationObserver((mutations) => {
    // 只关心视频卡片节点的新增，并把新增卡片收集为增量扫描候选，
    // 避免长列表页面上每次都全量遍历。广告遮罩不走这条防抖。
    let relevant = false;
    for (const mutation of mutations) {
      if (mutation.type === "attributes") {
        refreshFeedCoverFrom(mutation.target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        if (node.matches(WATCHED_CARD_SELECTOR)) {
          pendingCards.add(node as HTMLElement);
          relevant = true;
        } else {
          const cards = node.querySelectorAll<HTMLElement>(WATCHED_CARD_SELECTOR);
          if (cards.length > 0) {
            for (const card of cards) {
              pendingCards.add(card);
            }
            relevant = true;
          }
        }
        refreshFeedCoverFrom(node);
      }
    }
    if (relevant || location.href !== previousUrl) {
      scheduleScan();
    }
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"],
  });
  window.addEventListener("popstate", scheduleScan);
  window.addEventListener("hashchange", scheduleScan);
  // 兜底轮询：个别路由变化不触发 popstate/hashchange。
  window.setInterval(() => {
    if (location.href !== previousUrl) {
      scheduleScan();
    }
  }, 1_000);
}

/**
 * 设置页保存后，已打开的 B 站页面立刻按新开关盖上或拆掉广告遮罩。
 * 只读 `chrome.storage.onChanged`，不在这里写存储。
 */
function observeSettingsChanges(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || changes[SETTINGS_STORAGE_KEY] === undefined) {
      return;
    }
    const next = changes[SETTINGS_STORAGE_KEY].newValue;
    settings = normalizeSettings(
      typeof next === "object" && next !== null
        ? (next as Partial<ExtensionSettings>)
        : {},
    );
    coverReady = true;
    syncFeedAdCovers(document, settings.feedAdMode, settings.coverColor);
    pendingSettingsRefresh = true;
    void scanAndRender(true);
  });
}

/** 注册供 Popup 调用的页面级消息（查摘要、强制重扫）。 */
function registerContentMessages(): void {
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("scope" in message) ||
      message.scope !== "kcf-content"
    ) {
      return undefined;
    }
    if ("type" in message && message.type === "page.summary.get") {
      return Promise.resolve(summary);
    }
    if ("type" in message && message.type === "page.rescan") {
      return scanAndRender(true).then(() => summary);
    }
    if ("type" in message && message.type === "accounts.block") {
      return blockAccountsFromPopup(message).then((result) => {
        if (result.blocked > 0) {
          window.setTimeout(() => location.reload(), 0);
        }
        return result;
      });
    }
    return undefined;
  });
}

/** 防抖调度扫描：350ms 内的连续触发合并为一次。 */
function scheduleScan(): void {
  if (scanTimer !== undefined) {
    window.clearTimeout(scanTimer);
  }
  scanTimer = window.setTimeout(() => {
    scanTimer = undefined;
    void scanAndRender(false);
  }, 350);
}

/**
 * 清理已脱离文档的卡片登记。
 *
 * B 站长列表会移除或复用卡片节点；Map 若只增不减，一次长滚动就会把
 * 所有历史节点连同整棵子树留在内存里。
 */
function pruneDetachedCards(): void {
  for (const element of renderedCards.keys()) {
    if (!element.isConnected) {
      renderedCards.delete(element);
    }
  }
}

/** 把已登记卡片按当前分析重绘。增量扫描后旧卡片的徽章也靠这次对齐。 */
function renderRegisteredCards(): void {
  for (const card of renderedCards.values()) {
    const analysis =
      card.accountKey === undefined ? undefined : analyses.get(card.accountKey);
    // 先取到局部常量：闭包里 TS 不保留对 card 属性的窄化，
    // 用 const 才能在「深度判定」回调里直接把它当 string 用。
    const profileUid = card.uid;
    renderBadge(
      card,
      analysis,
      settings,
      async (action) => {
        if (analysis === undefined) {
          return;
        }
        await applyDisposition(analysis, action);
        await scanAndRender(true);
      },
      settings.aiEnabled && analysis !== undefined
        ? () => runAiReview(analysis)
        : undefined,
      // 深度判定必须走 Service Worker：内容脚本没有 chrome.tabs。
      profileUid === undefined
        ? undefined
        : async () => {
            await sendRuntimeRequest("account.openProfile", {
              uid: profileUid,
            });
          },
      analysis === undefined || card.accountKey === undefined
        ? undefined
        : (action) => toggleBlock(analysis, action),
      analysis === undefined ? undefined : () => verifyBlockState(analysis),
    );
    syncDimCover(card.mount.cardElement, analysis);
  }
}

/**
 * 同步高风险弱化遮罩：与广告遮挡共用 card-cover，只是 kind 不同。
 * 条件是设置开启、AI 概率 ≥80（isHighRisk，与徽章配色同一常量）、且尚未处置。
 * 遮罩吃掉点击并 inert 卡片内容，但徽章宿主豁免——面板处置入口仍可用。
 */
function syncDimCover(
  cardElement: HTMLElement,
  analysis: AccountAnalysis | undefined,
): void {
  const shouldDim =
    settings.automaticallyDimHighRisk &&
    isHighRisk(analysis) &&
    analysis?.disposition === "none";
  if (shouldDim) {
    ensureCardCover(cardElement, {
      kind: "dim",
      color: settings.coverColor,
      label: "已弱化",
    });
  } else {
    removeCardCover(cardElement, "dim");
  }
}

/** 把还没有 AI 结论的新账号排进自动判定。已在队列或刚失败的不重复提交。 */
function enqueueAutoReviews(accountKeys: readonly AccountKey[]): void {
  const excluded = new Set<AccountKey>([
    ...autoReviewQueued,
    ...aiFailedAccounts,
  ]);
  for (const accountKey of accountsNeedingAutoReview(
    accountKeys,
    analyses,
    excluded,
  )) {
    autoReviewQueued.add(accountKey);
    autoReviewQueue.push(accountKey);
  }
  void pumpAutoReviews();
}

/** 一次只判定一个账号。配置不可用时清空队列，避免滚动时连续报错。 */
async function pumpAutoReviews(): Promise<void> {
  if (autoReviewActive > 0 || autoReviewQueue.length === 0) {
    return;
  }
  const accountKey = autoReviewQueue.shift();
  if (accountKey === undefined) {
    return;
  }
  autoReviewActive += 1;
  try {
    const response = await sendRuntimeRequest("ai.review.run", { accountKey });
    for (const updated of response.analyses) {
      analyses.set(updated.accountKey, updated);
      aiFailedAccounts.delete(updated.accountKey);
    }
    refreshAiUnavailable(aiFailedAccounts);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message.includes("未启用") ||
      message.includes("配置不完整") ||
      message.includes("尚未获得")
    ) {
      autoReviewQueue.length = 0;
      autoReviewQueued.clear();
      console.warn("[B站内容净化助手] 自动判定已停止", error);
      return;
    }
    aiFailedAccounts.add(accountKey);
    refreshAiUnavailable(aiFailedAccounts);
    console.error("[B站内容净化助手] 自动判定失败", error);
  } finally {
    autoReviewQueued.delete(accountKey);
    autoReviewActive -= 1;
  }
  if (lastScanResult !== undefined) {
    summary = buildPageSummary(lastScanResult, renderedCards, analyses);
  }
  renderRegisteredCards();
  publishSummary();
  if (autoReviewQueue.length > 0) {
    void pumpAutoReviews();
  }
}

/** 通知已打开的弹出页刷新名单。弹出页关着时没有接收方，忽略即可。 */
function publishSummary(): void {
  void chrome.runtime.sendMessage({
    scope: "kcf-content",
    type: "page.summary.updated",
    summary,
  }).catch(() => undefined);
}

/**
 * 扫描页面、提交观察并渲染标签。
 *
 * 扫描策略：
 * - force（首次/路由变化/手动重扫）：全量扫描；
 * - 有待处理卡片：增量扫描，只处理新增卡片；
 * - 两者皆无：跳过本轮（面板渲染有状态签名去重，无需重复工作）。
 *
 * @param force true 时忽略卡片签名缓存，全部重新提交与渲染
 */
async function scanAndRender(force: boolean): Promise<void> {
  if (scanRunning) {
    scanAgain = true;
    return;
  }
  scanRunning = true;
  try {
    // 长列表会移除/复用卡片：先清掉脱离文档的登记，避免 Map 只增不减。
    pruneDetachedCards();
    // 盖广告不依赖本轮的名片补全、入库和 AI。先盖，再做那些事。
    syncFeedAdCovers(document, settings.feedAdMode, settings.coverColor);
    // SPA 路由变化后清空缓存：旧页面的分析结果对新区不再可靠。
    if (location.href !== previousUrl) {
      previousUrl = location.href;
      processedCards = new WeakMap<HTMLElement, string>();
      analyses.clear();
      pendingCards.clear();
      renderedCards.clear();
      autoReviewQueue.length = 0;
      autoReviewQueued.clear();
      force = true;
    }

    if (pendingSettingsRefresh) {
      pendingSettingsRefresh = false;
      force = true;
    }
    // 增量语义：既不强制、也没有新增卡片时，本轮无事可做。
    // 广告遮罩仍要按当前开关对齐：设置变更若撞上正在进行的扫描，
    // 补扫可能走到这里，不能把刚打开的遮挡漏掉。
    if (!force && pendingCards.size === 0) {
      syncFeedAdCovers(document, settings.feedAdMode, settings.coverColor);
      return;
    }
    const candidates =
      force || pendingCards.size === 0 ? undefined : [...pendingCards];
    pendingCards.clear();

    const result = scanCurrentPage(
      document,
      new URL(location.href),
      Date.now(),
      candidates,
    );
    // 只有解析出账号键、UID 与主页地址的卡片才可提交观察。
    // 健康度是整页指标（见 page-stats），不用来冻结单轮候选：增量扫描的
    // 候选子集里只要有一张解析失败，就会被误算成「过半失败」，把同批里
    // 能正常解析的卡片也一起丢掉。认不出身份的卡片本来就在 resolvedCards 之外。
    const resolvedCards = result.cards.filter(
      (card): card is ExtractedCard & {
        accountKey: AccountKey;
        uid: string;
        profileUrl: string;
      } =>
        card.accountKey !== undefined &&
        card.uid !== undefined &&
        card.profileUrl !== undefined,
    );
    // 登记本轮扫描到的卡片，供渲染与整页摘要使用。
    // 摘要按 renderedCards 去重统计，强制重扫不会重复累加。
    for (const card of result.cards) {
      renderedCards.set(card.mount.cardElement, card);
    }
    const freshCards = resolvedCards.filter((card) => {
      const signature = cardSignature(card);
      const previous = processedCards.get(card.mount.cardElement);
      if (!force && previous === signature) {
        return false;
      }
      return true;
    });

    if (freshCards.length > 0) {
      seasonVideosByAccount.clear();
      // 先提交 DOM 采集到的观察并渲染：公开名片补全是可选网络请求，
      // 不该挡住入库和徽章。补全拿到数据后再用同一批卡片补交一次，
      // 由 IndexedDB 的稀疏合并把简介/粉丝数/合集视频并进去。
      const baseIngested = await ingestObservations(
        groupObservations(freshCards),
      );
      let complete = baseIngested;
      if (baseIngested) {
        // 补全期间先让用户看到基础判定，不必等网络请求结束。
        if (settings.showBadges && settings.enrichAccountInfo) {
          renderRegisteredCards();
        }
        if (await enrichFreshCards(freshCards)) {
          complete = await ingestObservations(
            groupObservations(freshCards, seasonVideosByAccount),
          );
        }
      }
      // 失败时不写签名缓存，下轮扫描会重新提交这批卡片。
      if (complete) {
        for (const card of freshCards) {
          processedCards.set(card.mount.cardElement, cardSignature(card));
        }
      }
    }

    if (!settings.showBadges) {
      removeAllBadges();
      // 标签隐藏时弱化遮罩也一并拆掉：它是判定的可视化，不该单独留下。
      for (const card of renderedCards.keys()) {
        removeCardCover(card, "dim");
      }
    } else {
      renderRegisteredCards();
    }

    syncFeedAdCovers(document, settings.feedAdMode, settings.coverColor);

    lastScanResult = result;
    summary = buildPageSummary(result, renderedCards, analyses);
    // 能解析出身份的卡片就是有效观察，不再受单轮候选健康度牵连。
    if (settings.aiEnabled && freshCards.length > 0) {
      enqueueAutoReviews(freshCards.map((card) => card.accountKey));
    }
    publishSummary();
  } finally {
    scanRunning = false;
    // 扫描期间又收到了新请求：补扫一次，保证最终一致。
    if (scanAgain) {
      scanAgain = false;
      scheduleScan();
    }
  }
}

/**
 * 提交一批观察并合并分析结果。
 *
 * @returns 是否全部批次成功；失败时调用方不写签名缓存，下一轮会重试
 */
async function ingestObservations(
  observations: AccountObservationInput[],
): Promise<boolean> {
  try {
    // 协议单批上限 100，这里按 50 分批提交并逐批合并分析结果。
    for (const batch of chunk(observations, 50)) {
      const response = await sendRuntimeRequest("observations.ingest", {
        observations: batch,
      });
      for (const analysis of response.analyses) {
        analyses.set(analysis.accountKey, analysis);
      }
    }
    return true;
  } catch (error) {
    console.error("[B站内容净化助手] 本页分析失败", error);
    return false;
  }
}

/**
 * 把卡片列表按账号聚合成观察批次。
 *
 * 同账号的多张卡片合并为一条观察：视频按 videoKey 去重（上限 50），
 * 幂等键由视频键集合的哈希构成，便于服务端识别相同批次。
 */
function groupObservations(
  cards: EnrichableCard[],
  seasonVideosByAccount: ReadonlyMap<
    AccountKey,
    VideoObservationInput[]
  > = new Map(),
): AccountObservationInput[] {
  const grouped = new Map<AccountKey, typeof cards>();
  for (const card of cards) {
    const current = grouped.get(card.accountKey) ?? [];
    current.push(card);
    grouped.set(card.accountKey, current);
  }

  return [...grouped.entries()].map(([accountKey, accountCards]) => {
    const first = accountCards[0];
    if (first === undefined) {
      throw new Error("账号分组不能为空。");
    }
    // DOM 卡片 + 名片合集视频合并，按 videoKey 去重。
    // 注意必须用 accountCards（本账号的卡片）而不是 cards（整批所有账号）：
    // 用错会把这一批里其他账号的投稿算到当前账号上，
    // 「同一投稿也出现在其他账号名下」会整批误报。
    const merged = new Map(
      accountCards.map((card) => [card.video.videoKey, card.video] as const),
    );
    for (const seasonVideo of seasonVideosByAccount.get(accountKey) ?? []) {
      if (!merged.has(seasonVideo.videoKey)) {
        merged.set(seasonVideo.videoKey, seasonVideo);
      }
    }
    const videos = [...merged.values()].slice(0, 50);
    return {
      schemaVersion: 1,
      accountKey,
      uid: first.uid,
      profileUrl: first.profileUrl,
      ...(first.displayName === undefined
        ? {}
        : { displayName: first.displayName }),
      ...(first.profileBio === undefined ? {} : { profileBio: first.profileBio }),
      // 名片补充字段：空间页本身已能读到简介，所以只用名片补首页/搜索页
      // 拿不到的部分，避免重复请求。
      ...cardFieldsOf(accountCards[0]?.cardInfo),
      videos,
      missingFields: [...new Set(accountCards.flatMap((card) => card.missingFields))],
      source: first.source,
      observedAtMs: Date.now(),
    };
  });
}

/**
 * 为一批新卡片补全 UP 主公开名片（简介 / 粉丝数 / 投稿数）。
 *
 * 只读公开数据，不上传任何用户数据。退出条件保证「未开启时零行为」：
 *   1) 设置里没开；
 *   2) 账号本来就已有简介（空间页自己带，不必再请求）。
 *
 * 请求必须发给 Service Worker：授权检查要用 `chrome.permissions`，而内容脚本
 * 没有这个 API——早期实现直接调它会抛 TypeError，还会把整轮扫描带崩（徽章
 * 一个都渲染不出来）。SW 侧未授权或失败时返回空结果，这里据此静默跳过：
 * 这是可选增强，不该弹权限提示打断浏览。
 *
 * @returns 是否至少拿到一个账号的名片数据（调用方据此决定要不要补交观察）
 */
async function enrichFreshCards(cards: EnrichableCard[]): Promise<boolean> {
  if (!settings.enrichAccountInfo) {
    return false;
  }
  // 每个账号只请求一次：同屏多卡同一 UP 是常态（尤其是矩阵号）。
  const pending = [
    ...new Set(
      cards
        .filter((card) => card.profileBio === undefined)
        .map((card) => card.uid),
    ),
  ];
  if (pending.length === 0) {
    return false;
  }
  let received: Record<string, CardPayload>;
  try {
    const response = await sendRuntimeRequest("accountCard.get", {
      uids: pending,
    });
    received = response.cards;
  } catch (error) {
    // 消息失败不该中断扫描：补全是可选增强，失败就按没有简介处理。
    console.warn("[B站内容净化助手] 公开信息补全请求失败，已跳过。", error);
    return false;
  }
  let enriched = false;
  for (const uid of pending) {
    const info = received[uid];
    if (info === undefined) {
      continue;
    }
    enriched = true;
    for (const card of cards) {
      if (card.uid === uid) {
        card.cardInfo = { ...info, fetchedAtMs: Date.now() };
      }
    }
    // 合集视频转成观察记录：与 DOM 采集的记录同形，走同一条入库通道。
    const accountKey = `uid:${uid}` as AccountKey;
    const observed = seasonVideosOf(info);
    if (observed.length > 0) {
      seasonVideosByAccount.set(accountKey, observed);
    }
  }
  return enriched;
}

/**
 * 带名片信息的卡片：名片是内容脚本运行时补上的，不属于适配器输出，
 * 因此在这里定义而不是改适配器契约。
 */
type EnrichableCard = ExtractedCard & {
  accountKey: AccountKey;
  uid: string;
  profileUrl: string;
  cardInfo?: CardPayload & { fetchedAtMs: number };
};

/** 定长切分数组（观察分批提交用）。 */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** FNV-1a 32 位哈希（十六进制串）：卡片签名与幂等键的紧凑摘要。 */
function hashString(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 计算卡片签名：内容任何字段变化都会改变签名，
 * 用于跳过未变化的卡片、避免重复提交观察。
 */
function cardSignature(card: ExtractedCard): string {
  return hashString(
    JSON.stringify({
      cardKey: card.cardKey,
      accountKey: card.accountKey,
      displayName: card.displayName,
      profileBio: card.profileBio,
      missingFields: [...card.missingFields].sort(),
      video: {
        videoKey: card.video.videoKey,
        title: card.video.title,
        videoUrl: card.video.videoUrl,
        coverUrl: card.video.coverUrl,
        publishedText: card.video.publishedText,
        publishedAtMs: card.video.publishedAtMs,
        metricsRaw: card.video.metricsRaw,
      },
    }),
  );
}

/** 把用户在标签面板上的处置操作提交给 Service Worker。 */
async function applyDisposition(
  analysis: AccountAnalysis,
  action: BadgeAction,
): Promise<void> {
  await sendRuntimeRequest("account.disposition", {
    accountKey: analysis.accountKey,
    uid: analysis.uid,
    ...(analysis.displayName === undefined
      ? {}
      : { displayName: analysis.displayName }),
    ...(analysis.review.kind === "ai"
      ? { aiProbability: analysis.review.review.marketingProbability }
      : {}),
    disposition: action.disposition,
    selected: action.selected,
  });
}

/**
 * 手动触发 AI 判定：请求 Service Worker 调用用户配置的接口，
 * 成功后用返回的最新分析结果更新缓存并整页重绘。
 *
 * AI 接口是按端点域名授权的（安装时零授权）：首次复核时在用户手势内
 * 申请该域名的访问权限，未获授权则不发起任何外发请求。
 * 失败时提示本次未取得结论（按钮会恢复可用），不写入任何判定。
 */
async function runAiReview(analysis: AccountAnalysis): Promise<void> {
  try {
    const response = await sendRuntimeRequest("ai.review.run", {
      accountKey: analysis.accountKey,
    });
    for (const updated of response.analyses) {
      analyses.set(updated.accountKey, updated);
      // 复核成功：清掉该账号的降级标记，徽章恢复成 AI 主结论形态。
      if (aiFailedAccounts.delete(updated.accountKey)) {
        refreshAiUnavailable(aiFailedAccounts);
      }
    }
    await scanAndRender(true);
  } catch (error) {
    // AI 失败必须让用户看见：判定只由 AI 产出，失败后账号没有任何结论，
    // 若只打 console，用户会以为「没提示」等于「没问题」。
    // 授权检查已移到 SW：`chrome.permissions` 在内容脚本里根本不存在，
    // 原来放在这里每一次都会抛 TypeError，再被这个 catch 吞成一条提示
    // ——面板上的「AI 判定」按钮实际上从未真正发出过请求。
    showAiError(`AI 判定失败，本次未取得结论：${errorMessage(error)}`);
    // 同时把该账号标记为「AI 不可用」，让徽章长期带降级标记，
    // 而不是只闪一条几秒后就看不见的提示。
    markAiFailure(analysis.accountKey);
    console.error("[B站内容净化助手] AI 判定失败", error);
  }
}

/** AI 判定失败的账号集合：徽章据此显示降级态。 */
const aiFailedAccounts = new Set<AccountKey>();

/**
 * 由公开名片补充的合集视频（账号 → 观察记录）。
 *
 * 只在一轮扫描内有效：卡片会随无限滚动分批出现，所以每轮开始时清空、
 * 由 enrichFreshCards 重新填充。SW 侧名片有 24h 缓存，清空不会丢数据
 * （同账号再次取到的是同一份快照），但能避免 Map 无限增长。
 */
const seasonVideosByAccount = new Map<AccountKey, VideoObservationInput[]>();

function markAiFailure(accountKey: AccountKey): void {
  aiFailedAccounts.add(accountKey);
  refreshAiUnavailable(aiFailedAccounts);
  // 立即重扫一次，让徽章带上降级标记（不等下一轮 350ms 扫描）。
  void scanAndRender(true).catch(() => undefined);
}

/**
 * 拉黑 / 取消拉黑：平台动作，按钮处已做二次确认。
 *
 * 分工（实测结论，缺一不可）：
 * - CSRF（bili_jct）是 HttpOnly cookie，只有 SW 能用 chrome.cookies 读
 *   （内容脚本没有 chrome.permissions / chrome.cookies）；
 * - 接口请求由内容脚本在页面上下文发起——与用户手动拉黑完全一致
 *   （同源、同 cookie、同 UA）；从 SW 发请求会被 B 站风控 412 拦截。
 * 首次使用前需在设置页点「拉黑授权」一次性授权。
 */
async function toggleBlock(
  analysis: AccountAnalysis,
  action: "block" | "unblock",
): Promise<void> {
  // 1) 向 SW 取 CSRF 令牌（SW 校验 cookies 授权并读取 HttpOnly cookie）。
  let csrf: string;
  try {
    const prepared = await sendRuntimeRequest("relation.prepare", {});
    if (prepared.csrf === "") {
      // 按真实原因提示：未授权与未登录的处置方式完全不同，
      // 笼统一句「请刷新页面」会把用户引向无用功。
      showBlockError(
        `${action === "block" ? "拉黑" : "取消拉黑"}失败：${
          prepared.reason === undefined
            ? "未取到 B 站登录凭证（bili_jct），请刷新页面后重试。"
            : describeCsrfFailure(prepared.reason)
        }`,
      );
      return;
    }
    csrf = prepared.csrf;
  } catch (error) {
    showBlockError(
      `拉黑准备失败：${errorMessage(error)}`,
    );
    return;
  }
  // 2) 在页面上下文调用 B 站关系接口（成功 = code 0）。
  try {
    await modifyRelation(
      action === "block" ? "block" : "unblock",
      { uid: analysis.uid, csrf },
    );
  } catch (error) {
    showBlockError(
      `${action === "block" ? "拉黑" : "取消拉黑"}失败：${errorMessage(error)}`,
    );
    return;
  }
  // 3) 落本地审计并刷新界面（成功才写；失败已在上方提示）。
  if (action === "block") {
    await addBlockedAccount({
      accountKey: analysis.accountKey,
      uid: analysis.uid,
      ...(analysis.displayName === undefined
        ? {}
        : { displayName: analysis.displayName }),
      ...(analysis.review.kind === "ai"
        ? { aiProbability: analysis.review.review.marketingProbability }
        : {}),
      blockedAtMs: Date.now(),
    });
  } else {
    await removeBlockedAccount(analysis.accountKey);
  }
  refreshBlockedAccounts((await getBlockedAccounts()).map((entry) => entry.accountKey));
  // 与 B 站官方拉黑按钮一致：成功后刷新页面，让用户立即看到结果
  // （此前不刷新，徽章仍显示旧状态，看起来像没有生效）。
  location.reload();
}

/** 弹出页批量拉黑的单个账号。 */
interface PopupBlockAccount {
  accountKey: AccountKey;
  uid: string;
  displayName?: string;
  aiProbability?: number;
}

/**
 * 单次批量拉黑上限，与 PopupApp 的 MAX_BLOCK_BATCH 保持一致。
 * 内容脚本再做一次防御性截断：即使调用方发来更多账号，也不会连续打满接口。
 */
const MAX_POPUP_BLOCK_BATCH = 10;
/** 连续拉黑之间的间隔，避免触发 B 站风控。 */
const POPUP_BLOCK_INTERVAL_MS = 600;

/**
 * 按弹出页给出的名单逐个拉黑。
 * 凭证只取一次；某一户失败不影响其余账号。调用方在有成功时再刷新页面。
 */
async function blockAccountsFromPopup(
  message: unknown,
): Promise<{ blocked: number; failed: number; error?: string }> {
  const accounts = readPopupBlockAccounts(message).slice(
    0,
    MAX_POPUP_BLOCK_BATCH,
  );
  if (accounts.length === 0) {
    return { blocked: 0, failed: 0 };
  }
  const prepared = await sendRuntimeRequest("relation.prepare", {});
  if (prepared.csrf === "") {
    return {
      blocked: 0,
      failed: accounts.length,
      error:
        prepared.reason === undefined
          ? "未取到 B 站登录凭证（bili_jct），请刷新页面后重试。"
          : describeCsrfFailure(prepared.reason),
    };
  }
  let blocked = 0;
  let failed = 0;
  for (const [index, account] of accounts.entries()) {
    if (index > 0) {
      await delay(POPUP_BLOCK_INTERVAL_MS);
    }
    try {
      await modifyRelation("block", { uid: account.uid, csrf: prepared.csrf });
      await addBlockedAccount({
        accountKey: account.accountKey,
        uid: account.uid,
        ...(account.displayName === undefined
          ? {}
          : { displayName: account.displayName }),
        ...(account.aiProbability === undefined
          ? {}
          : { aiProbability: account.aiProbability }),
        blockedAtMs: Date.now(),
      });
      blocked += 1;
    } catch {
      failed += 1;
    }
  }
  if (blocked > 0) {
    refreshBlockedAccounts(
      (await getBlockedAccounts()).map((entry) => entry.accountKey),
    );
  }
  return { blocked, failed };
}

/** 等待指定毫秒数（批量拉黑节流用）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function readPopupBlockAccounts(message: unknown): PopupBlockAccount[] {
  if (
    typeof message !== "object" ||
    message === null ||
    !("accounts" in message) ||
    !Array.isArray(message.accounts)
  ) {
    return [];
  }
  const accounts: PopupBlockAccount[] = [];
  for (const item of message.accounts) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const uid = "uid" in item && typeof item.uid === "string" ? item.uid : "";
    const accountKey =
      "accountKey" in item && typeof item.accountKey === "string"
        ? item.accountKey
        : "";
    if (!/^\d+$/u.test(uid) || accountKey !== `uid:${uid}`) {
      continue;
    }
    const displayName =
      "displayName" in item && typeof item.displayName === "string"
        ? item.displayName
        : undefined;
    const aiProbability =
      "aiProbability" in item && typeof item.aiProbability === "number"
        ? item.aiProbability
        : undefined;
    accounts.push({
      accountKey: accountKey as AccountKey,
      uid,
      ...(displayName === undefined ? {} : { displayName }),
      ...(aiProbability === undefined ? {} : { aiProbability }),
    });
  }
  return accounts;
}

/**
 * 核对 B 站真实的拉黑状态：本地记录可能过期（用户可能已通过 B 站官方
 * 途径解除拉黑）。面板打开时调用；若本地记录与真实状态不一致则修正
 * 本地记录，并返回真实状态（接口失败/未登录返回 null，保持现状）。
 */
async function verifyBlockState(
  analysis: AccountAnalysis,
): Promise<boolean | null> {
  const attribute = await fetchRelationAttribute(analysis.uid);
  if (attribute === null) {
    return null;
  }
  const live = isBlockedAttribute(attribute);
  const local = await isBlocked(analysis.accountKey);
  if (local && !live) {
    // 本地记录过期：用户已在 B 站侧解除拉黑，移除本地记录。
    await removeBlockedAccount(analysis.accountKey);
    refreshBlockedAccounts(
      (await getBlockedAccounts()).map((entry) => entry.accountKey),
    );
  }
  return live;
}

/** 提取错误消息（截断到 200 字，避免面板被长错误撑爆）。 */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

/** 右下角提示条的宿主类名（与降级提示宿主分开，便于定位与清理）。 */
const NOTICE_HOST_CLASS = "kcf-notice-host";

/**
 * 提示条样式。放在 Shadow DOM 内，避免被 B 站页面 CSS 影响。
 * 历史问题：`.kcf-block-error` 曾经直接 append 到 body 且**没有任何样式定义**，
 * 既不受 `all: initial` 保护，也可能被页面 CSS 改掉排版甚至看不出是提示。
 */
const NOTICE_STYLE = `
  :host {
    all: initial;
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 2147483000;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", sans-serif;
  }

  .card {
    width: min(340px, calc(100vw - 32px));
    padding: 11px 13px;
    border: 1px solid #e8b4b4;
    border-radius: 10px;
    background: #fdf2f2;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    color: #8f2c2c;
    font-size: 12px;
    line-height: 1.6;
  }

  .card.ai {
    border-color: #f0d8a0;
    background: #fffaf0;
    color: #6b5312;
  }
`;

/**
 * 在页面上展示一条失败提示（右下角提示条，一段时间后自动消失）。
 * 之前失败只打 console，用户在页面上完全看不到，等于静默失败。
 * 同时只保留一条：新提示会顶掉旧提示，避免堆叠遮住页面。
 *
 * @param message 面向用户的完整说明（含原因与下一步该做什么）
 * @param kind 提示种类，决定配色：block=平台动作失败，ai=AI 判定失败
 */
function showNotice(message: string, kind: "block" | "ai" = "block"): void {
  document
    .querySelectorAll(`.${NOTICE_HOST_CLASS}`)
    .forEach((notice) => notice.remove());
  const host = document.createElement("div");
  host.className = NOTICE_HOST_CLASS;
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = NOTICE_STYLE;
  const card = document.createElement("div");
  card.className = `card ${kind}`;
  card.setAttribute("role", "alert");
  card.textContent = `[B站内容净化助手] ${message}`;
  root.append(style, card);
  document.body.append(host);
  // AI 失败停留更久：用户需要读完整段原因（可能是接口被拒绝或限流）。
  window.setTimeout(() => host.remove(), kind === "ai" ? 15_000 : 8_000);
}

/** 展示拉黑失败原因。 */
function showBlockError(message: string): void {
  showNotice(message, "block");
}

/** 展示 AI 判定失败原因。 */
function showAiError(message: string): void {
  showNotice(message, "ai");
}

/**
 * Popup 账号排序：有 AI 结论的按概率降序排在最前，其后是已触发待复核的，
 * 最后是无判定的。这样打开 Popup 第一眼看到的就是「最值得看」的账号。
 */
function summaryRank(
  left: PageAccountSummary,
  right: PageAccountSummary,
): number {
  return stateRank(right.review) - stateRank(left.review);
}

/** 判定状态的排序权重。 */
function stateRank(review: PageAccountSummary["review"]): number {
  if (review.kind === "ai") {
    return 1_000 + review.review.marketingProbability;
  }
  if (review.kind === "triggered") {
    return 500 + review.triggers.length;
  }
  return 0;
}

/**
 * 组装页面摘要：卡片统计与健康度按整页已见卡片集合计算（去重，不随重扫累加），
 * 诊断信息取本轮扫描，账号按 summaryRank 降序。
 */
function buildPageSummary(
  result: ReturnType<typeof scanCurrentPage>,
  pageCards: Map<HTMLElement, ExtractedCard>,
  currentAnalyses: Map<AccountKey, AccountAnalysis>,
): PageSummary {
  const stats = summarizePageCards(pageCards.values());
  const accountKeys = new Set(
    [...pageCards.values()]
      .map((card) => card.accountKey)
      .filter((accountKey): accountKey is AccountKey => accountKey !== undefined),
  );
  return {
    pageKind: result.pageKind,
    scannedCards: stats.scannedCards,
    unresolvedCards: stats.unresolvedCards,
    // 没有匹配适配器时保持 unsupported；其余情况按整页卡片判断，
    // 不能用增量候选子集的结论覆盖整页状态。
    adapterHealth:
      result.health === "unsupported" ? "unsupported" : stats.health,
    adapterId: result.adapterId,
    adapterVersion: result.adapterVersion,
    diagnostics: result.diagnostics,
    aiEnabled: settings.aiEnabled,
    accounts: [...accountKeys]
      .map((accountKey) => currentAnalyses.get(accountKey))
      .filter(
        (analysis): analysis is AccountAnalysis => analysis !== undefined,
      )
      .map((analysis) => ({
        accountKey: analysis.accountKey,
        uid: analysis.uid,
        ...(analysis.displayName === undefined
          ? {}
          : { displayName: analysis.displayName }),
        observedVideos: analysis.observedVideos,
        review: analysis.review,
        aiUnavailable: aiFailedAccounts.has(analysis.accountKey),
        disposition: analysis.disposition,
      }))
      // 排序：有 AI 结论的按概率降序，其后是已触发待复核的，最后是无判定的。
      // 这样 Popup 顶部永远是「最值得看」的账号。
      .sort(summaryRank),
    updatedAtMs: Date.now(),
  };
}
