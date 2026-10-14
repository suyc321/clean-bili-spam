/**
 * B 站 URL 与时间文本解析器。
 *
 * 安全原则：所有 URL 都必须解析后校验主机名，绝不信任 DOM 文本；
 * 解析失败一律返回 undefined，由上层决定降级行为。
 */

/** 解析成功的视频地址：规范化 URL + BVID。 */
export interface ParsedBilibiliVideoUrl {
  url: URL;
  bvid: string;
}

/** 解析成功的空间（UP 主主页）地址：规范化 URL + UID。 */
export interface ParsedBilibiliProfileUrl {
  url: URL;
  uid: string;
}

/** 视频路径匹配：/video/BVxxx，BV 号大小写敏感。 */
const BVID_PATH = /^\/video\/(BV[0-9A-Za-z]+)(?:\/|$)/u;
/** 空间路径匹配：/数字 UID。 */
const UID_PATH = /^\/(\d+)(?:\/|$)/u;

/**
 * 解析视频地址并严格校验域名。
 *
 * @param rawUrl 卡片锚点的原始 href（可能是相对或协议相对地址）
 * @param baseUrl 页面地址，用于解析相对路径
 * @returns 解析结果；非 www.bilibili.com 或路径不匹配时返回 undefined
 */
export function parseBilibiliVideoUrl(
  rawUrl: string,
  baseUrl: string,
): ParsedBilibiliVideoUrl | undefined {
  const url = safeUrl(
    rawUrl,
    rawUrl.startsWith("/video/")
      ? "https://www.bilibili.com/"
      : baseUrl,
  );
  if (url === undefined || url.hostname !== "www.bilibili.com") {
    return undefined;
  }

  const match = BVID_PATH.exec(url.pathname);
  const bvid = match?.[1];
  return bvid === undefined ? undefined : { url, bvid };
}

/**
 * 解析 UP 主空间地址并严格校验域名。
 * @returns 解析结果；非 space.bilibili.com 或路径不匹配时返回 undefined
 */
export function parseBilibiliProfileUrl(
  rawUrl: string,
  baseUrl: string,
): ParsedBilibiliProfileUrl | undefined {
  const url = safeUrl(rawUrl, baseUrl);
  if (url === undefined || url.hostname !== "space.bilibili.com") {
    return undefined;
  }

  const match = UID_PATH.exec(url.pathname);
  const uid = match?.[1];
  return uid === undefined ? undefined : { url, uid };
}

/**
 * 从空间页自身的地址中提取当前登录浏览的 UID。
 * 仅在 space.bilibili.com 页面上生效，供主页适配器做身份兜底。
 */
export function parseSpaceUidFromPage(url: URL): string | undefined {
  if (url.hostname !== "space.bilibili.com") {
    return undefined;
  }
  return UID_PATH.exec(url.pathname)?.[1];
}

/**
 * 把页面展示的相对时间文本解析为时间戳。
 *
 * 支持：「刚刚」「N分钟前」「N小时前」「N天前」「YYYY-MM-DD」「MM-DD」。
 * MM-DD 按今年推算，若落在未来则回退一年（跨年场景）。
 *
 * @param publishedText 页面展示的时间原文
 * @param nowMs 当前时间，相对时间的推算基准
 * @returns 毫秒时间戳；无法识别的格式返回 undefined
 */
export function parsePublishedAt(
  publishedText: string | undefined,
  nowMs: number,
): number | undefined {
  if (publishedText === undefined) {
    return undefined;
  }

  // 统一全角字符并去掉 B 站时间前的「·」分隔符。
  const normalized = publishedText
    .normalize("NFKC")
    .trim()
    .replace(/^·\s*/u, "");

  if (normalized === "刚刚") {
    return nowMs;
  }

  const minutes = /^(\d+)\s*分钟前$/u.exec(normalized)?.[1];
  if (minutes !== undefined) {
    return nowMs - Number(minutes) * 60_000;
  }

  const hours = /^(\d+)\s*小时前$/u.exec(normalized)?.[1];
  if (hours !== undefined) {
    return nowMs - Number(hours) * 60 * 60_000;
  }

  const days = /^(\d+)\s*天前$/u.exec(normalized)?.[1];
  if (days !== undefined) {
    return nowMs - Number(days) * 24 * 60 * 60_000;
  }

  // 完整日期：按本地时区构造，构造结果回读校验可排除非法日期（如 2 月 30 日）。
  const fullDate = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(normalized);
  if (fullDate !== null) {
    return localDateMs(
      Number(fullDate[1]),
      Number(fullDate[2]),
      Number(fullDate[3]),
    );
  }

  // 月-日：先按今年推算；若结果是未来时间，说明是去年的日期。
  const monthDay = /^(\d{1,2})-(\d{1,2})$/u.exec(normalized);
  if (monthDay !== null) {
    const current = new Date(nowMs);
    const candidate = localDateMs(
      current.getFullYear(),
      Number(monthDay[1]),
      Number(monthDay[2]),
    );
    if (candidate === undefined) {
      return undefined;
    }
    return candidate > nowMs
      ? localDateMs(
          current.getFullYear() - 1,
          Number(monthDay[1]),
          Number(monthDay[2]),
        )
      : candidate;
  }

  return undefined;
}

/**
 * 压缩文本：连续空白合并为单个空格并去首尾。
 * @returns 空字符串输入返回 undefined
 */
export function compactText(value: string | null | undefined): string | undefined {
  const compacted = value?.replace(/\s+/gu, " ").trim();
  return compacted === undefined || compacted.length === 0
    ? undefined
    : compacted;
}

/** 安全构造 URL，非法输入返回 undefined 而不是抛错。 */
function safeUrl(rawUrl: string, baseUrl: string): URL | undefined {
  try {
    return new URL(rawUrl, baseUrl);
  } catch {
    return undefined;
  }
}

/**
 * 按本地时区构造日期时间戳，并回读校验年月日，
 * 防止 JS Date 自动进位把非法日期（如 2026-02-30）静默修正。
 */
function localDateMs(
  year: number,
  month: number,
  day: number,
): number | undefined {
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }
  return date.getTime();
}
