import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveSessionState } from "./run-live.ts";

const VALID_STATE = JSON.stringify({ cookies: [], origins: [] });

/** Make a cwd with `.ccqa/sessions/<profile>/` and write the given session files. */
async function sessionsCwd(
  profile: string,
  files: Record<string, string>,
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ccqa-run-live-test-"));
  const dir = join(cwd, ".ccqa", "sessions", profile);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, `${name}.json`), content, "utf8");
  }
  return cwd;
}

describe("resolveSessionState", () => {
  test("restores a single existing session from its own file", async () => {
    const cwd = await sessionsCwd("default", { admin: VALID_STATE });
    const r = await resolveSessionState(["admin"], undefined, cwd);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.statePath).toBe(join(cwd, ".ccqa/sessions/default/admin.json"));
  });

  test("merges multiple sessions into a temp file", async () => {
    const cwd = await sessionsCwd("default", { admin: VALID_STATE, viewer: VALID_STATE });
    const r = await resolveSessionState(["admin", "viewer"], undefined, cwd);
    expect(r.ok).toBe(true);
    // Merged state goes to a fresh temp file, not either source file.
    if (r.ok) expect(r.statePath).not.toContain(".ccqa/sessions");
  });

  test("stops with a bootstrap hint when a session is missing", async () => {
    const cwd = await sessionsCwd("default", {});
    const r = await resolveSessionState(["admin"], undefined, cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa session bootstrap admin");
  });

  test("stops on a malformed session file just like a missing one", async () => {
    const cwd = await sessionsCwd("default", { admin: "not json" });
    const r = await resolveSessionState(["admin"], undefined, cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa session bootstrap admin");
  });

  test("threads --profile into the bootstrap hint", async () => {
    const cwd = await sessionsCwd("stg", {});
    const r = await resolveSessionState(["admin"], "stg", cwd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa session bootstrap admin --profile stg");
  });
});
