/**
 * 拉黑记录：本地审计与「已拉黑」状态来源。
 *
 * 只存 chrome.storage.local（不碰 IndexedDB）：拉黑是平台动作，
 * 本地只需要「什么时候拉黑了谁、由哪次判定触发」，用于面板显示状态、
 * 设置页审计，以及误拉黑后快速定位。上限 200 条，超出丢最旧。
 */
import type { AccountKey, BlockedEntry } from "../domain/types";

/** 本地存储键。 */
export const BLOCKED_STORAGE_KEY = "kcf:blocked:v1";

/** 拉黑记录类型定义在 domain 层；这里保留 re-export，兼容既有导入。 */
export type { BlockedEntry };

/** 读取全部拉黑记录（按时间降序，最近在前）。 */
export async function getBlockedAccounts(): Promise<BlockedEntry[]> {
  const stored = await chrome.storage.local.get(BLOCKED_STORAGE_KEY);
  const entries = stored[BLOCKED_STORAGE_KEY];
  return Array.isArray(entries) ? (entries as BlockedEntry[]) : [];
}

/** 查询某账号是否处于已拉黑状态。 */
export async function isBlocked(accountKey: AccountKey): Promise<boolean> {
  const entries = await getBlockedAccounts();
  return entries.some((entry) => entry.accountKey === accountKey);
}

/**
 * 写入一条拉黑记录（幂等：同一账号重复拉黑只更新时间与上下文）。
 * @returns 写入后的完整列表
 */
export async function addBlockedAccount(
  entry: BlockedEntry,
): Promise<BlockedEntry[]> {
  const entries = await getBlockedAccounts();
  const merged = [
    entry,
    ...entries.filter((item) => item.accountKey !== entry.accountKey),
  ].slice(0, BLOCKED_LIMIT);
  await chrome.storage.local.set({ [BLOCKED_STORAGE_KEY]: merged });
  return merged;
}

/** 移除一条拉黑记录（取消拉黑后调用，让面板状态回到可再次判定）。 */
export async function removeBlockedAccount(
  accountKey: AccountKey,
): Promise<BlockedEntry[]> {
  const entries = await getBlockedAccounts();
  const merged = entries.filter((item) => item.accountKey !== accountKey);
  await chrome.storage.local.set({ [BLOCKED_STORAGE_KEY]: merged });
  return merged;
}

/**
 * 清空全部拉黑记录（「重置插件」使用）。
 *
 * 拉黑记录不在 local-state 的 STORAGE_KEYS 里，必须单独清除；否则重置后
 * 面板仍会把账号显示成「已拉黑」，与「重置插件」的语义不符。
 */
export async function clearBlockedAccounts(): Promise<void> {
  await chrome.storage.local.remove(BLOCKED_STORAGE_KEY);
}

/** 拉黑记录上限：超出丢弃最旧的。 */
const BLOCKED_LIMIT = 200;
