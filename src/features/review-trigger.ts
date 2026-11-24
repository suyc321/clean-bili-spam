/**
 * 本地触发器：决定「这个账号值不值得花一次 AI 判定」。
 *
 * 判定由 AI 产出。这里只回答要不要花一次调用：命中表示本地看到了一条
 * 事实，界面也只陈述这条事实，例如「简介含侵权免责声明」。
 *
 * 四条信号都是单条事实即可成立、与标题风格无关：
 * - 侵权免责声明：大量转载他人内容的账号才会提前挂免责；
 * - 成套资源兜售：标题强调「视频+字幕+音频」这类物料构成；
 * - 同一投稿多账号发布：同一个 BV 出现在其他账号的观察里；
 * - 24 小时内密集投稿：可解析的发布时间里，窗口内不少于 5 条。
 *
 * 条件偏召回。角标太吵时，先收紧这里的条数或句式。
 */
import type {
  AccountKey,
  AccountProfileRecord,
  ReviewTriggerHit,
  VideoObservationRecord,
} from "../domain/types";

/** 触发器输入。 */
export interface ReviewTriggerInput {
  profile: AccountProfileRecord;
  videos: readonly VideoObservationRecord[];
  /**
   * BV 号 → 观察过它的账号（由调用方查存储得到）。
   * 用来算「同一投稿多账号发布」；没有历史数据时传空 Map，该信号即为 0。
   */
  repostHistory: ReadonlyMap<string, readonly AccountKey[]>;
}

/**
 * 侵权免责声明模式：命中即视为搬运号的高度特征信号。
 *
 * 典型情形：账号全是影视切片，简介写「如有侵权，联系
 * 第一时间删除！」。原创作者不会这样写——只有大量转载他人内容、随时可能
 * 被投诉的账号才需要提前挂免责。正规二创会署名来源或说明已授权。
 */
const REPOST_DISCLAIMER_PATTERNS = [
  /如有侵权/u,
  /侵删/u,
  /第一时间删除|随时删除|联系删除/u,
  /版权归(?:原)?作者|版权问题联系/u,
  /如不妥请联系|不当之处请联系/u,
];

/**
 * 盗版资源贩卖句式：命中即视为「在投稿标题里兜售成套资源」。
 *
 * 典型情形：投稿标题全是「某某L系列全套完整版 视频+字幕」
 * 「某某课程 169集 视频+字幕」「某某.中英字幕 中文+英文+音频+绘本」
 * 这类盗版课程或影视资源引流。
 *
 * 判定分三层，尽量不误伤常规创作。
 */

/** 第一层：物料清单话术——一条即中。原创作者讲自己的合集时不会强调物料构成。 */
const RESOURCE_MATERIAL_PATTERNS = [
  /(?:视频|动画|课程|纪录片|资料)\s*[+＋]\s*(?:字幕|音频|文稿|讲义|pdf|文本|绘本)/iu,
  /(?:音频|视频|讲义|绘本|字幕)\s*[+＋]\s*(?:音频|视频|讲义|绘本|文本)/iu,
  /(?:中英|中字|双语|无字幕|外挂)\s*字幕/u,
];

/** 第二层：成套完整性声明与资源名词，同一标题共现才算。 */
const RESOURCE_COMPLETENESS = /(?:全套|完整版|完结版|未删减版|共\d+[集季部期册]|\d+[集季部期册]全)/u;
const RESOURCE_NOUN = /(?:课程|网课|视频|动画|纪录片|资源|资料|教程|字幕|绘本|音频)/iu;

/** 第三层：明确的资源分发动作与网盘线索——一条即中。 */
const RESOURCE_DISTRIBUTION_PATTERNS = [
  /(?:资源|课程|资料|纪录片)\s*(?:分享|自取|下载|领取|打包)/iu,
  /(?:分享|自取|领取)\s*(?:资源|课程|资料)/iu,
  /(?:网盘|云盘|度盘|夸克|阿里云盘)/u,
  /提取码/u,
];

/** 判断单条标题是否在兜售成套资源。单独抽出以便与测试共用同一口径。 */
export function isResourceTraffickingTitle(title: string): boolean {
  if (RESOURCE_MATERIAL_PATTERNS.some((pattern) => pattern.test(title))) {
    return true;
  }
  if (RESOURCE_COMPLETENESS.test(title) && RESOURCE_NOUN.test(title)) {
    return true;
  }
  return RESOURCE_DISTRIBUTION_PATTERNS.some((pattern) => pattern.test(title));
}

