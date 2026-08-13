import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

import { sourceBehindBuildOutput } from "./build-output.ts";

let root: string;

/**
 * A workspace package as one is actually consumed: the browser runs `dist`,
 * the repository holds `src`, and the map between them is the only thing that
 * says which is which.
 */
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ccqa-build-output-"));
  const pkg = join(root, "packages", "logger");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await mkdir(join(pkg, "src"), { recursive: true });
  await writeFile(join(pkg, "src", "index.ts"), "export const log = () => {};\n");
  await writeFile(join(pkg, "dist", "index.mjs"), "export const log=()=>{};\n");
  await writeFile(
    join(pkg, "dist", "index.mjs.map"),
    JSON.stringify({ version: 3, sources: ["../src/index.ts"], mappings: "" }),
  );

  await mkdir(join(root, "app"), { recursive: true });
  await writeFile(join(root, "app", "bundle.js"), "");
  await writeFile(
    join(root, "app", "bundle.js.map"),
    JSON.stringify({ version: 3, sources: ["../a.ts", "../b.ts"], mappings: "" }),
  );

  await writeFile(join(root, "app", "gone.js"), "");
  await writeFile(
    join(root, "app", "gone.js.map"),
    JSON.stringify({ version: 3, sources: ["./missing.ts"], mappings: "" }),
  );
});

describe("sourceBehindBuildOutput", () => {
  test("reports the source a 1:1 build output came from", () => {
    expect(sourceBehindBuildOutput("packages/logger/dist/index.mjs", root)).toBe(
      "packages/logger/src/index.ts",
    );
  });

  test("leaves a bundle alone: its map cannot say which source the file is", () => {
    expect(sourceBehindBuildOutput("app/bundle.js", root)).toBeUndefined();
  });

  test("leaves an output alone when the source it names is not on disk", () => {
    expect(sourceBehindBuildOutput("app/gone.js", root)).toBeUndefined();
  });

  test("leaves an output with no map beside it alone", () => {
    expect(sourceBehindBuildOutput("packages/logger/src/index.ts", root)).toBeUndefined();
  });
});
