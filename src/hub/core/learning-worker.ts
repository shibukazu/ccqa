import { driftAuthAvailable } from "../../drift/auth.ts";
import { invokeClaudeStreaming } from "../../claude/invoke.ts";
import type { FailureLabel } from "../../report/schema.ts";
import { ANALYSIS_PROMPT_VERSION, buildFailureAnalysisPrompt } from "../../report/prompt.ts";
import { LEARNING_SYSTEM_PROMPT, buildLearningUserPrompt } from "../../prompts/custom-prompt-learning.ts";
import {
  type AnalysisCustomPrompt,
  type AnalysisCustomPromptOverlay,
  AnalysisCustomPromptSchema,
  type GradedCase,
  overlayAsPrompt,
} from "../../prompts/custom-prompt.ts";
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

  /**
   * One Claude call turning a batch of graded cases into a calibration note.
   * Returns null when nothing usable came back so the caller can drop that
   * group's overlay without failing the whole job.
   */
  const learnGuidance = async (cases: GradedCase[]): Promise<string | null> => {
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
    return isError || !guidance ? null : guidance;
  };

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
    // store (each record already carries the model's prediction, the human
    // label, and — when known — the row's generation target). Only labelled
    // cases count; UNKNOWN isn't a gradeable cause.
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
          ...(r.target ? { target: r.target } : {}),
        });
      }
    }

    if (cases.length === 0) {
      throw new Error("no graded triage cases for this project — grade some failing specs first");
    }

    // Record the resolved inputs now, so a later failure still reports the
    // real case count instead of the create-time 0.
    await storage.jobs.update(job.id, { input: { runLimit, casesConsidered: cases.length } });

    // Split by target so one target's calibration never leaks into another.
    // Cases with no recorded target (old grades) feed the un-scoped fallback
    // note — used for any target without its own overlay — not every target.
    const fallbackCases: GradedCase[] = [];
    const targetCases = new Map<string, GradedCase[]>();
    for (const c of cases) {
      if (!c.target) {
        fallbackCases.push(c);
        continue;
      }
      const list = targetCases.get(c.target) ?? [];
      list.push(c);
      targetCases.set(c.target, list);
    }

    // One Claude call per group (fallback + one per target). The groups are
    // disjoint and independent, so run them concurrently — a serial loop would
    // multiply job wall time by the target count on the single-worker queue. A
    // group whose call returns nothing usable is dropped (no overlay for it),
    // not fatal — only an entirely empty result fails the job, keeping the
    // "never store an empty custom prompt" contract.
    const generatedAt = new Date().toISOString();
    const sortedTargets = [...targetCases.keys()].sort((a, b) => a.localeCompare(b));
    const [fallbackGuidance, ...targetGuidances] = await Promise.all([
      fallbackCases.length > 0 ? learnGuidance(fallbackCases) : Promise.resolve(null),
      ...sortedTargets.map((target) => learnGuidance(targetCases.get(target)!)),
    ]);

    // Fold into byTarget in sorted-target order so the stored key order is
    // deterministic regardless of which call settled first.
    const byTarget: Record<string, AnalysisCustomPromptOverlay> = {};
    sortedTargets.forEach((target, i) => {
      const guidance = targetGuidances[i];
      if (guidance) {
        byTarget[target] = { customPromptVersion: `${generatedAt}-${target}-c${targetCases.get(target)!.length}`, generatedAt, guidance };
      }
    });

    if (!fallbackGuidance && Object.keys(byTarget).length === 0) {
      throw new Error("triage learning: Claude returned no usable calibration note");
    }

    // The custom prompt in place before this job — the "before" side of the preview.
    const prevCustomPrompt = await loadStoredCustomPrompt(storage, job.project);

    const customPrompt: AnalysisCustomPrompt = {
      schemaVersion: 1,
      basePromptVersion: ANALYSIS_PROMPT_VERSION,
      customPromptVersion: `${generatedAt}-c${fallbackCases.length}`,
      generatedAt,
      guidance: fallbackGuidance ?? "",
      ...(Object.keys(byTarget).length > 0 ? { byTarget } : {}),
    };
    AnalysisCustomPromptSchema.parse(customPrompt); // self-check before storing

    // The preview shows a representative overlay (the fallback if it has
    // guidance, else the first target's) so it reflects what the job learned
    // even when every case was target-scoped.
    const beforePrompt = buildFailureAnalysisPrompt({ ...PROMPT_PREVIEW_FIXTURE, customPrompt: representativeOverlay(prevCustomPrompt) });
    const afterPrompt = buildFailureAnalysisPrompt({ ...PROMPT_PREVIEW_FIXTURE, customPrompt: representativeOverlay(customPrompt) });

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

/**
 * A single representative overlay for the before/after prompt preview: the
 * un-scoped fallback when it has guidance, else the first target overlay by
 * name, else null. Only the preview uses this — the stored blob keeps every
 * overlay; run-time injection picks per target (resolveCustomPromptForTarget).
 */
function representativeOverlay(cp: AnalysisCustomPrompt | null): AnalysisCustomPrompt | null {
  if (!cp) return null;
  if (cp.guidance.trim()) return overlayAsPrompt(cp, cp);
  const firstTarget = cp.byTarget ? Object.keys(cp.byTarget).sort()[0] : undefined;
  const overlay = firstTarget ? cp.byTarget?.[firstTarget] : undefined;
  return overlay ? overlayAsPrompt(cp, overlay) : null;
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
