import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { z } from "zod";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import type { ExpandedStep } from "../spec/expand.ts";
import { caseRunDir, clearCaseRun, loadPromptBundle } from "../store/index.ts";
import { formatEmittedReview, reviewEmittedFiles } from "./emitted-review.ts";
import {
  formatFinding,
  formatViolation,
  type GuideViolation,
  type SpecCoverageFinding,
  type SpecCoverageReview,
} from "./verifies-spec.ts";
import { isExpandedActionStep } from "../spec/expand.ts";
import { EVIDENCE_DIR_ENV } from "../runtime/evidence-constants.ts";
import {
  buildLlmFixPrompt,
  buildLlmGenPrompt,
  retryNote,
  type PromptResource,
} from "../prompts/llm-gen.ts";
import {
  isWithin,
  loadConventions,
  resolveResources,
  type ConventionSection,
  type ResolvedResource,
} from "./resources.ts";
import { printUnifiedDiff, prompt } from "../cli/draft.ts";
import { substituteRunCommandFiles } from "./run-command-runner.ts";
import { amendForTrace, captureStepEvidence } from "./playwright/trace-capture.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import { ARTIFACTS_DIR_ENV, substituteArtifactsDir } from "./run-artifacts.ts";
import { buildProseEnvScrubMap, findLoadedValueLiterals, scrubEnvValues } from "../runtime/env-scrub.ts";
import type { GenerateContext, GenerateResult, StepEvidenceSupport } from "./types.ts";
import type { GuidanceKind } from "../prompts/prompt-names.ts";
import * as log from "../cli/logger.ts";

/**
 * Shared LLM generation engine for runCommand-verified targets (playwright /
 * runn). One pass through the engine is:
 *
 *   resolve resources + conventions → assemble the prompt (spec, optional
 *   mechanical draft, hub prompt bundle, reuse-first contract) → invoke
 *   Claude read-only (Read/Grep/Glob — no Bash, no browser) → parse the JSON
 *   output contract → validate output paths → write files → optionally verify
 *   via the target's `runCommand`, feeding failures back to Claude in a
 *   bounded fix loop.
 *
 * Targets whose first pass is deterministic (playwright without resources)
 * enter at `finalizePreparedFiles`, sharing the write/verify half.
 */

/** Read-only exploration: generation must never mutate the repo via tools. */
export const LLM_GEN_ALLOWED_TOOLS = ["Read", "Grep", "Glob"];

/** Test seam: the engine invokes Claude through this signature. */
export type InvokeFn = typeof invokeClaudeStreaming;

/**
 * A target's reading of the files one attempt produced: whether their
 * assertions decide what the case claims, and whether the code follows the
 * rule documents the project wrote.
 *
 * Supplied by the target rather than built here. What counts as an assertion
 * is the generated language's business — a target whose runbooks are YAML has
 * none in the shape a reader of test code looks for, and would otherwise be
 * told that every step of every case decides nothing. A target that offers no
 * reading is simply not read.
 *
 * The guides arrive from the engine, already loaded for the generation
 * prompt: the code was written with them in hand, and reading it against a
 * second, separately loaded copy would let the two disagree.
 *
 * `askModel` is false where nothing in this generation could act on a model's
 * judgement, or where the reviewer has already failed once. Whatever the
 * reading can decide on its own still runs; what costs a model call does not.
 */
export type Reading = (
  files: readonly LlmGeneratedFile[],
  guides: readonly ConventionSection[],
  askModel: boolean,
) => Promise<SpecCoverageReview>;

const LlmFileSchema = z.object({
  path: z.string().min(1),
  contents: z.string(),
  // `kind` is advisory metadata: only "support" changes behavior (support
  // files are excluded from the runCommand {files} list). Models sometimes
  // label the test with a free-form word ("runbook", "spec", ...); failing a
  // multi-minute generation over that label is not worth it, so anything
  // other than "support" is coerced to "test" by `parseLlmGenOutput` and
  // surfaced as a warning instead.
  kind: z.string().default("test"),
});

export interface LlmGeneratedFile {
  path: string;
  contents: string;
  kind: "test" | "support";
}

// `files` may be empty only on fix passes ("no file change needed" — e.g. an
// environment-caused failure); initial generation enforces non-emptiness via
// `validateOutput` so the two cases get distinct, actionable error messages.
const LlmOutputSchema = z.object({
  files: z.array(LlmFileSchema),
  summary: z.string().default(""),
});

export interface LlmGenOutput {
  files: LlmGeneratedFile[];
  summary: string;
  /** One entry per file whose non-enum `kind` label was coerced to "test". */
  kindWarnings: string[];
}

/**
 * Parse the engine's JSON output contract from a raw Claude reply. Tolerates
 * a fenced code block (same normalization as `codegen/cleanup.ts`) and
 * leading/trailing prose around the JSON object; throws a message suitable
 * for the retry prompt on anything else.
 */
