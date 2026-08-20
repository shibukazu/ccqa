import { describe, expect, it } from "vitest";

import { transformTs } from "./transform-ts.ts";

/**
 * The TypeScript dialect against the shapes Turbopack actually hands it:
 * untranspiled TSX with Next directives. What matters is parity with the
 * acorn dialect's rules (prologue after directives, depth 2, class methods)
 * plus the one thing acorn never faced — the output must still be valid
 * TypeScript, because the bundler compiles it after us.
 */

const FILE = { fileId: "src/page.tsx" };

describe("transformTs", () => {
  it("instruments the module and top-level functions, keeping 'use client' first", () => {
    const code = `"use client";\nimport React from "react";\nexport function Page() {\n  return <div a={1}>hi</div>;\n}\n`;
    const out = transformTs(code, FILE);
    expect(out).toBeDefined();
    // The directive must still be the first statement.
    expect(out!.startsWith('"use client";')).toBe(true);
    // Module prologue right after it, then the function entry probe.
    expect(out).toContain('globalThis.__ccqaCoverage');
    expect(out!.indexOf("__ccqa_")).toBeLessThan(out!.indexOf("import React"));
    expect(out!.split("\n")[2]).toMatch(/^export function Page\(\) \{__ccqa_/);
    // Insertions only: the line count is untouched.
    expect(out!.split("\n").length).toBe(code.split("\n").length);
  });

  it("leaves deep callbacks alone but always takes class methods", () => {
    const code = [
      "export function outer() {",
      "  list.forEach(function inner() {",
      "    deep(() => { work(); });",
      "  });",
      "}",
      "export const helpers = { run() { go(); } };",
      "function wrap() {",
      "  class Hidden {",
      "    method(): void { act(); }",
      "  }",
      "  return Hidden;",
      "}",
    ].join("\n");
    const out = transformTs(code, { fileId: "src/depth.ts" })!;
    const probes = out.split("__ccqa_").length - 1;
    // prologue(2 mentions) + outer + inner(depth2) + helpers.run + wrap +
    // Hidden.method(class, any depth), each probe mentioning the local twice.
    expect(out.split("\n")[2]).not.toContain("__ccqa_"); // the deep arrow
    expect(out).toContain("method(): void {__ccqa_");
    expect(probes).toBeGreaterThanOrEqual(2 + 2 * 5);
  });

  it("skips bodyless declarations and keeps type syntax intact", () => {
    const code = [
      "export interface Shape { width: number }",
      "export function area(s: Shape): number;",
      "export function area(s: { width: number }): number {",
      "  return s.width;",
      "}",
    ].join("\n");
    const out = transformTs(code, { fileId: "src/types.ts" })!;
    expect(out).toContain("export interface Shape { width: number }");
    expect(out.split("\n")[1]).toBe("export function area(s: Shape): number;");
    expect(out.split("\n")[2]).toContain("{__ccqa_");
  });

  it("leaves an unparsable file alone", () => {
    expect(transformTs("export function {", { fileId: "src/broken.ts" })).toBeUndefined();
  });
});
