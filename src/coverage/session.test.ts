import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CoverageSession, resolveRoot, resolveSourceBase } from "./session.ts";
import { RunEventSchema, type RunEvent } from "./events.ts";
import { FRONTEND_COVERAGE_FILE, type FrontendCoverage } from "./contract.ts";
import type { ActorPlan, ActorWindow } from "./actors.ts";
import type { CoverageConfig } from "../config/project-config.ts";
import { RunUsageError } from "../run/errors.ts";

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

function config(include?: readonly string[], exclude: readonly string[] = []): CoverageConfig {
  return {
    instrumentedOrigins: ["http://127.0.0.1:9"],
    sink: "http://127.0.0.1:4757",
    ...(include ? { include: [...include] } : {}),
    exclude: [...exclude],
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
      unresolvedSamples: [],
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

  // An aggregate every spec reaches is measured correctly and says nothing
  // about which spec to run, so it leaves neither as reach nor as a gap.
  test("coverage.exclude keeps its files out of both the browser event and the universe", async () => {
    await mkdir(join(root, "src", "generated"), { recursive: true });
    await writeFile(join(root, "src", "generated", "client.ts"), "export {};\n");
    const session = await CoverageSession.start({
      runId: "run-1",
      cwd: root,
      config: config(["src"], ["src/generated/**"]),
      specs: [REF],
      inbox,
    });

    await session.beginSpec(REF);
    const frontend: FrontendCoverage = {
      specId: SPEC_ID,
      files: ["src/app.ts", "src/generated/client.ts"],
      unmappedScripts: 0,
      unmappedRanges: 0,
      unresolvedSources: 0,
      unresolvedSamples: [],
      excludedDependencies: 0,
      stopped: false,
    };
    await writeFile(join(coverageDir, FRONTEND_COVERAGE_FILE), JSON.stringify(frontend));
    await session.collect(REF, coverageDir);
    await session.close();

    expect(events.find((e) => e.kind === "universe")).toMatchObject({ files: ["src/app.ts"] });
    expect(events.find((e) => e.kind === "browser")).toMatchObject({ files: ["src/app.ts"] });
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

describe("CoverageSession gaps", () => {
  // The counts alone cannot say whether the base directory is wrong or the
  // sources are genuinely foreign — which is the only question a reader has
  // when a run reports that it resolved nothing.
  test("a gap carries a few of the paths behind it, not just how many", async () => {
    const session = await CoverageSession.start({
      runId: "run-1",
      cwd: root,
      config: config(["src"]),
      specs: [REF],
    });
    await session.beginSpec(REF);
    const frontend: FrontendCoverage = {
      specId: SPEC_ID,
      // Only app.ts is in the working tree; the rest resolved somewhere else.
      files: ["src/app.ts", "src/gone.ts", "../elsewhere/other.ts"],
      unmappedScripts: 0,
      unmappedRanges: 0,
      unresolvedSources: 2,
      unresolvedSamples: ["webpack://./nowhere.ts", "[project]/virtual.ts"],
      excludedDependencies: 0,
      stopped: false,
    };
    await writeFile(join(coverageDir, FRONTEND_COVERAGE_FILE), JSON.stringify(frontend));
    const row = await session.collect(REF, coverageDir);
    await session.close();

    expect(row?.gaps.outsideProject).toBe(2);
    expect(row?.gaps.outsideProjectSamples).toEqual(["src/gone.ts", "../elsewhere/other.ts"]);
    expect(row?.gaps.unresolvedSamples).toEqual(["webpack://./nowhere.ts", "[project]/virtual.ts"]);
  });
});

describe("resolveRoot and resolveSourceBase", () => {
  let cwd: string;
  let outside: string;

  // realpath: on macOS the tmpdir lives behind a /var → /private/var symlink,
  // and resolveConfiguredDir returns real paths — keep both sides comparable.
  async function makeDir(prefix: string): Promise<string> {
    return realpath(await mkdtemp(join(tmpdir(), prefix)));
  }

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
  });

  test("a sibling of cwd resolves instead of being rejected (tests and the application are often separate checkouts)", async () => {
    cwd = await makeDir("ccqa-session-root-");
    outside = await makeDir("ccqa-session-root-outside-");
    expect(await resolveRoot(cwd, outside)).toBe(outside);
    expect(await resolveSourceBase(cwd, outside)).toBe(outside);
  });

  test("a relative root resolves against cwd", async () => {
    cwd = await makeDir("ccqa-session-root-");
    await mkdir(join(cwd, "app"), { recursive: true });
    expect(await resolveRoot(cwd, "app")).toBe(join(cwd, "app"));
    expect(await resolveSourceBase(cwd, "app")).toBe(join(cwd, "app"));
  });

  test("a directory reached through a symlink resolves to its real path", async () => {
    cwd = await makeDir("ccqa-session-root-");
    outside = await makeDir("ccqa-session-root-outside-");
    await symlink(outside, join(cwd, "app-link"));
    expect(await resolveRoot(cwd, "app-link")).toBe(outside);
  });

  test("a missing directory throws RunUsageError naming the config key", async () => {
    cwd = await makeDir("ccqa-session-root-");
    const rootErr = await resolveRoot(cwd, "nope").catch((e: unknown) => e);
    expect(rootErr).toBeInstanceOf(RunUsageError);
    expect((rootErr as Error).message).toMatch(/coverage\.projectRoot/);
    const baseErr = await resolveSourceBase(cwd, "nope").catch((e: unknown) => e);
    expect(baseErr).toBeInstanceOf(RunUsageError);
    expect((baseErr as Error).message).toMatch(/coverage\.sourceBase/);
  });

  test("a ${VAR} that resolves to empty throws RunUsageError naming the config key", async () => {
    cwd = await makeDir("ccqa-session-root-");
    const rootErr = await resolveRoot(cwd, "${CCQA_TEST_UNSET_ROOT_VAR}").catch((e: unknown) => e);
    expect(rootErr).toBeInstanceOf(RunUsageError);
    expect((rootErr as Error).message).toMatch(/coverage\.projectRoot/);
    const baseErr = await resolveSourceBase(cwd, "${CCQA_TEST_UNSET_ROOT_VAR}").catch((e: unknown) => e);
    expect(baseErr).toBeInstanceOf(RunUsageError);
    expect((baseErr as Error).message).toMatch(/coverage\.sourceBase/);
  });

  test("undefined returns undefined for both", async () => {
    cwd = await makeDir("ccqa-session-root-");
    expect(await resolveRoot(cwd, undefined)).toBeUndefined();
    expect(await resolveSourceBase(cwd, undefined)).toBeUndefined();
  });
});