export function parseLlmGenOutput(raw: string): LlmGenOutput {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\n?([\s\S]*?)\n?```$/, "$1")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("reply contains no JSON object");
    try {
      parsed = JSON.parse(stripped.slice(start, end + 1));
    } catch (e) {
      throw new Error(`reply is not valid JSON: ${(e as Error).message}`);
    }
  }
  const res = LlmOutputSchema.safeParse(parsed);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(
      `reply JSON does not match {files:[{path,contents,kind}],summary}: ${issues.join("; ")}`,
    );
  }
  const kindWarnings: string[] = [];
  const files: LlmGeneratedFile[] = res.data.files.map((f) => {
    if (f.kind === "test" || f.kind === "support") return { ...f, kind: f.kind };
    kindWarnings.push(`file "${f.path}": unknown kind "${f.kind}" coerced to "test"`);
    return { ...f, kind: "test" as const };
  });
  return { files, summary: res.data.summary, kindWarnings };
}

export interface OutputPathPolicy {
  cwd: string;
  /** The one path the test file may take (project-root-relative). */
  testPath: string;
  /** Absolute path-resource roots that may receive support files. */
  writeRootsAbs: string[];
}

/**
 * Validate one output path against the write policy: project-root-relative, no
 * traversal, never under node_modules, and — for the test itself — exactly the
 * configured `testPath`, so a rewrite pass cannot decide where a spec's test
 * lives. Returns an error message, or null when valid.
 */
export function validateOutputPath(
  policy: OutputPathPolicy,
  path: string,
  kind: "test" | "support",
): string | null {
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
    return `absolute output path is not allowed: ${path}`;
  }
  const segments = normalize(path).split(/[\\/]+/);
  if (segments.includes("..")) return `output path traversal is not allowed: ${path}`;
  if (segments.includes("node_modules")) {
    return `writing under node_modules is not allowed: ${path}`;
  }
  // Defense in depth on top of the runCommand shell-quoting: these paths are
  // LLM output and end up in `shell: true` command lines and report links.
  // eslint-disable-next-line no-control-regex
  if (/[;&|`$<>()'"\\\x00-\x1f]/.test(path)) {
    return `output path contains shell-unsafe characters: ${path}`;
  }
  const abs = resolve(policy.cwd, path);
  if (kind === "test") {
    return abs === resolve(policy.cwd, policy.testPath)
      ? null
      : `the test file must be written to ${policy.testPath} (configured as this target's testPath), not ${path}`;
  }
  // Support files land beside the test or under a configured write root. The
  // test's own directory is included so a project that configures none can
  // still receive the page object a rewrite pass had to create.
  const roots = [dirname(resolve(policy.cwd, policy.testPath)), ...policy.writeRootsAbs];
  if (!roots.some((root) => isWithin(root, abs))) {
    const allowed = roots.map((r) => relative(policy.cwd, r) || ".").join(", ");
    return `support file escapes the allowed roots (${allowed}): ${path}`;
  }
  return null;
}

/**
 * The variables ccqa loaded whose values appear verbatim in `contents`, or an
 * empty list. Values reach a generated file through the model, not through the
 * emitter: a rewrite pass is shown the project's own conventions and page
 * objects, and it writes what it read — in the observed case a sign-in comment
 * naming the account the recording used.
 *
 * Rewriting the value into a `${VAR}` is the wrong repair. Code is not a
 * recording: a credential a model chose to write into a comment or a fixture
 * is not a reference the test needs, so the answer is to reject the file and
 * ask again, not to launder it.
 */
export function leakedVariables(contents: string): string[] {
  return findLoadedValueLiterals([contents]);
}

/** The rejection a leak becomes, naming the variable and never the value. */
export function leakMessage(path: string, names: string[]): string {
  return (
    `${path} contains the value of ${names.join(", ")} — a credential this project keeps in a ` +
    `variable. Never write a resolved value into generated code, in a comment or anywhere else; ` +
    `read it from the environment, or leave it out.`
  );
}

/** Written-files state: cwd-relative path → what's on disk. */
type FileState = Map<
  string,
  {
    abs: string;
    kind: "test" | "support";
    contents: string;
  }
>;

async function writeGeneratedFiles(
  cwd: string,
  files: LlmGeneratedFile[],
  state: FileState,
): Promise<void> {
  for (const file of files) {
    // The last gate before a secret reaches the consumer's repository. Every
    // path that produces files ends here, which is why the check is here as
    // well as in the retryable one above.
    const leaked = leakedVariables(file.contents);
    if (leaked.length > 0) throw new Error(leakMessage(file.path, leaked));
    const abs = resolve(cwd, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.contents, "utf8");
    state.set(relative(cwd, abs), { abs, kind: file.kind, contents: file.contents });
    log.meta("saved", abs);
  }
}

// --- runCommand execution ---

// `{files}` substitution (shell-quoted) lives with the run-side consumer;
// re-exported here for existing importers.
export { substituteRunCommandFiles };

/**
 * Run the verification command through the platform shell (runCommand is a
 * user-authored shell string — `pnpm exec playwright test {files}` — so PATH
 * lookup and quoting must behave like their terminal). Output is teed live
 * and captured for the fix prompt.
 */
async function runShellCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      output += text;
      log.emitRaw(text);
    };
    child.stdout!.on("data", capture);
    child.stderr!.on("data", capture);
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise({ exitCode: code ?? 0, output }));
  });
}

const OUTPUT_TAIL_CHARS = 6_000;

function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= OUTPUT_TAIL_CHARS ? trimmed : trimmed.slice(-OUTPUT_TAIL_CHARS);
}

// --- engine entry points ---

export interface LlmEngineRequest {
  ctx: GenerateContext;
  /** Target id — also the hub guidance kind (`<target>.user` / `<target>.agent`). */
  target: GuidanceKind;
  /**
   * The spec's steps, already expanded by the caller. Passed in rather than
   * expanded here so the target that emits a step decides which kinds it
   * accepts — a claim reaching a target that emits no judge call would
   * otherwise reach the prompt as prose and be answered with nothing.
   */
  steps: ExpandedStep[];
  /** Target-specific instruction block (what to generate, in which format). */
  taskInstructions: string;
  /** Mechanical draft treated as recorded ground truth (playwright). */
  draft?: { path: string; contents: string };
  /** Extra "don't drop this from the draft" rule the target owns (see LlmGenPromptInput.draftInvariant). */
  draftInvariant?: string;
  /** Per-file validation before writing (e.g. YAML parse for runn); returns an error message to reject. */
  validateFile?: (file: LlmGeneratedFile) => string | null;
  /**
   * The target's `stepEvidence`, resolved against the project's config: a
   * verification run that passes leaves the case's screenshots behind. Absent
   * means the target captures none.
   */
  stepEvidence?: StepEvidenceSupport;
  /** Test seam — defaults to `invokeClaudeStreaming`. */
  invoke?: InvokeFn;
  /** How this target reads back what it wrote (see `Reading`). Absent: not read. */
  reading?: Reading;
}

