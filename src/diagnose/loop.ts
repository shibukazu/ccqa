import { writeFile } from "node:fs/promises";
import * as log from "../cli/logger.ts";
import { applyDiagnosis, previewDiff } from "./apply.ts";
import { diagnose, type DiagnoseOutcome } from "./diagnose.ts";
import { promptForChoice } from "./interactive.ts";
import { captureSnapshot } from "./snapshot.ts";
import type { Diagnosis, DiagnosisResult } from "./types.ts";
import type { TraceAction } from "../types.ts";

export type FixMode = "auto" | "non-interactive" | "interactive";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

export interface RunVitestResult {
  exitCode: number;
  output: string;
  currentScript: string;
}

export interface AutoFixLoopInput {
  scriptPath: string;
  initialRun: RunVitestResult;
  /** Spec YAML shown to the diagnose LLM for context. */
  specYaml: string;
  /** Recorded actions used as additional context. */
  actions: TraceAction[];
  maxRetries: number;
  mode: FixMode;
  /** Re-run vitest after each applied fix; the loop hands back the new run result. */
  runVitest: (scriptPath: string) => Promise<RunVitestResult>;
  /**
   * agent-browser session name used by the test run. When set, the loop
   * captures a `agent-browser snapshot` right after each failure and
   * attaches the accessibility tree to the diagnose prompt — invaluable
   * for catching SELECTOR_DRIFT cases the failure log alone can't see.
   */
  agentBrowserSession?: string;
  /** BCP-47 hint for the language used in `reasoning` / `reason`. Defaults to "en". */
  outputLanguage?: string;
  /** Claude model to use for the diagnose call. Falls back to CCQA_MODEL / CLI default. */
  model?: string;
}

/**
 * Returns true when vitest finally passed; false when retries were exhausted
 * or the diagnose loop chose to bail out early.
 */
export async function runAutoFixLoop(input: AutoFixLoopInput): Promise<boolean> {
  const {
    scriptPath,
    initialRun,
    specYaml,
    actions,
    maxRetries,
    mode,
    runVitest,
    agentBrowserSession,
    outputLanguage,
    model,
  } = input;

  let { exitCode, output, currentScript } = initialRun;
  if (exitCode === 0) return true;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log.fix(`attempt ${attempt}/${maxRetries}`);
    log.blank();

    const pageSnapshot = agentBrowserSession
      ? await log.timedPhase("page snapshot", () => captureSnapshot(agentBrowserSession), "fix")
      : null;
    if (agentBrowserSession) {
      if (pageSnapshot) {
        log.fix(`page snapshot: ${pageSnapshot.length} chars captured`);
      } else {
        log.fix("page snapshot unavailable; continuing without it");
      }
    }

    const fixed = await diagnoseAndFix({
      script: currentScript,
      specYaml,
      actions,
      failureLog: output,
      pageSnapshot: pageSnapshot ?? undefined,
      mode,
      outputLanguage,
      model,
    });
    if (!fixed) {
      // diagnoseAndFix has already emitted the [hint] handoff; here we just
      // surface the loop-level outcome.
      log.fix("bailed out; see diagnosis above");
      return false;
    }

    await writeFile(scriptPath, fixed, "utf-8");
    log.fix(`saved: ${scriptPath}`);
    log.blank();

    ({ exitCode, output, currentScript } = await log.timedPhase(
      `vitest run #${attempt + 1}`,
      () => runVitest(scriptPath),
      "run",
    ));
    if (exitCode === 0) return true;
  }

  return false;
}

interface DiagnoseAndFixInput {
  script: string;
  specYaml: string;
  actions: TraceAction[];
  failureLog: string;
  pageSnapshot?: string;
  mode: FixMode;
  outputLanguage?: string;
  model?: string;
}