/** 短期投稿频率的判定：24 小时窗口内至少这么多条。 */
const BURST_WINDOW_MS = 24 * 60 * 60 * 1_000;
const BURST_MIN_POSTS = 5;

/**
 * 评估一个账号的本地触发器。
 *
 * 纯函数：不碰 DOM、chrome.* 或存储，跨账号数据由调用方查询后作为
 * `repostHistory` 传入。
 *
 * @returns 命中的信号清单（可能为空）；顺序固定，便于 UI 稳定呈现
 */
export function detectReviewTriggers(
  input: ReviewTriggerInput,
): ReviewTriggerHit[] {
  const hits: ReviewTriggerHit[] = [];

  // 侵权免责声明：只看简介，一条即可成立。无简介时无法判断，不命中。
  const bio = input.profile.profileBio?.trim();
  if (
    bio !== undefined &&
    bio.length > 0 &&
    REPOST_DISCLAIMER_PATTERNS.some((pattern) => pattern.test(bio))
  ) {
    hits.push({
      signal: "repost-disclaimer",
      detail: "简介含侵权免责声明（搬运/切片号的典型自述）",
    });
  }

  // 成套资源兜售：标题里出现即成立，无样本量门槛。
  const traffickingCount = input.videos.filter((video) =>
    isResourceTraffickingTitle(video.title),
  ).length;
  if (traffickingCount > 0) {
    hits.push({
      signal: "resource-trafficking",
      detail: `有 ${traffickingCount} 条投稿标题在兜售成套可下载资源`,
    });
  }

  // 同一投稿多账号发布：不同 UP 发同一个 BV。除官方授权转载外基本都是
  // 搬运/一稿多投。这条信号完全来自本地库，单账号复核也能算出。
  const repostedCount = countRepostedVideos(
    input.profile.accountKey,
    input.videos,
    input.repostHistory,
  );
  if (repostedCount > 0) {
    hits.push({
      signal: "reposted-video",
      detail: `有 ${repostedCount} 条投稿也在其他账号名下出现`,
    });
  }

  // 24 小时内密集投稿：量产节奏的事实陈述。阈值取召回导向——漏判的代价是
  // 一个农场号完全不被提示，而误触发的代价只是用户看到一个可忽略的角标。
  const burstCount = maxPostsInWindow(
    input.videos
      .map((video) => video.publishedAtMs)
      .filter((ms): ms is number => typeof ms === "number")
      .sort((left, right) => left - right),
    BURST_WINDOW_MS,
  );
  if (burstCount >= BURST_MIN_POSTS) {
    hits.push({
      signal: "burst-posting",
      detail: `24 小时内投稿不少于 ${burstCount} 条`,
    });
  }

  return hits;
}

/**
 * 统计投稿中有多少 BV 也被**其他账号**观察过。
 *
 * 注意必须排除自身：同一账号重复扫描同一视频不会让记录变成两条，
 * 但历史里可能残留本账号的更早记录，不过滤会把自己算成「其他账号」。
 */
function countRepostedVideos(
  accountKey: AccountKey,
  videos: readonly VideoObservationRecord[],
  history: ReadonlyMap<string, readonly AccountKey[]>,
): number {
  let count = 0;
  for (const video of videos) {
    const accounts = history.get(video.videoKey);
    if (accounts === undefined) {
      continue;
    }
    if (accounts.some((key) => key !== accountKey)) {
      count += 1;
    }
  }
  return count;
}

/**
 * 滑动窗口统计：排序时间戳上求窗口期内的最大条目数。
 * 双指针实现，时间复杂度 O(n)。
 */
function maxPostsInWindow(timestamps: number[], windowMs: number): number {
  let left = 0;
  let maximum = 0;
  for (let right = 0; right < timestamps.length; right += 1) {
    const rightValue = timestamps[right];
    let leftValue = timestamps[left];
    // 左指针右移直到窗口跨度小于 windowMs。
    while (
      rightValue !== undefined &&
      leftValue !== undefined &&
      rightValue - leftValue >= windowMs
    ) {
      left += 1;
      leftValue = timestamps[left];
    }
    maximum = Math.max(maximum, right - left + 1);
  }
  return maximum;
}
