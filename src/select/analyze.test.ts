import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangedFile } from "../drift/affected.ts";

vi.mock("../claude/invoke.ts", () => ({ invokeClaudeStreaming: vi.fn() }));
const { invokeClaudeStreaming } = await import("../claude/invoke.ts");
const { parseSpecDirPath, selectSpecs } = await import("./analyze.ts");

import type { SpecDescription } from "./inventory.ts";

function file(path: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", ...overrides };
}

function spec(featureName: string, specName: string, includedBlocks: string[] = []): SpecDescription {
  return {
    featureName,
    specName,
    title: "Sample flow",
    steps: ["open the page", "do a thing"],
    includedBlocks,
  };
}

const NO_COST = {
  totalCostUsd: null,
  durationMs: null,
  durationApiMs: null,
  numTurns: null,
  inputTokens: null,
  cacheCreationInputTokens: null,
  cacheReadInputTokens: null,
  outputTokens: null,
  models: [],
};

function claudeResult(result: string, isError: boolean): Awaited<ReturnType<typeof invokeClaudeStreaming>> {
  return { result, isError, errorDetail: isError ? "mock error" : null, cost: NO_COST };
}

function modelReply(json: unknown): Awaited<ReturnType<typeof invokeClaudeStreaming>> {
  return claudeResult("```json\n" + JSON.stringify(json) + "\n```", false);
}

beforeEach(() => {
  vi.mocked(invokeClaudeStreaming).mockReset();
});

describe("parseSpecDirPath", () => {
  it("extracts <feature>/<spec> from a spec's own directory, else null", () => {
    expect(parseSpecDirPath(".ccqa/features/checkout/test-cases/purchase-with-card/spec.yaml")).toBe(
      "checkout/purchase-with-card",
    );
    expect(parseSpecDirPath("src/features/checkout/purchase.ts")).toBeNull();
    expect(parseSpecDirPath(".ccqa/blocks/login/spec.yaml")).toBeNull();
  });
});

describe("selectSpecs: mechanical partitioning", () => {
  it("marks a spec whose own directory changed as needed/mechanical, and calls no model when nothing else changed", async () => {
    const specs = [spec("checkout", "purchase-with-card"), spec("checkout", "apply-coupon")];
    const changed = [file(".ccqa/features/checkout/test-cases/purchase-with-card/spec.yaml")];

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    const purchase = report.specs.find((s) => s.specName === "purchase-with-card")!;
    expect(purchase.verdict).toBe("needed");
    expect(purchase.source).toBe("mechanical");
    const coupon = report.specs.find((s) => s.specName === "apply-coupon")!;
    expect(coupon.verdict).toBe("notNeeded");
    expect(invokeClaudeStreaming).not.toHaveBeenCalled();
  });

  it("marks only specs that include a changed block as needed; specs without it fall to notNeeded", async () => {
    const specs = [
      spec("checkout", "purchase-with-card", ["login"]),
      spec("checkout", "apply-coupon", []),
    ];
    const changed = [file(".ccqa/blocks/login/spec.yaml")];

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    const purchase = report.specs.find((s) => s.specName === "purchase-with-card")!;
    expect(purchase.verdict).toBe("needed");
    expect(purchase.source).toBe("mechanical");
    expect(purchase.touchedBy).toEqual([".ccqa/blocks/login/spec.yaml"]);
    const coupon = report.specs.find((s) => s.specName === "apply-coupon")!;
    expect(coupon.verdict).toBe("notNeeded");
    expect(invokeClaudeStreaming).not.toHaveBeenCalled();
  });

  it("treats an outsideCwd change as a product change even if it looks like a spec path", async () => {
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(claudeResult("", true));
    const specs = [spec("checkout", "purchase-with-card")];
    const changed = [
      file(".ccqa/features/checkout/test-cases/purchase-with-card/spec.yaml", { outsideCwd: true }),
    ];

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    // Went to the model path (not mechanically needed) — proven by the error
    // reply landing as "unknown" rather than the mechanical "needed".
    expect(report.specs[0]!.verdict).toBe("unknown");
    expect(report.specs[0]!.source).toBe("model");
    // That it was asked at all is the point; an errored reply is retried, so
    // the count is not fixed here.
    expect(invokeClaudeStreaming).toHaveBeenCalled();
  });

  it("drops a .ccqa/ path that is neither a spec nor a block from the evidence", async () => {
    const specs = [spec("checkout", "purchase-with-card")];
    const changed = [file(".ccqa/config.yaml")];

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    expect(report.specs[0]!.verdict).toBe("notNeeded");
    expect(report.specs[0]!.source).toBe("mechanical");
    expect(invokeClaudeStreaming).not.toHaveBeenCalled();
  });

  it("calls the model exactly once when there is a product change to judge", async () => {
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(
      modelReply({ specs: [{ spec: "checkout/purchase-with-card", verdict: "needed", reason: "touches checkout", touchedBy: ["src/features/checkout/page.ts"] }] }),
    );
    const specs = [spec("checkout", "purchase-with-card")];
    const changed = [file("src/features/checkout/page.ts")];

    await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    expect(invokeClaudeStreaming).toHaveBeenCalledTimes(1);
  });
});

