import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import configs from "../tsdown.config.ts";

/**
 * The build and the export map have to name the same set of artifacts.
 *
 * They are written in two files that nothing connects: adding an entry to
 * `tsdown.config.ts` builds a file nobody can import, and adding a subpath to
 * `package.json` publishes a path that resolves to nothing. The second is the
 * dangerous one — an application installs the SDK, imports the subpath its docs
 * name, and fails at runtime in a deployment rather than here.
 *
 * The other tests in this package import sources directly, so neither mistake
 * shows up in any of them.
 */

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { exports: Record<string, Record<string, string>> };

/** `dist/<name>.js` (or `.cjs`) is what an entry named `<name>` produces. */
function builtNames(): string[] {
  return configs.flatMap((config) => Object.keys((config as { entry: Record<string, string> }).entry));
}

/** The dist basename each subpath resolves to, from whichever condition it declares. */
function exportedNames(): string[] {
  return Object.values(pkg.exports).map((conditions) => {
    const target = conditions.import ?? conditions.default ?? conditions.require ?? "";
    return target.replace(/^\.\/dist\//, "").replace(/\.(c?js)$/, "");
  });
}

describe("build entries and the export map", () => {
  test("name the same artifacts", () => {
    expect(exportedNames().sort()).toEqual(builtNames().sort());
  });

  test("every subpath points inside dist/", () => {
    // `files` publishes only `dist/`, so a target anywhere else ships a
    // subpath that resolves to a file the tarball does not contain.
    for (const conditions of Object.values(pkg.exports)) {
      for (const target of Object.values(conditions)) {
        expect(target, `${target} is outside dist/`).toMatch(/^\.\/dist\//);
      }
    }
  });
});