/**
 * Where new support files may be created.
 *
 * A project that lists `writeRoots` has said which directories generated code
 * may appear in, and `resources` then means only "code you may read and
 * import" — the shared assets a generation must not rewrite. Without
 * `writeRoots`, path resources stay writable, which is what the built-in
 * targets have always done.
 */
function configuredWriteRoots(ctx: GenerateContext, resources: ResolvedResource[]): string[] {
  if (ctx.targetConfig.writeRoots.length > 0) {
    return ctx.targetConfig.writeRoots.map((root) => resolve(ctx.cwd, root));
  }
  return resources.filter((r) => r.writable).map((r) => r.rootAbs);
}

/** Full LLM generation: prompt assembly → invoke → write → verify loop. */
export async function generateWithLlmEngine(req: LlmEngineRequest): Promise<GenerateResult> {
  const { ctx } = req;
  const resources = await resolveResources(ctx.cwd, ctx.resources);
  const conventions = await loadConventions(ctx.cwd, {
    guides: ctx.conventions.guides,
    examples: ctx.conventions.examples,
  });
  const warnings = [...conventions.warnings];
  for (const w of conventions.warnings) log.warn(w);
  log.meta("resources", resources.length);
  log.meta("conventions", conventions.sections.length);

  const bundle = await loadPromptBundle(ctx.hub, req.target, ctx.cwd);
  if (bundle) log.meta("prompt-bundle", bundle.loaded.join(", "));

  const writeRootsAbs = configuredWriteRoots(ctx, resources);
  const policy: OutputPathPolicy = { cwd: ctx.cwd, testPath: ctx.testPath, writeRootsAbs };
  const writeRoots = writeRootsAbs.map((root) => relative(ctx.cwd, root) || ".");

  const prompt = buildLlmGenPrompt({
    taskInstructions: req.taskInstructions,
    specTitle: ctx.spec.title,
    steps: req.steps,
    draft: req.draft,
    ...(req.draftInvariant ? { draftInvariant: req.draftInvariant } : {}),
    resources: resources.map(toPromptResource),
    conventionSections: conventions.sections,
    promptBundle: bundle?.text,
    testPath: ctx.testPath,
    writeRoots,
    language: ctx.language,
  });

  const invoke = req.invoke ?? invokeClaudeStreaming;
  const output = await log.timedPhase(
    `${req.target} generation`,
    () =>
      invokeForFiles({
        prompt,
        invoke,
        ctx,
        policy,
        validateFile: req.validateFile,
        requireTestFile: true,
        allowEmpty: false,
      }),
    "run",
  );

  warnings.push(...output.kindWarnings);

  return finalizeAndVerify({
    ctx,
    target: req.target,
    policy,
    writeRoots,
    initialFiles: output.files,
    summary: output.summary,
    warnings,
    guides: conventions.sections.filter((s) => s.kind === "guide"),
    ...(req.stepEvidence ? { stepEvidence: req.stepEvidence } : {}),
    validateFile: req.validateFile,
    invoke,
    reading: req.reading,
  });
}

export interface PreparedFilesRequest {
  ctx: GenerateContext;
  target: GuidanceKind;
  /** Deterministically produced files (e.g. the playwright mechanical emit). */
  files: LlmGeneratedFile[];
  summary: string;
  warnings: string[];
  validateFile?: (file: LlmGeneratedFile) => string | null;
  /** See {@link LlmEngineRequest.stepEvidence}. */
  stepEvidence?: StepEvidenceSupport;
  invoke?: InvokeFn;
  reading?: Reading;
}

/**
 * Entry point for targets whose files are already prepared: shares the
 * engine's write + runCommand verification half (the fix loop still consults
 * Claude on failures).
 */
export async function finalizePreparedFiles(req: PreparedFilesRequest): Promise<GenerateResult> {
  const { ctx } = req;
  const resources = await resolveResources(ctx.cwd, ctx.resources);
  const writeRootsAbs = configuredWriteRoots(ctx, resources);
  const policy: OutputPathPolicy = { cwd: ctx.cwd, testPath: ctx.testPath, writeRootsAbs };
  return finalizeAndVerify({
    ctx,
    target: req.target,
    policy,
    writeRoots: writeRootsAbs.map((root) => relative(ctx.cwd, root) || "."),
    initialFiles: req.files,
    summary: req.summary,
    warnings: req.warnings,
    // A deterministic compile of a recording, written against no guide: this
    // path runs when a project declared no resources, so nothing here was
    // asked to follow a rule and reporting one broken would ask for the
    // rewrite this path exists to skip.
    guides: [],
    ...(req.stepEvidence ? { stepEvidence: req.stepEvidence } : {}),
    validateFile: req.validateFile,
    invoke: req.invoke ?? invokeClaudeStreaming,
    reading: req.reading,
  });
}

interface FinalizeParams {
  ctx: GenerateContext;
  target: GuidanceKind;
  policy: OutputPathPolicy;
  writeRoots: string[];
  /** The project's rule documents, as the generation prompt carried them. */
  guides: ConventionSection[];
  /** See {@link LlmEngineRequest.stepEvidence}. */
  stepEvidence?: StepEvidenceSupport;
  initialFiles: LlmGeneratedFile[];
  summary: string;
  warnings: string[];
  validateFile?: (file: LlmGeneratedFile) => string | null;
  invoke: InvokeFn;
  reading?: Reading;
}

