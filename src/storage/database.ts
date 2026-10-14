/**
 * IndexedDB 观察数据库：账号资料、投稿观察与 AI 结论缓存的唯一持久层。
 *
 * 合并语义（重要）：
 * - 记录 ID 为 `${accountKey}:${videoKey}`，天然幂等；
 * - 新旧观察按时间戳合并：新字段优先，旧数据中存在而新数据缺失的
 *   稀疏字段保留（乱序、残缺观察不会互相覆盖）；
 * - 每账号投稿数量与整体保留期限分别裁剪，控制存储规模。
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  AccountKey,
  AccountObservationInput,
  AccountProfileRecord,
  AiAuditEntry,
  AiReviewRecord,
  ObservationExportV1,
  VideoObservationRecord,
} from "../domain/types";

/** 带物理主键的视频观察记录（存储层内部形态）。 */
interface StoredVideoObservation extends VideoObservationRecord {
  id: string;
}

/**
 * AI 判定结论的保鲜期：超过该时长的结论不再作为账号的当前判定。
 *
 * 改造后 AI 结论是插件唯一的判定来源，因此这个 TTL 同时决定了
 * 「徽章上显示 AI 概率」的时效——过期后账号回到「无判定」态。
 * 该账号再次出现在健康扫描里、且 AI 已配置时，会重新排队判定。
 */
export const AI_REVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** 数据库结构声明：为 idb 提供类型安全的库/表/索引定义。 */
interface GuardDatabase extends DBSchema {
  account_profiles: {
    key: AccountKey;
    value: AccountProfileRecord;
  };
  video_observations: {
    key: string;
    value: StoredVideoObservation;
    indexes: {
      "by-account": AccountKey;
      "by-last-seen": number;
      /** v4 新增：按 BV 号反查观察过它的账号，用于搬运检测。 */
      "by-video": string;
    };
  };
  /** v2 新增：AI 判定结论缓存，同时是账号当前的判定。 */
  ai_reviews: {
    key: AccountKey;
    value: AiReviewRecord;
  };
  /** v3 新增：AI 判定外发审计（仅元数据）。 */
  ai_audit: {
    key: string;
    value: AiAuditEntry;
  };
}

/** 反馈记录的数量上限（超出裁掉最旧的）。 */
/** AI 审计记录的数量上限。 */
export const AI_AUDIT_LIMIT = 200;

/** 数据库连接的单例缓存（避免重复 openDB）。 */
let databasePromise: Promise<IDBPDatabase<GuardDatabase>> | undefined;

/** 升级时删掉已经不再使用的对象仓库。新装的库里没有它。 */
function deleteStoreIfPresent(
  database: IDBPDatabase<GuardDatabase>,
  name: string,
): void {
  const names = database.objectStoreNames as unknown as DOMStringList;
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] === name) {
      (database.deleteObjectStore as unknown as (storeName: string) => void)(name);
      return;
    }
  }
}

/**
 * 打开（或复用）观察数据库。
 * 版本迁移按 oldVersion 逐级执行：
 * v1 账号资料与投稿观察；v2 AI 结论；v3 反馈与审计；
 * v4 按 BV 反查观察过它的账号；v5 删掉旧库里残留的 assessments 仓库；
 * v6 删掉不再使用的 feedback 仓库。
 */
