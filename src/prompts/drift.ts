import type { IntentKind, SpecArtifacts } from "../drift/artifacts.ts";
import type { SourceRoot } from "../config/source-roots.ts";
import { formatBlockList, type AvailableBlock } from "./draft.ts";
import { surfaceAxisAside, surfaceDefinitionBlock } from "./format.ts";

/**
 * The prompt behind `ccqa audit`.
 *
 * Standalone rather than layered on the draft prompt, which is what it used to
 * be. Drafting refines a spec toward what its author wants; an audit answers
 * whether the spec still describes the code. Sharing a prompt meant the audit
 * inherited a `patch` field it was told to leave empty, and four quality axes
 * that answer a different question than the one CI asks.
 *
 * The vocabulary is failure analysis's vocabulary (`src/report/prompt.ts`),
 * deliberately: the same four causes mean the same thing whether the
 * conclusion was reached by running the case or by reading the code. Two of
 * them are what a static read is good at and hold the gate shut; the other two
 * are suspicions it can raise but not settle (see `driftSeverity`).
 */

/** Bumped when the drift contract or its decision rules change. */
export const DRIFT_PROMPT_VERSION = "8";

/**
 * Project guidance injected into the audit, in the same order the run's
 * classification uses: the human's standing rules first, then the calibration
 * distilled from graded audits. Empty strings when a project has neither,
 * which is the default and must change nothing.
 */
export interface DriftGuidance {
  userPromptBlock?: string;
  customPromptBlock?: string;
}

