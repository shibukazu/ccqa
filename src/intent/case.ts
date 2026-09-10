import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parseTestSpec } from "../spec/parser.ts";
import { expandSpec } from "../spec/expand.ts";
import type { ExpandedActionStep, ExpandedStep } from "../spec/expand.ts";
import type { BlockSpec, TestSpec } from "../types.ts";
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
  /** What to do, in order, already expanded (blocks inlined for a spec). */
  steps: ExpandedStep[];
  /** What to undo afterwards; recorded after the steps, emitted into afterEach. */
  cleanup: ExpandedActionStep[];
  /** Expectations stated for the case as a whole, unattached to any step. */
  expectations: string[];
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

/** Step ids are the case's numbering, so evidence and diffs can cite them. */
function stepId(n: number): string {
  return `step-${String(n).padStart(2, "0")}`;
}

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
    steps: expandSpec(spec, { blocks }),
    cleanup: [],
    expectations: [],
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
}): TestCase {
  const parsed = parseMarkdownCase({ id: input.id, source: input.source, fields: input.intent.fields });
  return {
    ref: intentCase(input.id, input.cwd),
    title: parsed.title,
    steps: parsed.steps.map((step) => ({
      id: stepId(step.number),
      source: "case",
      instruction: step.text,
      // The case states its expectations as a list for the whole flow; placing
      // them is the recorder's reading, not the parser's.
      expected: "",
    })),
    cleanup: parsed.cleanup.map((step) => ({
      id: `cleanup-${String(step.number).padStart(2, "0")}`,
      source: "cleanup",
      instruction: step.text,
      expected: "",
    })),
    expectations: parsed.expected,
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
): Promise<TestCase> {
  const rootAbs = resolve(cwd, intent.root);
  const id = caseIdFor(argument, rootAbs, cwd);
  const path = resolve(rootAbs, `${id}.md`);
  const source = await readFile(path, "utf8").catch(() => {
    throw new Error(`No test case at ${relative(cwd, path)} (${intent.kind} source under ${intent.root})`);
  });
  return caseFromMarkdown({ id, path, source, intent, cwd });
}

/**
 * A path below the intent root, or an id already in that form. Only a `.md`
 * suffix is stripped — a case named `add.item` is a case, not an id with an
 * extension, and the two spellings this exists to make equivalent have to
 * agree about that.
 */
function caseIdFor(argument: string, rootAbs: string, cwd: string): string {
  const asPath = isAbsolute(argument) ? argument : resolve(cwd, argument);
  const below = relative(rootAbs, asPath);
  const looksLikePath = below !== "" && !below.startsWith("..") && !isAbsolute(below);
  const id = looksLikePath ? below : argument;
  const withoutExtension = id.endsWith(".md") ? id.slice(0, -3) : id;
  return withoutExtension.split(/[\\/]+/).join("/");
}
