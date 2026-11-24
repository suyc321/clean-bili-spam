/**
 * 页面级扫描统计。
 *
 * 统计口径必须按「整页已见卡片集合」算，而不是按单轮扫描的候选子集算：
 *
 * - 增量扫描只处理新出现的卡片。拿这一小批算健康度，一张解析不出 UID 的
 *   卡片就会变成「1/1 = 100% 失败」，把整页误判成适配器降级，同批里能正常
 *   解析的卡片也会被一起冻结；
 * - 强制全量重扫会再次经过同一批卡片。每轮累加计数会让弹出页的
 *   「已扫描 N 个视频」随重扫次数虚高。
 *
 * 因此调用方统一把 `renderedCards`（按元素去重、路由变化时清空）交进来。
 */
import type { ExtractedCard } from "../adapters/contract";

export interface PageCardStats {
  /** 本页已见（去重后）的卡片总数。 */
  scannedCards: number;
  /** 其中解析不出稳定账号身份的卡片数。 */
  unresolvedCards: number;
  /** 整页健康度：没有卡片，或过半卡片解析不出身份时为 degraded。 */
  health: "healthy" | "degraded";
}

/**
 * 汇总整页卡片。
 *
 * 阈值与原适配器的判定一致（严格大于 50%）：一半卡片解析失败仍算健康，
 * 超过一半才认为页面结构可能改版。
 */
export function summarizePageCards(
  cards: Iterable<ExtractedCard>,
): PageCardStats {
  let scannedCards = 0;
  let unresolvedCards = 0;
  for (const card of cards) {
    scannedCards += 1;
    if (card.accountKey === undefined) {
      unresolvedCards += 1;
    }
  }
  return {
    scannedCards,
    unresolvedCards,
    health:
      scannedCards === 0 || unresolvedCards / scannedCards > 0.5
        ? "degraded"
        : "healthy",
  };
}
