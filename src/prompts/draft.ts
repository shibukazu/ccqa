import type { AvailableBlock } from "../store/index.ts";

export type DraftMode = "create" | "refine";

export interface ExistingFeatureTree {
  featureName: string;
  specs: Array<{ specName: string }>;
}

export type { AvailableBlock };

export function buildNamingSystemPrompt(): string {
  return `You name a new ccqa test case based on the user's intent and the existing feature tree.

ccqa test cases live under \`.ccqa/features/<featureName>/test-cases/<specName>/spec.yaml\`.

## Naming rules

- featureName and specName are kebab-case ASCII (lowercase, words separated by '-').
- featureName: a broad area (e.g. "tasks", "auth", "billing", "search").
- specName: a short scenario name (e.g. "create-and-complete", "login-with-email", "search-by-tag").
- Reuse existing featureName when the user's intent fits an existing area. Only invent a new featureName when the existing tree clearly does not cover the area.
- specName must NOT collide with an existing spec under the chosen feature. If the natural name collides, pick a different one that distinguishes the new scenario from the existing ones.
- Use the codebase (Read/Grep/Glob) sparingly to confirm domain vocabulary if helpful. Do not over-explore.

## Output (STRICT)

Output ONE fenced \`\`\`json block, nothing else outside it:

{
  "featureName": "<kebab-case>",
  "specName": "<kebab-case>",
  "reason": "<one short sentence: why this name and how it relates to existing specs>"
}
`;
}

export function buildNamingPrompt(intent: string, tree: ExistingFeatureTree[]): string {
  const treeText = tree.length === 0
    ? "(no existing features yet)"
    : tree
        .map((f) => {
          const specLines = f.specs.length === 0
            ? "  (no specs yet)"
            : f.specs.map((s) => `  - ${s.specName}`).join("\n");
          return `- ${f.featureName}/\n${specLines}`;
        })
        .join("\n");

  return `## User intent

${intent}

## Existing feature tree

${treeText}

## Task

Pick featureName and specName for the new test case. Follow the naming rules. Avoid colliding with any existing specName under the chosen feature.
`;
}


