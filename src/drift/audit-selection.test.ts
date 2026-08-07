import { describe, expect, test } from "vitest";
import { fetchStillDrifted, selectSpecsNeedingAudit } from "./audit-selection.ts";
import type { AuditNeedReport } from "../hub/contract/schema.ts";
import type { HubContext } from "../cli/hub-conn.ts";
import type { SpecRef } from "../store/index.ts";

const ref = (feature: string, spec: string): SpecRef => ({ featureName: feature, specName: spec });

const report = (specs: AuditNeedReport["specs"]): AuditNeedReport => ({ project: "demo", profile: "dev", specs });

describe("selectSpecsNeedingAudit", () => {
  test("a spec with an open drift entry is selected even when the hub says current", () => {
    const targets = [ref("a", "one"), ref("a", "two")];
    const { selected, summary } = selectSpecsNeedingAudit(
      targets,
      report({ "a/one": { because: "current" }, "a/two": { because: "current" } }),
      new Set(["a/one"]),
    );
    expect(selected.map((t) => t.specName)).toEqual(["one"]);
    expect(summary).toContain("1 stillDrifted");
    expect(summary).toContain("1 current");
  });

  test("stillDrifted takes the count even when the deploy answer also says due", () => {
    const targets = [ref("a", "one")];
    const { selected, summary } = selectSpecsNeedingAudit(
      targets,
      report({ "a/one": { because: "deployReached" } }),
      new Set(["a/one"]),
    );
    expect(selected).toHaveLength(1);
    expect(summary).toContain("1 stillDrifted");
    expect(summary).not.toContain("deployReached");
  });

  test("without the drifted set the deploy-based behaviour is unchanged", () => {
    const targets = [ref("a", "one"), ref("a", "two")];
    const { selected } = selectSpecsNeedingAudit(
      targets,
      report({ "a/one": { because: "deployReached" }, "a/two": { because: "current" } }),
    );
    expect(selected.map((t) => t.specName)).toEqual(["one"]);
  });
});

describe("fetchStillDrifted", () => {
  const ctxWith = (getDriftLedger: () => Promise<unknown>): HubContext =>
    ({ hub: { getDriftLedger } as never, project: "demo" }) as HubContext;

  test("collects the keys whose entry has a label", async () => {
    const set = await fetchStillDrifted(
      ctxWith(async () => ({
        specs: {
          "a/one": { label: "TEST_DRIFT" },
          "a/two": { label: null },
        },
      })),
    );
    expect([...set]).toEqual(["a/one"]);
  });

  test("an unreadable ledger degrades to an empty set", async () => {
    const set = await fetchStillDrifted(ctxWith(async () => Promise.reject(new Error("boom"))));
    expect(set.size).toBe(0);
  });
});
