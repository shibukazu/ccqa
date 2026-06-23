import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  AgentBrowserUnavailableError,
  assertAgentBrowserAvailable,
  formatAgentBrowserUnavailableMessage,
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

describe("formatAgentBrowserUnavailableMessage", () => {
  test("mentions the install commands", () => {
    const msg = formatAgentBrowserUnavailableMessage();
    expect(msg).toContain("pnpm add -D agent-browser");
    expect(msg).toContain("npm install -D agent-browser");
    expect(msg).toMatch(/not installed or not on PATH/);
  });
});