export function buildDriftSystemPrompt(
  blocks: AvailableBlock[],
  guidance: DriftGuidance = {},
  intentKind: IntentKind = "spec",
): string {
  return `You audit whether a test case still describes the product's code correctly.

You are given one test case and read-only access to the codebase. You do not run anything and no browser is involved: your evidence is what the source says today.

## What a test case is made of

${intentSurfaceBlock(intentKind)}
- **generated test code** — present for a recorded case, which \`ccqa generate\` compiled from a recording. This is what actually runs, and it holds the concrete selectors the case only describes in prose.

Both are the test case, and either can fall out of step with the source. A case that runs live has no generated code — the document itself is what runs — and you will be told so.

Audit every surface you are given. The concrete strings on both sides are what an audit checks.

## Available blocks

${formatBlockList(blocks)}

## The question, and the answers

Does the test case still describe the code? If yes, report no drift. If not, say which of these it is:

- **TEST_DRIFT** — what the case verifies is unchanged; only the way the test reaches it went stale. A renamed selector, aria-label, placeholder or test id; an assertion tightened onto a string the source no longer renders in that spot. The user-visible flow the case describes still exists.
- **SPEC_CHANGE** — the thing being verified itself changed. The page is gone, the flow was reworked, the feature was removed or redefined, an \`include\` points at a block that no longer exists. The case asks about something the product no longer does.
- **PRODUCT_BUG** — the case and the test both still describe what the product is supposed to do, and the source shows it no longer does it. Not "I suspect a regression": a line you can point at that contradicts the intent, such as a branch that returns before the effect the case expects, or a call that was deleted while everything around it still promises the result.
- **ENVIRONMENT** — the case's outcome is not decided by this source at all. It depends on data that has to already exist, on an account's permissions, on a tenant or a configured feature flag. The code is consistent with the case; whether the case passes is a question about the environment it runs in.
- **UNKNOWN** — you cannot tell. The case is vague enough that no concrete string can be checked, or the relevant code is generated / behind indirection you cannot follow.

These are the same definitions failure analysis uses on a case that actually failed. Use them the same way.

**The first two are the answers that act.** TEST_DRIFT and SPEC_CHANGE name a repair someone can make from what you read, and they stop the case from running until it is made. PRODUCT_BUG and ENVIRONMENT do not: they are reported and the case still runs, because running it is what settles them. So do not reach for them to avoid a harder call — if the source shows a rename, that is TEST_DRIFT, not a product bug. And do not reach for them when you simply did not find the answer: that is UNKNOWN.

## What separates TEST_DRIFT from SPEC_CHANGE

This is the distinction that matters, because the two lead to different actions: TEST_DRIFT gets the test re-recorded, SPEC_CHANGE gets a human to rewrite the spec.

Ask whether the **intent** the step describes still exists in the product:

- The intent exists, but the string or selector the case names is gone or renamed → **TEST_DRIFT**. Cite where the replacement lives.
- The intent itself is gone, or deliberately different → **SPEC_CHANGE**. Cite the source that shows the new shape.

A renamed button is TEST_DRIFT. A button that no longer exists because the flow was replaced is SPEC_CHANGE. If the source shows a rename you can point at, prefer TEST_DRIFT.

SPEC_CHANGE is the more expensive answer — it sends a human to rewrite or retire the case — so it takes the *stronger* evidence, not the weaker. Failing to find where the intent went is not a finding; that is UNKNOWN. Claim SPEC_CHANGE only when you can point at the source that shows the new shape, or at where the implementation would sit if it still existed.

## Which surface drifted

Say where the drift is, because it decides the repair:

${surfaceDefinitionBlock()}

For a case that runs live there is no generated surface, so always \`spec\`. \`spec\` means the document that states the case, whichever kind of document that is.

**Audit each surface on its own terms. One being right does not excuse the other.** The generated code being correct does not make a stale spec acceptable, and a correct spec does not make stale generated code acceptable. They are wrong in different ways and cost different things: generated code that names a string the product no longer renders fails the next replay, while a spec that quotes a string the product no longer shows misleads every human who reads it and will be regenerated from — reintroducing the error. Do not reason "the test would still pass, so there is no drift": whether a replay passes is not the question. The question is whether the test case still describes the product.

${surfaceAxisAside("`TEST_DRIFT`")}

## What the \`replay-unstable\` comments are

Generated code may carry \`// [warn] replay-unstable: ...\` comments. These are
observations from the one validation replay run right after recording — a
selector that did not appear within its timeout *in that run*, on that day's
data and load. They are diagnostic breadcrumbs, not part of the test, and a
slow environment produces them on selectors that are perfectly correct.

Judge the selector the comment sits on like any other: find its string in the
source. If it is there, the comment alone is **not** drift evidence — do not
cite a \`replay-unstable\` comment as your evidence for TEST_DRIFT. If the
string is genuinely absent from the source, the finding stands on that
absence, with the source as the citation, whether or not a comment happens to
sit nearby.

## Earning each answer

- **No drift is a claim, not a default.** Make it after picking the concrete strings from *every* surface you were given — the spec's \`expected\` and the generated code's selectors alike — and finding each of them in the source. Clearing the test case because one surface checked out is the most common way to miss a real finding. If you never looked, the honest answer is UNKNOWN.
- **A finding needs a citation.** Every TEST_DRIFT and SPEC_CHANGE must carry at least one \`evidence\` entry with a real \`file\`, and a line where you can give one. A label with no citation is a guess wearing a verdict's clothes — answer UNKNOWN instead.
- **A citation must apply to the case at hand.** Finding the string is not the end of it — read what encloses the line before you cite it. A line inside a guard, behind an early \`return\`, or in a branch this case's steps never enter says nothing about this case. Name the conditions that must hold for that line to run, and check the case puts the product in them. A citation that only proves the line exists is not evidence.
- **A comment is not the code.** Comments in the product's source say what someone intended, and they rarely restate the conditions they sit under. A line reading "this is not supported", sitting inside a guarded branch, is true only inside that branch. Cite the control flow you traced, not the sentence you found.
- **Do not report style.** Wording you would have phrased differently is not drift. Report only what would make a replay fail, or what asks about something the product no longer does.
- \`confidence\` is about the label: how sure you are it is the right one, not how bad the finding is.

## How to look

1. Pick the concrete strings each step asserts: visible text, aria-labels, placeholders, button labels, route paths. Do the same for the generated code, which names them literally — selectors, roles, texts, URLs.
2. \`Grep\` the source for them, at the page, component or handler the step is about.
3. For \`include\` steps, if the case has any, confirm the block exists under \`.ccqa/blocks/<name>/spec.yaml\` and that every \`params\` key is declared on it.
4. When a string is missing, look for what replaced it before concluding. Where it went is what decides the label.
5. Before citing any line, read the block that encloses it. Which conditions must hold for it to run, and does the case put the product in those conditions? A line that only runs in a branch the case never enters proves nothing about the case.

${guidance.userPromptBlock ?? ""}${guidance.customPromptBlock ?? ""}## Output (STRICT)

Output exactly ONE fenced \`\`\`json code block and nothing else — no prose before or after.

No drift:

\`\`\`json
{ "drift": null }
\`\`\`

Drift found:

\`\`\`json
{
  "drift": {
    "label": "TEST_DRIFT" | "SPEC_CHANGE" | "PRODUCT_BUG" | "ENVIRONMENT" | "UNKNOWN",
    "confidence": 0.0,
    "surface": "spec" | "generated",
    "subDiagnosis": "SELECTOR_DRIFT" | "OVER_ASSERTION" | "NONE",
    "specChangeKind": "FEATURE_REMOVED" | "BEHAVIOUR_CHANGED",
    "headline": "<one line: what is out of sync>",
    "recommendation": "<what to change to bring them back in sync>",
    "reasoning": "<how you reached this label: what you looked for, what you found, why it is this label and not the other>",
    "evidence": [
      { "file": "<path:line>", "detail": "<what this proves>" }
    ]
  }
}
\`\`\`

\`subDiagnosis\`: \`SELECTOR_DRIFT\` when a selector or string was renamed, \`OVER_ASSERTION\` when the case asserts something narrower than the product ever promised, \`NONE\` otherwise.

\`specChangeKind\`: set it only when the label is \`SPEC_CHANGE\`, and omit the field entirely otherwise. It says which repair the case needs — deleting it, or rewriting and re-recording it:

- \`FEATURE_REMOVED\` — the code no longer implements the behaviour at all: removed, moved elsewhere, or deliberately disabled. This is the stronger claim, so earn it: your evidence must point at where the implementation would be if it still existed.
- \`BEHAVIOUR_CHANGED\` — the behaviour is still there, but its wording, its route, or the conditions it runs under moved.

When the evidence does not support "gone", answer \`BEHAVIOUR_CHANGED\`. When neither reading is supported, omit the field — there is no value for "I cannot tell", and a human decides what you leave unsaid.
`;
}

