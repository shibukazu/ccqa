/**
 * What the audit says was renamed, and which of a case's files still say it.
 *
 * A rename is the one finding a machine can act on without reading prose, but
 * only once it is known *where* the old string survives: the case's document
 * decides whether an edit is needed, and the saved recording decides whether
 * recompiling that document is enough (ADR-0035). Both answers are string
 * comparisons against text ccqa already holds, which is what keeps them out of
 * the model's hands.
 */

import { z } from "zod";
import type { Locator, RecordedAction } from "../ir/types.ts";

/**
 * A string the test case still uses, and what the product renders in its place.
 *
 * Answered by the audit, never parsed back out of its prose: a quoted run is a
 * guess about one project's punctuation (ADR-0035).
 */
export const RenameSchema = z.object({
  /** As the test case writes it, verbatim: a repair looks it up character for character. */
  from: z.string(),
  /** As the cited source renders it, verbatim. */
  to: z.string(),
});
export type Rename = z.infer<typeof RenameSchema>;

/** A rename the sweep has checked against the case's document. */
export interface AuditedRename extends Rename {
  /** The document holds `from`, so rewriting it is a literal edit. */
  inDocument: boolean;
}

/**
 * The audit's renames, sanitized and checked against the document.
 *
 * A blank `from` matches everywhere and an identity pair edits nothing, so
 * neither is an instruction. Blank is tested after trimming and kept
 * untrimmed: a trimmed `from` is a string ccqa never checked the document for.
 * Two pairs naming the same `from` differently are the audit contradicting
 * itself, and both go — picking a winner would invent an answer nobody gave.
 */
export function auditedRenames(
  document: string,
  renames: readonly Rename[],
): AuditedRename[] {
  const byFrom = new Map<string, Rename | null>();
  for (const r of renames) {
    if (r.from.trim() === "" || r.to.trim() === "" || r.from === r.to) continue;
    const kept = byFrom.get(r.from);
    if (kept === undefined) byFrom.set(r.from, r);
    else if (kept !== null && kept.to !== r.to) byFrom.set(r.from, null);
  }
  return [...byFrom.values()]
    .filter((r): r is Rename => r !== null)
    .map((r) => ({ ...r, inDocument: document.includes(r.from) }));
}

/**
 * Whether the saved recording still names a string the audit says was renamed.
 *
 * It decides between the two machine repairs: a recording that names the old
 * string compiles it back in, so the case has to be recorded again rather than
 * regenerated. Missing one is not dangerous — the case routes to `regenerate`,
 * whose replay gate then refuses the dead recording — but it costs a browser
 * run to find that out.
 *
 * Walked value by value rather than over a serialization: `JSON.stringify`
 * escapes quotes and backslashes, so a `from` holding one would silently miss.
 */
export function recordingNamesRenamed(
  recording: { actions: readonly RecordedAction[]; cleanup?: readonly RecordedAction[] },
  renames: readonly Rename[],
): boolean {
  if (renames.length === 0) return false;
  const actions = [...recording.actions, ...(recording.cleanup ?? [])];
  return actions.some((action) =>
    actionStrings(action).some((text) => renames.some((r) => text.includes(r.from))),
  );
}

/**
 * The strings a recorded action takes from the product: what it typed or
 * asserted, and how it addressed the element. What the recorder wrote about an
 * action — its observation, its step id, why it replayed badly — is ccqa's own
 * prose and would match on words the product never rendered.
 */
function actionStrings(action: RecordedAction): string[] {
  return [
    action.value,
    action.label,
    ...locatorStrings(action.locator),
    ...locatorStrings(action.target),
  ].filter((s): s is string => s !== undefined && s !== "");
}

/**
 * A role locator is addressed by its accessible name; its `value` is the ARIA
 * role, which is that vocabulary rather than anything the product wrote.
 */
function locatorStrings(locator: Locator | undefined): Array<string | undefined> {
  if (locator === undefined) return [];
  return locator.by === "role" ? [locator.name] : [locator.value];
}