describe("selectSpecs: model judging", () => {
  const specs = [spec("checkout", "purchase-with-card"), spec("checkout", "apply-coupon")];
  const changed = [file("src/features/checkout/page.ts")];

  it.each([
    ["the model errors", () => claudeResult("", true)],
    ["the reply has no JSON block", () => claudeResult("I looked, but did not answer in JSON.", false)],
    ["the JSON block does not parse", () => claudeResult("```json\n{not valid json\n```", false)],
  ])("resolves every undecided spec to unknown, never notNeeded, when %s", async (_label, mockResult) => {
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(mockResult());

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    // `toBe("unknown")` alone already rules out `notNeeded` — the one verdict
    // a broken reply must never be allowed to produce.
    for (const s of report.specs) {
      expect(s.verdict).toBe("unknown");
      expect(s.source).toBe("model");
    }
  });

  it("retries once, so a single malformed reply does not cost the whole selection", async () => {
    // Seen against a real repository: three runs over one commit produced a
    // parse failure, a clean answer, and a different clean answer. Without the
    // retry the first of those abandons all 37 specs to `unknown`, and the
    // feature silently stops selecting anything.
    vi.mocked(invokeClaudeStreaming)
      .mockResolvedValueOnce(claudeResult("```json\n{not valid json\n```", false))
      .mockResolvedValueOnce(
        modelReply({
          specs: specs.map((s) => ({
            spec: `${s.featureName}/${s.specName}`,
            verdict: "notNeeded",
            reason: "unrelated area",
            touchedBy: [],
          })),
        }),
      );

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    expect(vi.mocked(invokeClaudeStreaming)).toHaveBeenCalledTimes(2);
    for (const s of report.specs) expect(s.verdict).toBe("notNeeded");
  });

  it("gives up after the retry rather than calling forever", async () => {
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(claudeResult("```json\n{not valid json\n```", false));

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    expect(vi.mocked(invokeClaudeStreaming)).toHaveBeenCalledTimes(2);
    for (const s of report.specs) expect(s.verdict).toBe("unknown");
  });

  it("leaves a spec the model never mentioned as unknown, while honoring the verdicts it did give", async () => {
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(
      modelReply({
        specs: [{ spec: "checkout/purchase-with-card", verdict: "notNeeded", reason: "unrelated area", touchedBy: [] }],
      }),
    );

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    expect(report.specs.find((s) => s.specName === "purchase-with-card")!.verdict).toBe("notNeeded");
    expect(report.specs.find((s) => s.specName === "apply-coupon")!.verdict).toBe("unknown");
  });

  it("filters touchedBy down to paths that are actually in the diff", async () => {
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(
      modelReply({
        specs: [
          {
            spec: "checkout/purchase-with-card",
            verdict: "needed",
            reason: "touches checkout",
            touchedBy: ["src/features/checkout/page.ts", "src/features/invented/not-in-diff.ts"],
          },
          { spec: "checkout/apply-coupon", verdict: "notNeeded", reason: "unrelated", touchedBy: [] },
        ],
      }),
    );

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    expect(report.specs.find((s) => s.specName === "purchase-with-card")!.touchedBy).toEqual([
      "src/features/checkout/page.ts",
    ]);
  });

  it("ignores an entry with an unrecognized verdict or a missing spec field, leaving it unknown", async () => {
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(
      modelReply({
        specs: [
          { spec: "checkout/purchase-with-card", verdict: "maybe", reason: "unsure", touchedBy: [] },
          { verdict: "notNeeded", reason: "no spec field" },
        ],
      }),
    );

    const report = await selectSpecs({ changed, specs, cwd: "/repo", base: "main", head: "HEAD" });

    for (const s of report.specs) expect(s.verdict).toBe("unknown");
  });

  it("returns specs in inventory order regardless of mechanical/model registration order", async () => {
    const mixedSpecs = [
      spec("checkout", "refund"),
      spec("checkout", "purchase-with-card"),
      spec("checkout", "apply-coupon"),
    ];
    const mixedChanged = [
      file(".ccqa/features/checkout/test-cases/apply-coupon/spec.yaml"),
      file("src/features/checkout/page.ts"),
    ];
    vi.mocked(invokeClaudeStreaming).mockResolvedValue(
      modelReply({
        specs: [
          { spec: "checkout/refund", verdict: "needed", reason: "touches checkout", touchedBy: ["src/features/checkout/page.ts"] },
          { spec: "checkout/purchase-with-card", verdict: "notNeeded", reason: "unrelated", touchedBy: [] },
        ],
      }),
    );

    const report = await selectSpecs({ changed: mixedChanged, specs: mixedSpecs, cwd: "/repo", base: "main", head: "HEAD" });

    expect(report.specs.map((s) => s.specName)).toEqual(["refund", "purchase-with-card", "apply-coupon"]);
  });
});
