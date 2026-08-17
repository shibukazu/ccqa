import { describe, expect, it } from "vitest";
import type { HubClient, HubCoverageAnswer } from "../hub-client/index.ts";
import type { Run } from "../hub/contract/schema.ts";
import { EDGE_MAX_AGE_MS, loadCoverageEdges } from "./coverage-edges.ts";

// Timestamps are anchored to now because edges past `EDGE_MAX_AGE_MS` are not
// adopted — a fixed date would silently expire under every test at once.
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** A resolved stream answer with only the fields this consumer reads populated meaningfully. */
function resolved(runId: string, asOf: number, specs: { specId: string; files: string[] }[]): NonNullable<HubCoverageAnswer["resolved"]> {
  return {
    runId,
    asOf,
    lastSeq: 0,
    specs: specs.map((s) => ({ ...s, actorEvents: {} })),
    boot: [],
    health: {
      heardFromApplication: true,
      pushesDuringRun: 1,
      attributedSpecs: specs.length,
      rejectedPushes: 0,
      uninstrumentedFiles: 0,
      uninstrumentedProcesses: 0,
      droppedPushes: 0,
      unmappedActorEvents: 0,
      outsideWindowEvents: {},
      specsMeasured: specs.length,
    },
  };
}

function run(id: string, createdAt: string, status: Run["status"] = "passed"): Run {
  return { id, status, createdAt } as Run;
}

interface FakeHub {
  coverage?: Record<string, HubCoverageAnswer>;
  runs?: Run[];
  reports?: Record<string, unknown>;
}

/** Only the three methods `loadCoverageEdges` touches; anything else throws. */
function fakeHub(data: FakeHub): HubClient {
  return {
    async getCoverage(_project: string, q: { runId?: string } = {}) {
      const key = q.runId ?? "";
      const answer = data.coverage?.[key];
      if (!answer) throw new Error(`no coverage for runId "${key}"`);
      return answer;
    },
    async listRuns() {
      if (!data.runs) throw new Error("runs unavailable");
      return data.runs;
    },
    async getReport(id: string) {
      const report = data.reports?.[id];
      if (report === undefined) throw new Error(`no report for ${id}`);
      return report;
    },
  } as Partial<HubClient> as HubClient;
}

const NO_RUNS: Pick<FakeHub, "runs"> = { runs: [] };
const NO_STREAM: Pick<FakeHub, "coverage"> = {
  coverage: { "": { resolved: null, runIds: [] } },
};

describe("loadCoverageEdges: stream source", () => {
  it("strips the runId prefix by length, so a runId containing dots still yields the spec key", async () => {
    const runId = "run.2026.08.17";
    const hub = fakeHub({
      ...NO_RUNS,
      coverage: {
        "": {
          resolved: resolved(runId, NOW, [
            { specId: `${runId}.checkout/purchase-with-card`, files: ["src/a.ts"] },
            // A specId not prefixed by this run's id is not this run's to claim.
            { specId: "other-run.checkout/refund", files: ["src/b.ts"] },
          ]),
          runIds: [runId],
        },
      },
    });

    const edges = await loadCoverageEdges({ hub, project: "demo" });

    expect([...edges.keys()]).toEqual(["checkout/purchase-with-card"]);
    expect(edges.get("checkout/purchase-with-card")!.files.has("src/a.ts")).toBe(true);
  });

  it("resolves older runs individually and keeps the newest measurement per spec", async () => {
    const hub = fakeHub({
      ...NO_RUNS,
      coverage: {
        "": {
          resolved: resolved("new", NOW, [{ specId: "new.checkout/a", files: ["src/new.ts"] }]),
          runIds: ["new", "old"],
        },
        old: {
          resolved: resolved("old", NOW - 1000, [
            { specId: "old.checkout/a", files: ["src/old.ts"] },
            { specId: "old.checkout/b", files: ["src/b.ts"] },
          ]),
          runIds: ["new", "old"],
        },
      },
    });

    const edges = await loadCoverageEdges({ hub, project: "demo" });

    // checkout/a keeps the newer run's reach; checkout/b only the old run measured.
    expect(edges.get("checkout/a")!.files.has("src/new.ts")).toBe(true);
    expect(edges.get("checkout/a")!.files.has("src/old.ts")).toBe(false);
    expect(edges.get("checkout/b")!.files.has("src/b.ts")).toBe(true);
  });

  it("skips a spec whose measured file set is empty — no evidence is not an edge", async () => {
    const hub = fakeHub({
      ...NO_RUNS,
      coverage: {
        "": {
          resolved: resolved("r1", NOW, [{ specId: "r1.checkout/a", files: [] }]),
          runIds: ["r1"],
        },
      },
    });

    expect((await loadCoverageEdges({ hub, project: "demo" })).size).toBe(0);
  });
});

