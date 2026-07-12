import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { z } from "zod";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { expandSpec } from "../spec/expand.ts";
import { getSpecDir, loadAllBlocks, loadPromptBundleFromHub } from "../store/index.ts";
import {
  buildLlmFixPrompt,
  buildLlmGenPrompt,
  retryNote,
  type PromptResource,
} from "../prompts/llm-gen.ts";
import { isWithin, loadConventions, resolveResources, type ResolvedResource } from "./resources.ts";
import {
  GENERATED_MANIFEST_FILE,
  GeneratedManifestSchema,
  substituteRunCommandFiles,
  type GeneratedManifest,
} from "./run-command-runner.ts";
import { buildRunId } from "../runtime/live-artifacts.ts";
import { ARTIFACTS_DIR_ENV, substituteArtifactsDir } from "./run-artifacts.ts";
import type { GenerateContext, GenerateResult, SpecRef } from "./types.ts";
import type { GuidanceKind } from "../prompts/prompt-names.ts";
import * as log from "../cli/logger.ts";

/**
 * Shared LLM generation engine for runCommand-verified targets (playwright /
 * runn). One pass through the engine is:
 *
 *   resolve resources + conventions → assemble the prompt (spec, optional
 *   mechanical draft, hub prompt bundle, reuse-first contract) → invoke
 *   Claude read-only (Read/Grep/Glob — no Bash, no browser) → parse the JSON
 *   output contract → validate output paths → write files + the
 *   `generated.json` manifest → optionally verify via the target's
 *   `runCommand`, feeding failures back to Claude in a bounded fix loop.
 *
 * Targets whose first pass is deterministic (playwright without resources)
 * enter at `finalizePreparedFiles`, sharing the write/manifest/verify half.
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
  /** Absolute `targetConfig.outDir`. */
  outDirAbs: string;
  /** Absolute path-resource roots that may also receive support files. */
  writeRootsAbs: string[];
}

/**
 * Validate one output path against the write policy: project-root-relative,
 * no traversal, never under node_modules, and confined to outDir or a
 * writable path-resource root. Returns an error message, or null when valid.
 */
export function validateOutputPath(policy: OutputPathPolicy, path: string): string | null {
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
  const roots = [policy.outDirAbs, ...policy.writeRootsAbs];
  if (!roots.some((root) => isWithin(root, abs))) {
    const allowed = roots.map((r) => relative(policy.cwd, r) || ".").join(", ");
    return `output path escapes the allowed roots (${allowed}): ${path}`;
  }
  return null;
}

// --- generated.json manifest ---
// The shape (`GeneratedManifestSchema`) lives in run-command-runner.ts — the
// consumer side of the contract — and is written here:
//   { target, generatedAt (ISO8601), files: [{ path (cwd-relative), kind, sha256 }] }

function manifestPath(ref: SpecRef, cwd: string): string {
  return join(getSpecDir(ref.featureName, ref.specName, cwd), GENERATED_MANIFEST_FILE);
}

