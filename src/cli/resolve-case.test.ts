import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadProjectConfig } from "../config/project-config.ts";
import { resolveCase } from "./resolve-case.ts";

const SPEC = `title: Add an item
steps:
  - instruction: Open the list and add an item.
    expected: The item is on the list.
`;

let cwd = "";

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
  cwd = "";
});

/**
 * A project with one spec, and whatever `.ccqa/config.yaml` the test needs.
 * `playwright` is given a `testPath` of its own so an assertion about which
 * target a path came from can tell the two apart — the default is the same
 * template agent-browser uses.
 */
const CONFIG = `defaultTarget: agent-browser

targets:
  playwright:
    testPath: e2e/{feature}/{spec}.spec.ts
`;

async function project(config: string, specYaml = SPEC): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccqa-resolve-case-"));
  const specDir = join(dir, ".ccqa/features/todo/test-cases/add-item");
  await mkdir(specDir, { recursive: true });
  await writeFile(join(specDir, "spec.yaml"), specYaml, "utf8");
  await writeFile(join(dir, ".ccqa/config.yaml"), config, "utf8");
  return dir;
}

/** A project whose cases come from a source it owns, read by its default target. */
async function ownCasesProject(config: string, cases: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ccqa-resolve-case-"));
  await mkdir(join(dir, ".ccqa"), { recursive: true });
  await writeFile(join(dir, ".ccqa/config.yaml"), config, "utf8");
  for (const [path, body] of Object.entries(cases)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), body, "utf8");
  }
  return dir;
}

const READER = `export default ({ cwd }) => ({
  list: () => ["todo/add_item"],
  load: (id) => ({
    id,
    path: \`\${cwd}/docs/cases/\${id}.md\`,
    text: "Add an item",
    title: "Add an item",
    mode: "deterministic",
    steps: [{ instruction: "Open the list and add an item." }],
  }),
});
`;

/** Two targets reading the same case source and emitting to different places. */
const TWO_EMITTERS = `defaultTarget: primary

targets:
  primary:
    kind: external
    framework: playwright
    testPath: specs/{case}.spec.ts
    cases: ./ccqa/cases.mjs
    runCommand: "true {files}"
  secondary:
    kind: external
    framework: playwright
    testPath: legacy/{case}.spec.ts
    cases: ./ccqa/cases.mjs
    runCommand: "true {files}"
`;

describe("resolveCase — where the case's recording lives", () => {
  test("anchors a spec case's recording on its own target, not on --target", async () => {
    cwd = await project(CONFIG);
    const config = await loadProjectConfig(cwd);

    const resolved = await resolveCase("todo/add-item", config, cwd, {
      targetOverride: "playwright",
    });

    // `--target` moves where the test is written, and the route stays where
    // the case recorded it.
    expect(resolved.testPath).toBe("e2e/todo/add-item.spec.ts");
    expect(resolved.testCase.ref.recordingPathAbs).toBe(
      join(cwd, ".ccqa/features/todo/test-cases/add-item/test.spec.ccqa.ir.json"),
    );
  });

  test("anchors an own-source case's recording on its own target, not on --target", async () => {
    cwd = await ownCasesProject(TWO_EMITTERS, { "ccqa/cases.mjs": READER });
    const config = await loadProjectConfig(cwd);

    const resolved = await resolveCase("todo/add_item", config, cwd, {
      targetOverride: "secondary",
    });

    expect(resolved.testPath).toBe("legacy/todo/add_item.spec.ts");
    expect(resolved.testCase.ref.recordingPathAbs).toBe(
      join(cwd, "specs/todo/add_item.spec.ccqa.ir.json"),
    );
  });

  test("generates through --target even when the spec's own target no longer resolves", async () => {
    cwd = await project(CONFIG, `${SPEC}target: no-such-target\n`);
    const config = await loadProjectConfig(cwd);

    const resolved = await resolveCase("todo/add-item", config, cwd, {
      targetOverride: "playwright",
    });

    expect(resolved.target.id).toBe("playwright");
    // No target to derive a path from, so the recording keeps the location
    // every case's used to have.
    expect(resolved.testCase.ref.recordingPathAbs).toBeUndefined();
  });
});
