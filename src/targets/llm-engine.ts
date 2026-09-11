import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { z } from "zod";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import type { ExpandedStep } from "../spec/expand.ts";
import { caseRunDir, clearCaseRun, loadPromptBundle } from "../store/index.ts";
import { formatEmittedReview, reviewEmittedFiles } from "./emitted-review.ts";
import { isExpandedActionStep } from "../spec/expand.ts";
import { EVIDENCE_DIR_ENV } from "../runtime/evidence-constants.ts";
import {
  buildLlmFixPrompt,
  buildLlmGenPrompt,
  retryNote,
  type PromptResource,
} from "../prompts/llm-gen.ts";
import { isWithin, loadConventions, resolveResources, type ResolvedResource } from "./resources.ts";
import { printUnifiedDiff, prompt } from "../cli/draft.ts";
import { substituteRunCommandFiles } from "./run-command-runner.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import { ARTIFACTS_DIR_ENV, substituteArtifactsDir } from "./run-artifacts.ts";
import { buildProseEnvScrubMap, findLoadedValueLiterals, scrubEnvValues } from "../runtime/env-scrub.ts";
import type { GenerateContext, GenerateResult } from "./types.ts";
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
type FileState = Map<string, { abs: string; kind: "test" | "support"; contents: string }>;

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
  /** Test seam — defaults to `invokeClaudeStreaming`. */
  invoke?: InvokeFn;
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
  const conventions = await loadConventions(ctx.cwd, [...ctx.conventions.guides, ...ctx.conventions.examples]);
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
    validateFile: req.validateFile,
    invoke,
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
  invoke?: InvokeFn;
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
    validateFile: req.validateFile,
    invoke: req.invoke ?? invokeClaudeStreaming,
  });
}

interface FinalizeParams {
  ctx: GenerateContext;
  target: GuidanceKind;
  policy: OutputPathPolicy;
  writeRoots: string[];
  initialFiles: LlmGeneratedFile[];
  summary: string;
  warnings: string[];
  validateFile?: (file: LlmGeneratedFile) => string | null;
  invoke: InvokeFn;
}

/** Write the files, then run the bounded runCommand verify/fix loop. */
async function finalizeAndVerify(p: FinalizeParams): Promise<GenerateResult> {
  const { ctx } = p;
  const state: FileState = new Map();
  await writeGeneratedFiles(ctx.cwd, p.initialFiles, state);

  const passed = await runVerificationLoop(p, state);
  return {
    files: [...state.values()].map((f) => ({ path: f.abs, kind: f.kind })),
    summary: p.summary || `${state.size} file(s) generated for the ${p.target} target`,
    warnings: p.warnings,
    passed,
  };
}

