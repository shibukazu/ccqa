import { describe, test, expect } from "vitest";
import { applyDiagnosis, applyOverAssertion, applySelectorDrift, applyTiming, previewDiff } from "./apply.ts";

const SCRIPT = [
  `import { test } from "vitest";`,
  `import { ab, abAssertVisible } from "ccqa/test-helpers";`,
  ``,
  `test("demo", () => {`,
  `  ab("open", "http://localhost:3000");`,
  `  spawnSync("sleep", ["3"], { stdio: "inherit" });`,
  `  ab("fill", "[name='q']", "hello");`,
  `  ab("press", "Enter");`,
  `  abAssertVisible("[aria-label='Old']");`,
  `  abAssertVisible("[role='banner']");`,
  `});`,
].join("\n");

describe("applyTiming", () => {
  test("inserts a sleep at the given line (1-based, before)", () => {
    const out = applyTiming(SCRIPT, [{ kind: "insert", line: 8, seconds: 2, reason: "after press" }]);
    expect(out.applied).toBe(true);
    if (!out.applied) return;
    const lines = out.script.split("\n");
    expect(lines[7]).toContain(`spawnSync("sleep", ["2"]`);
  });

  test("increases an existing sleep", () => {
    const out = applyTiming(SCRIPT, [{ kind: "increase", line: 6, increase_to: 7, reason: "slow" }]);
    expect(out.applied).toBe(true);
    if (!out.applied) return;
    expect(out.script).toContain(`spawnSync("sleep", ["7"]`);
    expect(out.script).not.toContain(`spawnSync("sleep", ["3"]`);
  });

  test("bails when no fixes", () => {
    expect(applyTiming(SCRIPT, []).applied).toBe(false);
  });

  test("bails when increase target line has no sleep", () => {
    const out = applyTiming(SCRIPT, [{ kind: "increase", line: 5, increase_to: 9, reason: "x" }]);
    expect(out.applied).toBe(false);
  });
});

describe("applyOverAssertion", () => {
  test("removes assertion lines (preserves indices via descending sort)", () => {
    const out = applyOverAssertion(SCRIPT, [9, 10]);
    expect(out.applied).toBe(true);
    if (!out.applied) return;
    expect(out.script).not.toContain("[aria-label='Old']");
    expect(out.script).not.toContain("[role='banner']");
  });

  test("refuses to delete non-assertion lines", () => {
    const out = applyOverAssertion(SCRIPT, [5]);
    expect(out.applied).toBe(false);
  });

  test("bails on empty list", () => {
    expect(applyOverAssertion(SCRIPT, []).applied).toBe(false);
  });
});

describe("applySelectorDrift", () => {
  test("replaces selector on the given line", () => {
    const out = applySelectorDrift(SCRIPT, 9, "[aria-label='Old']", "[aria-label='New']");
    expect(out.applied).toBe(true);
    if (!out.applied) return;
    expect(out.script).toContain("[aria-label='New']");
    expect(out.script).not.toContain("[aria-label='Old']");
  });

  test("bails when oldSelector not present on the line", () => {
    const out = applySelectorDrift(SCRIPT, 9, "[aria-label='WRONG']", "[aria-label='New']");
    expect(out.applied).toBe(false);
  });
});

describe("applyDiagnosis dispatch", () => {
  test("DATA_MISSING bails", () => {
    const out = applyDiagnosis(SCRIPT, { type: "DATA_MISSING", reason: "no record" });
    expect(out.applied).toBe(false);
  });
  test("UNKNOWN bails", () => {
    const out = applyDiagnosis(SCRIPT, { type: "UNKNOWN", reason: "?" });
    expect(out.applied).toBe(false);
  });
});

describe("previewDiff", () => {
  test("emits -/+ pairs for changed lines", () => {
    const before = "a\nb\nc";
    const after = "a\nB\nc";
    expect(previewDiff(before, after)).toBe("- b\n+ B");
  });
});
