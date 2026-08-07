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

function spec(verdict: SpecRerun["verdict"], extra: Partial<SpecRerun> = {}): SpecRerun {
  // The axes are carried for the view; selection reads only the verdict (and,
  // for `inProgress`, `auditAssumedReached`), so the rest is pinned to a value
  // that could not itself change the outcome.
  return {
    verdict, audit: "clean", execution: "passed", heldBy: null,
    lastRun: null, lastGreen: null, lastRed: null,
    ...extra,
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
    { featureName: "f", specName: "needsRepair" },
    { featureName: "f", specName: "inProgress" },
    { featureName: "f", specName: "manuallyVerified" },
  ];
  const verdicts = report({
    "f/rerunNeeded": spec("rerunNeeded"),
    "f/verified": spec("verified"),
    "f/needsRepair": spec("needsRepair"),
    "f/inProgress": spec("inProgress"),
    "f/manuallyVerified": spec("manuallyVerified"),
  });

  test("selects `rerunNeeded`, and nothing the other four answer for", () => {
    // Running a spec the audit rejected is exactly what `needsRepair` exists
    // to prevent, `inProgress` would race whatever is already holding it, and
    // a `manuallyVerified` spec's test is still the broken one a person's
    // word stands in for.
    const { selected } = selectSpecsNeedingRerun(specs, verdicts);
    expect(selected.map((s) => s.specName)).toEqual(["rerunNeeded"]);
  });

  test("a spec absent from the perspectives document is excluded as `inProgress`, not run uncleared", () => {
    // ADR-0014: running a spec the audit has not cleared is what this whole
    // selection path exists to stop. A spec the hub has never heard of has
    // not been cleared, so it must not run just because it is also not
    // "verified" — the two used to point the same way and no longer do.
    const local = [{ featureName: "f", specName: "brand-new" }];
    const selection = selectSpecsNeedingRerun(local, report({}));
    expect(selection.selected).toEqual([]);
    expect(selection.excludedInProgress).toBe(1);
    expect(selection.excludedUnknownToHub).toBe(1);
  });

  test("the summary accounts for every offered spec", () => {
    expect(selectSpecsNeedingRerun(specs, verdicts).summary).toBe(
      "1 needsRepair, 1 rerunNeeded, 1 inProgress, 1 manuallyVerified, 1 verified",
    );
  });

  test("counts the specs held back only because the audit has not answered", () => {
    // `needsRepair` and `verified` are decisions; `inProgress` is the only
    // verdict that keeps a spec out while nobody has decided anything.
    expect(selectSpecsNeedingRerun(specs, verdicts).excludedInProgress).toBe(1);
  });

  test("an `inProgress` spec known to the hub is not counted as unknown to it", () => {
    expect(selectSpecsNeedingRerun(specs, verdicts).excludedUnknownToHub).toBe(0);
  });

  test("names the hole behind an `inProgress` spec the audit could not place", () => {
    // The audit's own baseline was unplaceable (ADR-0014's "assumed reached"),
    // so re-running the audit at the same commit would not clear it — the
    // caller needs the reason to point at a fix that actually helps.
    const holed = [{ featureName: "f", specName: "stuck" }];
    const verdict = report({
      "f/stuck": spec("inProgress", { auditAssumedReached: "deployedShaNotInLog" }),
    });
    const selection = selectSpecsNeedingRerun(holed, verdict);
    expect(selection.excludedAssumedReached).toBe(1);
    expect(selection.excludedAssumedReachedReasons).toEqual(["deployedShaNotInLog"]);
    expect(selection.excludedUnknownToHub).toBe(0);
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
    await expect(fetchRerunReport(ctx, "stg")).rejects.toThrow(/needs ccqa 1\.20 or newer/);
  });

  test("a hub still answering the old vocabulary is rejected, not read as nothing to run", async () => {
    // A 1.19 hub answers 200 with `unanswerable`; taking it at face value
    // would drop those specs silently, which is the one outcome this path
    // exists to prevent.
    const stale = { verdict: "unanswerable", reason: "gapInRange" } as unknown as SpecRerun;
    const ctx = hubCtx({ getRerun: async () => report({ "f/s": stale }) });
    await expect(fetchRerunReport(ctx, "stg")).rejects.toThrow(/different versions/);
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
