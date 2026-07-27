import type { ChangedFile } from "../drift/affected.ts";
import type { SpecDescription } from "../select/inventory.ts";
import { specKey } from "../store/index.ts";

/**
 * The prompt behind `ccqa select-specs`.
 *
 * It replaces a stored path mapping with a judgement made against the actual
 * diff. That trade is worth making only if the judgement is honest about its
 * own limits, so the whole prompt is built around one rule: clearing a spec is
 * a claim that has to be earned, and `unknown` is always available instead.
 */

export function buildSelectSystemPrompt(): string {
  return `You decide which end-to-end test specs have to be re-run after a set of source changes.

You are given the files that changed between two commits, and an inventory of every test spec: what each one does, step by step. Return one verdict per spec.

## The three verdicts

- **needed** — at least one changed file plausibly affects what this spec verifies. Name the file(s) in \`touchedBy\`.
- **notNeeded** — you have accounted for the changed files and none of them reach what this spec does.
- **unknown** — you cannot tell.

## Why \`notNeeded\` is the only answer that can hurt

Re-running a spec that did not need it costs a few minutes of CI. NOT re-running a spec that needed it lets a regression reach users with the suite still green — the failure mode this tool exists to prevent.

So the two answers are not symmetric:

- \`needed\` and \`unknown\` are both safe. The caller runs them.
- \`notNeeded\` is a **positive claim**. Make it only when you have actually looked at what the spec exercises and at what changed, and can say the two do not meet.

When you cannot make that claim — a file whose purpose you cannot infer, a change whose blast radius you cannot bound, a spec whose steps are missing or unclear — answer \`unknown\`. That is a correct answer, not a failure. Guessing \`notNeeded\` is the one thing that causes damage.

**Do not over-correct.** Marking every spec \`needed\` throws away the entire point: the caller ends up running the full suite on every change. When a change is confined to an area that a spec demonstrably never touches, say \`notNeeded\` and say why. Both a reflexive "run everything" and a careless "skip it" are wrong; judge each spec on the evidence.

## How to judge

1. Read the changed paths. Most are self-describing — a path naming a screen, a component, a handler, or a route tells you what it belongs to.
2. For a path whose purpose is not obvious from its name, use \`Read\` or \`Grep\` to find out what it does before judging. Prefer this over guessing. Stay focused: this is a routing decision, not a code review.
3. Match against what each spec actually does — the screens its steps open, the controls they drive, the strings they assert on.
4. Remember indirect reach: shared layout, navigation, authentication, permission checks, and data-access code are touched by specs that never mention them. A change to a sign-in path can break every spec that has to sign in first.

## What does not affect any spec

Treat these as irrelevant unless something specific says otherwise: documentation and Markdown, changes to test files of the product's own unit-test suite, lockfile-only churn, formatting-only changes, and code paths that only run in a build or tooling context.

## Output (STRICT)

Output ONE fenced \`\`\`json block, and nothing else outside it.

\`\`\`json
{
  "specs": [
    {
      "spec": "<feature>/<spec>",
      "verdict": "needed" | "notNeeded" | "unknown",
      "reason": "<one sentence>",
      "touchedBy": ["<changed path>"]
    }
  ]
}
\`\`\`

Rules for the output:

- Include **every** spec from the inventory, exactly once, using the key as it was given to you.
- \`touchedBy\` is required for \`needed\` and must name paths from the changed-file list. Omit it otherwise.
- \`reason\` for \`notNeeded\` must say what you checked, not just "unrelated".
- \`reason\` for \`unknown\` must name what you could not determine.
`;
}

/** Cap on how many changed paths are spelled out before the list is summarised. */
const MAX_LISTED_PATHS = 400;

export function buildSelectPrompt(input: {
  changed: readonly ChangedFile[];
  specs: readonly SpecDescription[];
  base: string;
  head: string;
}): string {
  return `## Changed files (${input.base} → ${input.head})

${formatChangedFiles(input.changed)}

## Test spec inventory

${input.specs.map(formatSpec).join("\n\n")}

## Task

Return one verdict for each of the ${input.specs.length} specs above. Clear a spec only when you can account for the changes; otherwise answer \`needed\` or \`unknown\`.
`;
}

function formatChangedFiles(changed: readonly ChangedFile[]): string {
  if (changed.length === 0) return "(none)";
  const listed = changed.slice(0, MAX_LISTED_PATHS);
  const lines = listed.map((f) => `- ${f.status.padEnd(8)} ${f.path}${f.outsideCwd ? "  (outside the tested package)" : ""}`);
  if (changed.length > listed.length) {
    // Truncation must be visible: a silently cut list looks like a complete
    // one, and the model would clear specs against evidence it never saw.
    lines.push(
      `- ... and ${changed.length - listed.length} more paths, not listed. You have NOT seen the full change set: do not answer \`notNeeded\` for a spec unless the listed paths alone rule it out.`,
    );
  }
  return lines.join("\n");
}

function formatSpec(spec: SpecDescription): string {
  const steps = spec.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
  return `### ${specKey(spec)}\n${spec.title}\n${steps}`;
}