describe("loadCoverageEdges: report source", () => {
  it("reads coverage rows off finished runs, skipping running runs and unparsable reports", async () => {
    const hub = fakeHub({
      ...NO_STREAM,
      runs: [
        run("r-running", iso(0), "running"),
        run("r-new", iso(1000)),
        run("r-broken", iso(2000)),
        run("r-old", iso(3000)),
      ],
      reports: {
        "r-running": { results: [{ feature: "checkout", spec: "a", coverage: { files: ["src/never.ts"] } }] },
        "r-new": {
          results: [
            { feature: "checkout", spec: "a", coverage: { files: ["src/new.ts"] } },
            { feature: "checkout", spec: "no-coverage" },
          ],
        },
        "r-broken": "not a report",
        "r-old": {
          results: [
            { feature: "checkout", spec: "a", coverage: { files: ["src/old.ts"] } },
            { feature: "checkout", spec: "b", coverage: { files: ["src/b.ts"] } },
          ],
        },
      },
    });

    const edges = await loadCoverageEdges({ hub, project: "demo" });

    expect(edges.get("checkout/a")!.files.has("src/new.ts")).toBe(true);
    expect(edges.get("checkout/a")!.files.has("src/never.ts")).toBe(false);
    expect(edges.get("checkout/b")!.files.has("src/b.ts")).toBe(true);
    expect(edges.has("checkout/no-coverage")).toBe(false);
  });
});

describe("loadCoverageEdges: merging and degradation", () => {
  it("takes the newer measurement per spec across the two sources", async () => {
    const hub = fakeHub({
      coverage: {
        "": {
          resolved: resolved("r1", NOW, [
            { specId: "r1.checkout/a", files: ["src/stream.ts"] },
          ]),
          runIds: ["r1"],
        },
      },
      runs: [run("hub-run", iso(1000))],
      reports: {
        "hub-run": { results: [{ feature: "checkout", spec: "a", coverage: { files: ["src/report.ts"] } }] },
      },
    });

    const edges = await loadCoverageEdges({ hub, project: "demo" });

    expect(edges.get("checkout/a")!.files.has("src/stream.ts")).toBe(true);
    expect(edges.get("checkout/a")!.files.has("src/report.ts")).toBe(false);
  });

  it("adopts no edge older than EDGE_MAX_AGE_MS, from either source", async () => {
    const stale = NOW - EDGE_MAX_AGE_MS - 60_000;
    const hub = fakeHub({
      coverage: {
        "": {
          resolved: resolved("r1", stale, [{ specId: "r1.checkout/a", files: ["src/a.ts"] }]),
          runIds: ["r1"],
        },
      },
      runs: [run("hub-run", new Date(stale).toISOString())],
      reports: {
        "hub-run": { results: [{ feature: "checkout", spec: "b", coverage: { files: ["src/b.ts"] } }] },
      },
    });

    expect((await loadCoverageEdges({ hub, project: "demo" })).size).toBe(0);
  });

  it("returns an empty map, never throws, when the hub cannot be read at all", async () => {
    const hub = fakeHub({});

    expect((await loadCoverageEdges({ hub, project: "demo" })).size).toBe(0);
  });

  it("still uses the readable source when the other fails", async () => {
    const hub = fakeHub({
      // Stream unreadable (no coverage entry); reports readable.
      runs: [run("hub-run", iso(1000))],
      reports: {
        "hub-run": { results: [{ feature: "checkout", spec: "a", coverage: { files: ["src/a.ts"] } }] },
      },
    });

    const edges = await loadCoverageEdges({ hub, project: "demo" });

    expect(edges.get("checkout/a")!.files.has("src/a.ts")).toBe(true);
  });
});
