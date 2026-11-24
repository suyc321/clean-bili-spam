import { describe, expect, it } from "vitest";
import { forEachConcurrent } from "../src/background/concurrency";

describe("固定并发工作池", () => {
  it("同时运行的任务不超过上限，且每个任务只执行一次", async () => {
    const items = Array.from({ length: 10 }, (_, index) => index);
    const seen: number[] = [];
    let active = 0;
    let peak = 0;

    await forEachConcurrent(items, 3, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      seen.push(item);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect([...seen].sort((left, right) => left - right)).toEqual(items);
  });

  it("空列表直接完成", async () => {
    await expect(
      forEachConcurrent([], 4, async () => undefined),
    ).resolves.toBeUndefined();
  });

  it("非法上限按 1 处理", async () => {
    let active = 0;
    let peak = 0;
    await forEachConcurrent([1, 2, 3], 0, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    });
    expect(peak).toBe(1);
  });
});
