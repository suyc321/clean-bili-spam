/**
 * 从本轮新见到的账号里挑出还没有 AI 结论、也没在队列里的，供自动判定。
 */
import type { AccountAnalysis, AccountKey } from "../domain/types";

export function accountsNeedingAutoReview(
  candidates: readonly AccountKey[],
  analyses: ReadonlyMap<AccountKey, AccountAnalysis>,
  excluded: ReadonlySet<AccountKey>,
): AccountKey[] {
  const seen = new Set<AccountKey>();
  const pending: AccountKey[] = [];
  for (const accountKey of candidates) {
    if (seen.has(accountKey) || excluded.has(accountKey)) {
      continue;
    }
    const analysis = analyses.get(accountKey);
    if (analysis === undefined || analysis.review.kind === "ai") {
      continue;
    }
    // 用户已经明确处置过的账号不再自动花钱：
    // 白名单表示「这是正常账号」，忽略表示「不想再看到提示」。
    // 待处理（candidate）保留自动判定：用户只是标记稍后人工复核，
    // AI 结论仍然是有效的辅助信息。
    if (
      analysis.disposition === "whitelisted" ||
      analysis.disposition === "ignored"
    ) {
      continue;
    }
    seen.add(accountKey);
    pending.push(accountKey);
  }
  return pending;
}
