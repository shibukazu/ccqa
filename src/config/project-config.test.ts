import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadProjectConfig,
  parseProjectConfig,
  PROJECT_CONFIG_PATH,
} from "./project-config.ts";

async function writeConfig(yaml: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ccqa-config-"));
  await mkdir(join(cwd, ".ccqa"), { recursive: true });
  await writeFile(join(cwd, PROJECT_CONFIG_PATH), yaml, "utf8");
  return cwd;
}

describe("loadProjectConfig", () => {
  it("returns defaults when the config file is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ccqa-config-"));
    const config = await loadProjectConfig(cwd);
    expect(config).toEqual({
      defaultTarget: "agent-browser",
      targets: {},
      serialGroups: {},
      envFiles: [],
      sourceRoots: [],
    });
  });

  it("returns defaults for an empty config file", async () => {
    const cwd = await writeConfig("");
    const config = await loadProjectConfig(cwd);
    expect(config).toEqual({
      defaultTarget: "agent-browser",
      targets: {},
      serialGroups: {},
      envFiles: [],
      sourceRoots: [],
    });
  });

  it("loads a full config", async () => {
    const cwd = await writeConfig(
      [
        "defaultTarget: playwright",
        "targets:",
        "  playwright:",
        "    testPath: e2e/specs/{feature}/{spec}.spec.ts",
        '    runCommand: "pnpm exec playwright test {files}"',
        "    resources:",
        "      - path: e2e/pages",
        "        description: page objects",
        '      - package: "@acme/e2e-kit"',
        "        description: shared fixtures",
        "    conventions:",
        "      guides: [docs/e2e-guidelines.md]",
        "      examples: [e2e/specs/sample_login.spec.ts]",
      ].join("\n"),
    );
    const config = await loadProjectConfig(cwd);
    expect(config.defaultTarget).toBe("playwright");
    expect(config.targets["playwright"]).toMatchObject({
      testPath: "e2e/specs/{feature}/{spec}.spec.ts",
      runCommand: "pnpm exec playwright test {files}",
      resources: [
        { path: "e2e/pages", description: "page objects" },
        { package: "@acme/e2e-kit", description: "shared fixtures" },
      ],
      conventions: {
        guides: ["docs/e2e-guidelines.md"],
        examples: ["e2e/specs/sample_login.spec.ts"],
      },
    });
  });

  it("fails loudly on broken YAML instead of falling back", async () => {
    const cwd = await writeConfig("defaultTarget: [unclosed");
    await expect(loadProjectConfig(cwd)).rejects.toThrow(/Failed to parse YAML/);
  });
});

describe("parseProjectConfig", () => {
  it("fills target-level defaults", () => {
    const config = parseProjectConfig(
      "targets:\n  runn:\n    testPath: runbooks/{feature}/{spec}.yaml\n",
    );
    expect(config.defaultTarget).toBe("agent-browser");
    expect(config.targets["runn"]).toEqual({
      testPath: "runbooks/{feature}/{spec}.yaml",
      resources: [],
      conventions: { guides: [], examples: [], operate: [] },
      writeRoots: [],
      checkCommands: [],
      hooks: { stepEvidence: true },
    });
  });

  it("allows a target without testPath (e.g. agent-browser needs none)", () => {
    const config = parseProjectConfig("targets:\n  agent-browser: {}\n");
    expect(config.targets["agent-browser"]?.testPath).toBeUndefined();
  });

  it("rejects testPath on the agent-browser target", () => {
    expect(() =>
      parseProjectConfig("targets:\n  agent-browser:\n    testPath: e2e/{feature}/{spec}.spec.ts\n"),
    ).toThrow(/testPath is not configurable for the agent-browser target/);
  });

  it("accepts a target the project defines against its own framework", () => {
    const config = parseProjectConfig(
      [
        "targets:",
        "  scenario:",
        "    kind: external",
        "    framework: playwright",
        "    testPath: specs/{case}.spec.ts",
        "    writeRoots: [pages]",
        "    checkCommands: [\"pnpm tsc --noEmit\"]",
        "    intent:",
        "      kind: markdown",
        "      root: docs/testcase",
        "      fields:",
        "        steps: 手順",
        "    titleTags:",
        "      field: priority",
        "      map: { 高: high }",
      ].join("\n"),
    );
    const target = config.targets["scenario"]!;
    expect(target.kind).toBe("external");
    expect(target.intent?.fields.steps).toBe("手順");
    // Unnamed fields keep ccqa's own defaults, so a project maps only what it renames.
    expect(target.intent?.fields.expected).toBe("Expected");
    expect(target.writeRoots).toEqual(["pages"]);
  });

  it.each([
    [
      "kind: external\n    testPath: specs/{spec}.spec.ts",
      /must say which framework/,
    ],
    ["kind: external\n    framework: playwright", /must say where its generated tests go/],
    [
      "kind: external\n    framework: playwright\n    testPath: specs/{spec}.spec.ts\n    intent:\n      kind: markdown\n      root: docs",
      /must use \{case\}/,
    ],
  ])("refuses an incomplete external target (%#)", (body, message) => {
    expect(() => parseProjectConfig(`targets:\n  scenario:\n    ${body}\n`)).toThrow(message);
  });

  it("refuses settings that only a project-defined target can act on", () => {
    expect(() =>
      parseProjectConfig("targets:\n  playwright:\n    header: \"// x\"\n"),
    ).toThrow(/header applies to a `kind: external` target/);
  });

  it("rejects a resource with both path and package", () => {
    expect(() =>
      parseProjectConfig(
        [
          "targets:",
          "  playwright:",
          "    resources:",
          "      - path: e2e/pages",
          '        package: "@acme/e2e-kit"',
        ].join("\n"),
      ),
    ).toThrow(/exactly one of `path`.*`package`/);
  });

  it("rejects a resource with neither path nor package", () => {
    expect(() =>
      parseProjectConfig(
        ["targets:", "  playwright:", "    resources:", "      - description: orphan"].join(
          "\n",
        ),
      ),
    ).toThrow(/exactly one of `path`.*`package`/);
  });

  it("rejects an invalid defaultTarget slug", () => {
    expect(() => parseProjectConfig("defaultTarget: ../escape\n")).toThrow(/slug/);
  });

  it("rejects an invalid target key slug", () => {
    expect(() => parseProjectConfig("targets:\n  a/b: {}\n")).toThrow(/slug/);
  });

  it("rejects unknown keys and names the source file", () => {
    expect(() => parseProjectConfig("extra: value\n")).toThrow(
      /Invalid \.ccqa\/config\.yaml/,
    );
  });
});
