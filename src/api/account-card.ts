/**
 * UP 主公开信息补全：通过 B 站用户名片接口取简介、粉丝数与投稿数。
 *
 * 本模块运行在 **Service Worker** 侧（与 api/relation.ts 同一层）。
 * 之所以不放内容脚本：授权检查要用 `chrome.permissions`，而内容脚本
 * 没有这个 API（项目文档早已记录「内容脚本没有 chrome.permissions/
 * chrome.cookies」）。内容脚本只管把 UID 列表发过来。
 *
 * 为什么需要（2026-09-25 实测发现）：
 * 首页/搜索页的卡片身份解析来自作者链接，**拿不到简介**；简介只在 UP 主
 * 主页能读到。后果是「侵权免责声明」这条触发器在首页没有输入。
 * 粉丝数与投稿数交给面板和 AI。
 *
 * `x/web-interface/card?mid=xxx` 实测**不需要 wbi 签名、不需要登录**，
 * 一个请求即可拿到：
 *   - data.card.sign            简介（首页拿不到的那一项）
 *   - data.card.fans            粉丝数
 *   - data.archive_count        投稿数（在 data 层，不在 card 层）
 *   - data.card.official_verify 认证信息（type: -1 无 / 0 个人 / 1 机构）
 *
 * 投稿数与粉丝数会一起交给面板和 AI。举例：264 投稿 / 1089 万粉丝的大号，
 * 与 103 投稿 / 1.4 万粉丝的小号，投稿粉丝比差别很大。
 *
 * 隐私与权限边界：
 * - 这是**只读公开数据**，不发送任何用户数据；本机之外没有任何东西离开。
 * - 需要 `api.bilibili.com` 主机权限才能跨域读取。该权限扩展本就作为可选
 *   权限存在（拉黑功能用的就是它），因此复用同一条授权链路。
 * - **默认不启用**：新增网络行为必须由用户在设置页显式开启，
 *   并在用户手势内申请授权；失败时返回 null，扫描继续，只是没有简介和粉丝数。
 */
/** 名片接口地址（只读公开数据，无需 wbi）。 */
import type { AccountKey } from "../domain/types";

/** 名片接口地址（只读公开数据，无需 wbi）。 */
const CARD_ENDPOINT = "https://api.bilibili.com/x/web-interface/card";
/** 合集列表接口地址（只读公开数据，无需 wbi、无需登录）。 */
const SEASONS_ENDPOINT =
  "https://api.bilibili.com/x/polymer/web-space/seasons_series_list";

/** 补全功能需要的可选权限（与拉黑功能同一条授权链路）。 */
export const ACCOUNT_INFO_ORIGIN = "https://api.bilibili.com/*";

/** 名片接口的原始返回结构（只声明会用到的字段）。 */
interface CardResponse {
  code?: number;
  data?: {
    archive_count?: number;
    card?: {
      name?: string;
      sign?: string;
      fans?: number;
      attention?: number;
      regtime?: number;
      Official?: { role?: number; title?: string };
      official_verify?: { type?: number; desc?: string };
    };
  };
}

/** 单条名片数据：只保留界面和 AI 会用到的字段。 */
export interface AccountCardInfo {
  /** UP 主 UID。 */
  mid: AccountKey;
  /** 昵称。 */
  name?: string;
  /** 签名/简介原文（空串表示该 UP 没有简介）。 */
  sign?: string;
  /** 粉丝数。 */
  fans?: number;
  /** 投稿数。 */
  archiveCount?: number;
  /** 关注数（该 UP 主动关注了多少人）。 */
  attention?: number;
  /** 认证类型：-1 无 / 0 个人 / 1 机构；取不到时为 undefined。 */
  officialVerifyType?: number;
  /** 认证说明（如「2025百大UP主」）。 */
  officialTitle?: string;
  /**
   * 合集数量。和投稿数一起交给面板与 AI。批量搬运的账号往往不整理合集。
   */
  seasonCount?: number;
  /** 从合集接口拿到的投稿（含 bvid、标题、发布时间、播放、弹幕）。 */
  seasonVideos: SeasonVideo[];
  /** 取到该数据的时间戳。 */
  fetchedAtMs: number;
}

/** 合集接口返回的单条投稿（字段名与 B 站返回一致，便于对照排查）。 */
export interface SeasonVideo {
  bvid: string;
  title: string;
  /** 发布时间（秒级时间戳）。 */
  pubdate?: number;
  /** 时长（秒）。 */
  duration?: number;
  /** 播放数。 */
  view?: number;
  /** 弹幕数。 */
  danmaku?: number;
}

/** 名片缓存的保鲜期：粉丝/投稿数变化不快，一天足够。 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/** mid → 名片数据的内存缓存。内容脚本每次注入都会重建，因此只覆盖当次会话。 */
const cardCache = new Map<string, AccountCardInfo>();

/**
 * 取一个 UP 主的公开名片信息。
 *
 * @param mid UP 主 UID
 * @param fetchImpl 可注入的 fetch（测试用）
 * @returns 名片数据；接口失败、数据缺失或返回 code≠0 时返回 null
 */
