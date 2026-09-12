import { isJudgeBody, type AnyStepBody, type ExpandedStep } from "../spec/expand.ts";
import { isIncludeStep, type Step } from "../spec/yaml-schema.ts";
import { iterEnvRefNames } from "./env-vars.ts";
import { loadedEnvNames } from "./profile-env.ts";
import { actionLiteralFields } from "./literal-scrub.ts";
import type { RecordedAction } from "../ir/types.ts";

export interface SpecEnvScrub {
  /** `[envValue, "${VAR}"]` pairs, sorted long-to-short for safe replacement. */
  map: Array<[string, string]>;
  /** Refs unset (or empty) in both `overrides` and `process.env` at trace start. */
  unresolved: string[];
}

/**
 * Build a list of `[envValue, "${VAR}"]` pairs for every `${VAR}` reference
 * mentioned in the spec OR in any of its expanded (block-inlined) steps.
 * Used at trace time to scrub recorded Claude-text outputs so a value the
 * spec author intentionally threaded through `process.env` is preserved as
 * `${VAR}` in `ir.json` rather than baked in as the concrete
 * trace-time value.
 *
 * Why we walk `spec.steps` AND `expanded`:
 *   - `spec.steps` carries the spec's own `instruction` / `expected` + each
 *     include's raw `params` (which may themselves be `${ENV}` refs).
 *   - `expanded` carries the inlined block-internal steps, whose
 *     `instruction` / `expected` may *also* contain `${ENV}` refs that
 *     don't go through include params.
 *
 * Each ref resolves against `overrides` first, then `process.env` —
 * `overrides` carries values the invoker injects into the child process,
 * which beat the parent env there. Only refs that resolve non-empty land in
 * the map — scrubbing against an empty string would corrupt unrelated empty
 * strings in the action stream; the rest are returned via `unresolved` so
 * the caller can warn the user.
 *
 * Longer values sort first so a `${SHORT}` whose value is a substring of a
 * `${LONG}` value doesn't clobber the longer one.
 *
 * `title` is deliberately NOT scanned — it never reaches the recorded action
 * stream.
 *
 * The variables ccqa itself put into the environment (`loadedEnvNames`) are
 * mapped too, under the extra bar in `loadedPairs`: a case written as prose
 * never mentions the variable its credentials come from, and without this its
 * concrete values are what the recording keeps. Read here rather than passed
 * in, because a caller that forgot the argument would silently record them.
 */
export function buildSpecEnvScrub(
  steps: readonly Step[],
  expanded: readonly ExpandedStep[],
  overrides: Record<string, string> = {},
): SpecEnvScrub {
  const refNames = new Set<string>();
  for (const step of steps) {
    if (isIncludeStep(step)) {
      for (const v of Object.values(step.params ?? {})) collect(v, refNames);
    } else {
      collectStepRefs(step, refNames);
    }
  }
  for (const step of expanded) collectStepRefs(step, refNames);

  const map: Array<[string, string]> = [];
  const unresolved: string[] = [];
  for (const name of refNames) {
    // `overrides` carries values the invoker injects into the child process
    // (e.g. CCQA_RUN_ID), which beat the parent env there — so they beat it
    // here too, or the map would name a value the child never sees.
    const value = overrides[name] ?? process.env[name];
    if (typeof value === "string" && value.length > 0) {
      map.push([value, "${" + name + "}"]);
    } else {
      unresolved.push(name);
    }
  }
  for (const [value, placeholder] of loadedPairs(refNames, overrides)) {
    map.push([value, placeholder]);
  }
  map.sort((a, b) => b[0].length - a[0].length);
  return { map, unresolved };
}

/**
 * Shorter than this, a value ccqa loaded wholesale is more likely to collide
 * with ordinary page text than to be worth symbolising: a port, a stage name,
 * a flag. A case that names such a variable in its own text still gets the
 * exact treatment above — this bar applies only to the variables nobody asked
 * for by name.
 */
const MIN_LOADED_VALUE_LENGTH = 8;