export function buildDraftSystemPrompt(blocks: AvailableBlock[]): string {
  return `You are a QA engineer drafting and refining a ccqa spec.yaml.

The CLI runs you in a loop: each turn the user gives an intent (first run) or a refinement instruction (later runs). You read the codebase, validate the spec, and return a single JSON report. The CLI displays a diff and asks the user whether to apply.

## spec.yaml format (STRICT)

Pure YAML — no markdown body, no frontmatter dashes.

Top-level fields:
- \`title\`: string (required) — short human-readable name for the test
- \`relatedPaths\`: array of glob string (optional) — source files this spec depends on, used by \`ccqa drift --changed\`
- \`steps\`: array (required, at least one)
- \`target\`: string (optional) — generation-target id (e.g. \`playwright\`, \`runn\`); omitted = the project default (agent-browser)
- \`mode\`: \`live\` (optional, agent-browser only) — Claude drives every run instead of replaying a recording
- \`session\`: string or array of string (optional, agent-browser only) — saved browser session name(s) restored before the run

Do not flag \`target\` / \`mode\` / \`session\` as unknown fields — they are part of the schema even though drafting rarely sets them.

A step is one of two shapes:

**Action step** — a user-facing browser interaction:
\`\`\`yaml
- instruction: <imperative; include the URL directly or via \${ENV_VAR}>
  expected: <observable outcome — visible text, URL pattern, element state>
\`\`\`

**Include step** — invoke a reusable block from \`.ccqa/blocks/<name>/spec.yaml\`:
\`\`\`yaml
- include: <block-name>
  params:
    <param-name>: <string value, can use \${ENV_VAR}>
\`\`\`

## URLs

Each step writes the URL it opens directly inside \`instruction\` (e.g. \`"\${APP_URL}/articles を開く"\`). Use \`\${ENV_VAR}\` references for environment-specific values.

## Available blocks

${formatBlockList(blocks)}

## Quality rules

- One user-facing action per step (login, click, fill, navigate, ...).
- \`expected\` must be assertion-friendly: visible text, URL pattern, element state.
- Forbidden in \`expected\`: timestamps, exact counts, session IDs, internal state.
- 3–8 steps is typical. Fewer means too coarse; more means too fine.

## Workflow (use Read / Grep / Glob extensively)

1. Read the codebase under cwd to find concrete strings: routes, button labels, aria-labels, page titles, placeholders. Use those exact strings in \`expected\`.
2. If you use \`include:\` steps, verify each \`params\` key matches a declared param of the block (see the Available blocks list above).
3. Populate \`relatedPaths\` with **provisional** glob patterns pointing at the source files this spec touches: the route/page file for each URL the spec visits, plus the component files (or their parent feature directory) that render the aria-labels, placeholders, or visible texts the spec asserts on. Prefer directory globs (e.g. \`src/features/tasks/**\`) when several files in one area are involved. Be conservative — include a path if you're unsure rather than omit it. \`ccqa trace\` will refine this list later from real browser observations.
4. Validate the (current or proposed) spec on four axes — emit one issue per finding:
   - **assertable**: each \`expected\` can be verified against a string/URL/state that exists in code.
   - **blocks**: every \`include\` resolves to a real block; every \`params\` key is declared on that block; every required param is provided.
   - **granularity**: not too coarse (multiple actions per step) nor too fine (snapshot-only steps); order is logical.
   - **unimplemented**: any feature mentioned in the spec that you cannot find in code.

## Output contract (STRICT)

Output exactly ONE fenced \`\`\`json code block, and nothing else outside it. No prose before or after.

Schema:

\`\`\`json
{
  "issues": [
    {
      "severity": "OK" | "WARN" | "ERROR",
      "category": "assertable" | "blocks" | "granularity" | "unimplemented",
      "stepId": "step-01" | null,
      "message": "<one-line summary>",
      "detail": "<optional, multiline explanation>"
    }
  ],
  "patch": "<COMPLETE rewritten spec.yaml, or empty string if no changes>"
}
\`\`\`

## Patch rules

- \`patch\` must be the COMPLETE file content if non-empty (never a diff fragment).
- The CLI replaces the file atomically with \`patch\`.
- The patch must be valid YAML matching the schema above. The CLI re-parses it before applying; if it fails validation, the patch is rejected.
- For **create** mode: produce a fresh spec from the user intent.
- For **refine** mode with a non-empty user instruction: apply the user's request, plus fix any issues it introduces. Preserve the user's wording elsewhere.
- For **refine** mode with an empty user instruction: only fix issues you find against the current spec; if everything is fine, return \`patch: ""\`.
- If \`patch\` is the same as the current spec, return \`patch: ""\` instead.
`;
}

function formatBlockList(blocks: AvailableBlock[]): string {
  if (blocks.length === 0) {
    return "(no blocks defined yet — only action steps are available.)";
  }
  return blocks
    .map((b) => {
      const paramLines = b.params.length === 0
        ? "    params: (none)"
        : b.params
            .map(
              (p) =>
                `    - ${p.name}${p.required ? "" : " (optional)"}${p.secret ? " [secret]" : ""}`,
            )
            .join("\n");
      return `- \`${b.name}\` — ${b.title}\n${paramLines}`;
    })
    .join("\n");
}

export interface DraftPromptInput {
  mode: DraftMode;
  existing: string;
  userInput: string;
}

export function buildDraftPrompt(input: DraftPromptInput): string {
  const { mode, existing, userInput } = input;

  if (mode === "create") {
    return `## Mode

create — no spec exists yet at the target path. Produce a fresh spec.yaml.

## User intent

${userInput}

## Task

Read the codebase under cwd. Discover concrete strings (routes, labels, titles). Produce a complete spec.yaml as the \`patch\` field, plus any issues you'd flag about your own draft.
`;
  }

  const instructionBlock = userInput
    ? `## User refinement instruction\n\n${userInput}\n`
    : `## User refinement instruction\n\n(empty — re-validate the current spec against the codebase; only emit a non-empty patch if something is actually wrong)\n`;

  return `## Mode

refine — a spec already exists. Apply the user's instruction (if any) and validate against the codebase.

## Current spec

\`\`\`yaml
${existing}\`\`\`

${instructionBlock}## Task

1. Read the codebase under cwd and any referenced blocks (\`.ccqa/blocks/<name>/spec.yaml\`).
2. If the user's instruction is non-empty, apply it to the spec.
3. Validate the resulting spec on the four axes. Emit issues.
4. Return the complete updated spec as \`patch\`. If no changes are needed, return \`patch: ""\`.
`;
}
