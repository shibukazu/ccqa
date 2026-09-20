import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvidenceForSpec } from "./evidence.ts";

describe("the order a case's screenshots read in", () => {
  it("puts the steps first, then the cleanup, then the failure capture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-evidence-order-"));
    try {
      // Written out of order on purpose: the directory listing is not the
      // order, and `cleanup-01` sorts before `step-01` by id alone.
      for (const stepId of ["cleanup-01", "failure", "step-02", "step-01"]) {
        await writeFile(join(dir, `${stepId}.png`), "png");
        await writeFile(
          join(dir, `${stepId}.json`),
          JSON.stringify({
            stepId,
            source: "case",
            pngFile: `${stepId}.png`,
            url: null,
            title: null,
            capturedAt: null,
          }),
        );
      }
      const loaded = await loadEvidenceForSpec(dir, dir, new Map());
      expect(loaded!.map((e) => e.stepId)).toEqual([
        "step-01",
        "step-02",
        "cleanup-01",
        "failure",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
