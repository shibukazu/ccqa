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
  lines[idx] = replaceSelectorLiteral(content, oldSelector, newSelector);
  return {
    applied: true,
    script: lines.join("\n"),
    summary: `line ${line}: "${oldSelector}" → "${newSelector}"`,
  };
}

/**
 * Rewrite a selector inside whatever string literal encloses it on the line.
 * The tricky case is when `newSelector` contains a `${...}` env reference
 * and the host literal is a plain `"..."` / `'...'` — a naive `replaceAll`
 * leaves the unescaped `${...}` inside the double-quoted literal and produces
 * invalid TS (the auto-fix loop used to ship this and blow up esbuild). When
 * a template-literal substitution is needed, promote the enclosing literal
 * from "..."/'...' to `...` in one step.
 */
function replaceSelectorLiteral(content: string, oldSelector: string, newSelector: string): string {
  const needsTemplate = /\$\{[A-Za-z_]/.test(newSelector);
  if (!needsTemplate) {
    return content.replaceAll(oldSelector, newSelector);
  }

  const tplRe = new RegExp("`([^`]*)" + escapeForRegex(oldSelector) + "([^`]*)`", "g");
  if (tplRe.test(content)) {
    return content.replace(tplRe, (_m, before: string, after: string) => `\`${before}${newSelector}${after}\``);
  }

  for (const quote of ['"', "'"] as const) {
    const re = new RegExp(`${quote}([^${quote}\\\\]*(?:\\\\.[^${quote}\\\\]*)*)${quote}`, "g");
    let match: RegExpExecArray | null;
    const replacements: Array<{ start: number; end: number; rewritten: string }> = [];
    while ((match = re.exec(content)) !== null) {
      const inner = match[1] ?? "";
      if (!inner.includes(oldSelector)) continue;
      const rewrittenInner = inner.replaceAll(oldSelector, newSelector);
      const backtickSafe = rewrittenInner.replace(/`/g, "\\`");
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        rewritten: `\`${backtickSafe}\``,
      });
    }
    if (replacements.length > 0) {
      let out = content;
      for (const r of replacements.reverse()) {
        out = out.slice(0, r.start) + r.rewritten + out.slice(r.end);
      }
      return out;
    }
  }

  return content.replaceAll(oldSelector, newSelector);
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a unified-diff snippet for showing the user what would change. Uses
 * the LCS so an insertion doesn't get mis-aligned as a "delete every line and
 * re-insert it shifted by one" cascade (the naive zip-by-index version did).
 * Output is GNU-style hunks (`@@ -a,b +c,d @@`) with 3 lines of context.
 * Colors are added by the caller — this function returns plain text.
 */
export function previewDiff(before: string, after: string, contextLines = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = lcsDiff(a, b);
  return formatUnifiedHunks(a, b, ops, contextLines);
}

type DiffOp =
  | { kind: "eq"; aIndex: number; bIndex: number }
  | { kind: "del"; aIndex: number }
  | { kind: "ins"; bIndex: number };

/**
 * Standard LCS table → diff op sequence. O(N·M) memory which is fine here:
 * proposed fixes touch a single test file (a few hundred lines at most).
 */
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0) as number[]);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", aIndex: i, bIndex: j });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: "del", aIndex: i });
      i++;
    } else {
      ops.push({ kind: "ins", bIndex: j });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", aIndex: i++ });
  while (j < m) ops.push({ kind: "ins", bIndex: j++ });
  return ops;
}

/**
 * Group changed ops into hunks (with `context` lines of surrounding equality
 * on each side), and emit GNU unified format. 1-based line numbers in the
 * hunk header match `diff -u` so users can map straight to the file.
 */
function formatUnifiedHunks(a: string[], b: string[], ops: DiffOp[], context: number): string {
  const out: string[] = [];
  let idx = 0;
  while (idx < ops.length) {
    while (idx < ops.length && ops[idx]!.kind === "eq") idx++;
    if (idx >= ops.length) break;
    let hunkStart = Math.max(0, idx - context);
    let hunkEnd = idx;
    while (hunkEnd < ops.length) {
      if (ops[hunkEnd]!.kind !== "eq") {
        hunkEnd++;
        continue;
      }
      let run = 0;
      while (hunkEnd + run < ops.length && ops[hunkEnd + run]!.kind === "eq") run++;
      if (run > context * 2 || hunkEnd + run === ops.length) {
        hunkEnd += Math.min(run, context);
        break;
      }
      hunkEnd += run;
    }
    const slice = ops.slice(hunkStart, hunkEnd);
    const aStart = firstAIndex(slice, a, hunkStart, ops);
    const bStart = firstBIndex(slice, b, hunkStart, ops);
    let aCount = 0;
    let bCount = 0;
    for (const op of slice) {
      if (op.kind === "eq" || op.kind === "del") aCount++;
      if (op.kind === "eq" || op.kind === "ins") bCount++;
    }
    out.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    for (const op of slice) {
      if (op.kind === "eq") out.push(` ${a[op.aIndex]}`);
      else if (op.kind === "del") out.push(`-${a[op.aIndex]}`);
      else out.push(`+${b[op.bIndex]}`);
    }
    idx = hunkEnd;
  }
  return out.join("\n");
}

function firstAIndex(slice: DiffOp[], a: string[], hunkStart: number, ops: DiffOp[]): number {
  for (const op of slice) {
    if (op.kind === "eq") return op.aIndex;
    if (op.kind === "del") return op.aIndex;
  }
  for (let k = hunkStart - 1; k >= 0; k--) {
    const op = ops[k]!;
    if (op.kind === "eq") return op.aIndex + 1;
    if (op.kind === "del") return op.aIndex + 1;
  }
  return a.length;
}

function firstBIndex(slice: DiffOp[], b: string[], hunkStart: number, ops: DiffOp[]): number {
  for (const op of slice) {
    if (op.kind === "eq") return op.bIndex;
    if (op.kind === "ins") return op.bIndex;
  }
  for (let k = hunkStart - 1; k >= 0; k--) {
    const op = ops[k]!;
    if (op.kind === "eq") return op.bIndex + 1;
    if (op.kind === "ins") return op.bIndex + 1;
  }
  return b.length;
}
