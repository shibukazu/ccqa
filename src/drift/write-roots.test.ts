import { describe, expect, test } from "vitest";
import { correctSurface } from "./write-roots.ts";
import type { DriftDiagnosis } from "./types.ts";

const AREA = {
  cwd: "/repo",
  writeRoots: ["e2e/generated"],
  testPath: "e2e/specs/todos.spec.ts",
  sourceRoots: ["/product/app"],
};

function finding(...files: string[]): DriftDiagnosis {
  return {
    label: "TEST_DRIFT",
    confidence: 0.9,
    surface: "generated",
    subDiagnosis: "SELECTOR_DRIFT",
    headline: "the navigation bar is addressed by a class the product no longer renders",
    recommendation: "update the shared component's selector",
    reasoning: "the product renders mainnavbar; the test asks for main-nav-bar",
    evidence: files.map((file) => ({ file, detail: "the class is written here" })),
  };
}

const SHARED = "shared_components/nav/main_nav_bar.ts:18";
const PRODUCT = "/product/app/Nav.tsx:18";

describe("correctSurface", () => {
  test("a finding whose repair is a shared asset is taken off the generated surface, and says so", () => {
    const drift = finding(SHARED, PRODUCT);
    correctSurface(drift, AREA);
    expect(drift.surface).toBe("spec");
    expect(drift.reasoning).toContain("main_nav_bar.ts");
    expect(drift.reasoning).toContain("writeRoots");
  });

  test("a finding on a page object ccqa wrote stays where the model put it", () => {
    const drift = finding("e2e/generated/pages/todos.ts:4", PRODUCT);
    correctSurface(drift, AREA);
    expect(drift.surface).toBe("generated");
    expect(drift.reasoning).not.toContain("[ccqa]");
  });

  // Ordinary selector drift: the only file named is the product's own, because
  // that is where the new name is. Regenerating is exactly the repair, and
  // counting the product source as "outside" would take it away.
  test("a finding that names only the product source is left alone", () => {
    const drift = finding(PRODUCT);
    correctSurface(drift, AREA);
    expect(drift.surface).toBe("generated");
  });

  // The shared asset is where the repair goes, but the generated test is named
  // too — regenerating it is still part of the answer.
  test("a finding that names both the shared asset and the test keeps its surface", () => {
    const drift = finding(SHARED, "e2e/specs/todos.spec.ts:9");
    correctSurface(drift, AREA);
    expect(drift.surface).toBe("generated");
  });

  test("a project that has not declared writeRoots is left alone", () => {
    const drift = finding(SHARED);
    correctSurface(drift, { ...AREA, writeRoots: [] });
    expect(drift.surface).toBe("generated");
  });

  // A flat `{case}.spec.ts` template would otherwise make the whole project
  // ccqa's, and hide every asset this check is about.
  test("only the generated file is ccqa's, not the directory holding it", () => {
    const drift = finding("e2e/support/nav.ts:3");
    correctSurface(drift, { ...AREA, testPath: "e2e/todos.spec.ts" });
    expect(drift.surface).toBe("spec");
  });

  // A citation may name a file and no line, and one that does is still a file.
  test("a bare path counts as a citation", () => {
    const drift = finding("shared_components/nav/main_nav_bar.ts");
    correctSurface(drift, AREA);
    expect(drift.surface).toBe("spec");
  });

  test("log-only evidence beside a cited file does not disable the correction", () => {
    const drift = finding(SHARED);
    drift.evidence.push({ detail: "the step log shows the click finding nothing" });
    correctSurface(drift, AREA);
    expect(drift.surface).toBe("spec");
  });
});
