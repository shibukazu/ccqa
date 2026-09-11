/**
 * A recorder reads an accessible name off a snapshot and writes it as the
 * attribute it guessed the name came from. The name can come from a `<label>`
 * or `aria-labelledby` instead, and the attribute's absence is not evidence
 * about the element. See docs/targets.md for the measurement.
 */
const NAMING_ATTR = /^\[\s*aria-label\s*=\s*(?:"([^"]*)"|'([^']*)')\s*\]$/;

/**
 * The name this selector may be after, or null.
 *
 * `aria-label` only. `[name='email']` and `[title='Close']` are attributes that
 * mean what they say, and a zero from one of those is evidence.
 */
export function nameFromAttributeSelector(selector: string): string | null {
  const m = NAMING_ATTR.exec(selector.trim());
  const name = m?.[1] ?? m?.[2];
  return name === undefined || name === "" ? null : name;
}

/**
 * The role of the first node in an accessibility snapshot whose name is
 * exactly `name`, or null.
 *
 * agent-browser prints one node per line as `<role> "<name>"`. Matched on the
 * whole name, so a tree holding both "Category" and "Category *" answers for
 * the one that was asked, and refused when two roles carry it.
 */
export function roleOfAccessibleName(snapshot: string, name: string): string | null {
  const roles = new Set<string>();
  for (const line of snapshot.split("\n")) {
    const m = /([A-Za-z]+)\s+"([^"]*)"/.exec(line);
    if (m && m[2] === name) roles.add(m[1]!);
  }
  // One role, or none. A nav `link "Save"` above the form's `button "Save"`
  // would otherwise turn an assertion about the button into a permanent green
  // check on the link — the guess `nameNotation` refuses to make.
  return roles.size === 1 ? [...roles][0]! : null;
}
