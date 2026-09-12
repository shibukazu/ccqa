import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z, ZodError } from "zod";
import { AGENT_BROWSER_TARGET, TargetIdSchema } from "../spec/yaml-schema.ts";
import { EVIDENCE_LABEL_KEYS, type EvidenceLabelKey } from "../evidence/labels.ts";
import { validateTestPathTemplate } from "../targets/test-path.ts";

/**
 * Loader for the consumer project's `.ccqa/config.yaml` — per-target
 * generation settings (default target, test path templates, reusable code
 * resources, generation conventions).
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

/** See `ProjectConfig.hub`. */
export const HubConfigSchema = z
  .object({
    url: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type HubConfig = z.infer<typeof HubConfigSchema>;

/**
 * How code should be written and how the application is driven, as guide
 * inputs to the prompts (never imported as code): `guides` are convention
 * documents and `examples` existing tests whose style to imitate, both read by
 * generation; `operate` is read by whatever drives the browser. Entries may be
 * globs.
 */
export const ConventionsSchema = z
  .object({
    guides: z.array(z.string().min(1)).default([]),
    examples: z.array(z.string().min(1)).default([]),
    /**
     * Documents whatever *drives the browser* reads, rather than the
     * generator: how this project signs in, which account a case's
     * precondition names, what to do before the first step. Read by both the
     * recorder and a live run — how an application is operated does not change
     * between the two. Kept as prose on purpose: a login is the part that
     * differs most between projects, and mechanising it would put a project's
     * own vocabulary into ccqa.
     */
    operate: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Conventions = z.infer<typeof ConventionsSchema>;

/**
 * Which sections of a markdown test case mean what. The keys are ccqa's
 * vocabulary; the values are the headings the project actually writes, in the
 * project's own language. Every one is optional — a case that states no
 * cleanup simply has none — except `steps`, without which there is nothing to
 * record.
 *
 * A heading no key names is not lost: it reaches the recorder as further
 * information about the case, which is what a precondition usually is.
 */
export const IntentFieldsSchema = z
  .object({
    title: z.string().min(1).default("Title"),
    precondition: z.string().min(1).default("Precondition"),
    steps: z.string().min(1).default("Steps"),
    expected: z.string().min(1).default("Expected"),
    cleanup: z.string().min(1).default("Cleanup"),
    priority: z.string().min(1).default("Priority"),
    link: z.string().min(1).default("Link"),
    /**
     * The heading that says how a case is executed: a body of `live` runs it
     * through the browser agent, anything else records and generates a test.
     * No default, for the same reason `outputPath` has none — a project that
     * did not name this heading has no cases that mean to declare a mode.
     */
    mode: z.string().min(1).optional(),
    /**
     * The heading ccqa writes the generated test's path into. No default on
     * purpose: this is the one section of the project's own file ccqa edits,
     * and it does that only where the project pointed at a heading and said
     * so. A guessed default would rewrite whatever a case happened to keep
     * under that name.
     */
    outputPath: z.string().min(1).optional(),
  })
  .strict();
export type IntentFields = z.infer<typeof IntentFieldsSchema>;

/**
 * Where a target's test cases are written, when they are not ccqa's own
 * `spec.yaml`. `root` is the directory the cases live under, and a case's id
 * is its path below it without the extension — which is also what `{case}`
 * expands to in `testPath`.
 */
export const IntentSourceSchema = z
  .object({
    kind: z.literal("markdown"),
    root: z.string().min(1),
    fields: IntentFieldsSchema.prefault({}),
  })
  .strict();
export type IntentSource = z.infer<typeof IntentSourceSchema>;

/**
 * How a generated test names the unique values it creates. `${CCQA_RUN_ID}` is
 * what the recording holds; a repo with its own helper for this says so here,
 * and the emitter calls that instead of leaving an env read in the test.
 */
export const RunIdConfigSchema = z
  .object({
    /** Module the expression comes from, imported by the generated test. */
    import: z.string().min(1),
    /** The expression itself, e.g. `utilsGenerateTimestampedUniqueId()`. */
    expression: z.string().min(1),
  })
  .strict();
export type RunIdConfig = z.infer<typeof RunIdConfigSchema>;

/**
 * A tag the test's title ends with, taken from an intent field. Mechanical on
 * purpose: a title tag is a convention a reviewer greps, and a model that
 * decides it per case gets it wrong in a way nobody notices.
 */
export const TitleTagsSchema = z
  .object({
    /** Intent field the value comes from (`priority`, ...). */
    field: z.string().min(1),
    /** Field value → tag value. A value the map does not name emits no tag. */
    map: z.record(z.string().min(1), z.string().min(1)).default({}),
    /** How the tag is written, `{value}` filled in. */
    format: z.string().min(1).default("@{value}"),
  })
  .strict();
export type TitleTags = z.infer<typeof TitleTagsSchema>;

/**
 * Per-target settings.
 *
 * `testPath` is the template deciding where a case's generated test lands
 * (`{feature}` / `{spec}` for `spec.yaml`, `{case}` for an intent source);
 * omitted, the target's own default applies. It is a template rather than a
 * directory because every other command has to find that file without asking
 * the generator — see src/targets/test-path.ts.
 *
 * `runCommand` is how `ccqa run` executes them (`{files}` expands to the test
 * paths, `{artifactsDir}` to the spec's report artifacts dir — see
 * src/targets/run-artifacts.ts). Optional at this layer because not every
 * target needs one; a target that requires it validates that itself.
 *
 * `kind: external` names a target the project defines here rather than one
 * ccqa ships: it has no code of its own, only this block. See
 * src/targets/external/index.ts.
 */
export const TargetConfigSchema = z
  .object({
    /** Absent: a target ccqa ships (`playwright`, `runn`, `agent-browser`). */
    kind: z.literal("external").optional(),
    /** Which test framework the generated code is written for. */
    framework: z.literal("playwright").optional(),
    /** Where this target's cases are written; absent means ccqa's `spec.yaml`. */
    intent: IntentSourceSchema.optional(),
    testPath: z
      .string()
      .min(1)
      .superRefine((template, ctx) => {
        const error = validateTestPathTemplate(template);
        if (error) ctx.addIssue({ code: "custom", message: error });
      })
      .optional(),
    /**
     * Directories generated support files may be created under. Only new files,
     * and only here: `resources` is what the generated code reads and imports,
     * never what it may rewrite.
     */
    writeRoots: z.array(z.string().min(1)).default([]),
    runCommand: z.string().min(1).optional(),
    /**
     * Checks run over the whole repository after generation (type check, lint).
     * Separate from `runCommand`, which runs the one test: a generated file
     * that breaks the project's build passes its own test and still cannot be
     * merged.
     */
    checkCommands: z.array(z.string().min(1)).default([]),
    resources: z.array(ResourceRefSchema).default([]),
    conventions: ConventionsSchema.prefault({}),
    runId: RunIdConfigSchema.optional(),
    /** Emitter switches. `stepEvidence` off drops the per-step capture calls. */
    hooks: z
      .object({ stepEvidence: z.boolean().default(true) })
      .strict()
      .prefault({}),
    /**
     * Whether the generated undo may contain `expect`.
     *
     * A case can state what its cleanup must make true, and ccqa asserts it
     * where the undo runs — inside the emitted `test.afterEach`. Some suites
     * forbid that: an assertion there turns a slow or partial teardown into a
     * failed test, which says the feature broke when it did not. Others want
     * the undo checked like anything else. Both are coherent, and ccqa is not
     * the one to decide — so a project that forbids it says so here, and the
     * undo is emitted as actions only.
     *
     * The case's stated expectations do not disappear when this is off: the
     * evidence table says which of them nothing checks, so a reader can see
     * what was traded away.
     */
    allowExpectInCleanup: z.boolean().default(true),
    /** Comment block the generated test opens with; intent fields fill it in. */
    header: z.string().optional(),
    titleTags: TitleTagsSchema.optional(),
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
     * Origins the application's static assets are served from, when they are
     * not the application's own. Only used to recognise a script as this
     * project's when reading a pushed source map; the spec cookie never goes
     * here, which is why it is a separate list from `instrumentedOrigins` —
     * widening that one to cover a CDN would hand a test marker to it.
     */
    assetOrigins: z.array(z.string().min(1)).optional(),
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
     * its siblings, whose code runs but lives above `--cwd`. It may also sit
     * entirely outside `--cwd`: a project whose tests are one checkout and
     * whose application is another names the application here. The
     * application's own `CCQA_COVERAGE_ROOT` has to name the same directory —
     * root the two halves differently and one file arrives under two names.
     */
    projectRoot: z.string().min(1).optional(),
    /**
     * The directory a source map's relative `sources` are resolved against —
     * where the build ran. Relative to `--cwd`, or absolute, and it need not
     * sit inside `projectRoot`.
     *
     * A bundler writes those paths relative to its own output directory, which
     * is only the working directory when ccqa and the build share one. When it
     * does not, every browser-side path resolves outside the project and the
     * run reports nothing reached — no error, because a path above the root is
     * dropped by design. Defaults to `--cwd`, which is the case where the two
     * are the same.
     */
    sourceBase: z.string().min(1).optional(),
    /**
     * Directories (relative to `projectRoot`) whose source files form the
     * denominator — the universe "uncovered" is judged against. Name the same
     * directories the application's `CCQA_COVERAGE_INCLUDE` instruments; the
     * run enumerates them from the checkout it measured, so numerator and
     * denominator can never drift apart. Absent, no universe is enumerated
     * and the hub's tree shows reached files only.
     */
    include: z.array(z.string().min(1)).optional(),
    /**
     * Globs (relative to `projectRoot`) whose files leave the answer: not
     * recorded as reached, not part of the universe, and never held against a
     * diff by `ccqa select-specs`. For aggregates every spec truthfully
     * reaches, which therefore select the whole suite; see docs/coverage.md.
     */
    exclude: z.array(z.string().min(1)).default([]),
    /** Specs whose flows are attributed by who acted, not by what the request carried. */
    actors: CoverageActorsSchema.default({}),
  })
  .strict();
export type CoverageConfig = z.infer<typeof CoverageConfigSchema>;

/**
 * The evidence table a reviewer reads instead of the generated test.
 *
 * `labels` puts the table's headings and furniture in the project's own
 * vocabulary. Only the keys the table prints are accepted: an override it
 * would never use is a typo, and ignoring it silently leaves the reader
 * wondering why nothing changed. What the table *concludes* is not among them
 * — ccqa owns those words, and translates them itself (`--language`).
 *
 * ```yaml
 * evidence:
 *   labels:
 *     step: 手順
 *     decides: テストが判定していること
 * ```
 */
export const EvidenceConfigSchema = z
  .object({
    labels: z
      .partialRecord(
        z.enum(EVIDENCE_LABEL_KEYS as [EvidenceLabelKey, ...EvidenceLabelKey[]]),
        z.string().min(1),
      )
      .default({}),
  })
  .strict();
export type EvidenceConfig = z.infer<typeof EvidenceConfigSchema>;

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
    evidence: EvidenceConfigSchema.prefault({}),
    /**
     * The language this project writes in (BCP-47, or `auto`), for everything
     * ccqa produces that a person reads: the comments in a generated test,
     * the evidence table, a model's findings. `--language` overrides it for
     * one command; here because a project's language is a fact about the
     * project, not a thing to remember on every invocation.
     */
    language: z.string().min(1).optional(),
    /**
     * Files the project keeps its own variables in (dotenv format, relative to
     * the project root), loaded before a recording resolves `${VAR}`. A project
     * that already has an env file for its tests points at it rather than
     * duplicating those values into a ccqa profile. A named file that is not
     * there is an error: recording against silently missing variables bakes
     * whatever the browser happened to show into the route.
     */
    envFiles: z.array(z.string().min(1)).default([]),
    /**
     * Where the product's own source lives, as `ccqa audit` reads it: the
     * "right answer" a test case is checked against. Paths may be absolute or
     * relative to the project root, and may point outside it — the application
     * a test drives is often a sibling checkout, not the repository the tests
     * live in. A named root that is not there is an error: auditing against a
     * directory that silently is not read clears cases nothing looked at.
     */
    sourceRoots: z.array(z.string().min(1)).default([]),
    /**
     * Which hub this project talks to. A fact about the project, so it belongs
     * beside the rest of them rather than in four flags repeated at every
     * invocation. The **token is deliberately not here**: it is a credential,
     * and it stays in `CCQA_HUB_TOKEN`. `headers` values may hold `${VAR}`,
     * resolved from the environment when the connection is made, so a gateway
     * secret is named here and kept elsewhere.
     */
    hub: HubConfigSchema.optional(),
    /**
     * A saved browser session (Playwright `storageState` JSON) restored before
     * the browser is driven, so a case whose precondition is "signed in" does
     * not have to record or replay the sign-in. A fact about the project, not
     * about one command: both a recording and a live run start from it.
     */
    sessionState: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const [id, target] of Object.entries(config.targets)) {
      const at = (key: string): string[] => ["targets", id, key];
      const refuse = (path: string[], message: string): void => {
        ctx.addIssue({ code: "custom", path, message });
      };
      if (target.kind !== "external") {
        // These only mean something for a target the project defines: a
        // built-in one brings its own generation, and settings it ignores
        // would read as configured behaviour that never happens.
        for (const key of ["framework", "intent", "runId", "header", "titleTags"] as const) {
          if (target[key] !== undefined) {
            refuse(at(key), `${key} applies to a \`kind: external\` target; "${id}" is one ccqa ships`);
          }
        }
        continue;
      }
      // A target with no code of its own cannot guess these.
      if (target.framework === undefined) refuse(at("framework"), "a kind: external target must say which framework its tests are written for (framework: playwright)");
      if (target.testPath === undefined) refuse(at("testPath"), "a kind: external target must say where its generated tests go (testPath)");
      // A case read from the project's own files is addressed by a path, and
      // `{spec}` is only its last segment: two cases filed in different
      // directories under the same name would generate onto one file.
      if (
        target.intent !== undefined &&
        target.testPath !== undefined &&
        !target.testPath.includes("{case}")
      ) {
        refuse(
          at("testPath"),
          "a target reading an intent source addresses cases by their path, so its testPath must use {case} — {spec} is only the last segment, and two cases filed under the same name would collide",
        );
      }
    }
    // The agent-browser target's vitest test is ccqa's own replay artifact,
    // not a consumer asset: `ccqa run` enumerates it in the spec directory. A
    // `testPath` there would be read by the audit and ignored by the runner.
    // Checked here rather than declared by the plugin, because this module
    // cannot reach the registry — the plugins import it.
    if (config.targets[AGENT_BROWSER_TARGET]?.testPath !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["targets", AGENT_BROWSER_TARGET, "testPath"],
        message: `testPath is not configurable for the ${AGENT_BROWSER_TARGET} target — its test always lives in the spec directory`,
      });
    }
  });
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * One target's settings, or the defaults when the project configured none (or
 * has no config at all). Every caller that resolves a target needs this, and
 * each one spelling out the fallback invites two of them to disagree about
 * what "unconfigured" means.
 */
export function targetConfigFor(config: ProjectConfig | null, targetId: string): TargetConfig {
  return config?.targets[targetId] ?? TargetConfigSchema.parse({});
}

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
