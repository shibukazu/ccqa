import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveSerialGroups } from "./serial-groups.ts";
import { RunUsageError } from "./errors.ts";

let cwd: string;

async function writeSpec(feature: string, spec: string): Promise<void> {
  const dir = join(cwd, ".ccqa", "features", feature, "test-cases", spec);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "spec.yaml"),
    "title: t\nsteps:\n  - instruction: i\n    expected: e\n",
  );
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-groups-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("resolveSerialGroups", () => {
  test("a spec belongs to every group that lists it; the rest belong to none", async () => {
    await writeSpec("notifications", "post");
    await writeSpec("notifications", "reply");
    await writeSpec("web", "search");
    const lookup = await resolveSerialGroups(
      { workspace: ["notifications/post", "notifications/reply"], inbox: ["notifications/post"] },
      cwd,
    );
    expect(lookup({ featureName: "notifications", specName: "post" })).toEqual(["workspace", "inbox"]);
    expect(lookup({ featureName: "notifications", specName: "reply" })).toEqual(["workspace"]);
    expect(lookup({ featureName: "web", specName: "search" })).toEqual([]);
  });

  test("a member that names no spec fails the run", async () => {
    // The whole reason membership lives in config: a mistyped member resolves
    // to nothing, and left unchecked it would silently shrink the group.
    await writeSpec("notifications", "post");
    await expect(
      resolveSerialGroups({ workspace: ["notifications/post", "notifications/repply"] }, cwd),
    ).rejects.toThrow(RunUsageError);
    await expect(
      resolveSerialGroups({ workspace: ["notifications/repply"] }, cwd),
    ).rejects.toThrow(/notifications\/repply/);
  });

  test("no groups means no filesystem work", async () => {
    // The common case is a project with no groups at all, which must not pay
    // for a full spec inventory read.
    expect(await resolveSerialGroups({}, "/nonexistent")).toBeTypeOf("function");
  });
});
