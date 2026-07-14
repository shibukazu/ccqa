import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  AgentBrowserUnavailableError,
  assertAgentBrowserAvailable,
  formatAgentBrowserUnavailableMessage,
  resolveAgentBrowserBin,
  resolveAgentBrowserBinDir,
} from "./agent-browser-bin.ts";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    await rm(d, { recursive: true, force: true });
  }
});

async function makeShimDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccqa-shim-"));
  tmpDirs.push(dir);
  const shim = join(dir, "agent-browser");
  await writeFile(shim, "#!/bin/sh\necho mock\n", "utf-8");
  await chmod(shim, 0o755);
  return dir;
}

async function makeEmptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccqa-empty-"));
  tmpDirs.push(dir);
  await mkdir(join(dir, "inner"), { recursive: true });
  return join(dir, "inner");
}

describe("assertAgentBrowserAvailable", () => {
  test("throws AgentBrowserUnavailableError when resolver returns null", () => {
    expect(() => assertAgentBrowserAvailable(() => null)).toThrowError(
      AgentBrowserUnavailableError,
    );
  });

  test("throws when resolver returns a dir but the shim file is missing", async () => {
    const emptyBin = await makeEmptyDir();
    expect(() => assertAgentBrowserAvailable(() => emptyBin)).toThrowError(
      AgentBrowserUnavailableError,
    );
  });

  test("does not throw when the shim file exists and is executable", async () => {
    const shimDir = await makeShimDir();
    expect(() => assertAgentBrowserAvailable(() => shimDir)).not.toThrow();
  });

  test("returns the resolved bindir when the shim is valid", async () => {
    const shimDir = await makeShimDir();
    expect(assertAgentBrowserAvailable(() => shimDir)).toBe(shimDir);
  });
});

describe("CCQA_AB_BIN override", () => {
  const saved = process.env["CCQA_AB_BIN"];

  afterEach(() => {
    if (saved === undefined) delete process.env["CCQA_AB_BIN"];
    else process.env["CCQA_AB_BIN"] = saved;
  });

  test("bin and PATH dir resolve to the same binary (the daemon-split invariant)", async () => {
    const shimDir = await makeShimDir();
    process.env["CCQA_AB_BIN"] = join(shimDir, "agent-browser");
    expect(resolveAgentBrowserBin()).toBe(join(shimDir, "agent-browser"));
    expect(resolveAgentBrowserBinDir()).toBe(shimDir);
    expect(dirname(resolveAgentBrowserBin())).toBe(resolveAgentBrowserBinDir());
  });

  test("assert validates the override file itself, so a non-shim name (e2e stub) passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-stub-"));
    tmpDirs.push(dir);
    const stub = join(dir, "agent-browser.js");
    await writeFile(stub, "// stub\n", "utf-8");
    process.env["CCQA_AB_BIN"] = stub;
    expect(assertAgentBrowserAvailable()).toBe(dir);
  });

  test("assert throws when the override points at a missing file", async () => {
    const dir = await makeEmptyDir();
    process.env["CCQA_AB_BIN"] = join(dir, "nope");
    expect(() => assertAgentBrowserAvailable()).toThrowError(AgentBrowserUnavailableError);
  });
});

describe("formatAgentBrowserUnavailableMessage", () => {
  test("mentions the install commands", () => {
    const msg = formatAgentBrowserUnavailableMessage();
    expect(msg).toContain("pnpm add -D agent-browser");
    expect(msg).toContain("npm install -D agent-browser");
    expect(msg).toMatch(/not installed or not on PATH/);
  });
});
