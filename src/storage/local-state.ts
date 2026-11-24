/**
 * 本地用户状态：设置与三类账号名单（白名单/忽略/待处理）的读写层。
 *
 * 数据保存在 chrome.storage.local，键均带 `kcf:` 前缀与版本号；
 * 读取时经 Zod 校验，损坏或缺失的数据回退为默认值而不是抛错。
 */
import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  MAX_JUDGMENT_CRITERIA_LENGTH,
  normalizeSettings,
} from "../domain/settings";
import type {
  AccountKey,
  CandidateEntry,
  ExportBundleV1,
  ExtensionSettings,
  IgnoreEntry,
  WhitelistEntry,
} from "../domain/types";

/** chrome.storage.local 的存储键（带版本号，便于未来迁移）。 */
const STORAGE_KEYS = {
  settings: "kcf:settings:v1",
  whitelist: "kcf:whitelist:v1",
  ignored: "kcf:ignored:v1",
  candidates: "kcf:candidates:v1",
} as const;

/** 账号主键校验。 */
const accountKeySchema = z.custom<AccountKey>(
  (value) => typeof value === "string" && /^uid:\d+$/u.test(value),
  "账号标识格式无效",
);

/**
 * 已从设置模型移除的键。旧的本地存储和导出文件里可能还在。
 * 读入前先丢掉，否则 strict 校验会失败，整份设置退回默认值，当前接口配置会一起丢。
 */
const RETIRED_SETTINGS_KEYS = [
  "aiFallbackEnabled",
  "aiFallbackEndpoint",
  "aiFallbackApiKey",
  "aiFallbackModel",
  "aiFallbackFormat",
] as const;

function withoutRetiredSettingsKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if ((RETIRED_SETTINGS_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    next[key] = entry;
  }
  return next;
}

function hasRetiredSettingsKeys(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const source = value as Record<string, unknown>;
  return RETIRED_SETTINGS_KEYS.some((key) => key in source);
}

/** 导入文件的 settings 里若还带着已移除字段，先丢掉再做 strict 校验。 */
function withoutRetiredSettingsInBundle(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const bundle = value as Record<string, unknown>;
  if (!("settings" in bundle)) {
    return value;
  }
  return {
    ...bundle,
    settings: withoutRetiredSettingsKeys(bundle.settings),
  };
}

// 字段全部可选：旧版本导出文件或旧本地数据缺少新增字段时仍可解析，
// 缺失与非法范围由 normalizeSettings 统一补默认值和裁剪。
const settingsSchema = z
  .object({
    showBadges: z.boolean().optional(),
    automaticallyDimHighRisk: z.boolean().optional(),
    feedAdMode: z.enum(["off", "cover", "remove"]).optional(),
    coverColor: z.enum(["dark", "light", "gray"]).optional(),
    // 旧版本布尔开关：仅用于向 feedAdMode 迁移，见 normalizeSettings。
    coverFeedAds: z.boolean().optional(),
    retentionDays: z.number().optional(),
    maxVideosPerAccount: z.number().optional(),
    showOnboarding: z.boolean().optional(),
    aiEnabled: z.boolean().optional(),
    aiEndpoint: z.string().max(2_000).optional(),
    aiApiKey: z.string().max(500).optional(),
    aiModel: z.string().max(200).optional(),
    aiFormat: z.enum(["openai_chat", "anthropic", "responses"]).optional(),
    aiJudgmentCriteria: z.string().max(MAX_JUDGMENT_CRITERIA_LENGTH).optional(),
    enrichAccountInfo: z.boolean().optional(),
    logAiExchange: z.boolean().optional(),
  })
  .strict();

const whitelistEntrySchema = z
  .object({
    accountKey: accountKeySchema,
    displayName: z.string().optional(),
    addedAtMs: z.number(),
  })
  .strict();

const ignoreEntrySchema = z
  .object({
    accountKey: accountKeySchema,
    // 昵称可选而不是必填：旧数据没有这个字段，而 readArray/parseArray 在
    // 校验失败时会把整个名单回退成空数组（用户会静默丢掉全部忽略设置）。
    displayName: z.string().optional(),
    ignoredAtMs: z.number(),
  })
  .strict();

const candidateEntrySchema = z
  .object({
    accountKey: accountKeySchema,
    uid: z.string().regex(/^\d+$/u),
    displayName: z.string().optional(),
    aiProbability: z.number().min(0).max(100).optional(),
    addedAtMs: z.number(),
  })
  .strict();

