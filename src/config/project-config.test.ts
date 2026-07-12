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
    expect(config).toEqual({ defaultTarget: "agent-browser", targets: {} });
  });

  it("returns defaults for an empty config file", async () => {
    const cwd = await writeConfig("");
    const config = await loadProjectConfig(cwd);
    expect(config).toEqual({ defaultTarget: "agent-browser", targets: {} });
  });

  it("loads a full config", async () => {
    const cwd = await writeConfig(
      [
        "defaultTarget: playwright",
        "targets:",
        "  playwright:",
        "    outDir: e2e/specs",
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
    expect(config.targets["playwright"]).toEqual({
      outDir: "e2e/specs",
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
  it("fills target-level defaults (resources, conventions)", () => {
    const config = parseProjectConfig("targets:\n  runn:\n    outDir: runbooks\n");
    expect(config.defaultTarget).toBe("agent-browser");
    expect(config.targets["runn"]).toEqual({
      outDir: "runbooks",
      resources: [],
      conventions: { guides: [], examples: [] },
    });
  });

  it("allows a target without outDir (e.g. agent-browser needs none)", () => {
    const config = parseProjectConfig("targets:\n  agent-browser: {}\n");
    expect(config.targets["agent-browser"]?.outDir).toBeUndefined();
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
