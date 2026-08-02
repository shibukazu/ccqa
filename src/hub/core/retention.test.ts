import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Run } from "../contract/schema.ts";
import { emptyLedger } from "./spec-ledger.ts";
import { sweepRunRetention } from "./retention.ts";
import { createFileHubStorage } from "./storage/file/index.ts";
import type { HubStorage } from "./storage/types.ts";

describe("run retention", () => {
  let dataDir: string;
  let storage: HubStorage;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ccqa-hub-retention-"));
    storage = createFileHubStorage(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  function run(overrides: Partial<Run> & { id: string }): Run {
    return {
      project: "demo",
      profile: null,
      branch: "main",
      status: "passed",
      kind: "run",
      drift: null,
      specs: { total: 1, passed: 1, failed: 0 },
      gitHead: null,
      promptVersion: "1",
      ciRunId: null,
      reportCreatedAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      ...overrides,
    };
  }

  /** Store a run with the two things a sweep must take with it: evidence bytes and a grade. */
  async function store(r: Run): Promise<void> {
    await storage.runs.create(r);
    await storage.artifacts.putFile(r.id, "evidence/step-01.png", new Uint8Array([1, 2, 3]));
    await storage.triage.putActualCause(r.id, {
      feature: "demo",
      spec: "example",
      predicted: { label: "TEST_DRIFT", confidence: 0.9, headline: "selector moved" },
      actualCause: "PRODUCT_BUG",
      promptVersion: "1",
      recordedAt: r.createdAt,
    });
  }

  const newest = run({ id: "newest", createdAt: "2026-08-03T00:00:00.000Z" });

  test("keeps the newest N of one (project, branch), dropping the rest with their artifacts and grades", async () => {
    await store(run({ id: "oldest", createdAt: "2026-08-01T00:00:00.000Z" }));
    await store(run({ id: "middle", createdAt: "2026-08-02T00:00:00.000Z" }));
    await store(newest);
    // Neither of these is in the swept group, so both survive a cap of 1.
    await store(run({ id: "other-branch", branch: "feature/x", createdAt: "2026-08-01T00:00:00.000Z" }));
    await store(run({ id: "other-project", project: "second", createdAt: "2026-08-01T00:00:00.000Z" }));

    await sweepRunRetention(storage, newest, 1);

    expect(await storage.runs.get("oldest")).toBeNull();
    expect(await storage.artifacts.listFiles("oldest")).toEqual([]);
    expect(await storage.triage.list("oldest")).toEqual([]);
    expect(await storage.runs.get("middle")).toBeNull();

    const kept = await storage.runs.list({});
    expect(kept.map((r) => r.id).sort()).toEqual(["newest", "other-branch", "other-project"]);
  });

  test("a run still streaming results neither counts toward the cap nor gets evicted", async () => {
    await store(run({ id: "streaming", status: "running", createdAt: "2026-08-01T00:00:00.000Z" }));
    await store(newest);

    await sweepRunRetention(storage, newest, 1);

    expect(await storage.runs.get("streaming")).not.toBeNull();
    expect(await storage.runs.get("newest")).not.toBeNull();
  });

  test("a run the spec ledger points at is evicted like any other, and the entry survives it", async () => {
    // Deliberate: pinning referenced runs would pin the oldest ones forever
    // and grow with the spec count rather than with the cap. Nothing
    // dereferences the id — every field a verdict needs is denormalized onto
    // the entry — so the link is allowed to dangle, and the UI says the run is
    // no longer kept instead of erroring.
    const entry = { gitHead: "a".repeat(40), runId: "oldest", at: "2026-08-01T00:00:00.000Z" };
    await storage.ledger.merge("demo", "default", "main", { ...emptyLedger(), green: { "demo/example": entry } });
    await store(run({ id: "oldest", createdAt: "2026-08-01T00:00:00.000Z" }));
    await store(newest);

    await sweepRunRetention(storage, newest, 1);

    expect(await storage.runs.get("oldest")).toBeNull();
    const ledger = await storage.ledger.get("demo", "default", "main");
    expect(ledger.green["demo/example"]).toEqual(entry);
  });
});
