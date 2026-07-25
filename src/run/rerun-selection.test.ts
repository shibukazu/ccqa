import { describe, expect, test } from "vitest";
import type { HubContext } from "../cli/hub-conn.ts";
import { HubApiError, type HubClient } from "../hub-client/index.ts";
import type { RerunReport, SpecRerun } from "../hub/contract/schema.ts";
import { RunUsageError } from "./errors.ts";
import {
  fetchRerunReport,
  requireRerunProfile,
  selectSpecsNeedingRerun,
} from "./rerun-selection.ts";

function spec(state: SpecRerun["state"]): SpecRerun {
  return { state, lastRun: null, lastGreen: null, lastRed: null };
}

function report(specs: Record<string, SpecRerun>, deployHead: RerunReport["deployHead"] = {
  index: 3,
  sha: "a".repeat(40),
  at: "2026-01-01T00:00:00.000Z",
}): RerunReport {
  return { project: "demo", profile: "stg", deployHead, specs };
}

function hubCtx(client: Partial<HubClient>): HubContext {
  return { hub: client as HubClient, project: "demo" };
}

describe("requireRerunProfile", () => {
  test("rejects a missing profile — the deploy log has no profile-free answer", () => {
    expect(() => requireRerunProfile(undefined)).toThrow(RunUsageError);
    expect(() => requireRerunProfile(undefined)).toThrow(/--profile/);
  });

  test("passes a given profile through", () => {
    expect(requireRerunProfile("stg")).toBe("stg");
  });
});

describe("selectSpecsNeedingRerun", () => {
  const specs = [
    { featureName: "f", specName: "needed" },
    { featureName: "f", specName: "notNeeded" },
    { featureName: "f", specName: "unknown" },
    { featureName: "f", specName: "neverRun" },
    { featureName: "f", specName: "notEvaluated" },
  ];
  const verdicts = report({
    "f/needed": spec("needed"),
    "f/notNeeded": spec("notNeeded"),
    "f/unknown": spec("unknown"),
    "f/neverRun": spec("neverRun"),
    "f/notEvaluated": spec("notEvaluated"),
  });

  test("selects only `needed` by default", () => {
    const { selected } = selectSpecsNeedingRerun(specs, verdicts, { includeUnknown: false });
    expect(selected.map((s) => s.specName)).toEqual(["needed"]);
  });

  test("--include-unknown adds unknown and neverRun, but never notNeeded/notEvaluated", () => {
    const { selected } = selectSpecsNeedingRerun(specs, verdicts, { includeUnknown: true });
    expect(selected.map((s) => s.specName)).toEqual(["needed", "unknown", "neverRun"]);
  });

  test("a spec absent from the perspectives document counts as unknown, not as notNeeded", () => {
    const local = [{ featureName: "f", specName: "brand-new" }];
    expect(selectSpecsNeedingRerun(local, report({}), { includeUnknown: false }).selected).toEqual([]);
    expect(
      selectSpecsNeedingRerun(local, report({}), { includeUnknown: true }).selected,
    ).toEqual(local);
  });

  test("the summary accounts for every offered spec", () => {
    const { summary } = selectSpecsNeedingRerun(specs, verdicts, { includeUnknown: false });
    expect(summary).toBe("1 needed, 1 unknown, 1 neverRun, 1 notNeeded, 1 notEvaluated");
  });

  test("counts the specs held back only because the hub could not answer", () => {
    // notNeeded is an answer, so it is not counted; the other three are not.
    expect(selectSpecsNeedingRerun(specs, verdicts, { includeUnknown: false }).excludedUnanswerable).toBe(3);
    expect(selectSpecsNeedingRerun(specs, verdicts, { includeUnknown: true }).excludedUnanswerable).toBe(1);
  });
});

describe("fetchRerunReport", () => {
  test("returns the report when the profile has a deploy head", async () => {
    const ctx = hubCtx({ getRerun: async () => report({ "f/s": spec("needed") }) });
    const got = await fetchRerunReport(ctx, "stg");
    expect(got.deployHead.sha).toBe("a".repeat(40));
  });

  test("a profile with no deploy log is an error, not an empty selection", async () => {
    const ctx = hubCtx({ getRerun: async () => report({ "f/s": spec("neverRun") }, null) });
    await expect(fetchRerunReport(ctx, "stg")).rejects.toThrow(/no deploy has been recorded/);
  });

  test("a generic 404 reads as a hub too old to serve the endpoint", async () => {
    const ctx = hubCtx({
      getRerun: async () => {
        throw new HubApiError(404, "not_found", "no route for GET /api/v1/projects/demo/rerun");
      },
    });
    await expect(fetchRerunReport(ctx, "stg")).rejects.toThrow(/needs ccqa 1\.9 or newer/);
  });

  test("the handler's `no_perspectives` code points at `ccqa perspectives`", async () => {
    const ctx = hubCtx({
      getRerun: async () => {
        throw new HubApiError(404, "no_perspectives", "no perspectives stored");
      },
    });
    await expect(fetchRerunReport(ctx, "stg")).rejects.toThrow(/ccqa perspectives/);
  });

  test("any other hub failure surfaces as a usage error, never as 'nothing to run'", async () => {
    const ctx = hubCtx({
      getRerun: async () => {
        throw new HubApiError(503, "no_key", "hub has no encryption key");
      },
    });
    await expect(fetchRerunReport(ctx, "stg")).rejects.toThrow(RunUsageError);
  });
});
