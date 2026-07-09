import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createIncrementalReport, type ReportEnvelope } from "./incremental-report.ts";
import { RunReportDataSchema, type ReportSpecResult } from "../report/schema.ts";

const ENVELOPE: ReportEnvelope = {
  schemaVersion: 1,
  kind: "run",
  createdAt: "2020-01-01T00:00:00.000Z",
  runId: null,
  git: { head: null, base: null },
  model: null,
  language: null,
  promptVersion: "1",
  customPromptVersion: null,
};

function row(feature: string, spec: string, status: "passed" | "failed" = "passed"): ReportSpecResult {
  return {
    feature,
    spec,
    title: null,
    status,
    testCounts: null,
    durationMs: null,
    assertions: null,
    analysis: null,
    analysisSkipped: null,
    driftIssues: null,
    failureLogExcerpt: null,
    diffExcerpt: null,
    specYaml: null,
    evidence: null,
    liveRun: null,
  };
}

describe("createIncrementalReport", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccqa-inc-report-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const readReport = async () => JSON.parse(await readFile(join(dir, "report.json"), "utf8"));

  test("writes a schema-valid report after each upsert (partial report is valid)", async () => {
    const report = createIncrementalReport(dir, ENVELOPE);

    await report.upsert(row("f", "a"));
    let data = await readReport();
    expect(RunReportDataSchema.safeParse(data).success).toBe(true);
    expect(data.results).toHaveLength(1);

    await report.upsert(row("f", "b", "failed"));
    data = await readReport();
    expect(RunReportDataSchema.safeParse(data).success).toBe(true);
    expect(data.results.map((r: ReportSpecResult) => r.spec)).toEqual(["a", "b"]);
  });

  test("upsert replaces a row by feature/spec instead of duplicating", async () => {
    const report = createIncrementalReport(dir, ENVELOPE);
    await report.upsert(row("f", "a", "failed"));
    await report.upsert(row("f", "a", "passed"));
    const data = await readReport();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].status).toBe("passed");
  });

  test("concurrent upserts all land and never leave a truncated file", async () => {
    const report = createIncrementalReport(dir, ENVELOPE);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => report.upsert(row("f", `s${i}`))),
    );
    const data = await readReport();
    expect(RunReportDataSchema.safeParse(data).success).toBe(true);
    expect(data.results).toHaveLength(20);
  });

  test("preserves the envelope fields verbatim", async () => {
    const report = createIncrementalReport(dir, { ...ENVELOPE, model: "opus" });
    await report.upsert(row("f", "a"));
    const data = await readReport();
    expect(data.model).toBe("opus");
    expect(data.promptVersion).toBe("1");
    expect(data.schemaVersion).toBe(1);
  });

  test("notifies the sink after each upsert, in order, with the row", async () => {
    const seen: string[] = [];
    const report = createIncrementalReport(dir, ENVELOPE, {
      onUpsert: (r) => {
        seen.push(`${r.feature}/${r.spec}`);
      },
    });
    await report.upsert(row("f", "a"));
    await report.upsert(row("f", "b"));
    expect(seen).toEqual(["f/a", "f/b"]);
  });

  test("sink runs only after the row is flushed to disk", async () => {
    let flushedWhenSinkRan: number | null = null;
    const report = createIncrementalReport(dir, ENVELOPE, {
      onUpsert: async () => {
        flushedWhenSinkRan = (await readReport()).results.length;
      },
    });
    await report.upsert(row("f", "a"));
    expect(flushedWhenSinkRan).toBe(1);
  });

  test("a throwing sink is best-effort: the flush chain and later rows survive", async () => {
    const report = createIncrementalReport(dir, ENVELOPE, {
      onUpsert: () => {
        throw new Error("hub down");
      },
    });
    await report.upsert(row("f", "a"));
    await report.upsert(row("f", "b"));
    const data = await readReport();
    expect(RunReportDataSchema.safeParse(data).success).toBe(true);
    expect(data.results.map((r: ReportSpecResult) => r.spec)).toEqual(["a", "b"]);
  });
});