/** Write the files, then run the bounded runCommand verify/fix loop. */
async function finalizeAndVerify(p: FinalizeParams): Promise<GenerateResult> {
  const { ctx } = p;
  const state: FileState = new Map();
  await writeGeneratedFiles(ctx.cwd, p.initialFiles, state);

  const { passed, review } = await runVerificationLoop(p, state);
  return {
    files: [...state.values()].map((f) => ({ path: f.abs, kind: f.kind })),
    summary: p.summary || `${state.size} file(s) generated for the ${p.target} target`,
    warnings: p.warnings,
    passed,
    review,
  };
}

/**
 * The runCommand verification loop. One round asks the project's own commands,
 * then the review, then the run — and a round is over when all three are
 * clean. On anything else the output goes to Claude for a corrected set and
 * the next round asks all three again: a fix written for a failing run can
 * break a rule the round before it cleared.
 *
 * `fix.mode` mirrors the agent-browser target's fix UX (which only ever
 * prompts inside its own fix loop, never for the first write):
 *
 *   - `auto` — apply every fix rewrite automatically, up to `fix.maxRetries`.
 *   - `interactive` (default) — show each fix pass's per-file diff and ask
 *     y/N before writing it; declining stops the loop with the current files.
 *   - `non-interactive` (`--auto-fix skip`) — never attempt a fix; the first
 *     verify decides pass/fail.
 *
 * Exhaustion (or a declined / skipped fix) keeps the files on disk and reports
 * `passed: false`. Targets without a runCommand are generate-only here and
 * pass trivially.
 */
async function runVerificationLoop(
  p: FinalizeParams,
  state: FileState,
): Promise<{ passed: boolean; review?: SpecCoverageReview }> {
  const runCommand = p.ctx.targetConfig.runCommand;
  let review: SpecCoverageReview | undefined;
  // Said once at each way out, not where the review is obtained: a round that
  // acts on a finding reads the files again next round, and the same lines
  // twice read as two findings.
  const finish = (passed: boolean): { passed: boolean; review?: SpecCoverageReview } => {
    for (const w of review?.warnings ?? []) log.warn(w);
    return { passed, review };
  };
  // A target with no test command of its own can still have project-wide
  // checks, and generated code that fails them is not done.
  if (!runCommand) {
    const checks = await runCheckCommands(p.ctx);
    if (checks !== null) {
      log.warn(`${checks.command} failed (exit ${checks.exitCode}) — generated files kept`);
      return { passed: false };
    }
    await refreshFromDisk(state);
    review = await readingOfEmitted(p, state, true);
    return finish(true);
  }
  // `--auto-fix skip` disables the fix pass entirely: run verification once and
  // report the result, never rewriting the generated files.
  const maxRetries = p.ctx.fix.mode === "non-interactive" ? 0 : p.ctx.fix.maxRetries;
  const captures = p.stepEvidence?.supported === true;
  // Loop-invariant: it reads the process env, which no attempt changes.
  const outputScrub = buildProseEnvScrubMap([], []);

  // `useSnapshot` pins an agent-browser session so that target can re-attach
  // for a post-failure page snapshot; a runCommand target has no such session
  // (its fix prompt is fed the command's output tail), so `--no-session-pin` is
  // inapplicable here. Say so once rather than ignoring it silently.
  if (!p.ctx.fix.useSnapshot) {
    log.warn(
      `--no-session-pin has no effect on the ${p.target} target — it captures no browser snapshot; ` +
        `the fix loop uses the command's output instead`,
    );
  }

  // What a fix prompt has already carried. A line the model was shown and did
  // not fix it reports again, and spending the next round on it buys nothing —
  // the prompt already lets it decline what it may not write.
  const spent = new Set<string>();
  // Asked only where a round could act on what it says: the reading's model
  // half is a call of its own, minutes long, and its findings with no budget
  // left to answer them are a bill. A reviewer that failed once is not asked
  // again either — the round it answers nothing for is the round a finding it
  // did answer would have bought.
  const askReviewer = maxRetries > 0;
  let reviewerGone = false;
  if (!askReviewer && p.reading) {
    log.info("no fix round could act on a review — the reviewer is not asked; the mechanical read still runs");
  }
  for (let attempt = 0; ; attempt++) {
    // Cheapest question first, most expensive last. The project's own commands
    // decide for themselves and cost nothing; the review is one model call;
    // the run is a browser against a live product. Code a reviewer would send
    // back is not worth running, and code that does not compile is not worth
    // reviewing.
    let failing = await runCheckCommands(p.ctx);
    // What this round's fix prompt asks for, registered only once the model
    // has answered it: a round that never reached one asked for nothing.
    let asked: readonly string[] = [];
    if (failing === null) {
      // The checks may have rewritten what they checked. From here the files
      // are read three ways, and they must all read the same file.
      await refreshFromDisk(state);
      // How the code reads, asked three ways — mechanically, against the case,
      // and against the project's own rules. All at once: they are the same
      // kind of question, and answering them in turn spends a whole round on
      // the cheaper one while the others wait for a budget that may be gone.
      // (Observed: three rounds went to two failures and one mechanical
      // finding, and the reading first spoke with nothing left to act on.)
      // Issued together as well: one is a model call and the other walks the
      // project's test roots, and neither reads what the other writes.
      const [reading, mechanical] = await Promise.all([
        readingOfEmitted(p, state, askReviewer && !reviewerGone),
        reviewOfEmitted(p.ctx, state, p.writeRoots),
      ]);
      review = reading;
      if (review?.reviewerFailed) reviewerGone = true;
      const unchecked = uncheckedSteps(review, spent);
      const violations = guideViolations(review, spent);
      const reads = allReadings(mechanical, unchecked, violations);
      if (reads !== null && attempt < maxRetries) {
        asked = [...(unchecked?.asked ?? []), ...(violations?.asked ?? [])];
        failing = reads;
      } else {
        if (reads !== null) {
          // Run all the same: the review is a judgement, and a generate that
          // reported failed without ever running the test would let one
          // decide the verdict.
          log.warn(
            "generated with review findings still open — the files are kept and the findings " +
              "are recorded against the case, but nothing acted on them",
          );
        }
        const run = await verifyRun(p, state, runCommand, attempt, captures);
        if (run.exitCode === 0) return finish(true);
        failing = run;
      }
    }
    if (attempt >= maxRetries) {
      log.warn(
        `verification still failing after ${maxRetries} fix attempt(s) — generated files kept`,
      );
      await clearCaseRun(p.ctx.ref);
      return finish(false);
    }

    log.fix(`verification failed (exit ${failing.exitCode}) — requesting a fix (${attempt + 1}/${maxRetries})`);
    const fixPrompt = buildLlmFixPrompt({
      targetId: p.target,
      command: failing.command,
      // The command's own output can echo a value the test resolved (a URL,
      // an account). It reaches the model as prose, which is how the leak
      // above happened, so it is symbolised before it goes.
      outputTail: scrubEnvValues(tail(failing.output), outputScrub),
      files: [...state.entries()].map(([path, f]) => ({
        path,
        contents: f.contents,
        kind: f.kind,
      })),
      testPath: p.ctx.testPath,
      writeRoots: p.writeRoots,
      language: p.ctx.language,
    });
    let output: LlmGenOutput;
    try {
      output = await log.timedPhase(
        `${p.target} fix generation`,
        () =>
          invokeForFiles({
            prompt: fixPrompt,
            invoke: p.invoke,
            ctx: p.ctx,
            policy: p.policy,
            validateFile: p.validateFile,
            // A fix pass may touch support files only, or report "no change
            // needed" (environment-caused failure / files already correct)
            // with an empty files array — verification then just re-runs.
            requireTestFile: false,
            allowEmpty: true,
          }),
        "fix",
      );
    } catch (err) {
      // A fix pass that exhausts its contract retries is a failed *attempt*,
      // not a failed generate: keep the current files and let the loop spend
      // its remaining fix retries instead of throwing the whole generation
      // (and the files already on disk) away.
      log.warn(
        `fix attempt ${attempt + 1} produced no usable output ` +
          `(${err instanceof Error ? err.message : String(err)}) — keeping current files`,
      );
      continue;
    }
    // Only now, and only what the prompt above actually carried: a line the
    // model never saw must not buy the silence of a round that never asked it,
    // and one it saw and declined is not worth asking twice. A reply of "no
    // change needed" below is an answer — the model read the line and left it.
    for (const key of asked) spent.add(key);
    if (output.files.length === 0) {
      log.info(`fix pass reported no file changes — re-running verification (${output.summary || "no reason given"})`);
      continue;
    }
    // Interactive mode: the fix pass rewrites files in the consumer's tree
    // (wherever `testPath` puts them), so show what changes and ask before
    // writing. Declining keeps the current files and ends the loop.
    if (p.ctx.fix.mode === "interactive" && !(await confirmFixWrite(output.files, p.ctx.cwd))) {
      log.info("fix not applied (declined) — keeping current files");
      await clearCaseRun(p.ctx.ref);
      return finish(false);
    }
    await writeGeneratedFiles(p.ctx.cwd, output.files, state);
    // The reading described the files as they were before this write. It is
    // saved against the case and read back by `ccqa evidence`, so carrying it
    // past the rewrite would pair findings with a file that no longer has
    // them — or, worse, say "checked" of one nobody read.
    review = undefined;
  }
}

