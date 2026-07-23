import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptySpecRow } from "../report/spec-row.ts";
import type { ReportEvidence, ReportSpecResult } from "../report/schema.ts";
import { readRowFilesBase64, readRowsFilesBase64 } from "./pipeline.ts";

/** A minimal step-evidence entry pointing at `pngPath` (and optional before). */
function evidence(pngPath: string, beforePngPath?: string): ReportEvidence {
  return {
    stepId: "step-01",
    source: "spec",
    pngPath,
    ...(beforePngPath ? { beforePngPath } : {}),
    url: null,
    title: null,
    capturedAt: null,
    description: null,
    status: "passed",
    failureSummary: null,
  };
}

let reportDir: string;

beforeEach(async () => {
  reportDir = await mkdtemp(join(tmpdir(), "ccqa-rowfiles-"));
});

afterEach(async () => {
  await rm(reportDir, { recursive: true, force: true });
});

async function writeReportFile(rel: string, contents: string): Promise<void> {
  const abs = join(reportDir, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, contents, "utf8");
}

describe("readRowFilesBase64", () => {
  it("uploads a script-driven row's step evidence (before + after) and its artifacts", async () => {
    await writeReportFile("evidence/demo/x/step-01.before.png", "before-bytes");
    await writeReportFile("evidence/demo/x/step-01.png", "after-bytes");
    await writeReportFile("artifacts/demo__x/output.log", "log");

    const row: ReportSpecResult = {
      ...emptySpecRow({ feature: "demo", spec: "x", title: null, status: "failed" }),
      evidence: [
        {
          stepId: "step-01",
          source: "spec",
          pngPath: "evidence/demo/x/step-01.png",
          beforePngPath: "evidence/demo/x/step-01.before.png",
          url: null,
          title: null,
          capturedAt: null,
          description: null,
          status: "passed",
          failureSummary: null,
        },
      ],
      artifacts: [{ name: "output.log", path: "artifacts/demo__x/output.log", kind: "text", sizeBytes: 3 }],
    };

    const files = await readRowFilesBase64(row, reportDir);
    // Both boundary shots must be present — the regression was that evidence
    // PNGs were never uploaded, so --push-report shipped a report whose
    // deterministic screenshots 404'd on the hub.
    expect(Buffer.from(files["evidence/demo/x/step-01.before.png"]!, "base64").toString()).toBe(
      "before-bytes",
    );
    expect(Buffer.from(files["evidence/demo/x/step-01.png"]!, "base64").toString()).toBe(
      "after-bytes",
    );
    expect(files["artifacts/demo__x/output.log"]).toBeDefined();
  });

  it("skips a missing evidence file without failing the row", async () => {
    const row: ReportSpecResult = {
      ...emptySpecRow({ feature: "demo", spec: "x", title: null, status: "failed" }),
      evidence: [evidence("evidence/demo/x/gone.png")],
    };
    expect(await readRowFilesBase64(row, reportDir)).toEqual({});
  });
});

describe("readRowsFilesBase64 (seal-time evidence for deterministic rows)", () => {
  it("collects evidence across several rows so det step PNGs reach the hub", async () => {
    await writeReportFile("evidence/demo/a/step-01.png", "a-shot");
    await writeReportFile("evidence/demo/b/step-01.png", "b-shot");
    const rows: ReportSpecResult[] = [
      {
        ...emptySpecRow({ feature: "demo", spec: "a", title: null, status: "failed" }),
        evidence: [evidence("evidence/demo/a/step-01.png")],
      },
      {
        ...emptySpecRow({ feature: "demo", spec: "b", title: null, status: "passed" }),
        evidence: [evidence("evidence/demo/b/step-01.png")],
      },
    ];
    const files = await readRowsFilesBase64(rows, reportDir);
    // This is the ONLY delivery path for deterministic evidence under
    // --push-report (det rows never pass through the mid-run sink), so both
    // rows' PNGs must be present or the hub UI's det frames 404.
    expect(Buffer.from(files["evidence/demo/a/step-01.png"]!, "base64").toString()).toBe("a-shot");
    expect(Buffer.from(files["evidence/demo/b/step-01.png"]!, "base64").toString()).toBe("b-shot");
  });
});
