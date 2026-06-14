import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIDENCE_THRESHOLD, decide, runAutoFixLoop } from "./loop.ts";
import type { DiagnosisResult } from "./types.ts";

function result(confidence: number): DiagnosisResult {
  return {
    diagnosis: { type: "SELECTOR_DRIFT", oldSelector: "x", newSelector: "y", line: 1, reason: "" },
    confidence,
    reasoning: "",
  };
}

describe("decide", () => {
  test("auto mode still skips low-confidence diagnoses (the threshold gates every mode)", () => {
    // Regression: previously `auto` bypassed the threshold and applied
    // 0.20-confidence selector swaps over working code. CI should fail
    // visibly, not silently corrupt the script.
    expect(decide(result(0.2), "auto")).toBe("skip-low-confidence");
  });

  test("auto mode applies when confidence is at or above the threshold", () => {
    expect(decide(result(DEFAULT_CONFIDENCE_THRESHOLD), "auto")).toBe("apply-auto");
    expect(decide(result(0.95), "auto")).toBe("apply-auto");
  });

  test("non-interactive mode behaves identically to auto", () => {
    expect(decide(result(0.2), "non-interactive")).toBe("skip-low-confidence");
    expect(decide(result(0.9), "non-interactive")).toBe("apply-auto");
  });

  test("interactive mode falls through to a prompt below the threshold", () => {
    expect(decide(result(0.2), "interactive")).toBe("interactive");
    expect(decide(result(0.9), "interactive")).toBe("apply-auto");
  });

  test("threshold boundary is inclusive", () => {
    const justBelow = DEFAULT_CONFIDENCE_THRESHOLD - 0.0001;
    expect(decide(result(justBelow), "auto")).toBe("skip-low-confidence");
    expect(decide(result(DEFAULT_CONFIDENCE_THRESHOLD), "auto")).toBe("apply-auto");
  });
});

vi.mock("./diagnose.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./diagnose.ts")>();
  return { ...actual, diagnose: vi.fn() };
});

describe("runAutoFixLoop — SDK error handling", () => {
  let tmp: string;
  let scriptPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ccqa-loop-test-"));
    scriptPath = join(tmp, "test.spec.ts");
    await writeFile(scriptPath, "// initial script\n", "utf8");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("bails gracefully (returns false) when diagnose throws — e.g. claude-agent-sdk maxTurns reached", async () => {
    // Regression: the SDK throws inside the async-iteration loop instead of
    // yielding a result with is_error:true when maxTurns is reached. The
    // auto-fix loop must catch the throw and bail out, not let it abort
    // the whole `ccqa generate` process.
    const { diagnose } = await import("./diagnose.ts");
    vi.mocked(diagnose).mockRejectedValueOnce(
      new Error("Claude Code returned an error result: Reached maximum number of turns (10)"),
    );

    const runVitest = vi.fn();
    const passed = await runAutoFixLoop({
      scriptPath,
      initialRun: { exitCode: 1, output: "FAIL: something", currentScript: "// initial script\n" },
      specYaml: "title: t\nsteps:\n  - instruction: do\n    expected: thing",
      actions: [],
      maxRetries: 3,
      mode: "auto",
      runVitest,
    });

    expect(passed).toBe(false);
    expect(runVitest).not.toHaveBeenCalled();
    // The script on disk must remain untouched when diagnose blew up — we
    // never want the loop to half-write something on a thrown SDK call.
    const onDisk = await readFile(scriptPath, "utf8");
    expect(onDisk).toBe("// initial script\n");
  });
});