/**
 * One verification run of the files as they are now, in the shape the fix loop
 * consumes. The round's last question and its most expensive: it is asked only
 * of files the project's own commands and the review have already cleared.
 */
async function verifyRun(
  p: FinalizeParams,
  state: FileState,
  runCommand: string,
  attempt: number,
  captures: boolean,
): Promise<{ exitCode: number; output: string; command: string }> {
  const testFiles = [...state.entries()]
    .filter(([, f]) => f.kind === "test")
    .map(([rel]) => rel);
  // `{artifactsDir}` targets `ccqa run`'s per-spec artifacts collection; a
  // verification run has no report dir, so it (and CCQA_ARTIFACTS_DIR)
  // points at a throwaway temp dir instead, discarded after the attempt.
  const artifactsDir = await mkdtemp(join(tmpdir(), "ccqa-verify-artifacts-"));
  // The step screenshots this run takes, kept when it passes. A project whose
  // tests belong to its own runner never calls `ccqa run`, so this is the only
  // time ccqa sees the case executed — and `ccqa evidence` has no pictures at
  // all without it. Cleared first: what is here is one run's.
  const evidenceDir = captures ? caseRunDir(p.ctx.ref) : null;
  if (evidenceDir) {
    await clearCaseRun(p.ctx.ref);
    await mkdir(evidenceDir, { recursive: true });
  }
  let command = substituteArtifactsDir(
    substituteRunCommandFiles(runCommand, testFiles),
    artifactsDir,
  );
  // The generated test carries no capture calls, so the evidence this run
  // leaves behind is whatever the trace holds. A command ccqa cannot amend
  // leaves none, and generation does not hang on that — it says so once the
  // run is otherwise done rather than failing here.
  let traceUnavailable: string | undefined;
  if (evidenceDir) {
    const amended = amendForTrace(command, artifactsDir);
    command = amended.command;
    traceUnavailable = amended.skip;
  }
  log.run(command);
  try {
    const result = await log.timedPhase(
      `verification run #${attempt + 1}`,
      () =>
        // Fresh CCQA_RUN_ID per verification run, mirroring the vitest runner:
        // specs that embed `${CCQA_RUN_ID}` in created-content names must not
        // collide with leftovers from earlier runs.
        runShellCommand(command, p.ctx.cwd, {
          ...process.env,
          [ARTIFACTS_DIR_ENV]: artifactsDir,
          CCQA_RUN_ID: buildRunId(),
          ...(evidenceDir ? { [EVIDENCE_DIR_ENV]: evidenceDir } : {}),
        }),
      "run",
    );
    // Read before the artifacts dir goes: the trace lives in it, and the
    // `finally` below removes it. Only a green run's is read — every other
    // outcome ends in a fix round or a give-up, both of which clear the case's
    // evidence again, so reading it would be work nobody keeps.
    if (evidenceDir && result.exitCode === 0) {
      const unavailable =
        traceUnavailable ?? (await captureStepEvidence({ artifactsDir, evidenceDir }));
      if (unavailable) log.warn(unavailable);
    }
    return { ...result, command };
  } finally {
    await rm(artifactsDir, { recursive: true, force: true });
  }
}

