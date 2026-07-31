import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFileHubStorage } from "../core/storage/file/index.ts";
import type { HubStorage } from "../core/storage/types.ts";
import { packTarGz, type TarEntry } from "../core/tar.ts";
import type { ReportSpecResult, RunReportData } from "../../report/schema.ts";
import { createHubServer } from "./server.ts";

// This server builds its own triage-learning worker internally with no
// injection point, and learning always calls out to Claude. Force auth to
// read as unavailable regardless of the host machine's real credentials, so
// the "learning jobs" tests below stay offline and deterministic (they only
// exercise the HTTP/queue wiring, not a real Claude call).
vi.mock("../../drift/auth.ts", () => ({
  driftAuthAvailable: () => ({ ok: false, reason: "mocked: no Claude auth in tests" }),
}));

const TOKEN = "test-token";

/** Test-only cast for `res.json()` results — these tests assert shape via runtime expectations, not static types. */
async function json(res: Response): Promise<any> {
  return res.json();
}

/**
 * Build a minimal valid pushed-report archive: a `report.json` satisfying
 * `RunReportDataSchema` plus a stub `index.html`, packed as a tar.gz — the
 * exact shape `POST /api/v1/runs` expects.
 */
function makeReportTarGz(opts: { status?: "passed" | "failed"; runId?: string; runUrl?: string } = {}): Uint8Array {
  const report: RunReportData = {
    schemaVersion: 1,
    kind: "run",
    createdAt: new Date().toISOString(),
    runId: opts.runId ?? null,
    ...(opts.runUrl ? { runUrl: opts.runUrl } : {}),
    git: { head: null, base: null },
    model: null,
    language: null,
    promptVersion: "1",
    customPromptVersion: null,
    results: opts.status
      ? [
          {
            feature: "demo",
            spec: "example",
            title: null,
            status: opts.status,
            testCounts: null,
            durationMs: null,
            assertions: null,
            analysis: null,
            analysisSkipped: null,
            failureLogExcerpt: null,
            diffExcerpt: null,
            specYaml: null,
            evidence: null,
            liveRun: null,
          },
        ]
      : [],
  };
  const entries: TarEntry[] = [
    { path: "report.json", content: new TextEncoder().encode(JSON.stringify(report)), mode: 0o644 },
    { path: "index.html", content: new TextEncoder().encode("<html></html>"), mode: 0o644 },
  ];
  return packTarGz(entries);
}

/**
 * Build a pushed-report archive with a per-spec drift diagnosis in `analysis`,
 * as produced by `ccqa drift --push` (`kind: "drift"` report.json). Three specs: one TEST_DRIFT (error severity), one UNKNOWN
 * (warn severity), one clean (no diagnosis).
 */
function makeDriftReportTarGz(opts: { gitHead?: string } = {}): Uint8Array {
  const baseResult: Omit<ReportSpecResult, "feature" | "spec" | "analysis" | "status"> = {
    title: null,
    testCounts: null,
    durationMs: null,
    assertions: null,
    analysisSkipped: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml: null,
    evidence: null,
    liveRun: null,
  };
  const report: RunReportData = {
    schemaVersion: 1,
    kind: "drift",
    createdAt: new Date().toISOString(),
    runId: null,
    git: { head: opts.gitHead ?? null, base: null },
    model: null,
    language: null,
    promptVersion: "1",
    customPromptVersion: null,
    results: [
      {
        ...baseResult,
        feature: "demo",
        spec: "test-drift",
        status: "failed",
        analysis: {
          label: "TEST_DRIFT",
          confidence: 0.8,
          subDiagnosis: "SELECTOR_DRIFT",
          headline: "mismatch",
          recommendation: "",
          evidence: [],
          reasoning: "",
        },
      },
      {
        ...baseResult,
        feature: "demo",
        spec: "unknown-drift",
        status: "passed",
        analysis: {
          label: "UNKNOWN",
          confidence: 0.3,
          subDiagnosis: "NONE",
          headline: "cannot tell",
          recommendation: "",
          evidence: [],
          reasoning: "",
        },
      },
      {
        ...baseResult,
        feature: "demo",
        spec: "clean",
        status: "passed",
        analysis: null,
      },
    ],
  };
  const entries: TarEntry[] = [
    { path: "report.json", content: new TextEncoder().encode(JSON.stringify(report)), mode: 0o644 },
    { path: "index.html", content: new TextEncoder().encode("<html></html>"), mode: 0o644 },
  ];
  return packTarGz(entries);
}

/**
 * A `kind: "drift"` archive whose every row is clean, read at `gitHead`. The
 * re-run verdict now asks the audit first, so a fixture that exercises the run
 * axis has to say the audit already answered for the deployed commit —
 * otherwise every spec is `inProgress` and the run side is never reached.
 */
function makeCleanAuditTarGz(gitHead: string, specs: readonly string[]): Uint8Array {
  const report: RunReportData = {
    schemaVersion: 1,
    kind: "drift",
    createdAt: new Date().toISOString(),
    runId: null,
    git: { head: gitHead, base: null },
    model: null,
    language: null,
    promptVersion: "1",
    customPromptVersion: null,
    results: specs.map((key) => ({
      feature: key.split("/")[0]!,
      spec: key.split("/")[1]!,
      title: null,
      status: "passed" as const,
      testCounts: null,
      durationMs: null,
      assertions: null,
      analysis: null,
      analysisSkipped: null,
      failureLogExcerpt: null,
      diffExcerpt: null,
      specYaml: null,
      evidence: null,
      liveRun: null,
    })),
  };
  return packTarGz([
    { path: "report.json", content: new TextEncoder().encode(JSON.stringify(report)), mode: 0o644 },
    { path: "index.html", content: new TextEncoder().encode("<html></html>"), mode: 0o644 },
  ]);
}

/** A minimal valid `ReportSpecResult` row, as used by the incremental-run PATCH tests below. */
function makeRow(overrides: Partial<ReportSpecResult> = {}): ReportSpecResult {
  return {
    feature: "demo",
    spec: "example",
    title: null,
    status: "passed",
    testCounts: null,
    durationMs: null,
    assertions: null,
    analysis: null,
    analysisSkipped: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml: null,
    evidence: null,
    liveRun: null,
    ...overrides,
  };
}

/** Pack a tar.gz from raw string contents, for exercising malformed-push cases. */
function packStringFilesTarGz(files: Record<string, string>): Uint8Array {
  const entries: TarEntry[] = Object.entries(files).map(([path, content]) => ({
    path,
    content: new TextEncoder().encode(content),
    mode: 0o644,
  }));
  return packTarGz(entries);
}