export function getDatabase(): Promise<IDBPDatabase<GuardDatabase>> {
  databasePromise ??= openDB<GuardDatabase>("kcf-detector", 6, {
    // 第 4 个参数是原生升级事务：改动已存在的对象存储（如新增索引）必须用它，
    // 库级 transaction() 在 versionchange 期间不可用。
    upgrade(database, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        database.createObjectStore("account_profiles", {
          keyPath: "accountKey",
        });
        const videos = database.createObjectStore("video_observations", {
          keyPath: "id",
        });
        videos.createIndex("by-account", "accountKey");
        videos.createIndex("by-last-seen", "lastSeenAtMs");
      }
      if (oldVersion < 2) {
        database.createObjectStore("ai_reviews", {
          keyPath: "accountKey",
        });
      }
      if (oldVersion < 3) {
        database.createObjectStore("ai_audit", { keyPath: "id" });
      }
      if (oldVersion < 4) {
        // 按 BV 号反查：同一视频被多个账号观察过即搬运嫌疑。
        transaction
          .objectStore("video_observations")
          .createIndex("by-video", "videoKey");
      }
      if (oldVersion < 5) {
        // 旧版本数据库可能还有这个仓库；新装的库没有。升级时删掉。
        // objectStoreNames 是 DOMStringList：只有 length 与索引访问，
        // 没有数组的 includes 之类方法（真实浏览器同样如此，用 .includes()
        // 会在升级时抛 TypeError，整个库打不开）。
        // 两处 as 断言绕开 DBSchema 的收窄：迁移代码要处理的恰恰是
        // 「当前类型声明里已经没有这个 store」的情形。
        const names = database.objectStoreNames as unknown as DOMStringList;
        let hasAssessments = false;
        for (let index = 0; index < names.length; index += 1) {
          if (names[index] === "assessments") {
            hasAssessments = true;
            break;
          }
        }
        if (hasAssessments) {
          (database.deleteObjectStore as (name: string) => void)("assessments");
        }
      }
      if (oldVersion < 6) {
        deleteStoreIfPresent(database, "feedback");
      }
    },
  });
  return databasePromise;
}

/**
 * 反查一批 BV 号分别被哪些账号观察过（搬运检测用）。
 *
 * 记录 ID 为 `${accountKey}:${videoKey}`，同一 BV 出现在多个账号名下会
 * 各自成条，因此一个 BV 对应多个账号即「不同 UP 发了同一个视频」。
 *
 * @param videoKeys BV 号清单（去重后传入）
 * @returns BV 号 → 观察过它的账号清单（不含查询方自身也可，由调用方过滤）
 */
export async function getAccountsByVideoKeys(
  videoKeys: readonly string[],
): Promise<Map<string, AccountKey[]>> {
  const unique = [...new Set(videoKeys)].filter((key) => key !== "");
  const result = new Map<string, AccountKey[]>();
  if (unique.length === 0) {
    return result;
  }
  const database = await getDatabase();
  const store = database
    .transaction("video_observations", "readonly")
    .objectStore("video_observations");
  const index = store.index("by-video");
  for (const videoKey of unique) {
    const records = await index.getAll(IDBKeyRange.only(videoKey));
    const accounts = [
      ...new Set(records.map((record) => record.accountKey)),
    ];
    if (accounts.length > 0) {
      result.set(videoKey, accounts);
    }
  }
  return result;
}

/**
 * 写入一次观察并返回合并后的最新画像与全部投稿记录。
 *
 * @param observation 待写入的账号观察批次
 * @param maxVideosPerAccount 每账号保留上限（超出时裁掉最旧的）
 */
