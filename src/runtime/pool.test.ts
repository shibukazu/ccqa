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

  test("a throwing fn rejects the whole pool and stops launching the rest", async () => {
    // On the live path each queued item is another paid Claude session, so a
    // pool that is going to reject must not keep starting them.
    const started: number[] = [];
    await expect(
      runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("boom");
        await delay(10);
        return n;
      }),
    ).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
  });

  test("an fn that throws synchronously rejects rather than spinning", async () => {
    // The body is registered before it can delete itself; inline, a sync throw
    // would delete an entry that was never set and the pool would never settle.
    await expect(
      runPool([1, 2], 1, ((n: number) => {
        if (n === 1) throw new Error("sync boom");
        return Promise.resolve(n);
      }) as (n: number) => Promise<number>),
    ).rejects.toThrow("sync boom");
  });

  test("two failures are reported together, not decided by timing", async () => {
    const err = await runPool([1, 2], 2, async (n) => {
      throw new Error(`boom-${n}`);
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual([
      "boom-1",
      "boom-2",
    ]);
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

  describe("shared resources", () => {
    /** Records what overlapped with what — the only thing exclusion is about. */
    function tracker() {
      const running = new Set<string>();
      const overlaps: [string, string][] = [];
      let peak = 0;
      return {
        overlaps,
        peak: () => peak,
        async run(name: string): Promise<string> {
          for (const other of running) overlaps.push([name, other]);
          running.add(name);
          peak = Math.max(peak, running.size);
          await delay(5);
          running.delete(name);
          return name;
        },
      };
    }

    test("items sharing a name never overlap; the rest still parallelise", async () => {
      // The failure this prevents does not look like a failure: two specs
      // posting to the same channel at once assert on each other's post.
      const t = tracker();
      const items = [
        { name: "post-1", res: ["channel"] },
        { name: "post-2", res: ["channel"] },
        { name: "read-1", res: [] },
        { name: "post-3", res: ["channel"] },
      ];
      await runPool(items, 4, (i) => t.run(i.name), { resources: (i) => i.res });

      const channel = new Set(["post-1", "post-2", "post-3"]);
      for (const [a, b] of t.overlaps) {
        expect(channel.has(a) && channel.has(b), `${a} overlapped ${b}`).toBe(false);
      }
      // And the point of the exercise: something did run alongside them.
      expect(t.peak()).toBeGreaterThan(1);
    });

    test("an item held up by a busy resource still runs once it frees", async () => {
      // A worker that finds nothing runnable must not retire, or the item it
      // was waiting on is never picked up.
      const t = tracker();
      const items = [
        { name: "a", res: ["x"] },
        { name: "b", res: ["x"] },
        { name: "c", res: ["x"] },
      ];
      expect(await runPool(items, 3, (i) => t.run(i.name), { resources: (i) => i.res }))
        .toEqual(["a", "b", "c"]);
      expect(t.peak()).toBe(1);
    });

    test("an item needing two names waits for both", async () => {
      const t = tracker();
      const items = [
        { name: "channel-only", res: ["channel"] },
        { name: "inbox-only", res: ["inbox"] },
        { name: "both", res: ["channel", "inbox"] },
      ];
      await runPool(items, 3, (i) => t.run(i.name), { resources: (i) => i.res });
      for (const [a, b] of t.overlaps) {
        expect(a === "both" || b === "both", `${a} overlapped ${b}`).toBe(false);
      }
    });
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
