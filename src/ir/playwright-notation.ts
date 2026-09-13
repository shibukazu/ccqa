import type { Locator } from "./types.ts";

/**
 * A selector string read back into the locator it addresses.
 *
 * `agent-browser get count` takes plain CSS and answers **0** for anything
 * else rather than failing, and a zero reads as an element that is not there.
 * See docs/targets.md for the measurement.
 */

/** Playwright notation this cannot convert. Not CSS, so not countable either. */
export const OPAQUE = "opaque";

const TEXT = /^text=(.*)$/s;
const ROLE = /^role=([A-Za-z]+)\[name=(?:"([^"]*)"|'([^']*)')\]$/;
/**
 * Anchored on purpose. `.toolbar button:has-text("Save")` pins one button in
 * one toolbar; reading the text out of it and dropping the rest would turn it
 * into an assertion that passes anywhere the word appears.
 */
const HAS_TEXT = /^:has-text\((?:"([^"]*)"|'([^']*)')\)$/;
/**
 * `:has-text` and friends, never CSS's own `:has()` — that one is real CSS the
 * engine answers correctly, and calling it unconvertible would skip validating
 * an assert instead of checking it.
 */
const UNCONVERTIBLE = /^(?:internal:|role=)|:(?:has-text|text|text-is|text-matches|visible)\(|:visible\b/;

/**
 * The locator `value` really is, `OPAQUE` when it is notation this cannot
 * convert, or null when it is plain CSS and `get count` can answer it.
 */
export function parseNotation(value: string): Locator | typeof OPAQUE | null {
  const text = TEXT.exec(value);
  if (text) return named({ by: "text", value: unquote(text[1] ?? "") });

  const role = ROLE.exec(value);
  if (role) return named({ by: "role", value: role[1]!, name: role[2] ?? role[3] ?? "", exact: true });

  const hasText = HAS_TEXT.exec(value);
  if (hasText) return named({ by: "text", value: hasText[1] ?? hasText[2] ?? "" });

  return UNCONVERTIBLE.test(value) ? OPAQUE : null;
}

/** An empty string names nothing, and `wait --text ""` matches trivially. */
function named(locator: Locator): Locator | typeof OPAQUE {
  const value = locator.by === "role" ? (locator.name ?? "") : locator.value;
  return value === "" ? OPAQUE : locator;
}

/** Only a matching pair: `text=say "hi"` keeps both of its own quotes. */
function unquote(s: string): string {
  const first = s[0];
  return (first === '"' || first === "'") && s.length > 1 && s.at(-1) === first ? s.slice(1, -1) : s;
}
