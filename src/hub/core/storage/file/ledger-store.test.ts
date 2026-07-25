import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SpecLedger, SpecLedgerEntry } from "../../../contract/schema.ts";
import { createFileSpecLedgerStore } from "./ledger-store.ts";
import { ledgerPath } from "./paths.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ccqa-ledger-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<SpecLedgerEntry> = {}): SpecLedgerEntry {
  return { gitHead: "a", runId: "r", at: "2026-07-21T00:00:00Z", deployedSha: null, ...overrides };
}

/** Only the named buckets; the rest stay empty. */
function ledger(buckets: Partial<SpecLedger>): SpecLedger {
  return { green: {}, run: {}, red: {}, ...buckets };
}

describe("file spec ledger store", () => {
  test("merge only advances, per bucket: an older run cannot move a baseline backwards", async () => {
    const store = createFileSpecLedgerStore(dir);
    const newer = entry({ gitHead: "new", runId: "r2", at: "2026-07-22T00:00:00Z" });
    const older = entry({ gitHead: "old", runId: "r1", at: "2026-07-21T00:00:00Z" });
    await store.merge("p", "default", "main", ledger({ green: { "f/s": newer }, run: { "f/s": newer } }));
    await store.merge(
      "p",
      "default",
      "main",
      ledger({ green: { "f/s": older, "f/other": older }, run: { "f/s": older, "f/other": older } }),
    );

    const stored = await store.get("p", "default", "main");
    expect(stored.green["f/s"]?.gitHead).toBe("new"); // late-arriving older run ignored
    expect(stored.run["f/s"]?.gitHead).toBe("new");
    expect(stored.green["f/other"]?.gitHead).toBe("old"); // new key still lands
  });

  test("a legacy flat document reads as the green bucket, and the next merge rewrites it in place", async () => {
    const path = ledgerPath(dir, "p", "default", "main");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ "f/legacy": { gitHead: "old", runId: "r0", at: "2026-07-20T00:00:00Z" } }));

    const store = createFileSpecLedgerStore(dir);
    expect((await store.get("p", "default", "main")).green["f/legacy"]?.gitHead).toBe("old");
    expect((await store.get("p", "default", "main")).run).toEqual({});

    const added = entry({ gitHead: "new", runId: "r1", at: "2026-07-22T00:00:00Z" });
    await store.merge("p", "default", "main", ledger({ run: { "f/added": added }, red: { "f/added": added } }));
    const stored = await store.get("p", "default", "main");
    expect(stored.green["f/legacy"]?.gitHead).toBe("old"); // migration keeps the old greens
    expect(stored.red["f/added"]?.gitHead).toBe("new");
  });

  test("getMerged unions every branch of a profile, newest `at` winning", async () => {
    const store = createFileSpecLedgerStore(dir);
    await store.merge(
      "p",
      "default",
      "main",
      ledger({ run: { "f/s": entry({ gitHead: "main-sha", at: "2026-07-21T00:00:00Z" }) } }),
    );
    await store.merge(
      "p",
      "default",
      "feat/x",
      ledger({
        run: {
          "f/s": entry({ gitHead: "pr-sha", at: "2026-07-22T00:00:00Z" }),
          "f/only-pr": entry({ gitHead: "pr-sha", at: "2026-07-22T00:00:00Z" }),
        },
      }),
    );

    const merged = await store.getMerged("p", "default");
    expect(merged.run["f/s"]?.gitHead).toBe("pr-sha");
    expect(merged.run["f/only-pr"]?.gitHead).toBe("pr-sha");
    // ...while the per-branch view stays isolated.
    expect((await store.get("p", "default", "main")).run["f/only-pr"]).toBeUndefined();
  });

  test("branch names with slashes map to distinct flat files", async () => {
    const store = createFileSpecLedgerStore(dir);
    await store.merge("p", "default", "feat/x", ledger({ green: { "f/s": entry() } }));
    expect((await store.get("p", "default", "feat/x")).green).toHaveProperty("f/s");
    expect((await store.get("p", "default", "feat")).green).toEqual({});
    expect((await store.get("p", "default", "x")).green).toEqual({});
  });

  test("a long multibyte branch name (3x percent-encode expansion) round-trips", async () => {
    const store = createFileSpecLedgerStore(dir);
    // 100 CJK chars → ~900 encoded chars, far past the 255-byte filename
    // limit; the path builder must hash-truncate, and two branches sharing a
    // long prefix must still map to distinct files.
    const long = "機能".repeat(50);
    const sibling = `${long}別`;
    await store.merge("p", "default", long, ledger({ green: { "f/s": entry({ gitHead: "a" }) } }));
    await store.merge("p", "default", sibling, ledger({ green: { "f/s": entry({ gitHead: "b" }) } }));
    expect((await store.get("p", "default", long)).green["f/s"]?.gitHead).toBe("a");
    expect((await store.get("p", "default", sibling)).green["f/s"]?.gitHead).toBe("b");
  });
});
