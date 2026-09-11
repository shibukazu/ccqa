import type { TitleTags } from "../../config/project-config.ts";

/**
 * The two things a project stamps onto every generated test: a comment saying
 * where the case came from, and a tag on the test's name saying how much it
 * matters.
 *
 * Both are mechanical on purpose. They are conventions a reviewer greps and a
 * pipeline filters on, and a model that decides them per case gets one wrong
 * eventually — in a way that looks like an ordinary test and is found months
 * later. What varies between projects is the wording, which is why both are
 * templates in the project's own config rather than anything ccqa knows.
 */

/** Values a header template may refer to, by the names the config uses. */
export type HeaderValues = Record<string, string | undefined>;

const PLACEHOLDER = /\{([a-zA-Z][\w.]*)\}/g;

/**
 * Fill a header template. A line is dropped unless every placeholder on it
 * has a value.
 *
 * All-or-nothing, because a partly-filled line is worse than a missing one:
 * a case with no sheet row rendered `// sheet: <url>&range=:`, a reference
 * that looks like one and resolves to nothing. What a header is for is being
 * followed back to the case, and a line nobody can follow fails at that more
 * quietly than a line that is not there.
 */
export function renderHeader(template: string, values: HeaderValues): string {
  const kept: string[] = [];
  for (const line of template.split("\n")) {
    const refs = [...line.matchAll(PLACEHOLDER)];
    if (refs.some((m) => !values[m[1]!])) continue;
    kept.push(line.replaceAll(PLACEHOLDER, (_m, key: string) => values[key] ?? ""));
  }
  return kept.join("\n").trim();
}

/**
 * The tag a case's field earns, or "" when the map does not name its value —
 * an unmapped value is a case the project has not classified, not a case to
 * label with whatever it happened to say.
 */
export function renderTitleTag(tags: TitleTags | undefined, values: HeaderValues): string {
  if (!tags) return "";
  const raw = values[tags.field];
  const mapped = raw === undefined ? undefined : tags.map[raw];
  return mapped === undefined ? "" : ` ${tags.format.replaceAll("{value}", mapped)}`;
}