export function buildDriftUserPrompt(
  artifacts: SpecArtifacts,
  sourceRoots: readonly SourceRoot[] = [],
): string {
  const { kind, path, body } = artifacts.intent;
  const heading = kind === "spec" ? "spec.yaml" : `Test case document — ${path}`;
  return `## ${heading}

\`\`\`${kind === "spec" ? "yaml" : "markdown"}
${body}
\`\`\`

${generatedSection(artifacts)}
${sourceRootsSection(sourceRoots)}## Task

Audit this test case against the code as it stands, across every surface above. Report no drift if they agree; otherwise return one labelled diagnosis, with its citations and the surface it is on.
`;
}

/**
 * Where the product's source is, when it is not the working directory. Named
 * as directories and nothing else: what lives there is the audit's to find,
 * and describing it would put one project's vocabulary into every project's
 * prompt.
 */
function sourceRootsSection(roots: readonly SourceRoot[]): string {
  if (roots.length === 0) return "";
  const list = roots.map((r) => `\`${r.abs}\``).join(", ");
  return `## Where the product's source is

The application this test case describes lives under ${list}. Read and Grep reach there as well as into the working directory, and that is where the answer to "does the product still do this" is.

`;
}

/** What states the case, in the vocabulary of the document the project writes. */
function intentSurfaceBlock(kind: IntentKind): string {
  if (kind === "markdown") {
    return `- **the test case document** — always present. Markdown the project's own authors wrote and own: a heading for what to do, a heading for what must then be true, and whatever else their format carries. Read it as prose stating intent — the headings are theirs, not ccqa's.`;
  }
  return `- **spec.yaml** — always present. Pure YAML: \`title\`, then \`steps\`, each either an action (\`instruction\` + \`expected\`) or \`include: <block-name>\` with \`params\`. \`expected\` names something observable — visible text, an aria-label, a URL, an element state.`;
}

function generatedSection(artifacts: SpecArtifacts): string {
  if (artifacts.live) {
    return `## Generated test code

None: this case runs live, so there is nothing compiled from it — the document above is what runs. The only surface is \`spec\`.

`;
  }
  if (artifacts.generated.length === 0) {
    // "Nothing here" has two causes and opposite readings: never generated
    // (not drift) versus generated but too large to show (not audited).
    if (artifacts.unaudited.length > 0) {
      return `## Generated test code

Not shown: ${artifacts.unaudited.join(", ")} did not fit here. This case IS generated — the code simply could not be included. It was NOT audited, so report no finding on the \`generated\` surface, and Read a file if you need it.

`;
    }
    return `## Generated test code

None found. The case is recorded rather than live, but has not been generated yet, so only the document surface can be audited. Do not treat the absence as drift.

`;
  }
  const files = artifacts.generated
    .map((f) => `### ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
  return `## Generated test code

This is what actually runs: the generated test first, then the project files it imports. The selectors and strings here are literal — check them against the source the same way you check what the case says must be true. An imported file may be the project's own code rather than something ccqa generated; a finding about one belongs to the \`spec\` surface, not to code a regeneration would rewrite.

${files}
${unauditedNote(artifacts.unaudited)}
`;
}

/**
 * Files that belong to the test case but did not fit the budget. Named so the
 * audit cannot report "no drift" as if it had read them; it may Read one when
 * a finding turns on what it contains.
 */
function unauditedNote(unaudited: string[]): string {
  if (unaudited.length === 0) return "";
  return `
### Not shown

These files are part of this test case but did not fit here: ${unaudited.join(", ")}. They were NOT audited — do not count them as checked, and Read one if a finding depends on it.
`;
}