export async function ingestObservation(
  observation: AccountObservationInput,
  maxVideosPerAccount: number,
): Promise<{
  profile: AccountProfileRecord;
  videos: VideoObservationRecord[];
}> {
  const database = await getDatabase();
  // 账号资料与视频写在同一事务里，保证原子性。
  const transaction = database.transaction(
    ["account_profiles", "video_observations"],
    "readwrite",
  );
  const profiles = transaction.objectStore("account_profiles");
  const videos = transaction.objectStore("video_observations");
  const previousProfile = await profiles.get(observation.accountKey);
  // 观察输入与存储记录的名片字段名不同（profileFollowers vs followers），
  // 先归一化成记录形态，后续稀疏合并才能同时兼容输入与历史记录。
  const incomingCard = extractCardFields(observation);
  // 按观察时间判定谁是较新数据；乱序到达时旧观察不会覆盖新画像。
  const incomingProfileIsNewest =
    previousProfile === undefined ||
    observation.observedAtMs >= previousProfile.lastSeenAtMs;
  const newestProfile = incomingProfileIsNewest
    ? observation
    : previousProfile;
  const olderProfile = incomingProfileIsNewest
    ? previousProfile
    : observation;
  const newestCard = incomingProfileIsNewest ? incomingCard : previousProfile;
  const olderCard = incomingProfileIsNewest ? previousProfile : incomingCard;
  // 稀疏字段合并：较新数据缺字段时用较旧数据的值补上。
  const displayName =
    newestProfile.displayName ?? olderProfile?.displayName;
  const profileBio = newestProfile.profileBio ?? olderProfile?.profileBio;
  // 名片字段同样做稀疏合并：某次补全失败不应把上次拿到的粉丝数抹掉。
  // 名片数据变化不快，「新数据优先、缺失时保留旧值」即可。
  const followers = newestCard?.followers ?? olderCard?.followers;
  const archiveCount = newestCard?.archiveCount ?? olderCard?.archiveCount;
  const cardFetched = newestCard?.cardFetched ?? olderCard?.cardFetched;
  const officialVerifyType =
    newestCard?.officialVerifyType ?? olderCard?.officialVerifyType;
  const profile: AccountProfileRecord = {
    accountKey: observation.accountKey,
    uid: newestProfile.uid,
    profileUrl: newestProfile.profileUrl,
    ...(displayName === undefined ? {} : { displayName }),
    ...(profileBio === undefined ? {} : { profileBio }),
    ...(followers === undefined ? {} : { followers }),
    ...(archiveCount === undefined ? {} : { archiveCount }),
    ...(cardFetched === undefined ? {} : { cardFetched }),
    ...(officialVerifyType === undefined ? {} : { officialVerifyType }),
    firstSeenAtMs: Math.min(
      previousProfile?.firstSeenAtMs ?? observation.observedAtMs,
      observation.observedAtMs,
    ),
    lastSeenAtMs: Math.max(
      previousProfile?.lastSeenAtMs ?? observation.observedAtMs,
      observation.observedAtMs,
    ),
  };
  await profiles.put(profile);

  for (const video of observation.videos) {
    // 记录 ID 由账号 + 视频键构成，重复观察天然命中同一条记录。
    const id = `${observation.accountKey}:${video.videoKey}`;
    const previous = await videos.get(id);
    const incomingVideoIsNewest =
      previous === undefined || video.observedAtMs >= previous.lastSeenAtMs;
    const newestVideo = incomingVideoIsNewest ? video : previous;
    const olderVideo = incomingVideoIsNewest ? previous : video;
    const coverUrl = newestVideo.coverUrl ?? olderVideo?.coverUrl;
    const publishedText =
      newestVideo.publishedText ?? olderVideo?.publishedText;
    const publishedAtMs =
      newestVideo.publishedAtMs ?? olderVideo?.publishedAtMs;
    // 统计原文去重合并（较新数据优先），并裁剪到有界数量。
    const metricsRaw = incomingVideoIsNewest
      ? mergeUniqueStrings(previous?.metricsRaw ?? [], video.metricsRaw)
      : mergeUniqueStrings(video.metricsRaw, previous?.metricsRaw ?? []);
    const record: StoredVideoObservation = {
      ...newestVideo,
      id,
      accountKey: observation.accountKey,
      ...(coverUrl === undefined ? {} : { coverUrl }),
      ...(publishedText === undefined ? {} : { publishedText }),
      ...(publishedAtMs === undefined ? {} : { publishedAtMs }),
      metricsRaw,
      firstSeenAtMs: Math.min(
        previous?.firstSeenAtMs ?? video.observedAtMs,
        video.observedAtMs,
      ),
      lastSeenAtMs: Math.max(
        previous?.lastSeenAtMs ?? video.observedAtMs,
        video.observedAtMs,
      ),
      // 每被重新观察到一次计数加一，作为「反复出现」的弱证据。
      seenCount: (previous?.seenCount ?? 0) + 1,
    };
    await videos.put(record);
  }

  await transaction.done;
  // 事务提交后按上限裁剪，避免单个账号无限增长。
  await pruneAccountVideos(observation.accountKey, maxVideosPerAccount);

  return {
    profile,
    videos: await getVideosForAccount(observation.accountKey),
  };
}

/**
 * 读取某账号的全部投稿观察（按最近观察时间降序）。
 * @returns 记录列表（剥掉内部主键字段）
 */