async function diagnoseAndFix(input: DiagnoseAndFixInput): Promise<string | null> {
  const { script, specYaml, actions, failureLog, pageSnapshot, mode, outputLanguage, model } = input;

  // claude-agent-sdk surfaces some failures (maxTurns reached, transport
  // errors, aborted process) by throwing inside the async-iteration loop
  // instead of yielding a result with `is_error: true`. Catch here so the
  // auto-fix loop can bail out gracefully instead of crashing the whole
  // `ccqa generate` invocation — the user still gets a [hint] explaining
  // what happened and where to look next.
  let outcome: DiagnoseOutcome;
  try {
    outcome = await log.timedPhase(
      "diagnose",
      () => diagnose({ script, specYaml, actions, failureLog, pageSnapshot, outputLanguage }, { model }),
      "fix",
    );
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    log.fix(`diagnose: threw while talking to Claude (${truncateForLog(message)})`);
    log.hint("re-run later, or check your Claude Code login / network connectivity / model availability");
    return null;
  }

  if (outcome.sdkError) {
    log.fix("diagnose: SDK error talking to Claude");
    if (outcome.raw) log.fix(`diagnose raw: ${truncateForLog(outcome.raw)}`);
    log.hint("re-run later, or check your Claude Code login / network connectivity");
    return null;
  }
  if (!outcome.result) {
    log.fix("diagnose: empty response from LLM");
    log.hint("re-run; if this keeps happening the failure log may be too short to diagnose");
    return null;
  }

  const result = outcome.result;
  reportDiagnosis(result);

  // Diagnoses that are inherently not auto-fixable: hand off to the user
  // with a category-specific [hint] explaining what they should do next.
  if (result.diagnosis.type === "DATA_MISSING" || result.diagnosis.type === "UNKNOWN") {
    handoffToUser(result, outcome.raw, outputLanguage);
    return null;
  }

  const apply = applyDiagnosis(script, result.diagnosis);
  if (!apply.applied) {
    log.fix(`cannot apply: ${apply.reason}`);
    handoffToUser(result, outcome.raw, outputLanguage);
    return null;
  }

  const decision = decide(result, mode);
  if (decision === "apply-auto") {
    log.fix(`applying automatically: ${apply.summary}`);
    return apply.script;
  }
  if (decision === "skip-low-confidence") {
    log.fix(
      `confidence ${result.confidence.toFixed(2)} below threshold ${DEFAULT_CONFIDENCE_THRESHOLD}; skipping (mode: ${mode})`,
    );
    handoffToUser(result, outcome.raw, outputLanguage);
    return null;
  }

  const choice = await promptForChoice({
    result,
    diff: previewDiff(script, apply.script),
    failureExcerpt: failureLog.slice(0, 800),
  });

  switch (choice) {
    case "apply":
      log.fix(`applied: ${apply.summary}`);
      return apply.script;
    case "skip":
      log.fix("skipped; leaving script untouched");
      return null;
    case "manual":
      log.fix("paused for manual edit");
      handoffToUser(result, outcome.raw, outputLanguage);
      return null;
    case "quit":
      log.fix("user quit");
      process.exit(1);
  }
}

export type Decision = "apply-auto" | "skip-low-confidence" | "interactive";

/**
 * Map a diagnosis to one of three actions. `auto` previously bypassed the
 * confidence threshold; it no longer does — a low-confidence guess can
 * corrupt working code, and CI wants "apply obvious fixes, fail loudly on
 * the rest" rather than "apply every guess".
 */
export function decide(result: DiagnosisResult, mode: FixMode): Decision {
  const highConfidence = result.confidence >= DEFAULT_CONFIDENCE_THRESHOLD;
  if (mode === "auto" || mode === "non-interactive") {
    return highConfidence ? "apply-auto" : "skip-low-confidence";
  }
  return highConfidence ? "apply-auto" : "interactive";
}

function reportDiagnosis(result: DiagnosisResult): void {
  log.fix(`diagnosis: ${result.diagnosis.type}`);
  log.fix(`confidence: ${result.confidence.toFixed(2)}`);
  if (result.reasoning) log.fix(`reasoning: ${result.reasoning}`);
}

/**
 * Emit a category-specific [hint] block that tells the user what to do next.
 * Called whenever the loop has decided it cannot proceed on its own —
 * because the diagnosis is intrinsically not auto-fixable, because the
 * proposed fix wasn't applicable to the current script, or because the
 * confidence was too low under --no-interactive.
 *
 * The goal is to never leave the user with just "auto-fix exhausted" —
 * always state which side (test artifacts vs. application) likely needs
 * the next action.
 */
function handoffToUser(result: DiagnosisResult, raw: string, language: string | undefined): void {
  const lines = handoffMessage(result.diagnosis, normLang(language));
  for (const line of lines) log.hint(line);
  if (raw) log.fix(`diagnose raw: ${truncateForLog(raw)}`);
}

