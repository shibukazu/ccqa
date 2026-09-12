// Stands in for the project's own test runner. It does the one thing ccqa
// depends on such a runner for: it writes the step evidence into
// CCQA_EVIDENCE_DIR, in the shape `ccqa/step-evidence` writes it — so the
// review table has pictures without this fixture needing a browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CCQA_EVIDENCE_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  for (const stepId of ["step-01", "step-04"]) {
    writeFileSync(join(dir, `${stepId}.png`), png);
    writeFileSync(
      join(dir, `${stepId}.json`),
      JSON.stringify({
        stepId,
        source: "case",
        pngFile: `${stepId}.png`,
        url: "https://example.test/notes",
        title: "Notes",
        capturedAt: new Date().toISOString(),
      }),
    );
  }
}
