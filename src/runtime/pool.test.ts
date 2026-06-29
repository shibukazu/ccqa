import { describe, expect, test } from "vitest";
import { runPool } from "./pool.ts";

describe("runPool", () => {
  test("preserves input order regardless of completion order", async () => {
    // Item 0 resolves last, item 4 first — output must still be [0..4].
    const items = [0, 1, 2, 3, 4];
    const results = await runPool(items, 5, async (n) => {
      await delay((items.length - n) * 2);
      return n * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40]);
  });

  test("never runs more than `concurrency` items at once", async () => {
    let active = 0;
    let peak = 0;
    await runPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
    });
    expect(peak).toBe(3);
  });

  test("a throwing fn rejects the whole pool", async () => {
    await expect(
      runPool([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  test("treats concurrency < 1 as sequential", async () => {
    let active = 0;
    let peak = 0;
    await runPool([1, 2, 3], 0, async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(2);
      active--;
    });
    expect(peak).toBe(1);
  });

  test("empty input is a no-op", async () => {
    expect(await runPool([], 4, async () => 1)).toEqual([]);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
