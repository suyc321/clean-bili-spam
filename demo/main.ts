// 内置浏览器演示：直接运行插件的生产代码。
// 本地触发器（review-trigger）与 Shadow DOM 标签渲染（badge-renderer）
// 均为 src/ 原模块，仅将 DOM 采集替换为脱敏的模拟卡片，并内置一个
// 假 AI 端点，用于在不联网、不需要 API Key 的前提下可视化完整链路：
// 观察 → 本地触发器 → 「值得复核」角标 → AI 判定 → AI 概率主结论。
import "./demo.css";
import type { ExtractedCard } from "../src/adapters/contract";
import type {
  AccountKey,
  AccountAnalysis,
  AccountProfileRecord,
  ExtensionSettings,
  ReviewOutcome,
  ObservationSource,
  ReviewTriggerHit,
  VideoObservationRecord,
} from "../src/domain/types";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import { detectReviewTriggers } from "../src/features/review-trigger";
import { renderBadge } from "../src/content/badge-renderer";

const SOURCE: ObservationSource = {
  pageKind: "home",
  adapterId: "demo-feed-v1",
  adapterVersion: 1,
};

interface DemoAccount {
  uid: string;
  displayName: string;
  bio?: string;
  followers?: number;
  archiveCount?: number;
  videos: Array<{ bvid: string; title: string; hoursAgo: number }>;
  /** 模拟 AI 判定会返回的结论；不填表示该账号复核失败。 */
  ai?: { marketingProbability: number; reason: string };
}

/**
 * 三类典型账号。
 *
 * 刻意覆盖改造后的三种判定态与一次失败：
 * - 「资源分享君」：标题兜售成套资源 → 触发器命中 → 复核后 AI 85%；
 * - 「搬运小能手」：简介挂侵权免责 → 触发器命中 → 复核后 AI 15%（本地提示
 *   但 AI 说没问题，这正是「触发器不构成判定」的演示）；
 * - 「老王做菜」：无任何本地信号 → 无判定态（不是「低风险」）；
 * - 「新人UP主小林」：只有一条投稿 → 无判定，演示"没有结论"长什么样。
 */
const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    uid: "100200301",
    displayName: "资源分享君",
    bio: "各类学习资料持续更新",
    followers: 1_204,
    archiveCount: 446,
    ai: {
      marketingProbability: 85,
      reason: "投稿标题成套兜售盗版课程与影视资源，简介无身份信息，投稿粉丝比异常",
    },
    videos: [
      { bvid: "BV1DEMO001", title: "某某课程L系列全套完整版 视频+字幕", hoursAgo: 2 },
      { bvid: "BV1DEMO002", title: "某纪录片 完结版 未删减 网盘自取", hoursAgo: 5 },
      { bvid: "BV1DEMO003", title: "某某绘本 中英字幕 中文+英文+音频+绘本", hoursAgo: 8 },
    ],
  },
  {
    uid: "100200305",
    displayName: "搬运小能手",
    bio: "如有侵权，联系第一时间删除！",
    followers: 3_842,
    archiveCount: 326,
    ai: {
      marketingProbability: 15,
      reason: "简介虽挂免责声明，但投稿为带独立解说的影视杂谈，节奏与用词更像个人二创",
    },
    videos: [
      { bvid: "BV1DEMO101", title: "经典剧集回顾 第 3 期", hoursAgo: 2 },
      { bvid: "BV1DEMO102", title: "经典剧集回顾 第 4 期", hoursAgo: 8 },
      { bvid: "BV1DEMO103", title: "影视原声合辑", hoursAgo: 30 },
    ],
  },
  {
    uid: "556677889",
    displayName: "老王做菜",
    bio: "专注家常菜谱十年，每周三更新",
    followers: 182_400,
    archiveCount: 512,
    ai: {
      marketingProbability: 8,
      reason: "长期垂直更新家常菜谱，投稿粉丝比正常，无明显营销特征",
    },
    videos: [
      { bvid: "BV1FOOD001", title: "红烧肉的正宗家常做法，肥而不腻", hoursAgo: 30 },
      { bvid: "BV1FOOD002", title: "清蒸鲈鱼的做法，鲜嫩不腥的小技巧", hoursAgo: 96 },
      { bvid: "BV1FOOD003", title: "家常豆腐怎么做好吃，详细步骤讲解", hoursAgo: 168 },
    ],
  },
  {
    uid: "990011223",
    displayName: "新人UP主小林",
    videos: [{ bvid: "BV1NEW0001", title: "我的第一个投稿，请多关照", hoursAgo: 6 }],
  },
];

/** 模拟的 AI 判定时延（毫秒），让「点下去有反应」看得见。 */
const AI_LATENCY_MS = 700;

interface DemoEntry {
  accountKey: AccountKey;
  uid: string;
  card: ExtractedCard;
  /** 已复核的账号：概率与理由来自 DEMO_ACCOUNTS 的 ai 字段。 */
  aiReview?: { marketingProbability: number; reason: string; model: string };
  triggers: ReviewTriggerHit[];
}