/**
 * The project's own checks over the whole repository (type check, lint), asked
 * first in a round: they cost nothing and code that does not compile has a
 * more urgent problem than how it reads. Answers null when they all pass — or
 * when the project configured none — and the failing one's output otherwise,
 * in the shape the fix loop already consumes.
 */
async function runCheckCommands(
  ctx: GenerateContext,
): Promise<{ exitCode: number; output: string; command: string } | null> {
  for (const command of ctx.targetConfig.checkCommands) {
    log.run(command);
    const result = await log.timedPhase(`check: ${command}`, () => runShellCommand(command, ctx.cwd), "run");
    if (result.exitCode !== 0) return { ...result, command };
  }
  return null;
}

/**
 * The mechanical read of what this attempt wrote, shaped like a failed check
 * so the fix loop carries it the same way.
 *
 * After the project's own commands, not instead of them: code that does not
 * compile has a more urgent problem than how it reads, and a fix pass given
 * both at once tends to answer the smaller one.
 */
async function reviewOfEmitted(
  ctx: GenerateContext,
  state: FileState,
  writeRoots: readonly string[],
): Promise<{ exitCode: number; output: string; command: string } | null> {
  const findings = reviewEmittedFiles({
    usedInProject: await identifiersInProject(
      ctx,
      writeRoots,
      new Map([...state].map(([rel, f]) => [rel, f.contents])),
    ),
    files: new Map([...state].map(([rel, f]) => [rel, f.contents])),
    caseText: [
      ...[...ctx.steps, ...ctx.cleanup].flatMap((s) =>
        isExpandedActionStep(s) ? [s.instruction, s.expected] : [s.judgeByLlm],
      ),
      ...ctx.expectations,
      ...ctx.cleanupExpectations,
    ],
    testPath: ctx.testPath,
  });
  if (findings.length === 0) return null;
  // Said here as well as handed to the fix pass: a run whose generation kept
  // failing should show what it was failing on, not only that it did.
  for (const f of findings) log.warn(`${f.file}:${f.line} [${f.rule}] ${f.message}`);
  return {
    exitCode: 1,
    command: "ccqa: review of the generated code",
    output: formatEmittedReview(findings),
  };
}

/**
 * What this attempt wrote, as the target's reading opens it.
 *
 * Timed like the loop's other phases: the reading opens the repository and
 * reads it, which is minutes, and a wedged one waits out its whole timeout
 * with nothing on the terminal to say what is happening.
 */
async function readingOfEmitted(
  p: FinalizeParams,
  state: FileState,
  askModel: boolean,
): Promise<SpecCoverageReview | undefined> {
  const { reading } = p;
  if (!reading) return undefined;
  const files = [...state.entries()].map(([path, f]) => ({ path, contents: f.contents, kind: f.kind }));
  return log.timedPhase("review of the generated files", () => reading(files, p.guides, askModel), "fix");
}

/**
 * Re-read what is on disk into the engine's copy of it.
 *
 * A check command may rewrite what it checks — a formatter is the ordinary
 * case — and from here the files are read three ways: the review opens the
 * disk, while the fix prompt and the mechanical read are given what the engine
 * holds. They must not be told different things about one file.
 */
async function refreshFromDisk(state: FileState): Promise<void> {
  for (const [rel, f] of state) {
    const contents = await readFile(f.abs, "utf8").catch(() => null);
    if (contents !== null) state.set(rel, { ...f, contents });
  }
}

/**
 * The reading's findings, shaped like a failed check so the fix loop carries
 * them the same way — or null when there is nothing to act on.
 *
 * It spends a fix round; it never decides the verdict. A green test says the
 * code runs and the project's checks say it may be merged, and neither of
 * those is a judgement — this is, and a judgement that could fail a generate
 * would make generation only as repeatable as the model behind it. A run that
 * exhausts its rounds still passes, with the findings reported, as it did when
 * nothing acted on them at all.
 *
 * What the round asks for is verified like any other rewrite, and that can
 * end red: an assertion strengthened to check what the case claims may simply
 * not hold. The generate then reports failed — on the test run, not on this —
 * and the files are kept. That is the honest outcome, and the alternative
 * (restoring what passed weakly) would hide a case the product does not meet.
 *
 * A review that could not be obtained is not acted on either: spending a round
 * answering a question nobody asked is worse than leaving it unanswered. Nor
 * is a finding a round has already asked for and got back unchanged: a step
 * the fix pass could not strengthen reports the same line every round, and
 * left alone it takes the whole budget and the run happens with none of it.
 */
