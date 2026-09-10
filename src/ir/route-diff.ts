import type { Locator, RecordedAction } from "./types.ts";
import type { Recording } from "../store/index.ts";

/**
 * What changed between two recordings of the same spec.
 *
 * Re-recording replaces the route wholesale, and the interesting question
 * afterwards is never "what does the new route do" but "what moved". A locator
 * that changed shape says the screen was rebuilt; a check whose wording changed
 * says the copy moved; a step that gained operations says the flow grew. That
 * is the evidence a reviewer needs, and reading it out of two JSON files by eye
 * is exactly the work nobody does.
 *
 * The diff is per spec step, because a step is the unit the spec author wrote
 * and the unit a reviewer reasons in. Actions carry their `stepId` from the
 * trace, so the grouping is recorded, not guessed.
 */

const NO_STEP = "(no step)";

export type RouteChange =
  | { kind: "added"; step: string; after: string }
  | { kind: "removed"; step: string; before: string }
  | { kind: "changed"; step: string; before: string; after: string };

export interface RouteDiff {
  changes: RouteChange[];
  /** Steps whose actions are identical in both recordings, in order. */
  unchangedSteps: string[];
}

/** One action as a reviewer reads it: what it did, to what, with which value. */
export function describeAction(action: RecordedAction): string {
  const parts = [action.assert ? `assert ${action.assert}` : action.action];
  if (action.locator) parts.push(renderLocator(action.locator));
  if (action.index !== undefined) parts.push(`[${action.index}]`);
  if (action.value !== undefined && action.value !== "") parts.push(JSON.stringify(action.value));
  if (action.target) parts.push(`→ ${renderLocator(action.target)}`);
  if (action.files?.length) parts.push(action.files.join(", "));
  return parts.join(" ");
}

/**
 * The same, prefixed by the step it belongs to. What a warning about one
 * action says, so a reader can find it in the case rather than counting
 * positions in a list.
 */
export function describeStepAction(action: RecordedAction): string {
  return `${action.stepId ? `${action.stepId} ` : ""}${describeAction(action)}`;
}

/**
 * A locator in full, unlike `describeLocator`'s log-line summary: two locators
 * that differ must render differently, or the diff reports a re-addressed
 * element as unchanged — the very thing it exists to show.
 */
function renderLocator(locator: Locator): string {
  if (locator.by === "css") return locator.value;
  const exact = locator.exact ? " exact" : "";
  // A role is an ARIA name with no whitespace; quoting it would only add noise.
  if (locator.by === "role") {
    const name = locator.name === undefined ? "" : `[name=${JSON.stringify(locator.name)}]`;
    return `role=${locator.value}${name}${exact}`;
  }
  return `${locator.by}=${JSON.stringify(locator.value)}${exact}`;
}

/**
 * Identity of an action across recordings: what it did and to which named
 * thing. Deliberately blind to the locator and the exact value, so a button
 * addressed a new way still pairs with its old self and reads as "changed"
 * rather than as one removal plus one addition.
 */
function identity(action: RecordedAction): string {
  return [action.action, action.assert ?? "", action.label ?? action.locator?.value ?? ""].join("|");
}

export function diffRoutes(before: RecordedAction[], after: RecordedAction[]): RouteDiff {
  const steps = orderedSteps(before, after);
  const changes: RouteChange[] = [];
  const unchangedSteps: string[] = [];
  for (const step of steps) {
    const stepChanges = diffStep(
      step,
      before.filter((a) => (a.stepId ?? NO_STEP) === step),
      after.filter((a) => (a.stepId ?? NO_STEP) === step),
    );
    if (stepChanges.length === 0) unchangedSteps.push(step);
    else changes.push(...stepChanges);
  }
  return { changes, unchangedSteps };
}

/** Every step id either recording mentions, in the new recording's order first. */
function orderedSteps(before: RecordedAction[], after: RecordedAction[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const action of [...after, ...before]) {
    const step = action.stepId ?? NO_STEP;
    if (seen.has(step)) continue;
    seen.add(step);
    out.push(step);
  }
  return out;
}

/**
 * Align one step's actions by identity (longest common subsequence), then
 * report the leftovers. An aligned pair whose rendered form differs is the
 * interesting case: same operation, new locator or new wording.
 */
function diffStep(
  step: string,
  before: RecordedAction[],
  after: RecordedAction[],
): RouteChange[] {
  const changes: RouteChange[] = [];
  for (const entry of alignByIdentity(before, after)) {
    if (entry.before && entry.after) {
      const b = describeAction(entry.before);
      const a = describeAction(entry.after);
      if (b !== a) changes.push({ kind: "changed", step, before: b, after: a });
    } else if (entry.after) {
      changes.push({ kind: "added", step, after: describeAction(entry.after) });
    } else if (entry.before) {
      changes.push({ kind: "removed", step, before: describeAction(entry.before) });
    }
  }
  return changes;
}

interface Alignment {
  before?: RecordedAction;
  after?: RecordedAction;
}

function alignByIdentity(before: RecordedAction[], after: RecordedAction[]): Alignment[] {
  // Classic LCS table over identities. Step action counts are small (tens), so
  // the quadratic table is cheaper than any smarter alignment.
  const lengths: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i]![j] =
        identity(before[i]!) === identity(after[j]!)
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const out: Alignment[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (identity(before[i]!) === identity(after[j]!)) {
      out.push({ before: before[i], after: after[j] });
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      out.push({ before: before[i++] });
    } else {
      out.push({ after: after[j++] });
    }
  }
  while (i < before.length) out.push({ before: before[i++] });
  while (j < after.length) out.push({ after: after[j++] });
  return out;
}

export interface RouteDiffReport {
  specKey: string;
  before: Recording;
  after: Recording;
  /** Spec step titles by step id, when the caller has them. */
  stepTitles?: Map<string, string>;
}

/** The diff as markdown — what `ccqa record` saves beside the spec. */
export function renderRouteDiff(diff: RouteDiff, report: RouteDiffReport): string {
  const { changes, unchangedSteps } = diff;
  const lines = [`# Route diff — ${report.specKey}`, ""];
  lines.push(
    `Recorded ${report.before.recordedAt ?? "(unknown)"} → ${report.after.recordedAt ?? "(unknown)"}.`,
    "",
  );
  if (report.before.origin !== report.after.origin) {
    lines.push(
      `Origin: \`${report.before.origin ?? "(none)"}\` → \`${report.after.origin ?? "(none)"}\``,
      "",
    );
  }
  if (changes.length === 0) {
    lines.push("The route is unchanged: same operations, locators and checks.", "");
    return lines.join("\n");
  }

  for (const step of groupByStep(changes)) {
    const title = report.stepTitles?.get(step.step);
    lines.push(`## ${step.step}${title ? ` — ${title}` : ""}`, "");
    for (const change of step.changes) {
      lines.push(
        change.kind === "changed"
          ? `- changed: \`${change.before}\` → \`${change.after}\``
          : change.kind === "added"
            ? `- added: \`${change.after}\``
            : `- removed: \`${change.before}\``,
      );
    }
    lines.push("");
  }
  if (unchangedSteps.length > 0) {
    lines.push(`Unchanged: ${unchangedSteps.join(", ")}`, "");
  }
  return lines.join("\n");
}

function groupByStep(changes: RouteChange[]): Array<{ step: string; changes: RouteChange[] }> {
  const grouped: Array<{ step: string; changes: RouteChange[] }> = [];
  for (const change of changes) {
    const last = grouped.at(-1);
    if (last && last.step === change.step) last.changes.push(change);
    else grouped.push({ step: change.step, changes: [change] });
  }
  return grouped;
}