export async function getVideosForAccount(
  accountKey: AccountKey,
): Promise<VideoObservationRecord[]> {
  const database = await getDatabase();
  const records = await database.getAllFromIndex(
    "video_observations",
    "by-account",
    accountKey,
  );
  return records
    .sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs)
    .map(({ id: _id, ...record }) => record);
}

/** 统计累计观察过的账号数量。 */
export async function countObservedAccounts(): Promise<number> {
  const database = await getDatabase();
  return database.count("account_profiles");
}

/** 读取账号资料记录。 */
export async function getProfile(
  accountKey: AccountKey,
): Promise<AccountProfileRecord | undefined> {
  const database = await getDatabase();
  return database.get("account_profiles", accountKey);
}

/** 写入（覆盖）一条 AI 判定结论。 */
export async function putAiReview(review: AiReviewRecord): Promise<void> {
  const database = await getDatabase();
  await database.put("ai_reviews", review);
}

/** 读取某账号最近一次 AI 判定结论。 */
export async function getAiReview(
  accountKey: AccountKey,
): Promise<AiReviewRecord | undefined> {
  const database = await getDatabase();
  return database.get("ai_reviews", accountKey);
}

/**
 * 读取未过期的 AI 判定结论。
 * @returns 结论存在且在保鲜期内时返回，否则 undefined
 */
export async function getFreshAiReview(
  accountKey: AccountKey,
): Promise<AiReviewRecord | undefined> {
  const review = await getAiReview(accountKey);
  if (review === undefined) {
    return undefined;
  }
  return Date.now() - review.reviewedAtMs <= AI_REVIEW_TTL_MS
    ? review
    : undefined;
}

/** 追加一条 AI 审计记录并按上限裁剪旧记录。 */
export async function addAiAuditEntry(entry: AiAuditEntry): Promise<void> {
  const database = await getDatabase();
  await database.put("ai_audit", entry);
  await trimByKeyOrder("ai_audit", AI_AUDIT_LIMIT);
}

/** 读取 AI 审计（按时间降序）。 */
export async function getAiAudit(): Promise<AiAuditEntry[]> {
  const database = await getDatabase();
  const records = await database.getAll("ai_audit");
  return records.sort((left, right) => right.createdAtMs - left.createdAtMs);
}

/**
 * 按记录内时间字段裁剪数量上限。
 * ai_audit 按 createdAtMs 排序删除最旧记录。
 */
async function trimByKeyOrder(
  storeName: "ai_audit",
  limit: number,
): Promise<void> {
  const database = await getDatabase();
  const records = await database.getAll(storeName);
  if (records.length <= limit) {
    return;
  }
  const stale = records
    .sort((left, right) => right.createdAtMs - left.createdAtMs)
    .slice(limit);
  const transaction = database.transaction(storeName, "readwrite");
  await Promise.all(
    stale.map((record) => transaction.objectStore(storeName).delete(record.id)),
  );
  await transaction.done;
}

/**
 * 导出全部观察数据（用户数据所有权）。
 * 内容包含标题与简介等敏感字段，调用方必须先取得用户显式确认。
 */
export async function buildObservationExport(): Promise<ObservationExportV1> {
  const database = await getDatabase();
  const [profiles, videos] = await Promise.all([
    database.getAll("account_profiles"),
    database.getAll("video_observations"),
  ]);
  return {
    formatVersion: 1,
    exportedAtMs: Date.now(),
    profiles,
    videos: videos.map(({ id: _id, ...record }) => record),
  };
}

/**
 * 删除保留期限之外的过期数据。
 *
 * 视频按 last-seen 索引游标删除；没有视频残留的账号连同评估缓存一起删除。
 * 在同一事务中执行，保证三者一致。
 *
 * @param cutoffMs 截止时间戳，早于该值的记录视为过期
 */