export async function loadGeneratedManifest(
  ref: SpecRef,
  cwd: string,
): Promise<GeneratedManifest | null> {
  const content = await readFile(manifestPath(ref, cwd), "utf8").catch(() => null);
  if (content === null) return null;
  try {
    return GeneratedManifestSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * `existingOutput` hook shared by manifest-writing targets: the first still-
 * existing generated file (tests first), i.e. what a re-generate would
 * clobber. Null when nothing was generated or every listed file is gone.
 */
export async function existingOutputFromManifest(
  ref: SpecRef,
  cwd: string,
): Promise<string | null> {
  const manifest = await loadGeneratedManifest(ref, cwd);
  if (!manifest) return null;
  const files = [...manifest.files].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "test" ? -1 : 1,
  );
  for (const f of files) {
    const abs = resolve(cwd, f.path);
    const exists = await stat(abs)
      .then(() => true)
      .catch(() => false);
    if (exists) return abs;
  }
  return null;
}

/** Written-files state: cwd-relative path → what's on disk. */
type FileState = Map<string, { abs: string; kind: "test" | "support"; contents: string }>;

async function writeGeneratedFiles(
  cwd: string,
  files: LlmGeneratedFile[],
  state: FileState,
): Promise<void> {
  for (const file of files) {
    const abs = resolve(cwd, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.contents, "utf8");
    state.set(relative(cwd, abs), { abs, kind: file.kind, contents: file.contents });
    log.meta("saved", abs);
  }
}

async function saveGeneratedManifest(
  ref: SpecRef,
  cwd: string,
  target: string,
  state: FileState,
): Promise<void> {
  const manifest: GeneratedManifest = {
    target,
    generatedAt: new Date().toISOString(),
    files: [...state.entries()].map(([path, f]) => ({
      path,
      kind: f.kind,
      sha256: createHash("sha256").update(f.contents, "utf8").digest("hex"),
    })),
  };
  // Contract with the run side (`GeneratedManifestSchema`) — see run-command-runner.ts.
  const path = manifestPath(ref, cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

// --- runCommand execution ---

// `{files}` substitution (shell-quoted) lives with the run-side consumer of
// the manifest; re-exported here for existing importers.
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
  /** Target-specific instruction block (what to generate, in which format). */
  taskInstructions: string;
  /** Mechanical draft treated as recorded ground truth (playwright). */
  draft?: { path: string; contents: string };
  /** Per-file validation before writing (e.g. YAML parse for runn); returns an error message to reject. */
  validateFile?: (file: LlmGeneratedFile) => string | null;
  /** Test seam — defaults to `invokeClaudeStreaming`. */
  invoke?: InvokeFn;
}

/** `targetConfig.outDir`, or a config-pointing error — LLM targets require it. */
export function requireOutDir(ctx: GenerateContext, target: string): string {
  const outDir = ctx.targetConfig.outDir;
  if (!outDir) {
    throw new Error(
      `the ${target} target needs \`targets.${target}.outDir\` in .ccqa/config.yaml — ` +
        `the directory generated tests are written to`,
    );
  }
  return outDir;
}

/** Full LLM generation: prompt assembly → invoke → write → verify loop. */
export async function generateWithLlmEngine(req: LlmEngineRequest): Promise<GenerateResult> {
  const { ctx } = req;
  const outDir = requireOutDir(ctx, req.target);
  const resources = await resolveResources(ctx.cwd, ctx.resources);
  const conventions = await loadConventions(ctx.cwd, ctx.conventions);
  const warnings = [...conventions.warnings];
  for (const w of conventions.warnings) log.warn(w);
  log.meta("resources", resources.length);
  log.meta("conventions", conventions.sections.length);

  const bundle = await loadPromptBundleFromHub(ctx.hub, req.target);
  if (bundle) log.meta("prompt-bundle", bundle.loaded.join(", "));

  const blocks = await loadAllBlocks(ctx.cwd);
  const steps = expandSpec(ctx.spec, { blocks });

  const policy: OutputPathPolicy = {
    cwd: ctx.cwd,
    outDirAbs: resolve(ctx.cwd, outDir),
    writeRootsAbs: resources.filter((r) => r.writable).map((r) => r.rootAbs),
  };
  const extraWriteRoots = resources.filter((r) => r.writable).map((r) => r.rootDisplay);

  const prompt = buildLlmGenPrompt({
    taskInstructions: req.taskInstructions,
    specTitle: ctx.spec.title,
    steps,
    relatedPaths: ctx.spec.relatedPaths ?? [],
    draft: req.draft,
    resources: resources.map(toPromptResource),
    conventionSections: conventions.sections,
    promptBundle: bundle?.text,
    outDir,
    extraWriteRoots,
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
    outDir,
    policy,
    extraWriteRoots,
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
 * engine's write + manifest + runCommand verification half (the fix loop
 * still consults Claude on failures).
 */
export async function finalizePreparedFiles(req: PreparedFilesRequest): Promise<GenerateResult> {
  const { ctx } = req;
  const outDir = requireOutDir(ctx, req.target);
  const resources = await resolveResources(ctx.cwd, ctx.resources);
  const policy: OutputPathPolicy = {
    cwd: ctx.cwd,
    outDirAbs: resolve(ctx.cwd, outDir),
    writeRootsAbs: resources.filter((r) => r.writable).map((r) => r.rootAbs),
  };
  return finalizeAndVerify({
    ctx,
    target: req.target,
    outDir,
    policy,
    extraWriteRoots: resources.filter((r) => r.writable).map((r) => r.rootDisplay),
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
  outDir: string;
  policy: OutputPathPolicy;
  extraWriteRoots: string[];
  initialFiles: LlmGeneratedFile[];
  summary: string;
  warnings: string[];
  validateFile?: (file: LlmGeneratedFile) => string | null;
  invoke: InvokeFn;
}

/** Write files + manifest, then run the bounded runCommand verify/fix loop. */
async function finalizeAndVerify(p: FinalizeParams): Promise<GenerateResult> {
  const { ctx } = p;
  const ref: SpecRef = { featureName: ctx.featureName, specName: ctx.specName };
  const state: FileState = new Map();
  await writeGeneratedFiles(ctx.cwd, p.initialFiles, state);
  await saveGeneratedManifest(ref, ctx.cwd, p.target, state);

  const passed = await runVerificationLoop(p, ref, state);
  return {
    files: [...state.values()].map((f) => ({ path: f.abs, kind: f.kind })),
    summary: p.summary || `${state.size} file(s) generated for the ${p.target} target`,
    warnings: p.warnings,
    passed,
  };
}

/**
 * The runCommand verification loop: run, and on failure hand the output tail
 * plus the current files to Claude for a corrected set, `fix.maxRetries`
 * times. Exhaustion keeps the files on disk and reports `passed: false`.
 * Targets without a runCommand are generate-only here and pass trivially.
 */
async function runVerificationLoop(
  p: FinalizeParams,
  ref: SpecRef,
  state: FileState,
): Promise<boolean> {
  const runCommand = p.ctx.targetConfig.runCommand;
  if (!runCommand) return true;
  const maxRetries = p.ctx.fix.maxRetries;

  for (let attempt = 0; ; attempt++) {
    const testFiles = [...state.entries()]
      .filter(([, f]) => f.kind === "test")
      .map(([rel]) => rel);
    // `{artifactsDir}` targets `ccqa run`'s per-spec artifacts collection; a
    // verification run has no report dir, so it (and CCQA_ARTIFACTS_DIR)
    // points at a throwaway temp dir instead, discarded after the attempt.
    const artifactsDir = await mkdtemp(join(tmpdir(), "ccqa-verify-artifacts-"));
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
          }),
        "run",
      );
    } finally {
      await rm(artifactsDir, { recursive: true, force: true });
    }
    if (result.exitCode === 0) return true;
    if (attempt >= maxRetries) {
      log.warn(
        `verification still failing after ${maxRetries} fix attempt(s) — generated files kept`,
      );
      return false;
    }

    log.fix(`verification failed (exit ${result.exitCode}) — requesting a fix (${attempt + 1}/${maxRetries})`);
    const fixPrompt = buildLlmFixPrompt({
      targetId: p.target,
      command,
      outputTail: tail(result.output),
      files: [...state.entries()].map(([path, f]) => ({
        path,
        contents: f.contents,
        kind: f.kind,
      })),
      outDir: p.outDir,
      extraWriteRoots: p.extraWriteRoots,
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
    await writeGeneratedFiles(p.ctx.cwd, output.files, state);
    await saveGeneratedManifest(ref, p.ctx.cwd, p.target, state);
  }
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
    const pathError = validateOutputPath(p.policy, file.path);
    if (pathError) {
      errors.push(pathError);
      continue;
    }
    const fileError = p.validateFile?.(file) ?? null;
    if (fileError) errors.push(fileError);
  }
  if (p.requireTestFile && !output.files.some((f) => f.kind === "test")) {
    errors.push('output contains no "kind": "test" file');
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