describe("hub API server", () => {
  let dataDir: string;
  let storage: HubStorage;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ccqa-hub-server-"));
    storage = createFileHubStorage(dataDir);
    server = createHubServer({
      storage,
      token: TOKEN,
      encryptionKey: null,
      allowedOrigins: ["https://intranet.example"],
    });
    // Bind to 127.0.0.1 explicitly (not the default IPv6 `::` wildcard). The
    // tests connect over `http://127.0.0.1:<port>`, and `listen(0)` with no
    // host binds the IPv6 wildcard, which reserves the port only for the
    // IPv6 family. A concurrent process (e.g. a browser's CDP endpoint, which
    // binds IPv4 loopback) can then hold the *same port number* on IPv4
    // `127.0.0.1`, so an IPv4 fetch reaches that foreign server instead of
    // ours — surfacing as `<!DOCTYPE`/empty-body JSON errors, cross-endpoint
    // status mismatches, or EPIPE. Binding IPv4 loopback here makes the port
    // exclusive on the family the tests actually connect to.
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    // `server.close()` only stops accepting new connections and waits for
    // existing keep-alive sockets to go idle; destroy them outright so the
    // rapid listen/close churn tears down cleanly.
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(dataDir, { recursive: true, force: true });
  });

  function authed(init: RequestInit = {}): RequestInit {
    return { ...init, headers: { ...init.headers, Authorization: `Bearer ${TOKEN}` } };
  }

  describe("auth", () => {
    test("GET /api/v1/health requires no token", async () => {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toEqual({ status: "ok", version: 1, queueDepth: 0 });
    });

    test("GET / (bundled UI) requires no token", async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
    });

    test("a protected endpoint without a token returns 401", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs`);
      expect(res.status).toBe(401);
      const body = await json(res);
      expect(body.error.code).toBe("unauthorized");
    });

    test("a protected endpoint with the wrong token returns 401", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });

    test("a protected GET endpoint accepts ?token= as well as the header", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs?token=${TOKEN}`);
      expect(res.status).toBe(200);
    });
  });

  describe("404 and CORS", () => {
    test("an unknown route returns 404 with the standard error shape", async () => {
      const res = await fetch(`${baseUrl}/api/v1/nope`, authed());
      expect(res.status).toBe(404);
      const body = await json(res);
      expect(body.error.code).toBe("not_found");
    });

    // Malformed percent-encoding throws URIError inside route decoding, which
    // runs before auth — it must become a 404, never an escaping error that
    // kills the process (an unauthenticated crash vector otherwise).
    test("malformed percent-encoding in a path returns 404 and the hub survives", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs/%ff`);
      expect(res.status).toBe(404);
      const health = await fetch(`${baseUrl}/api/v1/health`);
      expect(health.status).toBe(200);
    });

    test("OPTIONS preflight from an allowed origin gets CORS headers and a 204", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs`, {
        method: "OPTIONS",
        headers: { Origin: "https://intranet.example" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://intranet.example");
    });

    test("a request from a disallowed origin gets no CORS header", async () => {
      const res = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { Origin: "https://evil.example" },
      });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("runs", () => {
    test("POST with a valid tar.gz returns 201 with a Run derived from the report", async () => {
      const tarGz = makeReportTarGz({ status: "passed" });
      const res = await fetch(`${baseUrl}/api/v1/runs?project=demo`, authed({
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: tarGz,
      }));
      expect(res.status).toBe(201);
      const run = await json(res);
      expect(run.project).toBe("demo");
      expect(run.status).toBe("passed");
      expect(run.specs).toEqual({ total: 1, passed: 1, failed: 0 });
    });

    test("POST derives ciRunId + runUrl from the report so the UI can link to the CI run", async () => {
      const tarGz = makeReportTarGz({
        status: "passed",
        runId: "998877",
        runUrl: "https://github.com/acme/webapp/actions/runs/998877",
      });
      const res = await fetch(`${baseUrl}/api/v1/runs?project=demo`, authed({
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: tarGz,
      }));
      expect(res.status).toBe(201);
      const run = await json(res);
      expect(run.ciRunId).toBe("998877");
      expect(run.runUrl).toBe("https://github.com/acme/webapp/actions/runs/998877");
    });

    test("POST without ?project returns 400", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs`, authed({
        method: "POST",
        body: makeReportTarGz(),
      }));
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error.code).toBe("missing_param");
    });

    test("POST with a corrupt/non-gzip body returns 400 invalid_archive", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs?project=demo`, authed({
        method: "POST",
        body: new Uint8Array([1, 2, 3, 4, 5]),
      }));
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error.code).toBe("invalid_archive");
    });

    test("POST with a tar.gz missing report.json returns 400 invalid_report", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs?project=demo`, authed({
        method: "POST",
        body: packStringFilesTarGz({ "index.html": "<html></html>" }),
      }));
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error.code).toBe("invalid_report");
    });

    test("POST with report.json that isn't valid JSON returns 400 invalid_report (not 500)", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs?project=demo`, authed({
        method: "POST",
        body: packStringFilesTarGz({ "report.json": "not json" }),
      }));
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error.code).toBe("invalid_report");
    });

    test("POST with a report.json that fails RunReportDataSchema returns 400 invalid_report", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs?project=demo`, authed({
        method: "POST",
        body: packStringFilesTarGz({ "report.json": JSON.stringify({ foo: 1 }) }),
      }));
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error.code).toBe("invalid_report");
    });

    test("a pushed run is listable, filterable by branch, and its report.json is fetchable", async () => {
      // Pushes to different branches are independent — push both at once.
      const [mainRun, featureRun] = await Promise.all([
        fetch(`${baseUrl}/api/v1/runs?project=demo&branch=main`, authed({
          method: "POST",
          body: makeReportTarGz({ status: "passed" }),
        })).then(json),
        fetch(`${baseUrl}/api/v1/runs?project=demo&branch=feature`, authed({
          method: "POST",
          body: makeReportTarGz({ status: "passed" }),
        })).then(json),
      ]);

      const listRes = await fetch(`${baseUrl}/api/v1/runs?project=demo`, authed());
      const { runs } = await json(listRes);
      expect(runs.map((r: { id: string }) => r.id).sort()).toEqual([mainRun.id, featureRun.id].sort());

      const branchFilteredRes = await fetch(`${baseUrl}/api/v1/runs?project=demo&branch=main`, authed());
      const { runs: branchFiltered } = await json(branchFilteredRes);
      expect(branchFiltered.map((r: { id: string }) => r.id)).toEqual([mainRun.id]);

      const reportRes = await fetch(`${baseUrl}/api/v1/runs/${mainRun.id}/report`, authed());
      expect(reportRes.status).toBe(200);
    });

    test("POST ?kind=drift stores drift summary counts derived from each spec's diagnosis", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs?project=demo&kind=drift`, authed({
        method: "POST",
        body: makeDriftReportTarGz(),
      }));
      expect(res.status).toBe(201);
      const run = await json(res);
      expect(run.kind).toBe("drift");
      expect(run.drift).toEqual({ specs: 3, testDrift: 1, specChange: 0, unknown: 1 });
    });

    test("POST with no ?kind (and explicit ?kind=run) defaults to a kind:\"run\" Run with drift:null", async () => {
      for (const url of [`${baseUrl}/api/v1/runs?project=demo`, `${baseUrl}/api/v1/runs?project=demo&kind=run`]) {
        const res = await fetch(url, authed({ method: "POST", body: makeReportTarGz({ status: "passed" }) }));
        expect(res.status).toBe(201);
        const run = await json(res);
        expect(run.kind).toBe("run");
        expect(run.drift).toBeNull();
      }
    });

    test("POST with an invalid ?kind returns 400", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs?project=demo&kind=foo`, authed({
        method: "POST",
        body: makeReportTarGz({ status: "passed" }),
      }));
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error.code).toBe("invalid_param");
    });

    test("a request body over the limit returns 413", async () => {
      const oversized = new Uint8Array(33 * 1024 * 1024); // over the 32MB push default
      const res = await fetch(`${baseUrl}/api/v1/runs?project=demo`, authed({
        method: "POST",
        body: oversized,
      }));
      expect(res.status).toBe(413);
    }, 20_000);
  });

  describe("incremental run", () => {
    async function openRun(): Promise<Record<string, unknown>> {
      const res = await fetch(`${baseUrl}/api/v1/runs/open?project=demo`, authed({ method: "POST" }));
      expect(res.status).toBe(201);
      return json(res);
    }

    function patch(id: string, body: unknown): Promise<Response> {
      return fetch(`${baseUrl}/api/v1/runs/${id}`, authed({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    }

    test("POST /runs/open returns a running run with all-zero specs", async () => {
      const run = await openRun();
      expect(run.status).toBe("running");
      expect(run.specs).toEqual({ total: 0, passed: 0, failed: 0 });
      expect(run.gitHead).toBeNull();

      const getRes = await fetch(`${baseUrl}/api/v1/runs/${run.id}`, authed());
      const fetched = await json(getRes);
      expect(fetched.status).toBe("running");
      expect(fetched.specs).toEqual({ total: 0, passed: 0, failed: 0 });
    });

    test("POST /runs/open records ?gitHead= so an interrupted run is still attributable", async () => {
      const sha = "a".repeat(40);
      const res = await fetch(
        `${baseUrl}/api/v1/runs/open?project=demo&gitHead=${sha}`,
        authed({ method: "POST" }),
      );
      expect(res.status).toBe(201);
      const run = await json(res);
      expect(run.gitHead).toBe(sha);
    });

    test("POST /runs/open records ?ciRunId=/?runUrl= so an incremental CI run links back", async () => {
      const runUrl = "https://github.com/acme/webapp/actions/runs/424242";
      const res = await fetch(
        `${baseUrl}/api/v1/runs/open?project=demo&ciRunId=424242&runUrl=${encodeURIComponent(runUrl)}`,
        authed({ method: "POST" }),
      );
      expect(res.status).toBe(201);
      const run = await json(res);
      expect(run.ciRunId).toBe("424242");
      expect(run.runUrl).toBe(runUrl);
    });

    test("sealing a kind=drift run derives its label counts, like the single-shot push", async () => {
      // The single-shot push summarises the whole report at create time. Here
      // the rows only exist at `done`, so the counts have to be derived there
      // too — otherwise `drift` stays null on a run whose rows plainly carry
      // diagnoses, and "no summary" becomes indistinguishable from "no drift".
      const res = await fetch(`${baseUrl}/api/v1/runs/open?project=demo&kind=drift`, authed({ method: "POST" }));
      const run = await json(res);
      expect(run.drift).toBeNull();

      const diagnosis = (label: "TEST_DRIFT" | "SPEC_CHANGE" | "UNKNOWN") => ({
        label,
        confidence: 0.9,
        headline: "h",
        recommendation: "r",
        evidence: [],
        reasoning: "",
      });
      const sealed = await json(
        await patch(run.id as string, {
          rows: [
            makeRow({ spec: "a", status: "failed", analysis: diagnosis("TEST_DRIFT") }),
            makeRow({ spec: "b", status: "passed", analysis: diagnosis("UNKNOWN") }),
            makeRow({ spec: "c", status: "passed" }),
          ],
          done: true,
        }),
      );
      expect(sealed.drift).toEqual({ specs: 3, testDrift: 1, specChange: 0, unknown: 1 });
    });

    test("grading a drift row is joined on as gradedDrift, leaving the audit's own counts alone", async () => {
      // A grade is the ground truth and every screen should follow it, but the
      // run must keep saying what the audit found — that pair is what the
      // confusion matrix measures. So the corrected counts ride alongside.
      const res = await fetch(`${baseUrl}/api/v1/runs/open?project=demo&kind=drift`, authed({ method: "POST" }));
      const run = await json(res);
      const analysis: NonNullable<ReportSpecResult["analysis"]> = {
        label: "TEST_DRIFT",
        confidence: 0.9,
        headline: "h",
        recommendation: "r",
        evidence: [],
        reasoning: "",
      };
      await patch(run.id as string, {
        rows: [
          makeRow({ spec: "a", status: "failed", analysis }),
          makeRow({ spec: "b", status: "failed", analysis }),
        ],
        done: true,
      });

      const graded = await fetch(
        `${baseUrl}/api/v1/runs/${run.id}/triage/demo/a/actual-cause`,
        authed({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cause: "NO_DRIFT" }) }),
      );
      expect(graded.status).toBe(200);

      const after = await json(await fetch(`${baseUrl}/api/v1/runs/${run.id}`, authed()));
      expect(after.drift).toEqual({ specs: 2, testDrift: 2, specChange: 0, unknown: 0 });
      expect(after.gradedDrift).toEqual({ specs: 2, testDrift: 1, specChange: 0, unknown: 0, noDrift: 1, graded: 1 });
    });

    test("PATCH with one row (no done) updates the report and specs, and stays running", async () => {
      const run = await openRun();
      const res = await patch(run.id as string, { rows: [makeRow({ status: "passed" })] });
      expect(res.status).toBe(200);
      const updated = await json(res);
      expect(updated.status).toBe("running");
      expect(updated.specs).toEqual({ total: 1, passed: 1, failed: 0 });

      const reportRes = await fetch(`${baseUrl}/api/v1/runs/${run.id}/report`, authed());
      const report = await json(reportRes);
      expect(report.results).toEqual([makeRow({ status: "passed" })]);
    });

    test("a second PATCH accumulates rows, and re-patching the same feature/spec upserts", async () => {
      const run = await openRun();
      await patch(run.id as string, { rows: [makeRow({ feature: "a", spec: "one", status: "passed" })] });
      await patch(run.id as string, { rows: [makeRow({ feature: "a", spec: "two", status: "failed" })] });
      const res = await patch(run.id as string, {
        rows: [makeRow({ feature: "a", spec: "one", status: "failed" })],
      });
      const updated = await json(res);
      expect(updated.specs).toEqual({ total: 2, passed: 0, failed: 2 });

      const reportRes = await fetch(`${baseUrl}/api/v1/runs/${run.id}/report`, authed());
      const report = await json(reportRes);
      expect(report.results).toHaveLength(2);
      const one = report.results.find((r: ReportSpecResult) => r.spec === "one");
      expect(one.status).toBe("failed");
    });

    test("PATCH done:true makes the run terminal; a further PATCH returns 409", async () => {
      const run = await openRun();
      const res = await patch(run.id as string, { rows: [makeRow({ status: "passed" })], done: true });
      expect(res.status).toBe(200);
      const updated = await json(res);
      expect(updated.status).toBe("passed");

      const secondRes = await patch(run.id as string, { rows: [makeRow({ status: "passed" })] });
      expect(secondRes.status).toBe(409);
      const body = await json(secondRes);
      expect(body.error.code).toBe("conflict");
    });

    test("done:true with a failed row and no explicit finalStatus resolves to failed", async () => {
      const run = await openRun();
      const res = await patch(run.id as string, { rows: [makeRow({ status: "failed" })], done: true });
      const updated = await json(res);
      expect(updated.status).toBe("failed");
    });

    test("reportMeta on a later PATCH updates the report envelope built by an earlier one", async () => {
      const run = await openRun();
      // First patch creates report.json with the provisional envelope (git=null,
      // model=null) — mirrors a mid-run per-spec sink patch.
      await patch(run.id as string, { rows: [makeRow({ feature: "a", spec: "one" })] });
      // Reconcile patch carries the real metadata; it must land even though
      // report.json already exists (regression: it used to be dropped).
      await patch(run.id as string, {
        rows: [],
        done: true,
        finalStatus: "passed",
        reportMeta: {
          git: { head: "abc123", base: "main", baseSha: "def456", baseSource: "explicit" },
          model: "opus",
          promptVersion: "7",
        },
      });
      const reportRes = await fetch(`${baseUrl}/api/v1/runs/${run.id}/report`, authed());
      const report = await json(reportRes);
      expect(report.git).toEqual({ head: "abc123", base: "main", baseSha: "def456", baseSource: "explicit" });
      expect(report.model).toBe("opus");
      expect(report.promptVersion).toBe("7");
      expect(report.results).toHaveLength(1);
    });

    test("PATCH on a nonexistent run returns 404", async () => {
      const res = await patch("nonexistent-id", { rows: [] });
      expect(res.status).toBe(404);
    });

    test("PATCH on an already-terminal pushed run (POST /runs) returns 409", async () => {
      const pushRes = await fetch(`${baseUrl}/api/v1/runs?project=demo`, authed({
        method: "POST",
        body: makeReportTarGz({ status: "passed" }),
      }));
      const pushed = await json(pushRes);
      const res = await patch(pushed.id, { rows: [makeRow()] });
      expect(res.status).toBe(409);
    });

    test("PATCH with evidence stores the file, fetchable as image/png", async () => {
      const run = await openRun();
      const b64 = Buffer.from("fake-png-bytes").toString("base64");
      const res = await patch(run.id as string, {
        rows: [makeRow()],
        evidence: { "evidence/x.png": b64 },
      });
      expect(res.status).toBe(200);

      const fileRes = await fetch(`${baseUrl}/api/v1/runs/${run.id}/artifacts/evidence/x.png`, authed());
      expect(fileRes.status).toBe(200);
      expect(fileRes.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await fileRes.arrayBuffer()).toString()).toBe("fake-png-bytes");
    });

    test("N parallel PATCH calls all land in report.json with no corruption", async () => {
      const run = await openRun();
      const n = 10;
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          patch(run.id as string, { rows: [makeRow({ feature: "concurrent", spec: `s${i}` })] }),
        ),
      );
      for (const res of results) expect(res.status).toBe(200);

      const reportRes = await fetch(`${baseUrl}/api/v1/runs/${run.id}/report`, authed());
      const report = await json(reportRes);
      expect(report.results).toHaveLength(n);
      expect(new Set(report.results.map((r: ReportSpecResult) => r.spec)).size).toBe(n);
    });

    test("a run left 'running' is swept to 'failed' when the hub restarts", async () => {
      // A run whose producer never sent `done` (hub crashed mid-run) is
      // orphaned: nothing will resume patching it. Simulate a restart over the
      // same data dir and assert the startup sweep seals it terminal.
      const orphan = await openRun();
      expect(orphan.status).toBe("running");

      const restarted = createHubServer({
        storage: createFileHubStorage(dataDir),
        token: TOKEN,
        encryptionKey: null,
        allowedOrigins: ["https://intranet.example"],
      });
      try {
        await new Promise<void>((r) => restarted.listen(0, "127.0.0.1", r));
        // The sweep is fire-and-forget on startup; poll until it lands.
        const swept = createFileHubStorage(dataDir);
        for (let i = 0; i < 50; i++) {
          const run = await swept.runs.get(orphan.id as string);
          if (run?.status === "failed") break;
          await new Promise((r) => setTimeout(r, 20));
        }
        const finalRun = await swept.runs.get(orphan.id as string);
        expect(finalRun?.status).toBe("failed");
      } finally {
        restarted.closeAllConnections();
        await new Promise<void>((r) => restarted.close(() => r()));
      }
    });

    describe("triage actual-cause per-kind validation", () => {
      const runAnalysis = (): NonNullable<ReportSpecResult["analysis"]> => ({
        label: "PRODUCT_BUG",
        confidence: 0.9,
        headline: "h",
        recommendation: "r",
        evidence: [],
        reasoning: "",
      });

      async function openAnalyzedRun(): Promise<Record<string, unknown>> {
        const run = await openRun();
        await patch(run.id as string, {
          rows: [makeRow({ status: "failed", analysis: runAnalysis() })],
          done: true,
        });
        return run;
      }

      test("rejects a drift-only cause (NO_DRIFT) on a kind:\"run\" row", async () => {
        const run = await openAnalyzedRun();
        const res = await fetch(
          `${baseUrl}/api/v1/runs/${run.id}/triage/demo/example/actual-cause`,
          authed({
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cause: "NO_DRIFT" }),
          }),
        );
        expect(res.status).toBe(400);
        expect((await json(res)).error.code).toBe("invalid_request");
      });

      test("accepts a run-kind cause (ENVIRONMENT) on a kind:\"run\" row", async () => {
        const run = await openAnalyzedRun();
        const res = await fetch(
          `${baseUrl}/api/v1/runs/${run.id}/triage/demo/example/actual-cause`,
          authed({
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cause: "ENVIRONMENT" }),
          }),
        );
        expect(res.status).toBe(200);
      });

      test("GET triage flags a grade whose cause this row's kind cannot produce", async () => {
        const run = await openAnalyzedRun();
        // Simulate a grade whose cause this row's kind does not accept —
        // written straight to storage since PUT rejects it.
        await storage.triage.putActualCause(run.id as string, {
          feature: "demo",
          spec: "example",
          predicted: { label: "PRODUCT_BUG", confidence: 0.9, headline: "h" },
          actualCause: "NO_DRIFT",
          promptVersion: "1",
          recordedAt: new Date().toISOString(),
        });

        const body = await json(await fetch(`${baseUrl}/api/v1/runs/${run.id}/triage`, authed()));
        const triageCase = body.cases.find((c: { feature: string; spec: string }) => c.feature === "demo" && c.spec === "example");
        expect(triageCase.actual.invalidForKind).toBe(true);
      });

      test("GET triage splits an invalid-for-kind grade out of `recorded` into `recordedInvalidForKind`", async () => {
        const run = await openRun();
        await patch(run.id as string, {
          rows: [
            makeRow({ feature: "demo", spec: "one", status: "failed", analysis: runAnalysis() }),
            makeRow({ feature: "demo", spec: "two", status: "failed", analysis: runAnalysis() }),
          ],
          done: true,
        });

        const valid = await fetch(
          `${baseUrl}/api/v1/runs/${run.id}/triage/demo/one/actual-cause`,
          authed({
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cause: "ENVIRONMENT" }),
          }),
        );
        expect(valid.status).toBe(200);

        // A grade whose cause this row's kind does not accept, written
        // straight to storage since the PUT rejects it.
        await storage.triage.putActualCause(run.id as string, {
          feature: "demo",
          spec: "two",
          predicted: { label: "PRODUCT_BUG", confidence: 0.9, headline: "h" },
          actualCause: "NO_DRIFT",
          promptVersion: "1",
          recordedAt: new Date().toISOString(),
        });

        const body = await json(await fetch(`${baseUrl}/api/v1/runs/${run.id}/triage`, authed()));
        expect(body.recorded).toBe(1);
        expect(body.recordedInvalidForKind).toBe(1);
        expect(body.total).toBe(2);
      });
    });

    describe("triage bulk import (actual-causes)", () => {
      const runAnalysis = (): NonNullable<ReportSpecResult["analysis"]> => ({
        label: "PRODUCT_BUG",
        confidence: 0.9,
        headline: "h",
        recommendation: "r",
        evidence: [],
        reasoning: "",
      });

      function importCauses(runId: string, labels: unknown[]): Promise<Response> {
        return fetch(
          `${baseUrl}/api/v1/runs/${runId}/triage/actual-causes`,
          authed({
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ schemaVersion: 1, runId, promptVersion: "1", exportedAt: new Date().toISOString(), labels }),
          }),
        );
      }

      test("rejects a drift-only cause on a kind:\"run\" row without dropping it silently or importing the rest", async () => {
        const run = await openRun();
        await patch(run.id as string, {
          rows: [
            makeRow({ feature: "demo", spec: "one", status: "failed", analysis: runAnalysis() }),
            makeRow({ feature: "demo", spec: "two", status: "failed", analysis: runAnalysis() }),
          ],
          done: true,
        });

        const res = await importCauses(run.id as string, [
          { feature: "demo", spec: "one", predicted: "PRODUCT_BUG", label: "PRODUCT_BUG" },
          { feature: "demo", spec: "two", predicted: "PRODUCT_BUG", label: "NO_DRIFT" },
        ]);
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body.imported).toBe(1);
        expect(body.rejected).toEqual([
          { feature: "demo", spec: "two", reason: expect.stringContaining("not a valid actual cause") },
        ]);

        const triage = await json(await fetch(`${baseUrl}/api/v1/runs/${run.id}/triage`, authed()));
        const rejectedCase = triage.cases.find((c: { spec: string }) => c.spec === "two");
        expect(rejectedCase.actual).toBeNull();
      });

      test("reports a rejected entry, rather than dropping it, for a label with no matching report row", async () => {
        const run = await openRun();
        await patch(run.id as string, {
          rows: [makeRow({ feature: "demo", spec: "one", status: "failed", analysis: runAnalysis() })],
          done: true,
        });

        const res = await importCauses(run.id as string, [
          { feature: "demo", spec: "missing", predicted: "PRODUCT_BUG", label: "PRODUCT_BUG" },
        ]);
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body.imported).toBe(0);
        expect(body.rejected).toEqual([
          { feature: "demo", spec: "missing", reason: expect.stringContaining("no triage case") },
        ]);
      });
    });
  });

  describe("last-green ledger", () => {
    async function openAndFinish(args: {
      branch: string;
      gitHead: string;
      rows: ReportSpecResult[];
    }): Promise<void> {
      const openRes = await fetch(
        `${baseUrl}/api/v1/runs/open?project=lg&branch=${encodeURIComponent(args.branch)}&gitHead=${args.gitHead}`,
        authed({ method: "POST" }),
      );
      expect(openRes.status).toBe(201);
      const run = await json(openRes);
      const patchRes = await fetch(`${baseUrl}/api/v1/runs/${run.id}`, authed({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: args.rows, done: true }),
      }));
      expect(patchRes.status).toBe(200);
    }

    function getLedger(q: string): Promise<{
      entries: Record<string, { gitHead: string }>;
      lastRun: Record<string, { gitHead: string }>;
      lastRed: Record<string, { gitHead: string }>;
    }> {
      return fetch(`${baseUrl}/api/v1/projects/lg/last-green?${q}`, authed()).then(json);
    }

    test("`run` covers every executed spec, `red` the failures; a skipped row advances nothing", async () => {
      const sha = "d".repeat(40);
      await openAndFinish({
        branch: "buckets",
        gitHead: sha,
        rows: [
          makeRow({ feature: "f", spec: "green", status: "passed" }),
          makeRow({ feature: "f", spec: "red", status: "failed" }),
          makeRow({ feature: "f", spec: "skipped", status: "skipped" }),
        ],
      });

      const ledger = await getLedger("branch=buckets");
      expect(Object.keys(ledger.entries)).toEqual(["f/green"]);
      expect(Object.keys(ledger.lastRun).sort()).toEqual(["f/green", "f/red"]);
      expect(Object.keys(ledger.lastRed)).toEqual(["f/red"]);
      expect(ledger.lastRun["f/red"]?.gitHead).toBe(sha);
    });

    test("a finalized run advances passed specs only; branch overlays fallbackBranch", async () => {
      const mainSha = "b".repeat(40);
      await openAndFinish({
        branch: "main",
        gitHead: mainSha,
        rows: [
          makeRow({ feature: "f", spec: "green", status: "passed" }),
          makeRow({ feature: "f", spec: "red", status: "failed" }),
        ],
      });

      const onMain = await getLedger("branch=main");
      expect(onMain.entries["f/green"]?.gitHead).toBe(mainSha);
      expect(onMain.entries["f/red"]).toBeUndefined();

      // A PR branch overlays its own green onto main's baselines.
      const prSha = "c".repeat(40);
      await openAndFinish({
        branch: "feat/x",
        gitHead: prSha,
        rows: [makeRow({ feature: "f", spec: "red", status: "passed" })],
      });
      const onPr = await getLedger(`branch=${encodeURIComponent("feat/x")}&fallbackBranch=main`);
      expect(onPr.entries["f/green"]?.gitHead).toBe(mainSha); // inherited from main
      expect(onPr.entries["f/red"]?.gitHead).toBe(prSha); // own green wins

      // ...but the PR branch's green never leaks INTO main's bucket.
      const mainAgain = await getLedger("branch=main");
      expect(mainAgain.entries["f/red"]).toBeUndefined();
    });

    test("branch query parameter is required", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/lg/last-green`, authed());
      expect(res.status).toBe(400);
    });
  });

  describe("drift ledger", () => {
    function getDriftLedger(project: string): Promise<{ project: string; specs: Record<string, { label: string | null; gitHead: string; runId: string }> }> {
      return fetch(`${baseUrl}/api/v1/projects/${project}/drift`, authed()).then(json);
    }

    test("pushing a kind:\"drift\" run advances the ledger, readable via GET /drift with no ?profile=", async () => {
      const sha = "e".repeat(40);
      const pushRes = await fetch(`${baseUrl}/api/v1/runs?project=dr&kind=drift&branch=main`, authed({
        method: "POST",
        body: makeDriftReportTarGz({ gitHead: sha }),
      }));
      expect(pushRes.status).toBe(201);

      const ledger = await getDriftLedger("dr");
      expect(ledger.specs["demo/test-drift"]).toMatchObject({ label: "TEST_DRIFT", gitHead: sha });
      expect(ledger.specs["demo/unknown-drift"]).toMatchObject({ label: "UNKNOWN", gitHead: sha });
      // Audited and clean (label: null) is distinct from never having a row at all.
      expect(ledger.specs["demo/clean"]).toMatchObject({ label: null, gitHead: sha });
      expect(ledger.specs["demo/never-audited"]).toBeUndefined();
    });

    test("a kind:\"run\" push does not touch the drift ledger", async () => {
      const res = await fetch(`${baseUrl}/api/v1/runs?project=dr-run&branch=main`, authed({
        method: "POST",
        body: makeReportTarGz({ status: "passed" }),
      }));
      expect(res.status).toBe(201);

      const ledger = await getDriftLedger("dr-run");
      expect(ledger.specs).toEqual({});
    });
  });

  describe("deploy log and re-run selection", () => {
    const PROJECT = "rr";

    function specEntry(specName: string) {
      return {
        specName,
        title: specName,
        summary: "",
        status: { mode: "deterministic", traced: true, generated: true },
      };
    }

    async function putPerspectives(): Promise<void> {
      const res = await fetch(`${baseUrl}/api/v1/projects/${PROJECT}/perspectives`, authed({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          features: [
            {
              featureName: "f",
              specs: [specEntry("a"), specEntry("b"), specEntry("unscoped")],
            },
          ],
        }),
      }));
      expect(res.status).toBe(204);
    }

    async function recordDeploy(body: Record<string, unknown>): Promise<any> {
      const res = await fetch(`${baseUrl}/api/v1/projects/${PROJECT}/deploys`, authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      expect(res.status).toBe(201);
      return json(res);
    }

    async function openRun(): Promise<any> {
      const res = await fetch(
        `${baseUrl}/api/v1/runs/open?project=${PROJECT}&branch=main&gitHead=${"e".repeat(40)}`,
        authed({ method: "POST" }),
      );
      expect(res.status).toBe(201);
      return json(res);
    }

    async function finishRun(id: string, rows: ReportSpecResult[]): Promise<any> {
      const res = await fetch(`${baseUrl}/api/v1/runs/${id}`, authed({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, done: true }),
      }));
      expect(res.status).toBe(200);
      return json(res);
    }

    function getRerun(): Promise<any> {
      return fetch(`${baseUrl}/api/v1/projects/${PROJECT}/rerun`, authed()).then(json);
    }

    /** Say the audit has already cleared these specs at the given commit. */
    async function auditClean(gitHead: string, specs: readonly string[] = ALL_SPECS): Promise<void> {
      const res = await fetch(`${baseUrl}/api/v1/runs?project=${PROJECT}&kind=drift&branch=main`, authed({
        method: "POST",
        headers: { "Content-Type": "application/gzip" },
        body: makeCleanAuditTarGz(gitHead, specs),
      }));
      expect(res.status).toBe(201);
    }

    const ALL_SPECS = ["f/a", "f/b", "f/unscoped"] as const;

    /** The shared starting point: one deploy, and a run of spec `f/b` that observed it. */
    async function baselineRun(): Promise<void> {
      await putPerspectives();
      await recordDeploy({ sha: "d1", previousSha: null, changedPaths: [] });
      const opened = await openRun();
      await finishRun(opened.id, [makeRow({ feature: "f", spec: "b", status: "passed" })]);
      await auditClean("d1");
    }

    test("a deploy's selection turns a spec rerunNeeded, verified, or unanswerable — independently per spec", async () => {
      await putPerspectives();
      await recordDeploy({ sha: "d1", previousSha: null, changedPaths: ["src/a/x.ts"] });
      await auditClean("d1");

      const opened = await openRun();
      expect(opened.deployedSha).toBe("d1");
      expect(opened.deployedShaSource).toBe("hub-deploy-log");
      await finishRun(opened.id, [
        makeRow({ feature: "f", spec: "a", status: "passed" }),
        makeRow({ feature: "f", spec: "b", status: "passed" }),
        makeRow({ feature: "f", spec: "unscoped", status: "passed" }),
      ]);

      const settled = await getRerun();
      expect(settled.deployHead).toMatchObject({ index: 0, sha: "d1" });
      expect(settled.specs["f/a"].verdict).toBe("verified");
      expect(settled.specs["f/b"].verdict).toBe("verified");
      expect(settled.specs["f/unscoped"].verdict).toBe("verified");

      await recordDeploy({
        sha: "d2",
        previousSha: "d1",
        changedPaths: ["src/a/y.ts", "docs/z.md"],
        selection: {
          "f/a": { verdict: "needed", reason: "touches src/a", touchedBy: ["src/a/y.ts"] },
          "f/b": { verdict: "notNeeded", reason: "no match" },
          "f/unscoped": { verdict: "unknown", reason: "could not tell" },
        },
      });
      // The audit has to catch up with d2 before the run axis is consulted:
      // until then every spec these deploys reached reads `inProgress`.
      expect((await getRerun()).specs["f/a"].verdict).toBe("inProgress");
      await auditClean("d2");

      const after = await getRerun();
      // The verdict names the deploy that caused it, not just the head.
      expect(after.specs["f/a"]).toMatchObject({
        verdict: "rerunNeeded",
        touchedBy: ["src/a/y.ts"],
        touchedByDeploy: { index: 1, sha: "d2" },
      });
      expect(after.specs["f/b"].verdict).toBe("verified");
      expect(after.specs["f/unscoped"]).toMatchObject({ verdict: "unanswerable", reason: "selectionUnknown" });
      expect(after.specs["f/a"].lastGreen.gitHead).toBe("e".repeat(40));
    });

    test("a deploy that does not chain onto the head leaves affected specs unanswerable, not verified", async () => {
      await baselineRun();
      const broken = await recordDeploy({ sha: "d9", previousSha: "never-seen", changedPaths: [] });
      expect(broken.gapBefore).toBe(true);
      expect((await getRerun()).specs["f/b"]).toMatchObject({ verdict: "unanswerable", reason: "gapInRange" });
    });

    test("a deploy recorded without a selection leaves affected specs unanswerable, not verified", async () => {
      await baselineRun();
      await recordDeploy({ sha: "d2", previousSha: "d1", changedPaths: ["src/b/z.ts"] });
      expect((await getRerun()).specs["f/b"]).toMatchObject({ verdict: "unanswerable", reason: "noSelectionInRange" });
    });

    test("a run that straddles a deploy is unanswerable rather than credited with either commit", async () => {
      await putPerspectives();
      await recordDeploy({ sha: "d1", previousSha: null, changedPaths: [] });
      const opened = await openRun();
      await recordDeploy({ sha: "d2", previousSha: "d1", changedPaths: ["docs/z.md"] });
      const finished = await finishRun(opened.id, [makeRow({ feature: "f", spec: "b", status: "passed" })]);
      await auditClean("d2");

      expect(finished.deployedShaAmbiguous).toBe(true);
      expect((await getRerun()).specs["f/b"]).toMatchObject({
        verdict: "unanswerable",
        reason: "ambiguousDeployedSha",
      });
    });

    test("a spec that has never run is rerunNeeded; a profile with no data at all is unanswerable", async () => {
      await putPerspectives();
      const untouched = await getRerun();
      expect(untouched.specs["f/a"]).toMatchObject({ verdict: "unanswerable", reason: "notEvaluated" });
      expect(untouched.deployHead).toBeNull();

      await recordDeploy({ sha: "d1", previousSha: null, changedPaths: ["src/a/x.ts"] });
      const opened = await openRun();
      await finishRun(opened.id, [makeRow({ feature: "f", spec: "a", status: "passed" })]);
      await auditClean("d1");

      const partial = await getRerun();
      expect(partial.specs["f/a"].verdict).toBe("verified");
      // No result at all is as uncovered as one a deploy invalidated, so it is
      // offered for a run rather than parked in a state of its own.
      expect(partial.specs["f/b"]).toMatchObject({ verdict: "rerunNeeded", execution: "neverRun" });
    });

    test("re-run selection 404s when the project has no perspectives document", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/no-doc/rerun`, authed());
      expect(res.status).toBe(404);
    });
  });

  describe("sessions (missing encryption key)", () => {
    test("PUT session without CCQA_HUB_ENCRYPTION_KEY configured returns 503", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/demo/sessions/default/admin`, authed({
        method: "PUT",
        body: JSON.stringify({ cookies: [], origins: [] }),
      }));
      expect(res.status).toBe(503);
    });
  });

  // Prompts are plain text, not secrets — the contract that separates them from
  // sessions/variables is exactly these three points. This `baseUrl` server runs
  // with `encryptionKey: null`, which is what makes the "no key needed" test meaningful.
  describe("prompts", () => {
    test("PUT then GET a prompt round-trips with no encryption key configured", async () => {
      const body = "# Guidance\n\nBe thorough.\n";
      const putRes = await fetch(`${baseUrl}/api/v1/projects/demo/prompts/record.agent`, authed({
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body,
      }));
      expect(putRes.status).toBe(204); // no 503, unlike sessions/variables above

      const getRes = await fetch(`${baseUrl}/api/v1/projects/demo/prompts/record.agent`, authed());
      expect(getRes.status).toBe(200);
      expect(await getRes.text()).toBe(body);

      const listRes = await fetch(`${baseUrl}/api/v1/projects/demo/prompts`, authed());
      const listed = (await listRes.json()) as { prompts: { name: string; kind: string }[] };
      expect(listed.prompts).toEqual([{ name: "record.agent", kind: "guidance", updatedAt: expect.any(String), meta: { kind: "guidance" } }]);
    });

    test("an unknown prompt name is rejected with 400", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/demo/prompts/not-a-real-name`, authed({
        method: "PUT",
        body: "x",
      }));
      expect(res.status).toBe(400);
    });

    test("GET a prompt that was never stored returns 404", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/demo/prompts/live.agent`, authed());
      expect(res.status).toBe(404);
    });

    test("triage.user round-trips as a markdown guidance prompt", async () => {
      const body = "Treat copy changes on the settings screen as SPEC_CHANGE.\n";
      const putRes = await fetch(`${baseUrl}/api/v1/projects/demo/prompts/triage.user`, authed({
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body,
      }));
      expect(putRes.status).toBe(204);

      const getRes = await fetch(`${baseUrl}/api/v1/projects/demo/prompts/triage.user`, authed());
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-type")).toContain("text/markdown");
      expect(await getRes.text()).toBe(body);
    });
  });

  describe("perspectives", () => {
    const doc = {
      generatedAt: "2026-07-13T00:00:00.000Z",
      features: [
        {
          featureName: "tasks",
          specs: [
            {
              specName: "search-tasks",
              title: "検索できる",
              summary: "検索の確認",
              status: { mode: "deterministic", traced: true, generated: true },
            },
          ],
        },
      ],
    };

    function putDoc() {
      return fetch(`${baseUrl}/api/v1/projects/demo/perspectives`, authed({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(doc),
      }));
    }

    test("PUT then GET round-trips; PATCH sets and clears the note", async () => {
      expect((await putDoc()).status).toBe(204);

      const getRes = await fetch(`${baseUrl}/api/v1/projects/demo/perspectives`, authed());
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-type")).toContain("application/json");
      expect(await json(getRes)).toEqual(doc);

      const patchRes = await fetch(`${baseUrl}/api/v1/projects/demo/perspectives`, authed({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feature: "tasks", spec: "search-tasks", note: "QA-owned" }),
      }));
      expect(patchRes.status).toBe(204);
      const withNote = await json(await fetch(`${baseUrl}/api/v1/projects/demo/perspectives`, authed()));
      expect(withNote.features[0].specs[0].note).toBe("QA-owned");

      // An empty note clears the field entirely rather than storing "".
      const clearRes = await fetch(`${baseUrl}/api/v1/projects/demo/perspectives`, authed({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feature: "tasks", spec: "search-tasks", note: "" }),
      }));
      expect(clearRes.status).toBe(204);
      const cleared = await json(await fetch(`${baseUrl}/api/v1/projects/demo/perspectives`, authed()));
      expect("note" in cleared.features[0].specs[0]).toBe(false);
    });

    test("PUT rejects non-JSON and non-object bodies with 400", async () => {
      const notJson = await fetch(`${baseUrl}/api/v1/projects/demo/perspectives`, authed({
        method: "PUT",
        body: "not json",
      }));
      expect(notJson.status).toBe(400);
      const array = await fetch(`${baseUrl}/api/v1/projects/demo/perspectives`, authed({
        method: "PUT",
        body: "[1,2]",
      }));
      expect(array.status).toBe(400);
    });

    test("GET without a stored doc, and PATCH on a missing doc/spec, return 404", async () => {
      const getRes = await fetch(`${baseUrl}/api/v1/projects/never-stored/perspectives`, authed());
      expect(getRes.status).toBe(404);

      const patchMissingDoc = await fetch(`${baseUrl}/api/v1/projects/never-stored/perspectives`, authed({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feature: "f", spec: "s", note: "x" }),
      }));
      expect(patchMissingDoc.status).toBe(404);

      expect((await putDoc()).status).toBe(204);
      const patchMissingSpec = await fetch(`${baseUrl}/api/v1/projects/demo/perspectives`, authed({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feature: "tasks", spec: "no-such-spec", note: "x" }),
      }));
      expect(patchMissingSpec.status).toBe(404);
    });
  });

  describe("sessions and variables (with encryption key configured)", () => {
    let keyedDataDir: string;
    let keyedServer: Server;
    let keyedBaseUrl: string;

    beforeEach(async () => {
      keyedDataDir = await mkdtemp(join(tmpdir(), "ccqa-hub-server-keyed-"));
      keyedServer = createHubServer({
        storage: createFileHubStorage(keyedDataDir),
        token: TOKEN,
        encryptionKey: Buffer.alloc(32, 1),
        allowedOrigins: [],
      });
      await new Promise<void>((resolvePromise) => keyedServer.listen(0, "127.0.0.1", resolvePromise));
      const address = keyedServer.address();
      if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
      keyedBaseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      keyedServer.closeAllConnections();
      await new Promise<void>((resolvePromise) => keyedServer.close(() => resolvePromise()));
      await rm(keyedDataDir, { recursive: true, force: true });
    });

    test("PUT then GET a session round-trips the decrypted storage state", async () => {
      const storageState = { cookies: [], origins: [] };
      const putRes = await fetch(`${keyedBaseUrl}/api/v1/projects/demo/sessions/default/admin`, authed({
        method: "PUT",
        body: JSON.stringify(storageState),
      }));
      expect(putRes.status).toBe(204);

      const getRes = await fetch(`${keyedBaseUrl}/api/v1/projects/demo/sessions/default/admin`, authed());
      expect(getRes.status).toBe(200);
      expect(await json(getRes)).toEqual(storageState);
    });

    test("GET variables with ?include=values returns a previously-PUT sensitive variable's decrypted value", async () => {
      const putRes = await fetch(`${keyedBaseUrl}/api/v1/projects/demo/variables/default/api-key`, authed({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "secret-value", sensitive: true }),
      }));
      expect(putRes.status).toBe(204);

      const listRes = await fetch(`${keyedBaseUrl}/api/v1/projects/demo/variables/default?include=values`, authed());
      const { variables } = await json(listRes);
      expect(variables).toEqual([{ name: "api-key", sensitive: true, updatedAt: expect.any(String), value: "secret-value" }]);
    });

    test("GET /api/v1/projects unions and sorts projects across runs and variables", async () => {
      // Independent writes to different projects — do both at once.
      const [putRes, pushRes] = await Promise.all([
        fetch(`${keyedBaseUrl}/api/v1/projects/beta/variables/default/some-name`, authed({
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "v", sensitive: false }),
        })),
        fetch(`${keyedBaseUrl}/api/v1/runs?project=alpha`, authed({
          method: "POST",
          body: makeReportTarGz({ status: "passed" }),
        })),
      ]);
      expect(putRes.status).toBe(204);
      expect(pushRes.status).toBe(201);

      const res = await fetch(`${keyedBaseUrl}/api/v1/projects`, authed());
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toEqual({ projects: ["alpha", "beta"] });
    });
  });

  describe("GET /api/v1/projects", () => {
    test("without a token returns 401", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects`);
      expect(res.status).toBe(401);
      const body = await json(res);
      expect(body.error.code).toBe("unauthorized");
    });

    test("with no data pushed returns an empty list", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects`, authed());
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toEqual({ projects: [] });
    });
  });

  describe("GET /api/v1/projects/:project/profiles", () => {
    test("without a token returns 401", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/demo/profiles`);
      expect(res.status).toBe(401);
    });

    test("always offers 'default', and unions distinct profiles from stored secrets", async () => {
      // A secret under a non-default profile makes that profile show up (prompts
      // are project-wide, so only sessions/variables define profiles). Seed via
      // the storage handle directly — a variable PUT over HTTP needs an
      // encryption key this server isn't configured with.
      await storage.variables.put({ project: "demo", profile: "stg" }, "api-key", new Uint8Array([1, 2, 3]));

      const res = await fetch(`${baseUrl}/api/v1/projects/demo/profiles`, authed());
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toEqual({ profiles: ["default", "stg"] });
    });

    test("returns just 'default' for a project with no stored profiles", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/untouched/profiles`, authed());
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ profiles: ["default"] });
    });
  });

  describe("learning jobs", () => {
    // Learning always needs Claude auth on the hub, which this test server
    // doesn't configure — so a job always ends up "failed" here. The success
    // path (Claude actually invoked) is covered by learning-worker.test.ts
    // with an injected mock; these tests exercise the HTTP/queue wiring.
    async function seedGradedCase(): Promise<void> {
      await storage.runs.create({
        id: "run-lj", project: "demo", profile: null, branch: null, status: "failed",
        kind: "run", drift: null,
        specs: { total: 1, passed: 0, failed: 1 }, gitHead: null, promptVersion: "4",
        ciRunId: null, reportCreatedAt: "2026-07-01T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z",
      });
      await storage.triage.putActualCause("run-lj", {
        feature: "login", spec: "happy",
        predicted: { label: "TEST_DRIFT", confidence: 0.8, headline: "button not found" },
        actualCause: "PRODUCT_BUG", promptVersion: "4", recordedAt: "2026-07-02T00:00:00.000Z",
      });
    }

    /** Poll the job detail endpoint until it reaches a terminal status. */
    async function waitForJob(jobId: string): Promise<Record<string, unknown>> {
      for (let i = 0; i < 50; i++) {
        const res = await fetch(`${baseUrl}/api/v1/projects/demo/learning-jobs/${jobId}`, authed());
        const job = await json(res);
        if (job.status === "succeeded" || job.status === "failed") return job;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("job did not finish in time");
    }

    test("POST creates+enqueues a job that fails without Claude auth on the hub", async () => {
      await seedGradedCase();
      const postRes = await fetch(`${baseUrl}/api/v1/projects/demo/learning-jobs`, authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: "default" }),
      }));
      expect(postRes.status).toBe(202);
      const created = await json(postRes);
      expect(created.status).toBe("queued");

      const job = await waitForJob(created.id);
      expect(job.status).toBe("failed");
      expect(job.error).toMatch(/needs Claude auth/);
    });

    test("a job with no graded cases fails with a clear reason", async () => {
      const postRes = await fetch(`${baseUrl}/api/v1/projects/demo/learning-jobs`, authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: "default" }),
      }));
      const created = await json(postRes);
      const job = await waitForJob(created.id);
      expect(job.status).toBe("failed");
      // No Claude auth on this test hub is checked first, before the graded-cases
      // check — either reason is a valid "fails with a clear reason" outcome.
      expect(job.error).toMatch(/needs Claude auth|no graded triage cases/);
    });

    test("GET list omits before/after bodies and reflects a failed job", async () => {
      await seedGradedCase();
      const postRes = await fetch(`${baseUrl}/api/v1/projects/demo/learning-jobs`, authed({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: "default" }),
      }));
      const created = await json(postRes);
      await waitForJob(created.id);

      const listRes = await fetch(`${baseUrl}/api/v1/projects/demo/learning-jobs`, authed());
      const { jobs } = await json(listRes);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].result).toBeUndefined();
      expect(jobs[0].customPromptVersion).toBeNull();
    });

    test("without a token returns 401", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects/demo/learning-jobs`);
      expect(res.status).toBe(401);
    });
  });
});
