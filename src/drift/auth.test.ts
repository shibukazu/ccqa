import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { driftAuthAvailable } from "./auth.ts";

const ORIGINAL_KEY = process.env["ANTHROPIC_API_KEY"];
const ORIGINAL_HOME = process.env["HOME"];

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = ORIGINAL_KEY;
  if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = ORIGINAL_HOME;
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

  test("returns not-ok with a reason when neither is present", () => {
    delete process.env["ANTHROPIC_API_KEY"];
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ccqa-auth-"));
    const result = driftAuthAvailable();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no ANTHROPIC_API_KEY/);
  });

  test("empty ANTHROPIC_API_KEY does not count as set", () => {
    process.env["ANTHROPIC_API_KEY"] = "";
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ccqa-auth-"));
    expect(driftAuthAvailable().ok).toBe(false);
  });
});
