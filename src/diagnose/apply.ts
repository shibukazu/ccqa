import type { Diagnosis, FixOutcome, SleepFix } from "./types.ts";

export function applyDiagnosis(script: string, diagnosis: Diagnosis): FixOutcome {
  switch (diagnosis.type) {
    case "TIMING_ISSUE":
      return applyTiming(script, diagnosis.fixes);
    case "OVER_ASSERTION":
      return applyOverAssertion(script, diagnosis.lines);
    case "SELECTOR_DRIFT":
      return applySelectorDrift(script, diagnosis.line, diagnosis.oldSelector, diagnosis.newSelector);
    case "DATA_MISSING":
      return { applied: false, reason: `data missing — ${diagnosis.reason}` };
    case "UNKNOWN":
      return { applied: false, reason: `unknown failure — ${diagnosis.reason}` };
  }
}

export function applyTiming(script: string, fixes: SleepFix[]): FixOutcome {
  if (fixes.length === 0) return { applied: false, reason: "no timing fixes proposed" };

  const lines = script.split("\n");
  const summary: string[] = [];

  for (const fix of fixes) {
    if (fix.kind === "increase") {
      const idx = fix.line - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const original = lines[idx]!;
      const replaced = original.replace(
        /spawnSync\("sleep",\s*\["\d+"\]/,
        `spawnSync("sleep", ["${fix.increase_to}"]`,
      );
      if (replaced !== original) {
        lines[idx] = replaced;
        summary.push(`line ${fix.line}: sleep → ${fix.increase_to}s`);
      }
    }
  }

  const inserts = fixes
    .filter((f): f is Extract<SleepFix, { kind: "insert" }> => f.kind === "insert")
    .sort((a, b) => b.line - a.line);

  for (const fix of inserts) {
    const idx = fix.line - 1;
    if (idx < 0 || idx > lines.length) continue;
    lines.splice(idx, 0, `  spawnSync("sleep", ["${fix.seconds}"], { stdio: "inherit" });`);
    summary.push(`line ${fix.line}: insert sleep ${fix.seconds}s`);
  }

  if (summary.length === 0) {
    return { applied: false, reason: "timing fixes pointed at out-of-range lines" };
  }
  return { applied: true, script: lines.join("\n"), summary: summary.join("; ") };
}

// `abWait` is technically a wait, but in a generated spec it functions as an
// implicit existence assertion (the line only "exists" because Claude wanted
// to assert the element appears). Diagnose treats it the same way, so the
// applier must, too — otherwise OVER_ASSERTION on a `abWait("[aria-label='...']")`
// line bails out with "no abAssert lines matched" even at high confidence.
const REMOVABLE_ASSERT_RE = /\b(?:abAssert\w*|abWait)\b/;

export function applyOverAssertion(script: string, lineNumbers: number[]): FixOutcome {
  if (lineNumbers.length === 0) return { applied: false, reason: "no lines to remove" };
  const lines = script.split("\n");
  const targets = [...new Set(lineNumbers)].sort((a, b) => b - a);
  const removed: string[] = [];

  for (const line of targets) {
    const idx = line - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const content = lines[idx]!;
    if (!REMOVABLE_ASSERT_RE.test(content)) {
      // Refuse to delete non-assertion lines — guards against the LLM picking the wrong line.
      continue;
    }
    removed.push(`line ${line}: ${content.trim()}`);
    lines.splice(idx, 1);
  }

  if (removed.length === 0) {
    return { applied: false, reason: "no abAssert/abWait lines matched the proposed line numbers" };
  }
  return { applied: true, script: lines.join("\n"), summary: `removed ${removed.length} assertion(s)` };
}

export function applySelectorDrift(
  script: string,
  line: number,
  oldSelector: string,
  newSelector: string,
): FixOutcome {
  const lines = script.split("\n");
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) {
    return { applied: false, reason: `line ${line} out of range` };
  }
  const content = lines[idx]!;
  if (!content.includes(oldSelector)) {
    return { applied: false, reason: `oldSelector not found on line ${line}` };
  }
  lines[idx] = content.replaceAll(oldSelector, newSelector);
  return {
    applied: true,
    script: lines.join("\n"),
    summary: `line ${line}: "${oldSelector}" → "${newSelector}"`,
  };
}

/**
 * Build a unified-style diff snippet for showing the user what would change.
 * Just the changed lines with -/+ prefixes; not a real patch.
 */
export function previewDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
  }
  return out.join("\n");
}
