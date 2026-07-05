import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const UI_DIR = fileURLToPath(new URL(".", import.meta.url));

/**
 * Structural guarantee behind the hub's UI/backend split (docs/hub.md): the
 * bundled WebUI must consume only the public REST API, never core internals
 * directly — that's what makes it safe to say "replace this with your own
 * intranet frontend" without anything else in the hub needing to change.
 * This test enforces the rule mechanically rather than relying on review.
 */
describe("hub UI isolation", () => {
  test("no file under src/hub/ui/ imports from src/hub/core/", async () => {
    const violations: string[] = [];
    for await (const file of walkTsFiles(UI_DIR)) {
      const content = await readFile(file, "utf8");
      const importPaths = [...content.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const importPath of importPaths) {
        if (importPath.includes("/core/") || importPath.startsWith("../core")) {
          violations.push(`${file}: imports "${importPath}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("no file under src/hub/ui/ imports from src/hub/api/ (handlers are also backend-only)", async () => {
    const violations: string[] = [];
    for await (const file of walkTsFiles(UI_DIR)) {
      const content = await readFile(file, "utf8");
      const importPaths = [...content.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const importPath of importPaths) {
        if (importPath.includes("/api/") || importPath.startsWith("../api")) {
          violations.push(`${file}: imports "${importPath}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsFiles(abs);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      yield abs;
    }
  }
}
