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
    seen.add(accountKey);
    pending.push(accountKey);
  }
  return pending;
}
