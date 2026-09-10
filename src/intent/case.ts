import { readdir, readFile } from "node:fs/promises";
import * as log from "../cli/logger.ts";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseTestSpec } from "../spec/parser.ts";
import { expandSpec } from "../spec/expand.ts";
import type { ExpandedActionStep, ExpandedStep } from "../spec/expand.ts";
import type { BlockSpec, TestSpec } from "../types.ts";
import { DEFAULT_SPEC_MODE, type SpecMode } from "../spec/yaml-schema.ts";
import { intentCase, specCase, type CaseRef } from "../store/index.ts";
import type { IntentSource } from "../config/project-config.ts";
import { parseMarkdownCase, type IntentCase } from "./markdown.ts";

/**
 * One test case, whichever kind of document states it.
 *
 * ccqa's own `spec.yaml` and a project's markdown test case describe the same
 * thing in different vocabularies, and everything downstream — the recorder,
 * the emitters, the evidence table — wants that thing, not the document. So
 * both are read into this shape once, at the edge, and nothing past this
 * module asks which kind it came from.
 *
 * The one place the two genuinely differ is expectations. A `spec.yaml` step
 * carries its own; a markdown case lists them for the case and leaves the
 * reading of which step delivers which to whoever runs it. That difference is
 * kept rather than smoothed over: `expectations` is what the recorder is asked
 * to place.
 */
export interface TestCase {
  /** Where this case's own files live, and the id everything cites it by. */
  ref: CaseRef;
  title: string;
  /**
   * Whether the case is recorded and compiled into a test, or driven through
   * the browser agent on every run. Both document kinds state it — `spec.yaml`
   * in a `mode:` key, a markdown case in whichever heading the project mapped
   * to `intent.fields.mode` — so nothing downstream asks which kind it read.
   */
  mode: SpecMode;
  /** What to do, in order, already expanded (blocks inlined for a spec). */
  steps: ExpandedStep[];
  /** What to undo afterwards; recorded after the steps, emitted into afterEach. */
  cleanup: ExpandedActionStep[];
  /** Expectations stated for the case as a whole, unattached to any step. */
  expectations: string[];
  /**
   * What the cleanup must make true once it has run. Decided inside the
   * cleanup, where the undo happens — a `spec.yaml` case states none.
   */
  cleanupExpectations: string[];
  /** Sections ccqa does not interpret, handed to the recorder as context. */
  context: Array<{ heading: string; body: string }>;
  /** Values a header or title tag may refer to, by the config's own names. */
  fields: Record<string, string | undefined>;
  source: SpecSource | MarkdownSource;
}

export interface SpecSource {
  kind: "spec";
  spec: TestSpec;
  /** The file verbatim — prompts want what was written, not a re-serialization. */
  yaml: string;
}

export interface MarkdownSource {
  kind: "markdown";
  /** Absolute path of the case file. */
  path: string;
  /** The file verbatim — a write-back edits this rather than re-reading it. */
  text: string;
  parsed: IntentCase;
}

/**
 * A case's mode, from the heading the project mapped to `intent.fields.mode`.
 *
 * Only `live` turns the browser agent on; everything else is recorded and
 * generated. An unrecognised body is warned about rather than accepted
 * silently — a project that wrote `manual` there meant something by it, and
 * reading that as "record and generate" without a word is how a case ends up
 * automated that nobody meant to automate.
 */
function resolveMode(raw: string | undefined, id: string): SpecMode {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "live") return "live";
  if (value !== "" && !DETERMINISTIC_SPELLINGS.has(value)) {
    log.warn(`${id}: mode "${raw!.trim()}" is not a mode ccqa knows; recording and generating it`);
  }
  return DEFAULT_SPEC_MODE;
}

/** Bodies that plainly mean "not live", so they pass without a warning. */
const DETERMINISTIC_SPELLINGS = new Set(["deterministic", "recorded", "generated", "auto", "automated"]);

/**
 * Step ids are the case's numbering, so evidence and diffs can cite them. The
 * one spelling: `step-comment.ts` rebuilds an id from a comment's number, and
 * a padding width that disagreed would empty the evidence table's every row.
 */
export function stepId(n: number): string {
  return `step-${String(n).padStart(2, "0")}`;
}

export function cleanupId(n: number): string {
  return `cleanup-${String(n).padStart(2, "0")}`;
}

/** A `TestCase` whose document is known to be markdown, so readers need no branch. */
export type MarkdownCase = TestCase & { source: MarkdownSource };

/** ccqa's own spec, expanded — the shape every target has always consumed. */
export function caseFromSpec(
  featureName: string,
  specName: string,
  yaml: string,
  blocks: Map<string, BlockSpec>,
  cwd?: string,
): TestCase {
  const spec = parseTestSpec(yaml);
  return {
    ref: specCase(featureName, specName, cwd),
    title: spec.title,
    mode: spec.mode ?? DEFAULT_SPEC_MODE,
    steps: expandSpec(spec, { blocks }),
    cleanup: [],
    expectations: [],
    cleanupExpectations: [],
    context: [],
    fields: { case: `${featureName}/${specName}`, title: spec.title },
    source: { kind: "spec", spec, yaml },
  };
}

