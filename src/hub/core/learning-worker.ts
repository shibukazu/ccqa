import { driftAuthAvailable } from "../../drift/auth.ts";
import { invokeClaudeStreaming } from "../../claude/invoke.ts";
import type { FailureLabel } from "../../report/schema.ts";
import { ANALYSIS_PROMPT_VERSION, buildFailureAnalysisPrompt } from "../../report/prompt.ts";
import { LEARNING_SYSTEM_PROMPT, buildLearningUserPrompt } from "../../prompts/custom-prompt-learning.ts";
import { type AnalysisCustomPrompt, AnalysisCustomPromptSchema, type GradedCase } from "../../prompts/custom-prompt.ts";
import type { LearningJob } from "../contract/schema.ts";
import type { HubStorage } from "./storage/types.ts";

/**
 * A triage-learning job. It reads the "actual cause" labels a human recorded
 * against failing specs (via the hub UI), has Claude write a short calibration
 * note from them, and stores it back as the "analysis-custom-prompt" prompt. The
 * next `ccqa run` that pulls picks it up and the failure classifier calibrates
 * to this project's conventions.
 *
 * Learning always needs Claude auth on the hub — there is no deterministic
 * fallback — and fails the job (rather than silently downgrading) if Claude
 * returns nothing usable.
 *
 * Claude runs in-process here (one stateless call, no browser, no child
 * process — unlike a test run). `invoke` and `authCheck` are injected so the
 * whole test suite stays offline and deterministic.
 */
export interface LearningWorkerDeps {
  storage: HubStorage;
  invoke?: typeof invokeClaudeStreaming;
  authCheck?: typeof driftAuthAvailable;
}

/** How many recorded runs to scan when no runLimit is given. */
const DEFAULT_RUN_LIMIT = 50;
/** Upper bound on graded cases fed to the learning prompt (keeps token cost bounded). */
const LEARNING_MAX_CASES = 30;

/**
 * A fixed, neutral prompt input used only to render the before/after prompt the
 * UI shows. The custom prompt is the only part that changes between the two renders,
 * so the diff isolates exactly the learned calibration block. Nothing here is
 * project-specific — the real per-run inputs never reach this path.
 */
const PROMPT_PREVIEW_FIXTURE = {
  specYaml: "(sample spec)",
  failureLog: "(sample failure log)",
  diffPatch: null,
  changedFiles: null,
  baseRef: null,
  driftIssues: null,
} as const;

/** Build the short failure signal a graded case shows the learning prompt. */
function evidenceSignalFor(headline: string, note: string | undefined): string {
  const parts = [headline.trim(), note?.trim()].filter((p): p is string => !!p);
  return parts.join(" — ").slice(0, 1200);
}

export function createLearningWorker(deps: LearningWorkerDeps): (job: LearningJob) => Promise<void> {
  const { storage, invoke = invokeClaudeStreaming, authCheck = driftAuthAvailable } = deps;

  return async function runLearningJob(job: LearningJob): Promise<void> {
    // Learning always needs Claude. Check auth per-job (not at boot) so a hub
    // with no credentials still starts — only running a learning job fails,
    // with a clear reason.
    const auth = authCheck();
    if (!auth.ok) {
      throw new Error(`triage learning needs Claude auth on the hub: ${auth.reason}`);
    }

    const runLimit = job.input.runLimit > 0 ? job.input.runLimit : DEFAULT_RUN_LIMIT;

    // Gather every graded case across recent runs, straight from the triage
    // store (each record already carries the model's prediction and the human
    // label). Only labelled cases count; UNKNOWN isn't a gradeable cause.
    const runs = await storage.runs.list({ project: job.project, limit: runLimit });
    const cases: GradedCase[] = [];
    for (const run of runs) {
      const records = await storage.triage.list(run.id);
      for (const r of records) {
        const actual = r.actualCause as FailureLabel;
        cases.push({
          predicted: r.predicted.label,
          actualCause: actual,
          evidenceSignal: evidenceSignalFor(r.predicted.headline, r.note),
          matches: r.predicted.label === actual,
        });
      }
    }

    if (cases.length === 0) {
      throw new Error("no graded triage cases for this project — grade some failing specs first");
    }

    // Record the resolved inputs now, so a later failure still reports the
    // real case count instead of the create-time 0.
    await storage.jobs.update(job.id, { input: { runLimit, casesConsidered: cases.length } });

    // Have Claude write the calibration note. If it returns nothing usable,
    // fail — don't silently store an empty custom prompt.
    const { result, isError } = await invoke(
      {
        prompt: buildLearningUserPrompt(cases.slice(0, LEARNING_MAX_CASES)),
        systemPrompt: LEARNING_SYSTEM_PROMPT,
        allowedTools: [],
        disableBuiltinTools: true,
        // The note is written in a single model turn (no tools); capping turns
        // bounds a runaway call so it can't wedge the single-worker queue.
        maxTurns: 1,
      },
      () => {},
    );
    const guidance = result?.trim();
    if (isError || !guidance) {
      throw new Error("triage learning: Claude returned no usable calibration note");
    }

    // The custom prompt in place before this job — the "before" side of the preview.
    const prevCustomPrompt = await loadStoredCustomPrompt(storage, job.project);

    const generatedAt = new Date().toISOString();
    const customPrompt: AnalysisCustomPrompt = {
      schemaVersion: 1,
      basePromptVersion: ANALYSIS_PROMPT_VERSION,
      customPromptVersion: `${generatedAt}-c${cases.length}`,
      generatedAt,
      guidance,
    };
    AnalysisCustomPromptSchema.parse(customPrompt); // self-check before storing

    const beforePrompt = buildFailureAnalysisPrompt({ ...PROMPT_PREVIEW_FIXTURE, customPrompt: prevCustomPrompt });
    const afterPrompt = buildFailureAnalysisPrompt({ ...PROMPT_PREVIEW_FIXTURE, customPrompt });

    await storage.prompts.put(job.project, "analysis-custom-prompt", new TextEncoder().encode(JSON.stringify(customPrompt)), {
      customPromptVersion: customPrompt.customPromptVersion,
      basePromptVersion: customPrompt.basePromptVersion,
    });

    await storage.jobs.update(job.id, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      result: { customPromptVersion: customPrompt.customPromptVersion, beforePrompt, afterPrompt },
    });
  };
}

/** Read the currently-stored custom prompt, or null when there is none / it's unreadable. */
async function loadStoredCustomPrompt(storage: HubStorage, project: string): Promise<AnalysisCustomPrompt | null> {
  const entry = await storage.prompts.get(project, "analysis-custom-prompt");
  if (!entry) return null;
  try {
    const parsed = AnalysisCustomPromptSchema.safeParse(JSON.parse(new TextDecoder().decode(entry.blob)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
