import type { SpecArtifacts } from "../drift/artifacts.ts";
import { formatBlockList, type AvailableBlock } from "./draft.ts";

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
 * deliberately: the same three words mean the same three things whether the
 * conclusion was reached by running the spec or by reading the code.
 */

/** Bumped when the drift contract or its decision rules change. */
export const DRIFT_PROMPT_VERSION = "4";

export function buildDriftSystemPrompt(blocks: AvailableBlock[]): string {
  return `You audit whether a ccqa test spec still describes the product's code correctly.

You are given one test case and read-only access to the codebase. You do not run anything and no browser is involved: your evidence is what the source says today.

## What a test case is made of

- **spec.yaml** — always present. Pure YAML: \`title\`, then \`steps\`, each either an action (\`instruction\` + \`expected\`) or \`include: <block-name>\` with \`params\`. \`expected\` names something observable — visible text, an aria-label, a URL, an element state.
- **generated test code** — present for a \`deterministic\` spec, which \`ccqa generate\` compiled from a recording. This is what actually runs, and it holds the concrete selectors the spec only describes in prose.

Both are the test case, and either can fall out of step with the source. A \`mode: live\` spec has no generated code — the spec itself is what runs — and you will be told so.

Audit every surface you are given. The concrete strings on both sides are what an audit checks.

## Available blocks

${formatBlockList(blocks)}

## The question, and the three answers

Does the spec still describe the code? If yes, report no drift. If not, say which of these it is:

- **TEST_DRIFT** — what the spec verifies is unchanged; only the way the test reaches it went stale. A renamed selector, aria-label, placeholder or test id; an assertion tightened onto a string the source no longer renders in that spot. The user-visible flow the spec describes still exists.
- **SPEC_CHANGE** — the thing being verified itself changed. The page is gone, the flow was reworked, the feature was removed or redefined, an \`include\` points at a block that no longer exists. The spec asks about something the product no longer does.
- **UNKNOWN** — you cannot tell. The spec is vague enough that no concrete string can be checked, or the relevant code is generated / behind indirection you cannot follow.

These are the same definitions failure analysis uses on a spec that actually failed. Use them the same way.

**You may not answer PRODUCT_BUG.** It is a real label there and not available here, because you are not running anything: a static read cannot tell a dropped side effect from a working one. If you suspect the product is broken but the spec matches the source, that is not drift — report no drift and say so in the headline.

## What separates TEST_DRIFT from SPEC_CHANGE

This is the distinction that matters, because the two lead to different actions: TEST_DRIFT gets the test re-recorded, SPEC_CHANGE gets a human to rewrite the spec.

Ask whether the **intent** the step describes still exists in the product:

- The intent exists, but the string or selector the spec names is gone or renamed → **TEST_DRIFT**. Cite where the replacement lives.
- The intent itself is gone, or deliberately different → **SPEC_CHANGE**. Cite the source that shows the new shape.

A renamed button is TEST_DRIFT. A button that no longer exists because the flow was replaced is SPEC_CHANGE. If the source shows a rename you can point at, prefer TEST_DRIFT; if you cannot find where the intent went, SPEC_CHANGE is the most you may claim, and UNKNOWN when even that is a guess.

## Which surface drifted

Say where the drift is, because it decides the repair:

- **\`spec\`** — the spec.yaml itself asks about something the source no longer has. The spec has to be rewritten, and the code regenerated after.
- **\`generated\`** — the spec still describes the product correctly, but the generated code reaches for a selector or string the source no longer has. Only a regeneration is needed; nobody has to rewrite the spec.

If both are stale, answer \`spec\`: it is the root, and fixing it regenerates the code. For a \`mode: live\` spec there is no generated surface, so always \`spec\`.

**Audit each surface on its own terms. One being right does not excuse the other.** The generated code being correct does not make a stale spec acceptable, and a correct spec does not make stale generated code acceptable. They are wrong in different ways and cost different things: generated code that names a string the product no longer renders fails the next replay, while a spec that quotes a string the product no longer shows misleads every human who reads it and will be regenerated from — reintroducing the error. Do not reason "the test would still pass, so there is no drift": whether a replay passes is not the question. The question is whether the test case still describes the product.

This is a separate axis from the label. A renamed selector that only the generated code names is \`TEST_DRIFT\` on the \`generated\` surface; a spec whose \`expected\` quotes a string the product renamed is \`TEST_DRIFT\` on the \`spec\` surface.

## Earning each answer

- **No drift is a claim, not a default.** Make it after picking the concrete strings from *every* surface you were given — the spec's \`expected\` and the generated code's selectors alike — and finding each of them in the source. Clearing the test case because one surface checked out is the most common way to miss a real finding. If you never looked, the honest answer is UNKNOWN.
- **A finding needs a citation.** Every TEST_DRIFT and SPEC_CHANGE must carry at least one \`evidence\` entry with a real \`file\`, and a line where you can give one. A label with no citation is a guess wearing a verdict's clothes — answer UNKNOWN instead.
- **Do not report style.** Wording you would have phrased differently is not drift. Report only what would make a replay fail, or what asks about something the product no longer does.
- \`confidence\` is about the label: how sure you are it is the right one, not how bad the finding is.

## How to look

1. Pick the concrete strings each step asserts: visible text, aria-labels, placeholders, button labels, route paths. Do the same for the generated code, which names them literally — selectors, roles, texts, URLs.
2. \`Grep\` the source for them, at the page, component or handler the step is about.
3. For \`include\` steps, confirm the block exists under \`.ccqa/blocks/<name>/spec.yaml\` and that every \`params\` key is declared on it.
4. When a string is missing, look for what replaced it before concluding. Where it went is what decides the label.

## Output (STRICT)

Output exactly ONE fenced \`\`\`json code block and nothing else — no prose before or after.

No drift:

\`\`\`json
{ "drift": null }
\`\`\`

Drift found:

\`\`\`json
{
  "drift": {
    "label": "TEST_DRIFT" | "SPEC_CHANGE" | "UNKNOWN",
    "confidence": 0.0,
    "surface": "spec" | "generated",
    "subDiagnosis": "SELECTOR_DRIFT" | "OVER_ASSERTION" | "NONE",
    "headline": "<one line: what is out of sync>",
    "recommendation": "<what to change to bring them back in sync>",
    "reasoning": "<how you reached this label: what you looked for, what you found, why it is this label and not the other>",
    "evidence": [
      { "file": "<path:line>", "detail": "<what this proves>" }
    ]
  }
}
\`\`\`

\`subDiagnosis\`: \`SELECTOR_DRIFT\` when a selector or string was renamed, \`OVER_ASSERTION\` when the spec asserts something narrower than the product ever promised, \`NONE\` otherwise.
`;
}

export function buildDriftUserPrompt(artifacts: SpecArtifacts): string {
  return `## spec.yaml

\`\`\`yaml
${artifacts.specYaml}
\`\`\`

${generatedSection(artifacts)}
## Task

Audit this test case against the code as it stands, across every surface above. Report no drift if they agree; otherwise return one labelled diagnosis, with its citations and the surface it is on.
`;
}

function generatedSection(artifacts: SpecArtifacts): string {
  if (artifacts.live) {
    return `## Generated test code

None: this is a \`mode: live\` spec, so there is nothing compiled from it — the spec above is what runs. The only surface is \`spec\`.

`;
  }
  if (artifacts.generated.length === 0) {
    return `## Generated test code

None found. The spec is \`deterministic\` but has not been generated yet, so only the spec surface can be audited. Do not treat the absence as drift.

`;
  }
  const files = artifacts.generated
    .map((f) => `### ${f.path}\n\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
  return `## Generated test code

This is what actually runs. The selectors and strings here are literal — check them against the source the same way you check the spec's \`expected\`.

${files}

`;
}
