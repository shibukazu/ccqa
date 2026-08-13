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
 * Specs that must not run at the same time, grouped by the thing they share.
 *
 * The key names the shared thing (a chat channel, a seeded account, a tenant);
 * the list names the specs that write to it. `ccqa run` never runs two members
 * of one group concurrently, and specs sharing no group still run in parallel.
 *
 * Kept here rather than on each spec so there is one place to read the whole
 * picture, and so a mistyped member is a spec key that does not resolve —
 * caught — rather than a resource name that silently matches nothing.
 */
export const SerialGroupsSchema = z.record(
  // A slug, so `"g "` and `"g"` cannot be two groups and the name stays
  // distinguishable from a spec key once both are hub lock keys.
  z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/i,
      "serial group name must be a slug (letters, digits, '.', '_', '-')",
    ),
  z.array(z.string().min(1)).min(1),
);
export type SerialGroups = z.infer<typeof SerialGroupsSchema>;

/**
 * Which specs act as which external identity, for the flows whose requests
 * cannot carry a spec id at all.
 *
 * A chat platform's webhook is sent by the platform, not the browser, so no
 * cookie rides along and everything the flow reaches would be unattributed.
 * What the request does carry is who caused it, and if only one spec is allowed
 * to act as that identity at a time, "who" plus "when" is enough.
 *
 * ```yaml
 * coverage:
 *   actors:
 *     slack:                      # the preset's tag prefix
 *       ${TEST_USER_ID}: [chat/create-item, chat/resolve-item]
 * ```
 *
 * The provider name is the prefix the matching preset stamps, and the key is an
 * identity expression the run's variables resolve. Only the unexpanded text is
 * ever displayed or used as a lock key, so the identity itself stays out of
 * reports and the hub.
 */
export const CoverageActorsSchema = z.record(
  z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/i,
      "actor provider must be a slug (letters, digits, '.', '_', '-')",
    ),
  z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
);
export type CoverageActors = z.infer<typeof CoverageActorsSchema>;

/**
 * Settings for `ccqa run --coverage`, which measures what each spec actually
 * reached in the application under test.
 */
export const CoverageConfigSchema = z
  .object({
    /**
     * Where the spec cookie is allowed to go. No default on purpose: a spec
     * routinely visits origins that are not the application, so guessing wide
     * hands a test marker to a third party and guessing narrow loses an
     * origin's reach entirely.
     */
    instrumentedOrigins: z.array(z.string().min(1)).min(1),
    /**
     * The address `ccqa run --coverage` binds a listener on for the run's
     * duration, and therefore where instrumented application processes push.
     * The application is pointed at the same address through its own
     * `CCQA_COVERAGE_ENDPOINT`.
     *
     * Not the hub. The hub stores results and never executes; deciding which
     * spec a push belongs to needs the ids this run issued and the turns it
     * opened, which only the run has.
     *
     * The default binds loopback, so it fits an application on the same machine
     * and nothing else. Measuring a deployed one means binding an address it
     * can reach — on a port its egress rules allow, which is rarely an
     * arbitrary one — and the sink authenticates nothing, so that address
     * should not be one the open internet can find.
     */
    sink: z.string().min(1).default("http://127.0.0.1:4757"),
    /**
     * How far "the project" extends: reported paths are relative to it, and
     * anything resolving above it is dropped rather than guessed at. Resolved
     * against `--cwd`, and defaults to it.
     *
     * Widen it when the application is one package of a workspace and imports
     * its siblings, whose code runs but lives above `--cwd`. The application's
     * own `CCQA_COVERAGE_ROOT` has to name the same directory — root the two
     * halves differently and one file arrives under two names.
     */
    projectRoot: z.string().min(1).optional(),
    /** Specs whose flows are attributed by who acted, not by what the request carried. */
    actors: CoverageActorsSchema.default({}),
  })
  .strict();
export type CoverageConfig = z.infer<typeof CoverageConfigSchema>;

/**
 * Top-level `.ccqa/config.yaml` schema. `defaultTarget` is used by specs
 * with no `target:` of their own. Both defaults make a missing config file
 * equivalent to "agent-browser only, no extra settings".
 */
export const ProjectConfigSchema = z
  .object({
    defaultTarget: TargetIdSchema.default(AGENT_BROWSER_TARGET),
    targets: z.record(TargetIdSchema, TargetConfigSchema).default({}),
    serialGroups: SerialGroupsSchema.default({}),
    coverage: CoverageConfigSchema.optional(),
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
