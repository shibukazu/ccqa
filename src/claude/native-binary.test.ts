import { describe, expect, test } from "vitest";
import { missingNativeBinaryPackage, nativeBinaryPackage } from "./native-binary.ts";

describe("nativeBinaryPackage", () => {
  test("names the package for the host platform, cpu and libc", () => {
    expect(nativeBinaryPackage("darwin", "arm64", false)).toBe(
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
    );
    expect(nativeBinaryPackage("linux", "x64", false)).toBe(
      "@anthropic-ai/claude-agent-sdk-linux-x64",
    );
    // Only linux ships a musl variant; the flag must not leak elsewhere.
    expect(nativeBinaryPackage("linux", "arm64", true)).toBe(
      "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
    );
    expect(nativeBinaryPackage("win32", "x64", true)).toBe(
      "@anthropic-ai/claude-agent-sdk-win32-x64",
    );
  });

  test("falls back to x64 for cpus that ship no dedicated binary", () => {
    expect(nativeBinaryPackage("linux", "ia32", false)).toBe(
      "@anthropic-ai/claude-agent-sdk-linux-x64",
    );
  });
});

describe("missingNativeBinaryPackage", () => {
  test("returns the package name when it cannot be resolved", () => {
    const missing = missingNativeBinaryPackage(() => {
      throw new Error("Cannot find module");
    });
    expect(missing).toBe(nativeBinaryPackage());
  });

  test("returns null once the package resolves", () => {
    expect(missingNativeBinaryPackage(() => "/somewhere/package.json")).toBeNull();
  });
});
