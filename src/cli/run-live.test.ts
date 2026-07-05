import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import type { HubClient } from "../hub-client/index.ts";
import type { HubContext } from "./hub-conn.ts";
import { resolveSessionState } from "./run-live.ts";

const VALID_STATE = { cookies: [], origins: [] };

/** Minimal HubClient stub: only `getSession` is exercised by resolveSessionState. */
function fakeHub(
  handler: (project: string, profile: string, name: string) => Promise<unknown>,
): HubClient {
  return { getSession: handler } as unknown as HubClient;
}

function hubCtx(handler: (project: string, profile: string, name: string) => Promise<unknown>): HubContext {
  return { hub: fakeHub(handler), project: "test-project" };
}

describe("resolveSessionState", () => {
  test("fails without a hub connection when sessions are requested", async () => {
    const r = await resolveSessionState(["admin"], null, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("admin");
      expect(r.hint).toMatch(/CCQA_HUB_URL|CCQA_HUB_TOKEN|--hub-url|--hub-token/);
    }
  });

  test("restores a single session from the hub into a temp file, removed by cleanup", async () => {
    const ctx = hubCtx(async () => VALID_STATE);
    const r = await resolveSessionState(["admin"], ctx, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.statePath.startsWith(tmpdir())).toBe(true);
    expect(r.statePath).not.toContain(".ccqa/sessions");
    await r.cleanup();
    await expect(stat(r.statePath)).rejects.toThrow();
  });

  test("merges multiple hub sessions into a temp file", async () => {
    const ctx = hubCtx(async (_project, _profile, name) =>
      name === "admin"
        ? { cookies: [{ name: "a", domain: "x.example", path: "/" }], origins: [] }
        : { cookies: [{ name: "b", domain: "y.example", path: "/" }], origins: [] },
    );
    const r = await resolveSessionState(["admin", "viewer"], ctx, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.statePath.startsWith(tmpdir())).toBe(true);
    await r.cleanup();
  });

  test("fails with a bootstrap hint when the hub has no such session", async () => {
    const ctx = hubCtx(async () => {
      throw new Error("not found");
    });
    const r = await resolveSessionState(["admin"], ctx, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa session bootstrap admin");
  });

  test("fails when the hub returns a value that isn't storage-state shaped", async () => {
    const ctx = hubCtx(async () => ({ nope: true }));
    const r = await resolveSessionState(["admin"], ctx, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa session bootstrap admin");
  });

  test("threads --profile into the bootstrap hint", async () => {
    const ctx = hubCtx(async () => {
      throw new Error("not found");
    });
    const r = await resolveSessionState(["admin"], ctx, "stg");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toContain("ccqa session bootstrap admin --profile stg");
  });
});