/** 全部账号的处置状态（演示中仅支持白名单切换）。 */
const settings: ExtensionSettings = { ...DEFAULT_SETTINGS };
const entries = new Map<AccountKey, DemoEntry>();
const dispositions = new Map<AccountKey, "whitelisted" | "none">();

function accountKeyOf(uid: string): AccountKey {
  return `uid:${uid}` as AccountKey;
}

/** 构造一张模拟视频卡片（结构与真实适配器产出一致）。 */
function buildCard(account: DemoAccount, index: number): ExtractedCard {
  const video = account.videos[index]!;
  const cardElement = document.createElement("article");
  cardElement.className = "demo-card";
  cardElement.innerHTML = `
    <div class="demo-cover">
      <span class="demo-cover-text">视频封面</span>
    </div>
    <div class="demo-card-body">
      <h3 class="demo-title"></h3>
      <p class="demo-meta"></p>
    </div>`;
  cardElement.querySelector(".demo-title")!.textContent = video.title;
  cardElement
    .querySelector(".demo-meta")!
    .textContent = `${account.displayName} · ${video.hoursAgo}小时前`;
  const anchorElement = document.createElement("a");
  anchorElement.href = `https://www.bilibili.com/video/${video.bvid}`;
  cardElement.querySelector(".demo-cover")!.append(anchorElement);
  return {
    cardKey: `demo:${video.bvid}:uid:${account.uid}`,
    accountKey: accountKeyOf(account.uid),
    uid: account.uid,
    uidSource: "card",
    displayName: account.displayName,
    profileUrl: `https://space.bilibili.com/${account.uid}`,
    profileBio: account.bio,
    video: {
      videoKey: video.bvid,
      bvid: video.bvid,
      title: video.title,
      videoUrl: `https://www.bilibili.com/video/${video.bvid}`,
      publishedText: `${video.hoursAgo}小时前`,
      publishedAtMs: Date.now() - video.hoursAgo * 3_600_000,
      metricsRaw: [],
      source: SOURCE,
      observedAtMs: Date.now(),
    },
    missingFields: [],
    source: SOURCE,
    mount: { cardElement, anchorElement },
  };
}

/** 把演示账号转成存储层形态的资料（真实链路里由 IndexedDB 合并产出）。 */
function toProfile(account: DemoAccount): AccountProfileRecord {
  const now = Date.now();
  return {
    accountKey: accountKeyOf(account.uid),
    uid: account.uid,
    profileUrl: `https://space.bilibili.com/${account.uid}`,
    displayName: account.displayName,
    ...(account.bio === undefined ? {} : { profileBio: account.bio }),
    ...(account.followers === undefined ? {} : { followers: account.followers }),
    ...(account.archiveCount === undefined
      ? {}
      : { archiveCount: account.archiveCount }),
    firstSeenAtMs: now,
    lastSeenAtMs: now,
  };
}

/** 把演示账号的投稿转成存储层形态。 */
function toVideos(account: DemoAccount): VideoObservationRecord[] {
  const now = Date.now();
  return account.videos.map((video, index) => ({
    videoKey: video.bvid,
    bvid: video.bvid,
    title: video.title,
    videoUrl: `https://www.bilibili.com/video/${video.bvid}`,
    publishedText: `${video.hoursAgo}小时前`,
    publishedAtMs: now - video.hoursAgo * 3_600_000,
    metricsRaw: [],
    source: SOURCE,
    observedAtMs: now - index * 60_000,
    accountKey: accountKeyOf(account.uid),
    firstSeenAtMs: now,
    lastSeenAtMs: now,
    seenCount: 1,
  }));
}

/** 把账号转成消息协议里的 AccountAnalysis 形态（与扩展同构）。 */
function toAnalysis(account: DemoAccount, hasAiReview: boolean): AccountAnalysis {
  const profile = toProfile(account);
  const videos = toVideos(account);
  const triggers = detectReviewTriggers({
    profile,
    videos,
    // 演示页只有一批账号，没有任何跨账号历史，因此 reposted-video 恒为 0。
    repostHistory: new Map(),
  });
  const disposition = dispositions.get(accountKeyOf(account.uid)) === "whitelisted"
    ? "whitelisted"
    : "none";
  const review: ReviewOutcome =
    hasAiReview && account.ai !== undefined
      ? {
          kind: "ai",
          review: {
            accountKey: accountKeyOf(account.uid),
            marketingProbability: account.ai.marketingProbability,
            category: "uncertain",
            reason: account.ai.reason,
            insufficientData: [],
            model: "demo-model-flash",
            reviewedAtMs: Date.now(),
          },
        }
      : triggers.length > 0
        ? { kind: "triggered", triggers }
        : { kind: "none" };
  return {
    accountKey: accountKeyOf(account.uid),
    uid: account.uid,
    displayName: account.displayName,
    ...(profile.followers === undefined ? {} : { followers: profile.followers }),
    ...(profile.archiveCount === undefined
      ? {}
      : { archiveCount: profile.archiveCount }),
    observedVideos: videos.length,
    hasBio: (profile.profileBio ?? "").length > 0,
    review,
    disposition,
  };
}

