/**
 * UP 主公开名片的清洗与转换。
 *
 * 名片与合集来自 B 站接口，属于**外部数据**。内容脚本把它们拼进
 * `observations.ingest` 之前必须按消息协议的口径过滤/截断，否则一条空
 * BVID、超长标题或超长签名就会让整批消息被 Zod 拒绝，同批所有账号一起
 * 丢失这一轮观察（而且下一轮还会因为名片缓存重复失败）。
 *
 * 这里刻意做成不依赖 DOM / chrome API 的纯函数，便于单测。
 */
import type { VideoObservationInput } from "../domain/types";

/** 名片载荷：accountCard.get 返回的单条形态。 */
export interface CardPayload {
  name?: string;
  sign?: string;
  fans?: number;
  archiveCount?: number;
  officialVerifyType?: number;
  seasonVideos?: SeasonVideoPayload[];
}

/** 合集接口拿到的单条投稿（仅取特征计算会用到的字段）。 */
export interface SeasonVideoPayload {
  bvid: string;
  title: string;
  pubdate?: number;
  duration?: number;
  view?: number;
  danmaku?: number;
}

/** 提交观察时允许带上的名片字段（字段名与协议一致）。 */
export interface CardFieldPayload {
  profileBio?: string;
  profileFollowers?: number;
  profileArchiveCount?: number;
  profileCardFetched?: boolean;
  profileOfficialVerifyType?: number;
}

/** 与 protocol.ts 的 videoObservationSchema 保持一致。 */
const BVID_PATTERN = /^BV[0-9A-Za-z]+$/u;
const MAX_TITLE_LENGTH = 500;
const MAX_BIO_LENGTH = 2_000;

/** 协议要求 bvid 形如 BVxxx；空串或异常值直接丢弃。 */
function isValidBvid(value: string): boolean {
  return BVID_PATTERN.test(value);
}

/** 粉丝数/投稿数在协议里是非负整数；接口给别的类型时不提交。 */
function isNonNegativeInteger(value: number | undefined): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0
  );
}

/** 从卡片上的名片信息取出要提交的字段，并裁剪到协议上限。 */
export function cardFieldsOf(
  info: (CardPayload & { fetchedAtMs: number }) | undefined,
): CardFieldPayload {
  if (info === undefined) {
    return {};
  }
  const bio = info.sign?.trim() ?? "";
  return {
    ...(bio === "" ? {} : { profileBio: bio.slice(0, MAX_BIO_LENGTH) }),
    ...(isNonNegativeInteger(info.fans)
      ? { profileFollowers: info.fans }
      : {}),
    ...(isNonNegativeInteger(info.archiveCount)
      ? { profileArchiveCount: info.archiveCount }
      : {}),
    // 取到过就置 true：下游据此区分「无简介」与「没查过」。
    profileCardFetched: true,
    ...(info.officialVerifyType !== undefined &&
    Number.isInteger(info.officialVerifyType)
      ? { profileOfficialVerifyType: info.officialVerifyType }
      : {}),
  };
}

/**
 * 把合集视频转成观察记录形态。
 *
 * 来源标成 `adapterId: "account-card"` 以便区分数据来自接口而不是 DOM 采集；
 * `pageKind` 用 `space`，因为合集本质上属于 UP 主空间页的内容。
 * metricsRaw 保留播放、弹幕原文，只入库，不在这里解析。
 */
export function seasonVideosOf(
  info: CardPayload,
): VideoObservationInput[] {
  const source = {
    pageKind: "space" as const,
    adapterId: "account-card",
    adapterVersion: 1,
  };
  const observedAtMs = Date.now();
  const videos: VideoObservationInput[] = [];
  const seen = new Set<string>();
  for (const video of info.seasonVideos ?? []) {
    // 同一投稿可能出现在多个合集里；接口偶尔给空/异常 BVID。
    if (!isValidBvid(video.bvid) || seen.has(video.bvid)) {
      continue;
    }
    const title = video.title.trim();
    // 协议要求标题非空且不超过 500 字。
    if (title === "") {
      continue;
    }
    seen.add(video.bvid);
    const pubdate = video.pubdate;
    videos.push({
      videoKey: video.bvid,
      bvid: video.bvid,
      title: title.slice(0, MAX_TITLE_LENGTH),
      videoUrl: `https://www.bilibili.com/video/${video.bvid}`,
      metricsRaw: [
        ...(video.view === undefined ? [] : [String(video.view)]),
        ...(video.danmaku === undefined ? [] : [String(video.danmaku)]),
      ],
      source,
      observedAtMs,
      ...(isNonNegativeInteger(pubdate)
        ? {
            publishedAtMs: pubdate * 1_000,
            publishedText: relativeTime(pubdate * 1_000),
          }
        : {}),
    });
  }
  return videos;
}

/** 时间戳转「N 天前」这类文本，与 DOM 采集的 publishedText 同口径。 */
function relativeTime(atMs: number): string {
  const diff = Date.now() - atMs;
  const day = 86_400_000;
  if (diff < 0) {
    return "刚刚";
  }
  if (diff < day) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  if (diff < day * 30) {
    return `${Math.floor(diff / day)} 天前`;
  }
  return `${Math.floor(diff / (day * 30))} 个月前`;
}
