import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Run } from "../../../contract/schema.ts";
import type { HubStorage, TriageRecord } from "../types.ts";
import { createFileHubStorage } from "./index.ts";

/**
 * Tests target the `HubStorage` interface, not file-specific internals, so
 * a future backend (SQLite, a remote DB) can run this same suite against
 * its own `createXStorage` and inherit the coverage.
 */
describe("HubStorage (file backend)", () => {
  let dataDir: string;
  let storage: HubStorage;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ccqa-hub-storage-"));
    storage = createFileHubStorage(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("runs", () => {
    function run(overrides: Partial<Run> = {}): Run {
      return {
        id: "run-1",
        project: "demo",
        profile: null,
        branch: null,
        status: "passed",
        specs: { total: 1, passed: 1, failed: 0 },
        gitHead: null,
        promptVersion: "1",
        ciRunId: null,
        reportCreatedAt: "2026-07-02T00:00:00.000Z",
        createdAt: "2026-07-02T00:00:00.000Z",
        ...overrides,
      };
    }

    test("create/get round-trip", async () => {
      await storage.runs.create(run());
      expect(await storage.runs.get("run-1")).toEqual(run());
    });

    test("list filters by project and status", async () => {
      await storage.runs.create(run({ id: "a", project: "demo", status: "passed" }));
      await storage.runs.create(run({ id: "b", project: "demo", status: "failed" }));
      await storage.runs.create(run({ id: "c", project: "other", status: "passed" }));

      const demoPassed = await storage.runs.list({ project: "demo", status: "passed" });
      expect(demoPassed.map((r) => r.id)).toEqual(["a"]);
    });

    test("list filters by branch", async () => {
      await storage.runs.create(run({ id: "a", project: "demo", branch: "main" }));
      await storage.runs.create(run({ id: "b", project: "demo", branch: "feature" }));

      const mainOnly = await storage.runs.list({ project: "demo", branch: "main" });
      expect(mainOnly.map((r) => r.id)).toEqual(["a"]);
    });

    test("listProjects returns distinct project names, sorted", async () => {
      await storage.runs.create(run({ id: "a", project: "other" }));
      await storage.runs.create(run({ id: "b", project: "demo" }));
      await storage.runs.create(run({ id: "c", project: "demo" }));

      expect(await storage.runs.listProjects()).toEqual(["demo", "other"]);
    });
  });

  describe("artifacts", () => {
    test("putDir mirrors a directory tree, then read/listFiles/readTarGz expose it", async () => {
      const srcDir = await mkdtemp(join(tmpdir(), "ccqa-hub-src-"));
      await writeFile(join(srcDir, "report.json"), '{"ok":true}');
      await mkdir(join(srcDir, "evidence"), { recursive: true });
      await writeFile(join(srcDir, "evidence", "step1.png"), "fake-png-bytes");

      await storage.artifacts.putDir("run-1", srcDir);

      expect(await storage.artifacts.read("run-1", "report.json")).toEqual(
        new TextEncoder().encode('{"ok":true}'),
      );
      const files = await storage.artifacts.listFiles("run-1");
      expect(files.sort()).toEqual(["evidence/step1.png", "report.json"]);

      const tarGz = await storage.artifacts.readTarGz("run-1");
      expect(tarGz).not.toBeNull();

      await rm(srcDir, { recursive: true, force: true });
    });

    test("readTarGz returns null when nothing was stored for the run", async () => {
      expect(await storage.artifacts.readTarGz("nonexistent-run")).toBeNull();
    });

    test("read returns null for a missing file", async () => {
      expect(await storage.artifacts.read("nonexistent-run", "report.json")).toBeNull();
    });
  });

  describe.each(["sessions", "variables"] as const)("%s (SecretStore)", (kind) => {
    test("put/get round-trip preserves the blob and metadata", async () => {
      const store = storage[kind];
      const blob = new TextEncoder().encode("encrypted-bytes");
      await store.put({ project: "demo", profile: "default" }, "admin", blob, { sensitive: true });

      const result = await store.get({ project: "demo", profile: "default" }, "admin");
      expect(result?.blob).toEqual(blob);
      expect(result?.meta).toEqual({ sensitive: true });
    });

    test("get returns null for an unknown name", async () => {
      const store = storage[kind];
      expect(await store.get({ project: "demo", profile: "default" }, "nope")).toBeNull();
    });

    test("list returns every stored name in a scope", async () => {
      const store = storage[kind];
      await store.put({ project: "demo", profile: "default" }, "a", new Uint8Array([1]));
      await store.put({ project: "demo", profile: "default" }, "b", new Uint8Array([2]));
      const names = (await store.list({ project: "demo", profile: "default" })).map((e) => e.name).sort();
      expect(names).toEqual(["a", "b"]);
    });

    test("delete removes the entry", async () => {
      const store = storage[kind];
      await store.put({ project: "demo", profile: "default" }, "a", new Uint8Array([1]));
      await store.delete({ project: "demo", profile: "default" }, "a");
      expect(await store.get({ project: "demo", profile: "default" }, "a")).toBeNull();
    });

    test("scopes are isolated from each other by profile within the same project", async () => {
      const store = storage[kind];
      await store.put({ project: "demo", profile: "profileA" }, "shared-name", new Uint8Array([1]));
      await store.put({ project: "demo", profile: "profileB" }, "shared-name", new Uint8Array([2]));
      const a = await store.get({ project: "demo", profile: "profileA" }, "shared-name");
      const b = await store.get({ project: "demo", profile: "profileB" }, "shared-name");
      expect(a?.blob).toEqual(new Uint8Array([1]));
      expect(b?.blob).toEqual(new Uint8Array([2]));
    });

    test("scopes are isolated from each other by project within the same profile", async () => {
      const store = storage[kind];
      await store.put({ project: "demo", profile: "default" }, "shared-name", new Uint8Array([1]));
      await store.put({ project: "other", profile: "default" }, "shared-name", new Uint8Array([2]));
      const a = await store.get({ project: "demo", profile: "default" }, "shared-name");
      const b = await store.get({ project: "other", profile: "default" }, "shared-name");
      expect(a?.blob).toEqual(new Uint8Array([1]));
      expect(b?.blob).toEqual(new Uint8Array([2]));
    });

    test("listProjects returns distinct project names, sorted", async () => {
      const store = storage[kind];
      await store.put({ project: "other", profile: "default" }, "a", new Uint8Array([1]));
      await store.put({ project: "demo", profile: "default" }, "b", new Uint8Array([2]));

      expect(await store.listProjects()).toEqual(["demo", "other"]);
    });

    test("listProjects ignores stray files in the store directory", async () => {
      const store = storage[kind];
      await store.put({ project: "demo", profile: "default" }, "a", new Uint8Array([1]));
      // Filesystem litter (e.g. Finder metadata) must not surface as a project.
      await writeFile(join(dataDir, kind, ".DS_Store"), "junk", "utf8");

      expect(await store.listProjects()).toEqual(["demo"]);
    });
  });

  describe("prompts (PromptStore)", () => {
    test("put/get round-trip preserves the blob and metadata", async () => {
      const blob = new TextEncoder().encode("# Guidance\n\nBe thorough.\n");
      await storage.prompts.put("demo", "record.agent", blob, { kind: "guidance" });

      const result = await storage.prompts.get("demo", "record.agent");
      expect(result?.blob).toEqual(blob);
      expect(result?.meta).toEqual({ kind: "guidance" });
    });

    test("get returns null for an unknown name", async () => {
      expect(await storage.prompts.get("demo", "analysis-custom-prompt")).toBeNull();
    });

    test("list returns every stored name in a scope", async () => {
      await storage.prompts.put("demo", "record.agent", new TextEncoder().encode("a"));
      await storage.prompts.put("demo", "live.agent", new TextEncoder().encode("b"));
      const names = (await storage.prompts.list("demo")).map((e) => e.name).sort();
      expect(names).toEqual(["live.agent", "record.agent"]);
    });

    test("delete removes the entry", async () => {
      await storage.prompts.put("demo", "record.agent", new TextEncoder().encode("a"));
      await storage.prompts.delete("demo", "record.agent");
      expect(await storage.prompts.get("demo", "record.agent")).toBeNull();
    });

    test("scopes are isolated from each other by project", async () => {
      await storage.prompts.put("demo", "record.agent", new TextEncoder().encode("a"));
      await storage.prompts.put("other", "record.agent", new TextEncoder().encode("b"));
      const a = await storage.prompts.get("demo", "record.agent");
      const b = await storage.prompts.get("other", "record.agent");
      expect(a?.blob).toEqual(new TextEncoder().encode("a"));
      expect(b?.blob).toEqual(new TextEncoder().encode("b"));
    });

    test("listProjects returns distinct project names, sorted", async () => {
      await storage.prompts.put("other", "record.agent", new TextEncoder().encode("a"));
      await storage.prompts.put("demo", "record.agent", new TextEncoder().encode("b"));
      expect(await storage.prompts.listProjects()).toEqual(["demo", "other"]);
    });
  });

  describe("triage", () => {
    function record(overrides: Partial<TriageRecord> = {}): TriageRecord {
      return {
        feature: "login",
        spec: "happy-path",
        predicted: { label: "TEST_DRIFT", confidence: 0.8, headline: "selector renamed" },
        actualCause: "TEST_DRIFT",
        promptVersion: "4",
        recordedAt: "2026-07-02T00:00:00.000Z",
        ...overrides,
      };
    }

    test("putActualCause then list round-trips the record", async () => {
      await storage.triage.putActualCause("run-1", record());
      expect(await storage.triage.list("run-1")).toEqual([record()]);
    });

    test("putActualCause for the same case upserts rather than duplicates", async () => {
      await storage.triage.putActualCause("run-1", record({ actualCause: "TEST_DRIFT" }));
      await storage.triage.putActualCause("run-1", record({ actualCause: "PRODUCT_BUG" }));
      const records = await storage.triage.list("run-1");
      expect(records).toHaveLength(1);
      expect(records[0]?.actualCause).toBe("PRODUCT_BUG");
    });

    test("deleteActualCause removes only the matching (feature, spec) pair", async () => {
      await storage.triage.putActualCause("run-1", record({ feature: "login", spec: "a" }));
      await storage.triage.putActualCause("run-1", record({ feature: "login", spec: "b" }));
      await storage.triage.deleteActualCause("run-1", "login", "a");
      const records = await storage.triage.list("run-1");
      expect(records.map((r) => r.spec)).toEqual(["b"]);
    });

    test("list on a run with no recorded triage returns an empty array", async () => {
      expect(await storage.triage.list("nonexistent-run")).toEqual([]);
    });

    test("concurrent putActualCause calls for distinct cases all land, none clobbered", async () => {
      await Promise.all([
        storage.triage.putActualCause("run-1", record({ feature: "login", spec: "a" })),
        storage.triage.putActualCause("run-1", record({ feature: "login", spec: "b" })),
        storage.triage.putActualCause("run-1", record({ feature: "login", spec: "c" })),
      ]);
      const records = await storage.triage.list("run-1");
      expect(records.map((r) => r.spec).sort()).toEqual(["a", "b", "c"]);
    });
  });
});
