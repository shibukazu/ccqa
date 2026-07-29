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

function spec(verdict: SpecRerun["verdict"]): SpecRerun {
  // The axes are carried for the view; selection reads only the verdict, so
  // they are pinned to a value that could not itself change the outcome.
  return {
    verdict, audit: "clean", execution: "passed", heldBy: null,
    lastRun: null, lastGreen: null, lastRed: null,
  };
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
    expect(() => requireRerunProfile(undefined)).toThrow(/--hub-profile/);
  });

  test("passes a given profile through", () => {
    expect(requireRerunProfile("stg")).toBe("stg");
  });
});

describe("selectSpecsNeedingRerun", () => {
  const specs = [
    { featureName: "f", specName: "rerunNeeded" },
    { featureName: "f", specName: "verified" },
    { featureName: "f", specName: "unanswerable" },
    { featureName: "f", specName: "needsRepair" },
    { featureName: "f", specName: "inProgress" },
  ];
  const verdicts = report({
    "f/rerunNeeded": spec("rerunNeeded"),
    "f/verified": spec("verified"),
    "f/unanswerable": spec("unanswerable"),
    "f/needsRepair": spec("needsRepair"),
    "f/inProgress": spec("inProgress"),
  });

  test("selects only `rerunNeeded` by default", () => {
    const { selected } = selectSpecsNeedingRerun(specs, verdicts, { includeUnknown: false });
    expect(selected.map((s) => s.specName)).toEqual(["rerunNeeded"]);
  });

  test("--with-unknown adds unanswerable, but never needsRepair or inProgress", () => {
    // Running a spec the audit rejected is exactly what `needsRepair` exists
    // to prevent, and `inProgress` would race whatever is already holding it.
    const { selected } = selectSpecsNeedingRerun(specs, verdicts, { includeUnknown: true });
    expect(selected.map((s) => s.specName)).toEqual(["rerunNeeded", "unanswerable"]);
  });

  test("a spec absent from the perspectives document counts as unanswerable, not as verified", () => {
    const local = [{ featureName: "f", specName: "brand-new" }];
    expect(selectSpecsNeedingRerun(local, report({}), { includeUnknown: false }).selected).toEqual([]);
    expect(
      selectSpecsNeedingRerun(local, report({}), { includeUnknown: true }).selected,
    ).toEqual(local);
  });

  test("the summary accounts for every offered spec", () => {
    const { summary } = selectSpecsNeedingRerun(specs, verdicts, { includeUnknown: false });
    expect(summary).toBe("1 needsRepair, 1 rerunNeeded, 1 unanswerable, 1 inProgress, 1 verified");
  });

  test("counts the specs held back only because the hub could not answer", () => {
    // Only `unanswerable` counts. `needsRepair` and `inProgress` are answers,
    // and offering --with-unknown as their fix would be wrong advice.
    expect(selectSpecsNeedingRerun(specs, verdicts, { includeUnknown: false }).excludedUnanswerable).toBe(1);
    expect(selectSpecsNeedingRerun(specs, verdicts, { includeUnknown: true }).excludedUnanswerable).toBe(0);
  });
});

describe("fetchRerunReport", () => {
  test("returns the report when the profile has a deploy head", async () => {
    const ctx = hubCtx({ getRerun: async () => report({ "f/s": spec("rerunNeeded") }) });
    const got = await fetchRerunReport(ctx, "stg");
    expect(got.deployHead.sha).toBe("a".repeat(40));
  });

  test("a profile with no deploy log is an error, not an empty selection", async () => {
    const ctx = hubCtx({ getRerun: async () => report({ "f/s": spec("rerunNeeded") }, null) });
    await expect(fetchRerunReport(ctx, "stg")).rejects.toThrow(/no deploy has been recorded/);
  });

  test("a generic 404 reads as a hub too old to serve the endpoint", async () => {
    const ctx = hubCtx({
      getRerun: async () => {
        throw new HubApiError(404, "not_found", "no route for GET /api/v1/projects/demo/rerun");
      },
    });
    await expect(fetchRerunReport(ctx, "stg")).rejects.toThrow(/needs ccqa 1\.16 or newer/);
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
