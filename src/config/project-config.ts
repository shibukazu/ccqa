import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z, ZodError } from "zod";
import { AGENT_BROWSER_TARGET, TargetIdSchema } from "../spec/yaml-schema.ts";

/**
 * Loader for the consumer project's `.ccqa/config.yaml` — per-target
 * generation settings (default target, output dirs, reusable code resources,
 * generation conventions).
 *
 * This module only validates and holds the config. `path` / `guides` /
 * `examples` entries may be glob patterns; they are kept verbatim here and
 * expanded by the generation engine, which owns size limits and warnings.
 */

/**
 * An existing code asset the generated tests should reuse (import), in one of
 * two forms — exactly one of:
 *   - `path`: code inside the consumer repo (literal path or glob pattern);
 *   - `package`: an installed npm package (imported by name).
 * `description` tells the generator what the asset contains.
 */
export const ResourceRefSchema = z.union(
  [
    z.object({ path: z.string().min(1), description: z.string().optional() }).strict(),
    z.object({ package: z.string().min(1), description: z.string().optional() }).strict(),
  ],
  {
    error:
      "a resource must have exactly one of `path` (code in this repo) or `package` (installed npm package), plus an optional `description`",
  },
);
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

/**
 * How generated code should be written, as guide inputs to the prompt (never
 * imported as code): `guides` are convention documents, `examples` are
 * existing tests whose style to imitate. Entries may be glob patterns.
 */
export const ConventionsSchema = z
  .object({
    guides: z.array(z.string().min(1)).default([]),
    examples: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Conventions = z.infer<typeof ConventionsSchema>;

/**
 * Per-target settings. `outDir` (where generated tests are written) and
 * `runCommand` (how to execute them; `{files}` expands to the generated
 * paths, `{artifactsDir}` to the spec's report artifacts dir — see
 * src/targets/run-artifacts.ts) are optional at this layer because not every
 * target needs them — e.g. agent-browser stores its output in the spec
 * directory. A target that requires either must validate its presence itself.
 */
export const TargetConfigSchema = z
  .object({
    outDir: z.string().min(1).optional(),
    runCommand: z.string().min(1).optional(),
    resources: z.array(ResourceRefSchema).default([]),
    conventions: ConventionsSchema.default({ guides: [], examples: [] }),
  })
  .strict();
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

/**
 * Top-level `.ccqa/config.yaml` schema. `defaultTarget` is used by specs
 * with no `target:` of their own. Both defaults make a missing config file
 * equivalent to "agent-browser only, no extra settings".
 */
export const ProjectConfigSchema = z
  .object({
    defaultTarget: TargetIdSchema.default(AGENT_BROWSER_TARGET),
    targets: z.record(TargetIdSchema, TargetConfigSchema).default({}),
  })
  .strict();
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** Config file location, relative to the project root (`--cwd`). */
export const PROJECT_CONFIG_PATH = ".ccqa/config.yaml";

/**
 * Load `<cwd>/.ccqa/config.yaml`. A missing file yields the defaults (an
 * empty file too); a present but broken file is an error — never silently
 * fall back when the user wrote a config.
 */
export async function loadProjectConfig(cwd: string): Promise<ProjectConfig> {
  let content: string;
  try {
    content = await readFile(join(cwd, PROJECT_CONFIG_PATH), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ProjectConfigSchema.parse({});
    throw e;
  }
  return parseProjectConfig(content);
}

/** Parse config YAML. Schema rejections are rewritten with actionable messages. */
export function parseProjectConfig(
  content: string,
  source = PROJECT_CONFIG_PATH,
): ProjectConfig {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (e) {
    throw new Error(`Failed to parse YAML (${source}): ${(e as Error).message}`);
  }
  try {
    return ProjectConfigSchema.parse(raw ?? {});
  } catch (e) {
    throw enrichZodError(e, source);
  }
}

/** Flatten a ZodError into one `Invalid <source>:` message, path per line. */
function enrichZodError(error: unknown, source: string): Error {
  if (!(error instanceof ZodError)) return error as Error;
  const lines: string[] = [`Invalid ${source}:`];
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "(root)";
    // A bad record key (e.g. a non-slug target id) reports a generic
    // "Invalid key in record"; the key schema's own message nests inside.
    const message =
      issue.code === "invalid_key" && issue.issues[0] ? issue.issues[0].message : issue.message;
    lines.push(`  - ${path}: ${message}`);
  }
  return new Error(lines.join("\n"));
}
