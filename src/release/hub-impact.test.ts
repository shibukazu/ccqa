import { describe, expect, test } from "vitest";
import { classifyRelease, renderVerdict, type Bump } from "./hub-impact.ts";

const classify = (bump: Bump, changedPaths: string[] | null, removedWireNames: string[] = []) =>
  classifyRelease({ bump, changedPaths, removedWireNames });

describe("classifyRelease", () => {
  test("the hub's own source, its entry point and its image all leave a deployed hub stale", () => {
    const verdict = classify("minor", ["src/hub/ui/index.ts", "src/cli/serve.ts", "Dockerfile", "README.md"]);

    expect(verdict.impact).toBe("hub-source");
    expect(verdict.hubPaths).toEqual(["src/hub/ui/index.ts", "src/cli/serve.ts", "Dockerfile"]);
    expect(verdict.disagreement).toBeNull();
  });

  test("a contract schema answers the stronger question, though it sits under src/hub/", () => {
    const verdict = classify("minor", ["src/hub/contract/schema.ts", "src/hub/core/rerun.ts"]);

    expect(verdict.impact).toBe("wire-contract");
    expect(verdict.wirePaths).toEqual(["src/hub/contract/schema.ts"]);
    expect(verdict.hubPaths).toEqual(["src/hub/core/rerun.ts"]);
  });

  test("the client the CLI talks to the hub with is not the contract it talks over", () => {
    const verdict = classify("patch", ["src/hub-client/index.ts", "src/run/execute.ts", "docs/hub.md"]);

    expect(verdict.impact).toBe("cli-only");
    expect(verdict.disagreement).toBeNull();
  });

  test("a test beside the hub's source ships nowhere, so it is not hub source", () => {
    expect(classify("patch", ["src/hub/core/queue.test.ts"]).impact).toBe("cli-only");
  });

  test("a patch that touched the hub is stopped, and told which bump carries it", () => {
    const verdict = classify("patch", ["src/hub/ui/index.ts"]);

    expect(verdict.disagreement).toEqual({
      requiredBump: "minor",
      reason: expect.stringContaining("hub's own source"),
    });
  });

  test("a name the contract dropped demands major, even from a minor that only added paths", () => {
    const verdict = classify("minor", ["src/hub/contract/schema.ts"], ["RunSchema.specsWithIssues"]);

    expect(verdict.disagreement?.requiredBump).toBe("major");
    expect(classify("major", ["src/hub/contract/schema.ts"], ["RunSchema.specsWithIssues"]).disagreement).toBeNull();
  });

  test("no previous tag rules nothing out — and so stops nothing", () => {
    const verdict = classify("patch", null);

    expect(verdict.impact).toBe("unknown");
    expect(verdict.disagreement).toBeNull();
  });
});

describe("renderVerdict", () => {
  test("an override is printed with its reason, not swallowed", () => {
    const verdict = classify("patch", ["src/hub/core/queue.ts"]);
    const markdown = renderVerdict(verdict, { base: "v1.0.0", override: "test-only change to a hub fixture" });

    expect(markdown).toContain("**Overridden:**");
    expect(markdown).toContain("test-only change to a hub fixture");
  });
});