/**
 * 渲染整个演示流：每账号首卡挂真实标签，摘要侧栏同步展示判定状态。
 */
function renderFeed(): void {
  const feed = document.querySelector("#feed")!;
  feed.replaceChildren();
  entries.clear();

  for (const account of DEMO_ACCOUNTS) {
    for (let index = 0; index < account.videos.length; index += 1) {
      const card = buildCard(account, index);
      feed.append(card.mount.cardElement);
      if (index === 0) {
        entries.set(accountKeyOf(account.uid), {
          accountKey: accountKeyOf(account.uid),
          uid: account.uid,
          card,
          triggers: detectReviewTriggers({
            profile: toProfile(account),
            videos: toVideos(account),
            repostHistory: new Map(),
          }),
        });
      }
    }
  }

  renderSummary();
  for (const entry of entries.values()) {
    renderBadge(
      entry.card,
      toAnalysis(
        DEMO_ACCOUNTS.find((item) => item.uid === entry.uid)!,
        entry.aiReview !== undefined,
      ),
      settings,
      async (action) => {
        if (action.disposition === "whitelisted") {
          dispositions.set(
            entry.accountKey,
            action.selected ? "whitelisted" : "none",
          );
          rerenderAccount(entry.accountKey);
        }
      },
      // 「AI 判定」用内置假数据，不发任何网络请求。
      () => reviewWithMockAi(entry.accountKey),
    );
  }
}

/** 模拟一次 AI 判定：内置结论 + 一点时延，然后重绘该账号徽章。 */
async function reviewWithMockAi(accountKey: AccountKey): Promise<void> {
  const entry = entries.get(accountKey);
  const account = DEMO_ACCOUNTS.find((item) => accountKeyOf(item.uid) === accountKey);
  if (entry === undefined || account === undefined) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, AI_LATENCY_MS));
  entry.aiReview = account.ai
    ? { ...account.ai, model: "demo-model-flash" }
    : undefined;
  rerenderAccount(accountKey);
}

/** 复核/白名单操作后重算判定并重绘该账号徽章。 */
function rerenderAccount(accountKey: AccountKey): void {
  const entry = entries.get(accountKey);
  if (entry === undefined) {
    return;
  }
  const account = DEMO_ACCOUNTS.find((item) => accountKeyOf(item.uid) === accountKey)!;
  renderSummary();
  renderBadge(
    entry.card,
    toAnalysis(account, entry.aiReview !== undefined),
    settings,
    async () => {},
    () => reviewWithMockAi(accountKey),
  );
}

/** 渲染右侧账号摘要列表（与 Popup 的三态口径一致）。 */
function renderSummary(): void {
  const panel = document.querySelector("#summary")!;
  const rows = DEMO_ACCOUNTS.map((account) => {
    const entry = entries.get(accountKeyOf(account.uid));
    const analysis = toAnalysis(account, entry?.aiReview !== undefined);
    const state =
      analysis.review.kind === "ai"
        ? `AI ${analysis.review.review!.marketingProbability}%`
        : analysis.review.kind === "triggered"
          ? "待复核"
          : "无判定";
    const detail =
      analysis.review.kind === "ai"
        ? analysis.review.review!.reason
        : analysis.review.kind === "triggered"
          ? analysis.review.triggers!.map((hit) => hit.detail).join("；")
          : "本地未注意到值得复核的信号";
    return {
      name: account.displayName,
      state,
      detail,
      kind: analysis.review.kind,
      disposition: analysis.disposition,
    };
  });
  panel.replaceChildren(
    ...rows.map((row) => {
      const item = document.createElement("li");
      item.className = `summary-row summary-${row.kind}`;
      const name = document.createElement("strong");
      name.textContent = row.name;
      const state = document.createElement("span");
      state.className = "summary-score";
      state.textContent = row.disposition === "whitelisted"
        ? "白名单"
        : row.state;
      const detail = document.createElement("p");
      detail.textContent = row.detail;
      item.append(name, state, detail);
      return item;
    }),
  );
}

/** 搭建演示页骨架：头部说明 + 摘要侧栏 + 卡片流容器。 */
function buildShell(): void {
  const app = document.querySelector("#app")!;
  app.innerHTML = `
    <header class="demo-header">
      <div>
        <p class="demo-eyebrow">真实引擎演示 · detectReviewTriggers + renderBadge</p>
        <h1>B站内容净化助手 · 内置浏览器演示</h1>
        <p class="demo-note">
          本页运行的是插件源码中的本地触发器与标签渲染模块；判定只有 AI 一条路，
          「AI 判定」用的是内置假结论，不发任何网络请求。点击卡片左上角标签可展开
          判定依据与操作。
        </p>
      </div>
      <aside class="demo-summary">
        <h2>本页账号摘要</h2>
        <ul id="summary"></ul>
      </aside>
    </header>
    <main id="feed" class="demo-feed"></main>`;
}

buildShell();
renderFeed();
