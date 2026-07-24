import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { driftAuthAvailable } from "./auth.ts";

const ORIGINAL_KEY = process.env["ANTHROPIC_API_KEY"];
const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_PATH = process.env["PATH"];
const ORIGINAL_BEDROCK = process.env["CLAUDE_CODE_USE_BEDROCK"];
const ORIGINAL_VERTEX = process.env["CLAUDE_CODE_USE_VERTEX"];

// On darwin the probe also consults the Keychain via the `security` binary
// (resolved through PATH). Prepend a stub that always exits 1 so these tests
// stay deterministic on developer Macs that DO have a Claude Code login.
function stubSecurityBinary(exitCode: 0 | 1): void {
  const dir = mkdtempSync(join(tmpdir(), "ccqa-auth-stub-"));
  const stub = join(dir, "security");
  writeFileSync(stub, `#!/bin/sh\nexit ${exitCode}\n`, "utf-8");
  chmodSync(stub, 0o755);
  process.env["PATH"] = `${dir}:${ORIGINAL_PATH ?? ""}`;
}

beforeEach(() => {
  stubSecurityBinary(1);
  delete process.env["CLAUDE_CODE_USE_BEDROCK"];
  delete process.env["CLAUDE_CODE_USE_VERTEX"];
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = ORIGINAL_KEY;
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
  if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
  else process.env["PATH"] = ORIGINAL_PATH;
  if (ORIGINAL_BEDROCK === undefined) delete process.env["CLAUDE_CODE_USE_BEDROCK"];
  else process.env["CLAUDE_CODE_USE_BEDROCK"] = ORIGINAL_BEDROCK;
  if (ORIGINAL_VERTEX === undefined) delete process.env["CLAUDE_CODE_USE_VERTEX"];
  else process.env["CLAUDE_CODE_USE_VERTEX"] = ORIGINAL_VERTEX;
});

describe("driftAuthAvailable", () => {
  test("returns ok when ANTHROPIC_API_KEY is set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    expect(driftAuthAvailable()).toEqual({ ok: true });
  });

  test("returns ok when ~/.claude/.credentials.json exists", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const home = mkdtempSync(join(tmpdir(), "ccqa-auth-"));
    process.env["HOME"] = home;
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", ".credentials.json"), "{}", "utf-8");
    expect(driftAuthAvailable()).toEqual({ ok: true });
  });

  test("returns not-ok with a reason when nothing is present", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ccqa-auth-"));
    const result = driftAuthAvailable();
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/no ANTHROPIC_API_KEY/) });
  });

  test("empty ANTHROPIC_API_KEY does not count as set", () => {
    process.env["ANTHROPIC_API_KEY"] = "";
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ccqa-auth-"));
    expect(driftAuthAvailable().ok).toBe(false);
  });

  test("returns ok when CLAUDE_CODE_USE_BEDROCK is enabled", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ccqa-auth-"));
    process.env["CLAUDE_CODE_USE_BEDROCK"] = "1";
    expect(driftAuthAvailable()).toEqual({ ok: true });
  });

  test("returns ok when CLAUDE_CODE_USE_VERTEX is enabled", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ccqa-auth-"));
    process.env["CLAUDE_CODE_USE_VERTEX"] = "true";
    expect(driftAuthAvailable()).toEqual({ ok: true });
  });

  test("explicitly disabled cloud-provider toggles do not count", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ccqa-auth-"));
    process.env["CLAUDE_CODE_USE_BEDROCK"] = "0";
    process.env["CLAUDE_CODE_USE_VERTEX"] = "false";
    expect(driftAuthAvailable().ok).toBe(false);
  });

  (process.platform === "darwin" ? test : test.skip)(
    "darwin: a Keychain 'Claude Code-credentials' item counts as a login",
    () => {
      delete process.env["ANTHROPIC_API_KEY"];
      process.env["HOME"] = mkdtempSync(join(tmpdir(), "ccqa-auth-"));
      stubSecurityBinary(0);
      expect(driftAuthAvailable()).toEqual({ ok: true });
    },
  );
});
