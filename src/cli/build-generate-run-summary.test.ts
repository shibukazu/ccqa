import { describe, expect, it } from "vitest";
import { buildGenerateRunSummary } from "./build-generate-run-summary.ts";
import type { GenerateResult } from "../targets/types.ts";

const cwd = "/repo";

function result(over: Partial<GenerateResult> = {}): GenerateResult {
  return {
    files: [{ path: "/repo/e2e/tasks/create.spec.ts", kind: "test" }],
    summary: "compiled from 5 recorded actions",
    warnings: [],
    passed: true,
    ...over,
  };
}

describe("buildGenerateRunSummary", () => {
  it("reports outcome, cwd-relative files, and the generation summary", () => {
    const s = buildGenerateRunSummary("playwright", "tasks", "create", result(), cwd);
    expect(s).toContain("## playwright generation — tasks/create");
    expect(s).toContain("verification: passed");
    expect(s).toContain("- e2e/tasks/create.spec.ts (test)");
    expect(s).toContain("compiled from 5 recorded actions");
    expect(s).toContain("### Warnings\n- (none)");
  });

  it("surfaces a failed verification and its warnings as the learning signal", () => {
    const s = buildGenerateRunSummary(
      "runn",
      "api",
      "create-task",
      result({ passed: false, warnings: ["step step-02 is missing its capture calls"] }),
      cwd,
    );
    expect(s).toContain("verification: FAILED (auto-fix exhausted)");
    expect(s).toContain("- step step-02 is missing its capture calls");
  });
});
