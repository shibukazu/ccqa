import { describe, expect, test } from "vitest";
import type { SpecLocks } from "../contract/schema.ts";
import { acquire, emptyLocks, heldBy, releaseAll } from "./locks.ts";

const NOW = new Date("2026-07-26T00:00:00Z");
const LATER = new Date("2026-07-26T02:00:00Z");

function held(holder: string, expiresAt: string): SpecLocks {
  return { specs: { "f/s": { kind: "run", holder, expiresAt } } };
}

describe("spec claims", () => {
  test("a free spec is granted, and a spec another job holds is denied", () => {
    const taken = acquire(emptyLocks(), {
      specs: ["f/a", "f/b"], kind: "run", holder: "job-1", ttlSeconds: 60, now: NOW,
    });
    expect(taken.granted).toEqual(["f/a", "f/b"]);

    const second = acquire(taken.locks, {
      specs: ["f/a", "f/c"], kind: "run", holder: "job-2", ttlSeconds: 60, now: NOW,
    });
    // Denial is the answer, not an error: the second job skips what the first
    // is on and takes the rest.
    expect(second.denied).toEqual(["f/a"]);
    expect(second.granted).toEqual(["f/c"]);
  });

  test("a lapsed hold is free again, with no reaper having run", () => {
    // The job that took it died. Nothing swept the document — the expiry is
    // compared on read, which is what makes a crash self-healing.
    const stale = held("dead-job", "2026-07-26T00:30:00Z");
    expect(heldBy(stale, "f/s", LATER)).toBeNull();
    expect(
      acquire(stale, { specs: ["f/s"], kind: "run", holder: "job-2", ttlSeconds: 60, now: LATER }).granted,
    ).toEqual(["f/s"]);
  });

  test("re-asking extends the holder's own claim", () => {
    // How a job that outlives its TTL keeps its specs.
    const first = acquire(emptyLocks(), {
      specs: ["f/s"], kind: "run", holder: "job-1", ttlSeconds: 60, now: NOW,
    });
    const again = acquire(first.locks, {
      specs: ["f/s"], kind: "run", holder: "job-1", ttlSeconds: 60, now: LATER,
    });
    expect(again.granted).toEqual(["f/s"]);
    expect(again.locks.specs["f/s"]!.expiresAt).toBe("2026-07-26T02:01:00.000Z");
  });

  test("a release only drops what that job holds", () => {
    // A late release from a job whose hold already lapsed must not take away
    // the claim the next job has since acquired.
    const other = held("job-2", "2026-07-26T03:00:00Z");
    expect(releaseAll(other, "job-1")).toEqual(other);
    expect(releaseAll(other, "job-2").specs).toEqual({});
  });
});
