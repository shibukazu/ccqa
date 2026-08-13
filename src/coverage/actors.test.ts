import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { actorGroups, resolveActors } from "./actors.ts";
import { RunUsageError } from "../run/errors.ts";

let cwd: string;

async function writeSpec(feature: string, spec: string): Promise<void> {
  const dir = join(cwd, ".ccqa", "features", feature, "test-cases", spec);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "spec.yaml"), "title: t\nsteps:\n  - instruction: i\n    expected: e\n");
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-actors-"));
  process.env.TEST_ACTOR = "U100";
  process.env.TEST_ACTOR_ALIAS = "U100";
  process.env.TEST_ACTOR_2 = "U200";
  delete process.env.TEST_ACTOR_UNSET;
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  delete process.env.TEST_ACTOR;
  delete process.env.TEST_ACTOR_ALIAS;
  delete process.env.TEST_ACTOR_2;
});

describe("resolveActors", () => {
  test("resolves the identity but keeps the written form for display", async () => {
    await writeSpec("chat", "create");
    await writeSpec("chat", "resolve");
    const plan = await resolveActors({ demo: { "${TEST_ACTOR}": ["chat/create", "chat/resolve"] } }, cwd);

    // The resolved identity is what events carry; the unexpanded text is the
    // only form that leaves this process, so the id cannot reach a report.
    expect(plan.tagToKey.get("demo:U100")).toBe("demo:${TEST_ACTOR}");
    expect(plan.windows.map((w) => w.key)).toEqual(["demo:${TEST_ACTOR}"]);
    const groups = actorGroups(plan);
    expect(groups({ featureName: "chat", specName: "create" })).toEqual(["demo:${TEST_ACTOR}"]);
    expect(groups({ featureName: "chat", specName: "other" })).toEqual([]);
  });

  test("a spec may act as more than one identity", async () => {
    await writeSpec("chat", "create");
    const plan = await resolveActors(
      { demo: { "${TEST_ACTOR}": ["chat/create"] }, other: { "${TEST_ACTOR_2}": ["chat/create"] } },
      cwd,
    );
    expect(actorGroups(plan)({ featureName: "chat", specName: "create" })).toEqual([
      "demo:${TEST_ACTOR}",
      "other:${TEST_ACTOR_2}",
    ]);
  });

  test("refuses what would silently measure nothing", async () => {
    await writeSpec("chat", "create");
    // An identity that resolves to nothing matches no event at all.
    await expect(
      resolveActors({ demo: { "${TEST_ACTOR_UNSET}": ["chat/create"] } }, cwd),
    ).rejects.toThrow(RunUsageError);
    // Two entries resolving alike make each other's events unattributable.
    await expect(
      resolveActors(
        { demo: { "${TEST_ACTOR}": ["chat/create"], "${TEST_ACTOR_ALIAS}": ["chat/create"] } },
        cwd,
      ),
    ).rejects.toThrow(/same identity/);
    // An identity written out in full would be printed in the report and sent
    // to the hub, which is the one thing the display key exists to prevent.
    await expect(resolveActors({ demo: { U100: ["chat/create"] } }, cwd)).rejects.toThrow(
      /as a variable/,
    );
    // A member that names no spec would quietly shrink the window's owners.
    await expect(
      resolveActors({ demo: { "${TEST_ACTOR}": ["chat/craete"] } }, cwd),
    ).rejects.toThrow(/chat\/craete/);
  });

  test("no actors means no filesystem work", async () => {
    expect((await resolveActors({}, "/nonexistent")).windows).toEqual([]);
  });
});