// 导入文件校验：名单数量设上限，防止恶意超大导入文件。
const exportBundleSchema = z
  .object({
    formatVersion: z.literal(1),
    exportedAtMs: z.number(),
    settings: settingsSchema,
    whitelist: z.array(whitelistEntrySchema).max(10_000),
    ignored: z.array(ignoreEntrySchema).max(10_000),
    candidates: z.array(candidateEntrySchema).max(10_000),
  })
  .strict();

/** 三类处置名单的集合形态。 */
type AccountDisposition = "whitelisted" | "ignored" | "candidate";

interface AccountDispositionLists {
  whitelist: WhitelistEntry[];
  ignored: IgnoreEntry[];
  candidates: CandidateEntry[];
}

/** 一次账号处置变更的输入。 */
export interface AccountDispositionChange {
  accountKey: AccountKey;
  uid: string;
  displayName?: string;
  /** 加入名单时的 AI 概率快照；未复核过则为空。 */
  aiProbability?: number;
  disposition: AccountDisposition;
  /** true=加入名单，false=从名单移除。 */
  selected: boolean;
}

/** 读取设置；存储缺失或损坏时返回出厂默认值。 */
export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const raw = result[STORAGE_KEYS.settings];
  const parsed = settingsSchema.safeParse(withoutRetiredSettingsKeys(raw));
  if (!parsed.success) {
    return DEFAULT_SETTINGS;
  }
  const settings = normalizeSettings(parsed.data);
  // 只在旧键还在磁盘上时写回。之后的读取不再改存储。
  if (hasRetiredSettingsKeys(raw)) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  }
  return settings;
}

/**
 * 合并式更新设置（部分补丁），归一化后写回。
 * @returns 归一化后的完整设置
 */
export async function patchSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const settings = normalizeSettings({ ...(await getSettings()), ...patch });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  return settings;
}

/** 读取白名单。 */
export async function getWhitelist(): Promise<WhitelistEntry[]> {
  return readArray(STORAGE_KEYS.whitelist, whitelistEntrySchema);
}

/** 读取忽略名单。 */
export async function getIgnored(): Promise<IgnoreEntry[]> {
  return readArray(STORAGE_KEYS.ignored, ignoreEntrySchema);
}

/** 读取待处理清单。 */
export async function getCandidates(): Promise<CandidateEntry[]> {
  return readArray(STORAGE_KEYS.candidates, candidateEntrySchema);
}

/**
 * 变更某账号的处置状态（三类名单互斥）。
 *
 * 先把该账号从三份名单中全部移除，再按 selected 决定是否写入目标名单，
 * 因此同一次写回后账号只会存在于至多一份名单中。
 *
 * @returns 写回后的三份名单
 */
export async function setAccountDisposition(
  change: AccountDispositionChange,
): Promise<AccountDispositionLists> {
  const current = await readDispositionLists();
  const next: AccountDispositionLists = {
    whitelist: current.whitelist.filter(
      (entry) => entry.accountKey !== change.accountKey,
    ),
    ignored: current.ignored.filter(
      (entry) => entry.accountKey !== change.accountKey,
    ),
    candidates: current.candidates.filter(
      (entry) => entry.accountKey !== change.accountKey,
    ),
  };

  if (change.selected) {
    const changedAtMs = Date.now();
    switch (change.disposition) {
      case "whitelisted":
        next.whitelist.push({
          accountKey: change.accountKey,
          ...(change.displayName === undefined
            ? {}
            : { displayName: change.displayName }),
          addedAtMs: changedAtMs,
        });
        break;
      case "ignored":
        // 昵称必须一起存：载荷里一直有 change.displayName，早期在这里被丢掉，
        // 导致设置页的忽略名单只能显示 "UID xxx"，用户认不出忽略过谁。
        next.ignored.push({
          accountKey: change.accountKey,
          ...(change.displayName === undefined
            ? {}
            : { displayName: change.displayName }),
          ignoredAtMs: changedAtMs,
        });
        break;
      case "candidate":
        next.candidates.push({
          accountKey: change.accountKey,
          uid: change.uid,
          ...(change.displayName === undefined
            ? {}
            : { displayName: change.displayName }),
          ...(change.aiProbability === undefined
            ? {}
            : { aiProbability: change.aiProbability }),
          addedAtMs: changedAtMs,
        });
        break;
    }
  }

  await writeDispositionLists(next);
  return next;
}

/**
 * 生成配置导出文件（设置 + 三份名单）。
 * 注意：默认不包含 IndexedDB 中的投稿观察记录；
 * 也不包含 AI 接口的 API Key（导出文件常会被人贴到 issue 或网盘里）。
 */