type SupportedLang = "ja" | "en";

function normLang(language: string | undefined): SupportedLang {
  if (!language) return "en";
  const lower = language.toLowerCase();
  return lower.startsWith("ja") ? "ja" : "en";
}

const HANDOFF: Record<SupportedLang, (d: Diagnosis) => string[]> = {
  en: handoffEn,
  ja: handoffJa,
};

function handoffMessage(diagnosis: Diagnosis, language: SupportedLang): string[] {
  return HANDOFF[language](diagnosis);
}

function handoffEn(diagnosis: Diagnosis): string[] {
  switch (diagnosis.type) {
    case "DATA_MISSING":
      return [
        `application-side issue: required data is missing. ${diagnosis.reason}`,
        "next step: seed the data (or update spec.yaml prerequisites), then re-run trace + generate.",
      ];
    case "UNKNOWN":
      return [
        `could not classify the failure. ${diagnosis.reason}`,
        "next step: read the failure log above, decide whether the test or the app is wrong, and fix manually. consider re-running ccqa trace if the recorded flow no longer matches the live app.",
      ];
    case "SELECTOR_DRIFT":
      return [
        `selector likely drifted but auto-apply was not safe.`,
        `proposed: line ${diagnosis.line}: "${diagnosis.oldSelector}" → "${diagnosis.newSelector}" (${diagnosis.reason}).`,
        "next step: confirm in the live app and either accept the proposal manually, or re-run ccqa trace to recapture the new selector.",
      ];
    case "OVER_ASSERTION":
      return [
        `assertion may not be required by the spec. lines: ${diagnosis.lines.join(", ")} (${diagnosis.reason}).`,
        "next step: cross-check spec.yaml. either delete the assertion from the test, or tighten the spec to require it.",
      ];
    case "TIMING_ISSUE":
      return [
        `timing fix proposed but couldn't be applied automatically.`,
        "next step: insert a sleep manually before the failing line, or re-run with a higher confidence trace.",
      ];
  }
}

function handoffJa(diagnosis: Diagnosis): string[] {
  switch (diagnosis.type) {
    case "DATA_MISSING":
      return [
        `アプリ側の問題: 必要なデータが不足しています。${diagnosis.reason}`,
        "次のステップ: データを seed する（または spec.yaml の prerequisites を更新）してから ccqa trace + generate をやり直してください。",
      ];
    case "UNKNOWN":
      return [
        `失敗を分類できませんでした。${diagnosis.reason}`,
        "次のステップ: 上の失敗ログを確認し、テストとアプリのどちらが原因か判断して手動で修正してください。記録した手順がアプリの現状と合わない場合は ccqa trace の再実行を検討してください。",
      ];
    case "SELECTOR_DRIFT":
      return [
        "selector が変わった可能性が高いですが、自動適用は安全でないと判断しました。",
        `提案: 行 ${diagnosis.line}: "${diagnosis.oldSelector}" → "${diagnosis.newSelector}" (${diagnosis.reason})`,
        "次のステップ: アプリで新 selector を確認し、手動で適用するか ccqa trace をやり直して新しい selector を取り直してください。",
      ];
    case "OVER_ASSERTION":
      return [
        `spec が要求していない assertion の可能性があります。対象行: ${diagnosis.lines.join(", ")} (${diagnosis.reason})`,
        "次のステップ: spec.yaml と照合して、テスト側の assertion を削るか、spec 側を更新してください。",
      ];
    case "TIMING_ISSUE":
      return [
        "timing 関連の修正案は出ましたが、自動適用できませんでした。",
        "次のステップ: 失敗行の前に手動で sleep を入れるか、より信頼度の高い trace を取り直してください。",
      ];
  }
}

function truncateForLog(s: string): string {
  const oneLine = s.replace(/\n+/g, " ⏎ ");
  return oneLine.length <= 400 ? oneLine : `${oneLine.slice(0, 400)}... [+${oneLine.length - 400} chars]`;
}

export function resolveMode(opts: { auto?: boolean; noInteractive?: boolean; interactive?: boolean }): FixMode {
  if (opts.auto) return "auto";
  if (opts.interactive === false || opts.noInteractive) return "non-interactive";
  return "interactive";
}