export async function pruneExpiredObservations(cutoffMs: number): Promise<void> {
  const database = await getDatabase();
  const transaction = database.transaction(
    ["account_profiles", "video_observations", "ai_reviews"],
    "readwrite",
  );
  const videos = transaction
    .objectStore("video_observations")
    .index("by-last-seen");
  let cursor = await videos.openCursor(IDBKeyRange.upperBound(cutoffMs, true));
  while (cursor !== null) {
    await cursor.delete();
    cursor = await cursor.continue();
  }

  const profiles = transaction.objectStore("account_profiles");
  for (const profile of await profiles.getAll()) {
    if (profile.lastSeenAtMs < cutoffMs) {
      await profiles.delete(profile.accountKey);
    }
  }

  // AI 判定结论随观察一同过期：账号不再被观察时结论失去意义。
  const aiReviews = transaction.objectStore("ai_reviews");
  for (const review of await aiReviews.getAll()) {
    if (review.reviewedAtMs < cutoffMs) {
      await aiReviews.delete(review.accountKey);
    }
  }
  await transaction.done;
}

/** 有界去重合并两段字符串列表，保留最新的尾部至多 24 条。 */
function mergeUniqueStrings(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])].slice(-24);
}

/** 清空观察数据库（「重置插件」功能使用），含 AI 结论与审计。 */
export async function clearObservationDatabase(): Promise<void> {
  const database = await getDatabase();
  const transaction = database.transaction(
    [
      "account_profiles",
      "video_observations",
      "ai_reviews",
      "ai_audit",
    ],
    "readwrite",
  );
  await Promise.all([
    transaction.objectStore("account_profiles").clear(),
    transaction.objectStore("video_observations").clear(),
    transaction.objectStore("ai_reviews").clear(),
    transaction.objectStore("ai_audit").clear(),
  ]);
  await transaction.done;
}

/** 只清空判定日志。不影响已缓存的 AI 结论。 */
export async function clearAiAudit(): Promise<void> {
  const database = await getDatabase();
  await database.clear("ai_audit");
}

/** 清空观察账号、投稿和已缓存的 AI 结论。判定日志、设置和名单不动。 */
export async function clearObservedAccounts(): Promise<void> {
  const database = await getDatabase();
  const transaction = database.transaction(
    ["account_profiles", "video_observations", "ai_reviews"],
    "readwrite",
  );
  await Promise.all([
    transaction.objectStore("account_profiles").clear(),
    transaction.objectStore("video_observations").clear(),
    transaction.objectStore("ai_reviews").clear(),
  ]);
  await transaction.done;
}

/**
 * 裁剪单个账号的投稿数量：保留最近观察的 maximum 条，删除其余。
 */
async function pruneAccountVideos(
  accountKey: AccountKey,
  maximum: number,
): Promise<void> {
  const database = await getDatabase();
  const records = await database.getAllFromIndex(
    "video_observations",
    "by-account",
    accountKey,
  );
  const stale = records
    .sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs)
    .slice(maximum);
  const transaction = database.transaction("video_observations", "readwrite");
  await Promise.all(
    stale.map((record) =>
      transaction.objectStore("video_observations").delete(record.id),
    ),
  );
  await transaction.done;
}

/** 名片相关字段（存储记录形态）。 */
type CardFields = Pick<
  AccountProfileRecord,
  "followers" | "archiveCount" | "cardFetched" | "officialVerifyType"
>;

/**
 * 从观察输入提取名片字段，转成存储记录用的字段名。
 *
 * 输入用 `profileFollowers` 等前缀（与页面字段区分），存储记录用 `followers`
 * 等短名。未开启补全时这些字段全部缺省，函数返回空对象，
 * 行为与加这个功能之前完全一致。
 */
function extractCardFields(
  observation: AccountObservationInput,
): CardFields {
  return {
    ...(observation.profileFollowers === undefined
      ? {}
      : { followers: observation.profileFollowers }),
    ...(observation.profileArchiveCount === undefined
      ? {}
      : { archiveCount: observation.profileArchiveCount }),
    ...(observation.profileCardFetched === undefined
      ? {}
      : { cardFetched: observation.profileCardFetched }),
    ...(observation.profileOfficialVerifyType === undefined
      ? {}
      : { officialVerifyType: observation.profileOfficialVerifyType }),
  };
}