/** A markdown test case, read through the project's field map. */
export function caseFromMarkdown(input: {
  id: string;
  path: string;
  source: string;
  intent: IntentSource;
  cwd?: string;
}): MarkdownCase {
  const parsed = parseMarkdownCase({ id: input.id, source: input.source, fields: input.intent.fields });
  return {
    ref: intentCase(input.id, input.cwd),
    title: parsed.title,
    mode: resolveMode(parsed.mode, input.id),
    steps: parsed.steps.map((step) => ({
      id: stepId(step.number),
      source: "case",
      instruction: step.text,
      // The case states its expectations as a list for the whole flow; placing
      // them is the recorder's reading, not the parser's.
      expected: "",
    })),
    cleanup: parsed.cleanup.map((step) => ({
      id: cleanupId(step.number),
      source: "cleanup",
      instruction: step.text,
      expected: "",
    })),
    expectations: parsed.expected,
    cleanupExpectations: parsed.cleanupExpected,
    context: parsed.other,
    fields: {
      case: input.id,
      title: parsed.title,
      ...(parsed.priority ? { priority: parsed.priority } : {}),
      ...(parsed.link.url ? { "link.url": parsed.link.url } : {}),
      ...(parsed.link.ref ? { "link.ref": parsed.link.ref } : {}),
    },
    source: { kind: "markdown", path: input.path, text: input.source, parsed },
  };
}

/**
 * The case a CLI argument names, for a target that reads an intent source.
 * Both forms work: the file as the user sees it in their editor
 * (`docs/testcase/todo/add_item.md`) and the id the rest of ccqa uses
 * (`todo/add_item`) — the same case, named the two ways people reach for.
 */
export async function loadMarkdownCase(
  argument: string,
  intent: IntentSource,
  cwd: string,
): Promise<MarkdownCase> {
  const rootAbs = resolve(cwd, intent.root);
  const id = caseIdFor(argument, intent, cwd);
  const path = resolve(rootAbs, `${id}.md`);
  const source = await readFile(path, "utf8").catch(() => {
    throw new Error(`No test case at ${relative(cwd, path)} (${intent.kind} source under ${intent.root})`);
  });
  return caseFromMarkdown({ id, path, source, intent, cwd });
}

/**
 * Every case the intent source holds, by id, sorted.
 *
 * A sweep enumerates cases the same way a person finds them — by looking in
 * the directory the project pointed at — because there is no manifest to read
 * and a case that exists only on disk still has to be audited.
 *
 * A `.md` that does not parse as a case is not one: the directory holds a
 * project's own documents, and a README or a template sitting beside the
 * cases must not be swept into a run or an audit. Naming such a file on the
 * command line still fails loudly — this only decides what a sweep picks up.
 */
export async function listMarkdownCases(intent: IntentSource, cwd: string): Promise<string[]> {
  const rootAbs = resolve(cwd, intent.root);
  const files: Array<{ id: string; abs: string }> = [];
  const walk = async (dirAbs: string): Promise<void> => {
    const entries = await readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dirAbs, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.name.endsWith(".md")) {
        files.push({ id: relative(rootAbs, abs).slice(0, -3).split(/[\\/]+/).join("/"), abs });
      }
    }
  };
  await walk(rootAbs);

  const cases = await Promise.all(
    files.map(async ({ id, abs }) => {
      const source = await readFile(abs, "utf8").catch(() => null);
      if (source === null) return null;
      try {
        parseMarkdownCase({ id, source, fields: intent.fields });
        return id;
      } catch {
        return null;
      }
    }),
  );
  return cases.filter((id): id is string => id !== null).sort();
}

/**
 * The case ids an invocation named, or every case when it named none.
 *
 * Both commands that sweep a project's own documents ask this, and they must
 * agree: what a `<case>` argument names has one answer, not one per command.
 */
export async function intentCaseIds(
  named: readonly string[],
  intent: IntentSource,
  cwd: string,
): Promise<string[]> {
  if (named.length === 0) return listMarkdownCases(intent, cwd);
  return [...new Set(named.map((argument) => caseIdFor(argument, intent, cwd)))];
}

/**
 * A path below the intent root, or an id already in that form. Only a `.md`
 * suffix is stripped — a case named `add.item` is a case, not an id with an
 * extension, and the two spellings this exists to make equivalent have to
 * agree about that.
 */
export function caseIdFor(argument: string, intent: IntentSource, cwd: string): string {
  const rootAbs = resolve(cwd, intent.root);
  const asPath = isAbsolute(argument) ? argument : resolve(cwd, argument);
  const below = relative(rootAbs, asPath);
  const looksLikePath = below !== "" && !below.startsWith("..") && !isAbsolute(below);
  const id = looksLikePath ? below : argument;
  const withoutExtension = id.endsWith(".md") ? id.slice(0, -3) : id;
  return withoutExtension.split(/[\\/]+/).join("/");
}