export async function fetchAccountCard(
  mid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountCardInfo | null> {
  const cached = cardCache.get(mid);
  if (cached !== undefined && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
    return cached;
  }

  let payload: CardResponse;
  try {
    const response = await fetchImpl(
      `${CARD_ENDPOINT}?mid=${encodeURIComponent(mid)}&photo=false`,
      { method: "GET", credentials: "omit", headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      return null;
    }
    payload = (await response.json()) as CardResponse;
  } catch {
    // 网络失败时返回 null，调用方跳过这次补全。
    return null;
  }
  if (payload.code !== 0) {
    return null;
  }

  const card = payload.data?.card;
  if (card === undefined) {
    return null;
  }
  const verify = card.official_verify;
  const info: AccountCardInfo = {
    mid: `uid:${mid}`,
    ...(typeof card.name === "string" ? { name: card.name } : {}),
    // sign 为空串表示这个 UP 确实没写简介，与「取不到」不是一回事，
    // 因此空串也保留（下游据此判定「无身份标识」）。
    ...(typeof card.sign === "string" ? { sign: card.sign } : {}),
    ...(typeof card.fans === "number" ? { fans: card.fans } : {}),
    ...(typeof payload.data?.archive_count === "number"
      ? { archiveCount: payload.data.archive_count }
      : {}),
    ...(typeof card.attention === "number" ? { attention: card.attention } : {}),
    ...(typeof verify?.type === "number"
      ? { officialVerifyType: verify.type }
      : {}),
    ...(typeof verify?.desc === "string" && verify.desc !== ""
      ? { officialTitle: verify.desc }
      : {}),
    // 合集与合集内投稿：单独一次请求，失败不影响名片本身
    // （名片才是主要目标，合集视频只是额外的证据来源）。
    ...(await fetchSeasonVideos(mid, fetchImpl)),
    fetchedAtMs: Date.now(),
  };
  cardCache.set(mid, info);
  return info;
}

/** 合集列表接口的返回结构（只声明会用到的字段）。 */
interface SeasonsResponse {
  code?: number;
  data?: {
    items_lists?: {
      seasons_list?: Array<{
        meta?: { season_id?: number; name?: string; total?: number };
        archives?: Array<{
          bvid?: string;
          title?: string;
          pubdate?: number;
          duration?: number;
          stat?: { view?: number; danmaku?: number };
        }>;
      }>;
    };
  };
}

/**
 * 取 UP 主合集列表，以及每个合集附带的前几条投稿。
 *
 * 为什么走这条而不是 `space/arc/search`：后者被 B 站风控挡死（HTTP 412，
 * 需要 wbi 签名），而这条实测**不需要登录也不需要 wbi**，稳定可用。
 *
 * 已知边界（都实测过，不要在这上面浪费时间）：
 * - `page_size` 只能取 20，传 50/100 直接 -400；因此最多覆盖 20 个合集；
 * - 每个合集在列表里只带前约 6 条投稿；
 * - 合集内翻页接口 `seasons_archives_list` 被 -352 风控，**不可依赖**；
 * - 只有把投稿组织进合集的 UP 主才有数据；没有合集的账号返回空数组
 *   （内容农场大多如此，因此 `seasonCount=0` 配高投稿数本身是个观察点）。
 */
export async function fetchSeasonVideos(
  mid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ seasonCount: number; seasonVideos: SeasonVideo[] }> {
  let payload: SeasonsResponse;
  try {
    const response = await fetchImpl(
      `${SEASONS_ENDPOINT}?mid=${encodeURIComponent(mid)}&page_num=1&page_size=20`,
      { method: "GET", credentials: "omit", headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      return { seasonCount: 0, seasonVideos: [] };
    }
    payload = (await response.json()) as SeasonsResponse;
  } catch {
    // 合集失败不影响名片：名片是主要目标，这里只返回空。
    return { seasonCount: 0, seasonVideos: [] };
  }
  if (payload.code !== 0) {
    return { seasonCount: 0, seasonVideos: [] };
  }

  const seasons = payload.data?.items_lists?.seasons_list ?? [];
  const videos: SeasonVideo[] = [];
  const seen = new Set<string>();
  for (const season of seasons) {
    for (const arc of season.archives ?? []) {
      // 同一投稿可能出现在多个合集里，按 bvid 去重。
      if (arc.bvid === undefined || seen.has(arc.bvid)) {
        continue;
      }
      seen.add(arc.bvid);
      videos.push({
        bvid: arc.bvid,
        ...(typeof arc.title === "string" ? { title: arc.title } : { title: "" }),
        ...(typeof arc.pubdate === "number" ? { pubdate: arc.pubdate } : {}),
        ...(typeof arc.duration === "number" ? { duration: arc.duration } : {}),
        ...(typeof arc.stat?.view === "number" ? { view: arc.stat.view } : {}),
        ...(typeof arc.stat?.danmaku === "number"
          ? { danmaku: arc.stat.danmaku }
          : {}),
      });
    }
  }
  return { seasonCount: seasons.length, seasonVideos: videos };
}

/**
 * 投稿数与粉丝数的比值，供展示和提示词使用。
 * 仅供面板展示与 AI 提示词使用。
 *
 * 粉丝数为 0 时返回 null：此时比值无定义，而「有投稿却 0 粉丝」这件事本身
 * 由面板直接显示粉丝数让人看见，不该塞进一个比值里假装它是数值。
 */
export function archiveToFansRatio(card: AccountCardInfo): number | null {
  if (
    card.archiveCount === undefined ||
    card.fans === undefined ||
    card.fans === 0
  ) {
    return null;
  }
  return card.archiveCount / card.fans;
}

/** 清空名片缓存（测试用）。 */
export function clearCardCache(): void {
  cardCache.clear();
}