export function uncheckedSteps(
  review: SpecCoverageReview | undefined,
  alreadyAsked: ReadonlySet<string> = new Set(),
): { exitCode: number; output: string; command: string; asked: string[] } | null {
  if (!review?.complete || review.findings === null) return null;
  const findings = review.findings.filter((f) => !alreadyAsked.has(findingKey(f)));
  if (findings.length === 0) return null;
  return {
    exitCode: 1,
    command: "ccqa: reading of the generated test",
    asked: findings.map(findingKey),
    output: [
      "These steps pass without deciding what the case says they must:",
      "",
      ...findings.map((f) => `- ${formatFinding(f)}`),
      "",
      "Strengthen the assertions (and the locators they resolve through) so each",
      "step fails when its expectation stops holding. Do not weaken or delete a",
      "step to silence this.",
    ].join("\n"),
  };
}

/**
 * The rule violations the reading found, shaped like a failed check so the fix
 * loop carries them the same way — or null when there is nothing to act on.
 *
 * Every rule the loop could already decide is followed by the code it
 * produces: a type error fails the check command, a lint rule fails the lint,
 * a convention ccqa itself knows fails the review above. A rule that lives
 * only in the project's prose is followed by nothing, because until here
 * nothing in the loop had read it. Reused code is the older half of the same
 * gap — a helper this generation imported rather than wrote was written under
 * whatever rules existed then, and no rule added since has been applied to it.
 *
 * Like the reading it rides with, it spends a fix round and never decides the
 * verdict: it is a model's judgement, and a judgement that could fail a
 * generate would make generation only as repeatable as the model behind it.
 * And like the reading, a violation a round has already asked for and got back
 * unchanged is not asked again — the model may decline a file it is not
 * allowed to write, and asking again spends a round that can only be declined
 * again.
 *
 * Read apart from the step findings, as it comes back: one answer carries two
 * reviews, and a half that arrived unreadable must not discard the half that
 * arrived. Absent violations are absent either way — there is nothing here to
 * act on when that half never came.
 *
 * Only what the reviewer would hold the change for. It is asked to sort its
 * own violations, because the alternative is a round spent on a line it would
 * have approved anyway. Every violation is still reported: `warnings` carries
 * the advisory ones too, marked as such.
 */
export function guideViolations(
  review: SpecCoverageReview | undefined,
  alreadyAsked: ReadonlySet<string> = new Set(),
): { exitCode: number; output: string; command: string; asked: string[] } | null {
  const violations = (review?.ruleViolations ?? []).filter(
    (v) => v.severity === "blocking" && !alreadyAsked.has(violationKey(v)),
  );
  if (violations.length === 0) return null;
  return {
    exitCode: 1,
    command: "ccqa: the project's own conventions",
    asked: violations.map(violationKey),
    output: [
      "These files break a rule this project's conventions state:",
      "",
      // The same line the log and the report show — a reader must not meet two
      // wordings for one finding — with the code it is about under it.
      ...violations.flatMap((v) => [
        `- ${formatViolation(v)}`,
        ...v.code.trim().split("\n").map((line) => `      ${line}`),
        "",
      ]),
      "Rewrite each file so it follows the rule it breaks. A support file this",
      "generation did not write is still yours to correct while it is under a",
      "root you may write to; one outside them is not — say so in `summary`",
      "rather than rewriting it. Never weaken what the test checks to make a",
      "rule fit.",
    ].join("\n"),
  };
}

/** One finding, as the loop recognises the same one coming back. */
function findingKey(finding: SpecCoverageFinding): string {
  return [finding.stepId, finding.problem].join("\u0000");
}

/** One violation, as the loop recognises the same one coming back. */
function violationKey(violation: GuideViolation): string {
  return [violation.file, violation.guide, violation.rule, violation.code.trim()].join("\u0000");
}

/**
 * Every identifier the project's own test assets mention, outside the files
 * this generation just wrote.
 *
 * Only where the project said its test code lives — the roots it declared as
 * resources or as writable. ccqa does not go looking through a repository it
 * was not pointed at, and a definition nobody in those roots reaches is one
 * nobody reaches.
 */
async function identifiersInProject(
  ctx: GenerateContext,
  writeRoots: readonly string[],
  emitted: ReadonlyMap<string, string>,
): Promise<Map<string, Set<string>>> {
  // What each emitted file calls itself. A property of a class is only
  // reachable from code that names the class, so a file that never mentions it
  // cannot be the one using the property — however common the property's name.
  const owners = new Map<string, string[]>();
  for (const [rel, source] of emitted) {
    const names = [...source.matchAll(/\bexport\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/g)]
      .map((m) => m[1]!);
    owners.set(rel, names);
  }
  const roots = new Set(
    [...writeRoots, ...ctx.resources.map((r) => ("path" in r ? r.path : "")), dirname(ctx.testPath)]
      .filter((r) => r.length > 0)
      .map((r) => resolve(ctx.cwd, r)),
  );
  const found = new Map<string, Set<string>>([...emitted.keys()].map((rel) => [rel, new Set<string>()]));
  const seen = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) await walk(abs);
        continue;
      }
      if (!/\.[cm]?tsx?$/.test(entry.name)) continue;
      if (emitted.has(relative(ctx.cwd, abs))) continue;
      const source = await readFile(abs, "utf8").catch(() => "");
      const words = new Set([...source.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]));
      for (const [rel, classNames] of owners) {
        // Nameless (no exported class) falls back to every file: there is no
        // owner to scope by, and over-counting only makes the rule quieter.
        if (classNames.length > 0 && !classNames.some((c) => words.has(c))) continue;
        const into = found.get(rel)!;
        for (const w of words) into.add(w);
      }
    }
  };
  await Promise.all([...roots].map(walk));
  return found;
}

