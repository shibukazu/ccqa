import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SpecArtifacts } from "./artifacts.ts";
import { renderAuditInputs, writeAuditInputs, type AuditInputs } from "./dump-inputs.ts";

/** A neutral deterministic case: a spec.yaml with nothing generated yet, and no source roots. */
function artifacts(overrides: Partial<SpecArtifacts> = {}): SpecArtifacts {
  return {
    intent: { kind: "spec", path: ".ccqa/features/demo/test-cases/sample/spec.yaml", body: "title: Sample\nsteps: []" },
    generated: [],
    reached: [],
    unaudited: [],
    live: false,
    title: "Sample",
    ...overrides,
  };
}

function inputs(overrides: Partial<AuditInputs> = {}): AuditInputs {
  return {
    caseId: "demo/sample",
    artifacts: artifacts(),
    sourceRoots: [],
    systemPrompt: "You audit the case.",
    userPrompt: "Audit this case.",
    ...overrides,
  };
}

describe("renderAuditInputs", () => {
  test("lists each reached file with what reached it and whether it was read", () => {
    const out = renderAuditInputs(
      inputs({
        artifacts: artifacts({
          reached: [
            { path: "e2e/specs/todo.spec.ts", from: "(entry)" },
            { path: "e2e/pages/todo.ts", from: "e2e/specs/todo.spec.ts" },
            { path: "e2e/big.ts", from: "e2e/pages/todo.ts" },
          ],
          // Whether a file was read is this list, not a flag on the one above.
          unaudited: ["e2e/big.ts"],
        }),
      }),
    );
    expect(out).toContain("| `e2e/specs/todo.spec.ts` | `(entry)` | yes |");
    expect(out).toContain("| `e2e/pages/todo.ts` | `e2e/specs/todo.spec.ts` | yes |");
    // Over the size budget renders as not read, not as truncated content.
    expect(out).toContain("| `e2e/big.ts` | `e2e/pages/todo.ts` | no — over the size budget |");
  });

  test("says so plainly when reached is empty, distinguishing a live case from one with no generated test yet", () => {
    const live = renderAuditInputs(inputs({ artifacts: artifacts({ live: true, reached: [] }) }));
    expect(live).toContain("None: a live case has no generated test — the document below is what runs.");

    const notGenerated = renderAuditInputs(inputs({ artifacts: artifacts({ live: false, reached: [] }) }));
    expect(notGenerated).toContain("None: this case has no generated test yet.");
  });

  test("prints configured source roots, and says none are configured when the list is empty", () => {
    const withRoots = renderAuditInputs(
      inputs({ sourceRoots: [{ configured: "../product/src", abs: "/abs/product/src" }] }),
    );
    expect(withRoots).toContain("- `../product/src` → `/abs/product/src`");

    const withoutRoots = renderAuditInputs(inputs({ sourceRoots: [] }));
    expect(withoutRoots).toContain("None configured: the audit read the working directory only.");
  });

  // The document and the files are inside the user prompt already; printing
  // them again would double the file to say the same thing twice.
  test("does not re-print what the prompt it embeds already carries", () => {
    const out = renderAuditInputs(
      inputs({
        artifacts: artifacts({ generated: [{ path: "e2e/specs/todo.spec.ts", content: "test('flow', () => {});" }] }),
      }),
    );
    expect(out).not.toContain("## spec.yaml — ");
    expect(out).not.toContain("## e2e/specs/todo.spec.ts");
  });

  test("embeds both prompts verbatim — the record of what was asked", () => {
    const out = renderAuditInputs(inputs());
    expect(out).toContain("## System prompt");
    expect(out).toContain("You audit the case.");
    expect(out).toContain("## User prompt");
    expect(out).toContain("Audit this case.");
  });

  test("a prompt whose own content contains a fenced block still appears whole, in a longer wrapping fence", () => {
    // This is the bug `fence` exists to prevent: a naive 3-backtick wrapper
    // would end at the first nested ``` and silently drop the rest.
    const nested = "Before\n```\nembedded snippet\n```\nAfter";
    const out = renderAuditInputs(inputs({ userPrompt: nested }));
    const fourTicks = "`".repeat(4);
    expect(out).toContain(`${fourTicks}\n${nested}\n${fourTicks}`);
  });
});

describe("writeAuditInputs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccqa-dump-inputs-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes <dir>/<case id>.md, creating intermediate directories for a case id with a slash", async () => {
    const path = await writeAuditInputs(dir, inputs({ caseId: "demo/sample" }));
    expect(path).toBe(join(dir, "demo/sample.md"));

    const content = await readFile(path, "utf8");
    expect(content).toContain("# Audit inputs — demo/sample");
  });
});
