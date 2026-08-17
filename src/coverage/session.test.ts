import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CoverageSession } from "./session.ts";
import { RunEventSchema, type RunEvent } from "./events.ts";
import { FRONTEND_COVERAGE_FILE, type FrontendCoverage } from "./contract.ts";
import type { ActorPlan, ActorWindow } from "./actors.ts";
import type { CoverageConfig } from "../config/project-config.ts";

/**
 * Hub-inbox mode (ADR-0022): no sink is bound, and everything the run alone
 * can state — universe, spec markers, actor-window markers, the browser half —
 * leaves as an ordered stream of run events. Local mode is covered end to end
 * by the sink and actor-window tests.
 */

const REF = { featureName: "feat", specName: "spec" };
const SPEC_ID = "run-1.feat/spec";
const WINDOW: ActorWindow = { key: "chat:${TEST_USER}", tag: "chat:U1", specs: ["feat/spec"] };
const PLAN: ActorPlan = {
  windows: [WINDOW],
  tagToKey: new Map([[WINDOW.tag, WINDOW.key]]),
  windowsForSpec: new Map([["feat/spec", [WINDOW]]]),
};

let root: string;
let coverageDir: string;
let events: RunEvent[];
const inbox = { append: async (event: RunEvent): Promise<void> => void events.push(event) };

function config(include?: readonly string[]): CoverageConfig {
  return {
    instrumentedOrigins: ["http://127.0.0.1:9"],
    sink: "http://127.0.0.1:4757",
    ...(include ? { include: [...include] } : {}),
    actors: {},
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ccqa-session-"));
  coverageDir = join(root, "report", "coverage", "feat", "spec");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export {};\n");
  await mkdir(coverageDir, { recursive: true });
  events = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CoverageSession in hub-inbox mode", () => {
  test("streams universe, markers and the browser half as run events; the row gets nothing", async () => {
    const session = await CoverageSession.start({
      runId: "run-1",
      cwd: root,
      config: config(["src"]),
      specs: [REF],
      actors: PLAN,
      inbox,
    });
    // Streamed, not exposed: the envelope must not carry the universe here.
    expect(session.universe).toBeUndefined();

    await session.beginSpec(REF);
    const frontend: FrontendCoverage = {
      specId: SPEC_ID,
      // gone.ts is not in the working tree, so the run's resolve drops it.
      files: ["src/app.ts", "src/gone.ts"],
      unmappedScripts: 0,
      unmappedRanges: 0,
      unresolvedSources: 0,
      excludedDependencies: 0,
      stopped: false,
    };
    await writeFile(join(coverageDir, FRONTEND_COVERAGE_FILE), JSON.stringify(frontend));
    const row = await session.collect(REF, coverageDir);
    await session.close();

    expect(row).toBeUndefined();
    expect(events).toEqual([
      { kind: "universe", runId: "run-1", include: ["src"], files: ["src/app.ts"] },
      { kind: "spec-open", runId: "run-1", specId: SPEC_ID },
      { kind: "window-open", runId: "run-1", tag: WINDOW.tag, key: WINDOW.key, specId: SPEC_ID },
      { kind: "window-close", runId: "run-1", tag: WINDOW.tag },
      { kind: "browser", runId: "run-1", specId: SPEC_ID, files: ["src/app.ts"] },
      { kind: "spec-close", runId: "run-1", specId: SPEC_ID },
    ]);
    // Every event must be valid against the frozen wire schema.
    for (const event of events) RunEventSchema.parse(event);
  });

  test("without a universe, actors or a browser result, only the spec markers leave", async () => {
    const session = await CoverageSession.start({
      runId: "run-1",
      cwd: root,
      config: config(),
      specs: [REF],
      inbox,
    });

    await session.beginSpec(REF);
    const row = await session.collect(REF, coverageDir);
    await session.close();

    expect(row).toBeUndefined();
    expect(events).toEqual([
      { kind: "spec-open", runId: "run-1", specId: SPEC_ID },
      { kind: "spec-close", runId: "run-1", specId: SPEC_ID },
    ]);
  });
});