export async function createExportBundle(): Promise<ExportBundleV1> {
  const [settings, whitelist, ignored, candidates] = await Promise.all([
    getSettings(),
    getWhitelist(),
    getIgnored(),
    getCandidates(),
  ]);
  return {
    formatVersion: 1,
    exportedAtMs: Date.now(),
    settings: { ...settings, aiApiKey: "" },
    whitelist,
    ignored,
    candidates,
  };
}

/**
 * 导入配置文件：严格校验结构后归一化，整包覆盖本地名单与设置。
 * @throws z.ZodError 当文件结构不合法时抛出
 */
export async function importBundle(
  input: unknown,
): Promise<ExportBundleV1> {
  const bundle = exportBundleSchema.parse(withoutRetiredSettingsInBundle(input));
  const dispositions = normalizeDispositionLists(bundle);
  const importedSettings = normalizeSettings(bundle.settings);
  // 导出文件不含 API Key：导入文件里没有 Key 时保留本机已有的，避免导入一次就丢配置。
  const keptApiKey =
    importedSettings.aiApiKey === ""
      ? (await getSettings()).aiApiKey
      : importedSettings.aiApiKey;
  const normalized: ExportBundleV1 = {
    ...bundle,
    settings: { ...importedSettings, aiApiKey: keptApiKey },
    ...dispositions,
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: normalized.settings,
    [STORAGE_KEYS.whitelist]: normalized.whitelist,
    [STORAGE_KEYS.ignored]: normalized.ignored,
    [STORAGE_KEYS.candidates]: normalized.candidates,
  });
  return normalized;
}

/** 清除设置与三类处置名单（不含拉黑记录与 IndexedDB 观察库）。 */
export async function resetUserData(): Promise<void> {
  await chrome.storage.local.remove(Object.values(STORAGE_KEYS));
}

/** 读取并校验一个数组型存储键；损坏数据回退为空数组。 */
async function readArray<T>(
  key: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const result = await chrome.storage.local.get(key);
  const parsed = z.array(schema).safeParse(result[key]);
  return parsed.success ? parsed.data : [];
}

/** 一次性读取三份名单并做交叉归一化。 */
async function readDispositionLists(): Promise<AccountDispositionLists> {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.whitelist,
    STORAGE_KEYS.ignored,
    STORAGE_KEYS.candidates,
  ]);
  return normalizeDispositionLists({
    whitelist: parseArray(result[STORAGE_KEYS.whitelist], whitelistEntrySchema),
    ignored: parseArray(result[STORAGE_KEYS.ignored], ignoreEntrySchema),
    candidates: parseArray(
      result[STORAGE_KEYS.candidates],
      candidateEntrySchema,
    ),
  });
}

/** 三份名单一次性写回存储。 */
async function writeDispositionLists(
  lists: AccountDispositionLists,
): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.whitelist]: lists.whitelist,
    [STORAGE_KEYS.ignored]: lists.ignored,
    [STORAGE_KEYS.candidates]: lists.candidates,
  });
}

/**
 * 名单归一化：同账号去重（保留最后一条），
 * 并按「白名单 > 忽略 > 待处理」的优先级消除同一账号的交叉状态。
 */
function normalizeDispositionLists(
  lists: AccountDispositionLists,
): AccountDispositionLists {
  const whitelist = deduplicateByAccountKey(lists.whitelist);
  const whitelistKeys = new Set(
    whitelist.map((entry) => entry.accountKey),
  );
  const ignored = deduplicateByAccountKey(lists.ignored).filter(
    (entry) => !whitelistKeys.has(entry.accountKey),
  );
  const ignoredKeys = new Set(ignored.map((entry) => entry.accountKey));
  const candidates = deduplicateByAccountKey(lists.candidates).filter(
    (entry) =>
      !whitelistKeys.has(entry.accountKey) &&
      !ignoredKeys.has(entry.accountKey),
  );
  return { whitelist, ignored, candidates };
}

/** 按 accountKey 去重，后出现的条目覆盖先出现的。 */
function deduplicateByAccountKey<T extends { accountKey: AccountKey }>(
  entries: T[],
): T[] {
  const entriesByAccount = new Map<AccountKey, T>();
  for (const entry of entries) {
    entriesByAccount.set(entry.accountKey, entry);
  }
  return [...entriesByAccount.values()];
}

/** 解析数组；非法输入静默回退为空数组。 */
function parseArray<T>(input: unknown, schema: z.ZodType<T>): T[] {
  const parsed = z.array(schema).safeParse(input);
  return parsed.success ? parsed.data : [];
}