/**
 * `[value, "${VAR}"]` for every variable ccqa itself loaded, so a credential
 * the case never mentions is still symbolised.
 *
 * This is what a case written as prose needs. It says "sign in", the sign-in
 * values come from the project's own env file, and nothing in the case's text
 * names them — so the ref walk above finds nothing and the browser's concrete
 * values would land in `ir.json`.
 */
function loadedPairs(
  alreadyMapped: ReadonlySet<string>,
  overrides: Record<string, string>,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const name of loadedEnvNames()) {
    if (alreadyMapped.has(name)) continue;
    const value = overrides[name] ?? process.env[name];
    if (typeof value !== "string" || value.length < MIN_LOADED_VALUE_LENGTH) continue;
    if (COMMON_PROSE_VALUES.has(value.toLowerCase())) continue;
    pairs.push([value, "${" + name + "}"]);
  }
  return pairs;
}

function collect(value: string, into: Set<string>): void {
  for (const name of iterEnvRefNames(value)) into.add(name);
}

function collectStepRefs(step: AnyStepBody, into: Set<string>): void {
  if (isJudgeBody(step)) {
    collect(step.judgeByLlm, into);
    if (step.from !== undefined) collect(step.from, into);
    return;
  }
  collect(step.instruction, into);
  collect(step.expected, into);
}

/** Shorter than this, a value is no secret and matches inside ordinary words. */
const MIN_PROSE_SCRUB_LENGTH = 4;

/** Long enough to clear the length bar, still ordinary prose / JSON. */
const COMMON_PROSE_VALUES = new Set(["true", "false", "null", "none", "undefined"]);

/**
 * Scrub map for model output, built like {@link buildSpecEnvScrub} but
 * without the values that read as ordinary text (`"1"`, `"true"`): prose
 * runs to paragraphs, where replacing every occurrence of such a value
 * costs more meaning than it protects. Record's own scrub keeps them for
 * its single command lines; the live path reuses this one map for its Bash
 * command log too, trading that short-value coverage for not building a
 * second map.
 */
export function buildProseEnvScrubMap(
  steps: readonly Step[],
  expanded: readonly ExpandedStep[],
  overrides: Record<string, string> = {},
): Array<[string, string]> {
  return buildSpecEnvScrub(steps, expanded, overrides).map.filter(
    ([value]) =>
      value.length >= MIN_PROSE_SCRUB_LENGTH && !COMMON_PROSE_VALUES.has(value.toLowerCase()),
  );
}

/**
 * Replace every occurrence of an env value with its `${VAR}` placeholder in
 * `text`. **Caller invariant**: the map must be sorted longest-value-first
 * so a shorter value doesn't shadow a longer one that contains it as a
 * substring. `buildSpecEnvScrub` upholds this; hand-built maps should too.
 */
export function scrubEnvValues(text: string, scrubMap: Array<[string, string]>): string {
  if (scrubMap.length === 0) return text;
  let out = text;
  for (const [value, placeholder] of scrubMap) {
    if (out.includes(value)) out = out.replaceAll(value, placeholder);
  }
  return out;
}

/**
 * Variables whose resolved value appears verbatim somewhere in `texts`.
 *
 * The check that reads a recording back. Scrubbing happens while a route is
 * being recorded, so a route recorded before the project pointed ccqa at its
 * env files — or with a variable unset — keeps the concrete value, and nothing
 * later would notice. `ccqa generate` asks this and says so; the answer is
 * variable names, never values.
 */
export function findLoadedValueLiterals(texts: Iterable<string | undefined>): string[] {
  const candidates = loadedPairs(new Set(), {});
  if (candidates.length === 0) return [];
  const hit = new Set<string>();
  for (const text of texts) {
    if (typeof text !== "string" || text.length === 0) continue;
    for (const [value, placeholder] of candidates) {
      if (text.includes(value)) hit.add(placeholder.slice(2, -1));
    }
  }
  return [...hit];
}

/** Every string in an action that a value could have been baked into. */
export function actionTexts(action: RecordedAction): string[] {
  return actionLiteralFields(action).map(([, text]) => text);
}
