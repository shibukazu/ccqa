import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ccqaStepAfter, ccqaStepBefore, type CcqaEvidencePage } from "./step-evidence.ts";

let dir: string;
const prev = process.env["CCQA_EVIDENCE_DIR"];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ccqa-step-ev-"));
  process.env["CCQA_EVIDENCE_DIR"] = dir;
});

afterEach(async () => {
  if (prev === undefined) delete process.env["CCQA_EVIDENCE_DIR"];
  else process.env["CCQA_EVIDENCE_DIR"] = prev;
  await rm(dir, { recursive: true, force: true });
});

/** A page that records the screenshot paths it was asked to write and touches them on disk. */
function fakePage(over: Partial<CcqaEvidencePage> = {}): CcqaEvidencePage & { shots: string[] } {
  const shots: string[] = [];
  return {
    shots,
    async screenshot({ path }) {
      shots.push(path);
      await (await import("node:fs/promises")).writeFile(path, "png");
    },
    url: () => "https://example.test/page",
    title: async () => "Example",
    ...over,
  };
}

async function meta(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as Record<string, unknown>;
}

describe("ccqaStepBefore / ccqaStepAfter", () => {
  it("writes the before/after PNGs and a meta pair the report loader consumes", async () => {
    const page = fakePage();
    await ccqaStepBefore(page, "step-01", "spec");
    await ccqaStepAfter(page, "step-01", "spec");

    const files = (await readdir(dir)).sort();
    expect(files).toEqual(["step-01.before.png", "step-01.json", "step-01.png"]);
    const m = await meta("step-01");
    // The after shot is the primary; the before rides along as beforePngFile.
    expect(m["pngFile"]).toBe("step-01.png");
    expect(m["beforePngFile"]).toBe("step-01.before.png");
    expect(m["url"]).toBe("https://example.test/page");
    expect(m["title"]).toBe("Example");
    // The "did not complete" caption from the before shot is cleared on close.
    expect(m["failureSummary"]).toBeUndefined();
  });

  it("leaves the before shot marked incomplete when the step never closes", async () => {
    const page = fakePage();
    await ccqaStepBefore(page, "step-02", "spec");
    // No ccqaStepAfter — the test died mid-step.
    const m = await meta("step-02");
    expect(m["pngFile"]).toBe("step-02.before.png");
    expect(m["failureSummary"]).toContain("stopped inside this step");
  });

  it("clears the incomplete caption when the step finished but its closing shot failed", async () => {
    // Entry shot succeeds; closing shot fails. The step DID complete — it just
    // lost its final frame — so it must not stay marked failed.
    let call = 0;
    const page = fakePage({
      async screenshot({ path }) {
        call += 1;
        if (call === 1) {
          await (await import("node:fs/promises")).writeFile(path, "png");
          return;
        }
        throw new Error("browser closed before closing shot");
      },
    });
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await ccqaStepBefore(page, "step-03", "spec");
    await ccqaStepAfter(page, "step-03", "spec");
    warn.mockRestore();

    const m = await meta("step-03");
    // Entry shot stays the frame, and the "stopped inside this step" caption is gone.
    expect(m["pngFile"]).toBe("step-03.before.png");
    expect(m["failureSummary"]).toBeUndefined();
    expect(m["beforePngFile"]).toBeUndefined();
  });

  it("no-ops when CCQA_EVIDENCE_DIR is unset", async () => {
    delete process.env["CCQA_EVIDENCE_DIR"];
    const page = fakePage();
    await ccqaStepBefore(page, "step-01", "spec");
    await ccqaStepAfter(page, "step-01", "spec");
    expect(page.shots).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("never throws when the screenshot fails", async () => {
    const page = fakePage({
      screenshot: () => Promise.reject(new Error("browser closed")),
    });
    const warn = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(ccqaStepAfter(page, "step-01", "spec")).resolves.toBeUndefined();
    // A capture miss writes no meta and does not raise.
    expect(await readdir(dir)).toEqual([]);
    warn.mockRestore();
  });
});
