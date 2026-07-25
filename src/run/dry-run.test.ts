import { describe, expect, test } from "vitest";
import type { SpecWithMode } from "../cli/spec-mode.ts";
import { formatDryRunLines } from "./dry-run.ts";
import type { TargetDispatch } from "./target-dispatch.ts";

type Routed = Parameters<typeof formatDryRunLines>[1];

const nothingRouted: Routed = { external: [], skipped: [], unresolved: [] };

describe("formatDryRunLines", () => {
  test("tags each spec with the phase that would execute it", () => {
    const agentBrowser: SpecWithMode[] = [
      { featureName: "auth", specName: "login", mode: "deterministic" },
      { featureName: "tasks", specName: "create", mode: "live" },
    ];
    const routed: Routed = {
      ...nothingRouted,
      external: [
        {
          targetId: "playwright",
          specs: [{ featureName: "api", specName: "health", title: null }],
        } as TargetDispatch["external"][number],
      ],
    };
    expect(formatDryRunLines(agentBrowser, routed)).toEqual([
      "  auth/login    deterministic",
      "  tasks/create  live",
      "  api/health    playwright",
    ]);
  });

  test("lists rows that would not execute with their reason, so the list matches the report", () => {
    const routed: Routed = {
      ...nothingRouted,
      skipped: [{ featureName: "f", specName: "s", title: null, reason: "no runCommand", targetId: "runn" }],
      unresolved: [{ featureName: "f", specName: "u", title: null, reason: "unknown target", targetId: null }],
    };
    expect(formatDryRunLines([], routed)).toEqual([
      "  f/s  skipped — no runCommand",
      "  f/u  unresolved — unknown target",
    ]);
  });

  test("an empty selection prints nothing", () => {
    expect(formatDryRunLines([], nothingRouted)).toEqual([]);
  });
});