/**
 * The readings of the finished files as one report, since one fix pass
 * answers all of them. Any may be absent; all absent is nothing to act on.
 */
function allReadings(
  ...reports: ({ exitCode: number; output: string; command: string } | null)[]
): { exitCode: number; output: string; command: string } | null {
  const found = reports.filter((r) => r !== null);
  if (found.length === 0) return null;
  return {
    exitCode: 1,
    command: found.map((r) => r.command).join(" + "),
    output: found.map((r) => `${r.command}\n\n${r.output}`).join("\n\n"),
  };
}

/**
 * Show the per-file diff a fix pass would apply (current on-disk content vs the
 * proposed content; a not-yet-existing file shows as all-added) and ask y/N.
 * The confirmation covers the whole set — one prompt, not one per file.
 */
async function confirmFixWrite(files: LlmGeneratedFile[], cwd: string): Promise<boolean> {
  // Without a TTY (CI, piped stdin) readline's question never settles, so an
  // interactive fix would hang forever. Decline instead — same stance as
  // generate.ts's confirmOverwrite. Auto-applying here would reintroduce the
  // unreviewed-write problem the interactive gate exists to prevent.
  if (!process.stdin.isTTY) {
    log.warn(
      "interactive fix requested but stdin is not a TTY; declining the fix. " +
        "Pass `--auto-fix auto` to apply fixes without prompting (CI), or `--auto-fix skip` to disable the fix pass.",
    );
    return false;
  }
  log.blank();
  log.info("--- proposed fix (files to be written) ---");
  for (const file of files) {
    const abs = resolve(cwd, file.path);
    const before = await readFile(abs, "utf8").catch(() => "");
    log.info(`• ${file.path}${before === "" ? " (new file)" : ""}`);
    printUnifiedDiff(before, file.contents);
    log.blank();
  }
  const answer = await prompt("Apply this fix? [y/N] ");
  return /^y/i.test(answer);
}

interface InvokeForFilesParams {
  prompt: string;
  invoke: InvokeFn;
  ctx: GenerateContext;
  policy: OutputPathPolicy;
  validateFile?: (file: LlmGeneratedFile) => string | null;
  requireTestFile: boolean;
  /** Fix passes may reply with no files ("no change needed"); initial generation may not. */
  allowEmpty: boolean;
}

/**
 * One Claude invocation under the output contract, with a single retry: any
 * contract violation (unparseable reply, bad path, failed per-file
 * validation) is fed back verbatim once; a second violation is an error.
 */
async function invokeForFiles(p: InvokeForFilesParams): Promise<LlmGenOutput> {
  const attempt = async (prompt: string): Promise<LlmGenOutput> => {
    const { result, isError } = await p.invoke(
      {
        prompt,
        allowedTools: LLM_GEN_ALLOWED_TOOLS,
        cwd: p.ctx.cwd,
        model: p.ctx.model,
      },
      () => {},
    );
    if (isError) throw new Error(`Claude invocation failed: ${tail(result)}`);
    const output = parseLlmGenOutput(result);
    for (const w of output.kindWarnings) log.warn(w);
    const errors = validateOutput(output, p);
    if (errors.length > 0) throw new Error(errors.join("; "));
    return output;
  };

  // Two contract retries: a rejected reply is fed back with the violation
  // note. One retry proved too brittle in practice (long generations were
  // aborted over a second malformed-JSON reply despite correct files).
  const MAX_CONTRACT_RETRIES = 2;
  let lastMessage = "";
  for (let i = 0; i <= MAX_CONTRACT_RETRIES; i++) {
    const prompt = i === 0 ? p.prompt : p.prompt + retryNote(lastMessage);
    try {
      return await attempt(prompt);
    } catch (e) {
      lastMessage = (e as Error).message;
      if (i < MAX_CONTRACT_RETRIES) {
        log.warn(`generation output rejected (${lastMessage}) — retrying (${i + 1}/${MAX_CONTRACT_RETRIES})`);
      }
    }
  }
  throw new Error(`LLM generation failed after ${MAX_CONTRACT_RETRIES} retries: ${lastMessage}`);
}

function validateOutput(output: LlmGenOutput, p: InvokeForFilesParams): string[] {
  const errors: string[] = [];
  if (!p.allowEmpty && output.files.length === 0) {
    errors.push("output contains no files");
  }
  const seen = new Set<string>();
  for (const file of output.files) {
    const key = normalize(file.path);
    if (seen.has(key)) {
      errors.push(`duplicate output path: ${file.path}`);
      continue;
    }
    seen.add(key);
    const pathError = validateOutputPath(p.policy, file.path, file.kind);
    if (pathError) {
      errors.push(pathError);
      continue;
    }
    const leaked = leakedVariables(file.contents);
    if (leaked.length > 0) {
      errors.push(leakMessage(file.path, leaked));
      continue;
    }
    const fileError = p.validateFile?.(file) ?? null;
    if (fileError) errors.push(fileError);
  }
  const tests = output.files.filter((f) => f.kind === "test");
  if (p.requireTestFile && tests.length === 0) {
    errors.push('output contains no "kind": "test" file');
  }
  // Two test files would mean one of them is not the spec's test — and the
  // path check above already fails for whichever one is not at `testPath`, so
  // this only makes the reason legible in the retry note.
  if (tests.length > 1) {
    errors.push(`output contains ${tests.length} "kind": "test" files; a spec has exactly one`);
  }
  return errors;
}

function toPromptResource(r: ResolvedResource): PromptResource {
  return {
    kind: r.kind,
    ref: r.ref,
    root: r.rootDisplay,
    description: r.description,
  };
}
