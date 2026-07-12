import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireSpecLock, SPEC_LOCK_FILE, SpecLockedError } from "./spec-lock.ts";

let cwd: string;
const specDir = () => join(cwd, ".ccqa", "features", "demo", "test-cases", "x");
const lockPath = () => join(specDir(), SPEC_LOCK_FILE);

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ccqa-spec-lock-"));
  await mkdir(specDir(), { recursive: true });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("acquireSpecLock", () => {
  it("creates the lock, records the holder, and release removes it", async () => {
    const release = await acquireSpecLock("demo", "x", "generate", cwd);
    const body = JSON.parse(await readFile(lockPath(), "utf8"));
    expect(body.pid).toBe(process.pid);
    expect(body.command).toBe("generate");
    await release();
    await expect(readFile(lockPath(), "utf8")).rejects.toThrow();
  });

  it("fails fast when a live foreign process holds the lock", async () => {
    // PID 1 (launchd/init) is always alive and never us.
    await writeFile(
      lockPath(),
      JSON.stringify({ pid: 1, command: "record", startedAt: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    await expect(acquireSpecLock("demo", "x", "generate", cwd)).rejects.toThrow(SpecLockedError);
  });

  it("is re-entrant within the same process (record wrapping generate)", async () => {
    const outer = await acquireSpecLock("demo", "x", "record", cwd);
    const inner = await acquireSpecLock("demo", "x", "generate", cwd);
    await inner(); // inner release is a no-op — the outer still holds
    expect(JSON.parse(await readFile(lockPath(), "utf8")).command).toBe("record");
    await outer();
  });

  it("reclaims a stale lock whose holder is dead, and an unreadable one", async () => {
    // A PID from the ephemeral range that (almost certainly) isn't running;
    // even if it were, retry logic would surface SpecLockedError instead.
    await writeFile(
      lockPath(),
      JSON.stringify({ pid: 999999999, command: "generate", startedAt: "old" }),
      "utf8",
    );
    const release = await acquireSpecLock("demo", "x", "generate", cwd);
    expect(JSON.parse(await readFile(lockPath(), "utf8")).pid).toBe(process.pid);
    await release();

    await writeFile(lockPath(), "{ not json", "utf8");
    const release2 = await acquireSpecLock("demo", "x", "generate", cwd);
    expect(JSON.parse(await readFile(lockPath(), "utf8")).pid).toBe(process.pid);
    await release2();
  });
});