/**
 * The runCommand verification loop: run, and on failure hand the output tail
 * plus the current files to Claude for a corrected set. `fix.mode` mirrors the
 * agent-browser target's fix UX (which only ever prompts inside its own fix
 * loop, never for the first write):
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
async function runVerificationLoop(p: FinalizeParams, state: FileState): Promise<boolean> {
  const runCommand = p.ctx.targetConfig.runCommand;
  // A target with no test command of its own can still have project-wide
  // checks, and generated code that fails them is not done.
  if (!runCommand) {
    const checks = await runCheckCommands(p.ctx);
    if (checks === null) return true;
    log.warn(`${checks.command} failed (exit ${checks.exitCode}) — generated files kept`);
    return false;
  }
  // `--auto-fix skip` disables the fix pass entirely: run verification once and
  // report the result, never rewriting the generated files.
  const maxRetries = p.ctx.fix.mode === "non-interactive" ? 0 : p.ctx.fix.maxRetries;
  // Only a target whose generated tests call `ccqa/step-evidence` captures
  // anything; for the rest the variable stays unset and the helper is a no-op.
  const captures = p.ctx.targetConfig.hooks.stepEvidence;
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

  for (let attempt = 0; ; attempt++) {
    const testFiles = [...state.entries()]
      .filter(([, f]) => f.kind === "test")
      .map(([rel]) => rel);
    // `{artifactsDir}` targets `ccqa run`'s per-spec artifacts collection; a
    // verification run has no report dir, so it (and CCQA_ARTIFACTS_DIR)
    // points at a throwaway temp dir instead, discarded after the attempt.
    const artifactsDir = await mkdtemp(join(tmpdir(), "ccqa-verify-artifacts-"));
    // The step screenshots this attempt takes, kept when it passes. A project
    // whose tests belong to its own runner never calls `ccqa run`, so this is
    // the only time ccqa sees the case executed — and `ccqa evidence` has no
    // pictures at all without it. Cleared first: what is here is one attempt's.
    const evidenceDir = captures ? caseRunDir(p.ctx.ref) : null;
    if (evidenceDir) {
      await clearCaseRun(p.ctx.ref);
      await mkdir(evidenceDir, { recursive: true });
    }
    const command = substituteArtifactsDir(
      substituteRunCommandFiles(runCommand, testFiles),
      artifactsDir,
    );
    log.run(command);
    let result: { exitCode: number; output: string };
    try {
      result = await log.timedPhase(
        `verification run #${attempt + 1}`,
        () =>
          // Fresh CCQA_RUN_ID per verification attempt, mirroring the vitest
          // runner: specs that embed `${CCQA_RUN_ID}` in created-content names
          // must not collide with leftovers from earlier runs.
          runShellCommand(command, p.ctx.cwd, {
            ...process.env,
            [ARTIFACTS_DIR_ENV]: artifactsDir,
            CCQA_RUN_ID: buildRunId(),
            ...(evidenceDir ? { [EVIDENCE_DIR_ENV]: evidenceDir } : {}),
          }),
        "run",
      );
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
    let failing = command;
    if (result.exitCode === 0) {
      // The spec's own test passing is not the whole bar: generated code that
      // breaks the project's type check or lint cannot be merged, and finding
      // that out in review costs another round trip. Run those here, where the
      // fix loop can still act on the output.
      const checks = (await runCheckCommands(p.ctx)) ?? reviewOfEmitted(p.ctx, state);
      // What is on disk is this attempt's, and this attempt passed.
      if (checks === null) return true;
      result = checks;
      // The fix pass is shown this output, so it has to be told which command
      // produced it — otherwise it reads lint errors under the test command.
      failing = checks.command;
    }
    if (attempt >= maxRetries) {
      log.warn(
        `verification still failing after ${maxRetries} fix attempt(s) — generated files kept`,
      );
      await clearCaseRun(p.ctx.ref);
      return false;
    }

    log.fix(`verification failed (exit ${result.exitCode}) — requesting a fix (${attempt + 1}/${maxRetries})`);
    const fixPrompt = buildLlmFixPrompt({
      targetId: p.target,
      command: failing,
      // The command's own output can echo a value the test resolved (a URL,
      // an account). It reaches the model as prose, which is how the leak
      // above happened, so it is symbolised before it goes.
      outputTail: scrubEnvValues(tail(result.output), outputScrub),
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
      return false;
    }
    await writeGeneratedFiles(p.ctx.cwd, output.files, state);
  }
}

/**
 * The project's own checks over the whole repository (type check, lint), run
 * after the spec's test passes. Answers null when they all pass — or when the
 * project configured none — and the failing one's output otherwise, in the
 * shape the fix loop already consumes.
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
function reviewOfEmitted(
  ctx: GenerateContext,
  state: FileState,
): { exitCode: number; output: string; command: string } | null {
  const findings = reviewEmittedFiles({
    files: new Map([...state].map(([rel, f]) => [rel, f.contents])),
    caseText: [
      ...[...ctx.steps, ...ctx.cleanup].flatMap((s) =>
        isExpandedActionStep(s) ? [s.instruction, s.expected] : [s.judgeByLlm],
      ),
      ...ctx.expectations,
      ...ctx.cleanupExpectations,
    ],
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
