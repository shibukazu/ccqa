export type DraftMode = "create" | "refine";

export interface ExistingFeatureTree {
  featureName: string;
  specs: Array<{ specName: string; title?: string }>;
}

export function buildNamingSystemPrompt(): string {
  return `You name a new ccqa test case based on the user's intent and the existing feature tree.

ccqa test cases live under \`.ccqa/features/<featureName>/test-cases/<specName>/test-spec.md\`.

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
            : f.specs.map((s) => `  - ${s.specName}${s.title ? ` — ${s.title}` : ""}`).join("\n");
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


export function buildDraftSystemPrompt(): string {
  return `You are a QA engineer drafting and refining a ccqa test-spec.md.

The CLI runs you in a loop: each turn the user gives an intent (first run) or a refinement instruction (later runs). You read the codebase, validate the spec, and return a single JSON report. The CLI displays a diff and asks the user whether to apply.

## test-spec.md format (STRICT)

YAML frontmatter + Markdown body.

Frontmatter fields:
- title: string (required)
- baseUrl: string (required, e.g. http://localhost:3000)
- prerequisites: string (optional, free text)
- setups: array of { name: string, params?: Record<string,string> } (optional)
- relatedPaths: array of string (optional) — glob patterns identifying source files this spec depends on. Used by \`ccqa drift --changed\` in CI to skip drift checks for unrelated changes.

Body must contain a \`## Steps\` section followed by step blocks:

\`\`\`
### Step 1: <short title>
- **Instruction**: <imperative, one sentence>
- **Expected**: <observable outcome>

### Step 2: <short title>
...
\`\`\`

## Quality rules

- One user-facing action per step (login, click, fill, navigate, ...).
- **Expected** must be assertion-friendly: visible text, URL pattern, element state.
- Forbidden in **Expected**: timestamps, exact counts, session IDs, internal state.
- 3–8 steps is typical. Fewer means too coarse; more means too fine.

## Workflow (use Read / Grep / Glob extensively)

1. Read the codebase under cwd to find concrete strings: routes, button labels, aria-labels, page titles, placeholders. Use those exact strings in **Expected**.
2. If the spec references setups, Read \`.ccqa/setups/<name>/setup-spec.md\` and verify each \`params\` key matches the setup's \`placeholders\`.
3. Populate \`relatedPaths\` in the frontmatter with **provisional** glob patterns pointing at the source files this spec touches: the route/page file for each URL the spec visits, plus the component files (or their parent feature directory) that render the aria-labels, placeholders, or visible texts the spec asserts on. Prefer directory globs (e.g. \`src/features/tasks/**\`) when several files in one area are involved. Be conservative — include a path if you're unsure rather than omit it. \`ccqa trace\` will refine this list later from real browser observations.
4. Validate the (current or proposed) spec on four axes — emit one issue per finding:
   - **assertable**: each Expected can be verified against a string/URL/state that exists in code.
   - **setups**: referenced setup exists; params keys match placeholders.
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
      "category": "assertable" | "setups" | "granularity" | "unimplemented",
      "stepId": "step-01" | null,
      "message": "<one-line summary>",
      "detail": "<optional, multiline explanation>"
    }
  ],
  "patch": "<COMPLETE rewritten test-spec.md, or empty string if no changes>"
}
\`\`\`

## Patch rules

- \`patch\` must be the COMPLETE file content if non-empty (never a diff fragment).
- The CLI replaces the file atomically with \`patch\`.
- For **create** mode: produce a fresh spec from the user intent.
- For **refine** mode with a non-empty user instruction: apply the user's request, plus fix any issues it introduces. Preserve the user's wording elsewhere.
- For **refine** mode with an empty user instruction: only fix issues you find against the current spec; if everything is fine, return \`patch: ""\`.
- If \`patch\` is the same as the current spec, return \`patch: ""\` instead.
`;
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

create — no spec exists yet at the target path. Produce a fresh test-spec.md.

## User intent

${userInput}

## Task

Read the codebase under cwd. Discover concrete strings (routes, labels, titles). Produce a complete test-spec.md as the \`patch\` field, plus any issues you'd flag about your own draft.
`;
  }

  const instructionBlock = userInput
    ? `## User refinement instruction\n\n${userInput}\n`
    : `## User refinement instruction\n\n(empty — re-validate the current spec against the codebase; only emit a non-empty patch if something is actually wrong)\n`;

  return `## Mode

refine — a spec already exists. Apply the user's instruction (if any) and validate against the codebase.

## Current spec

\`\`\`markdown
${existing}\`\`\`

${instructionBlock}
## Task

1. Read the codebase under cwd and any referenced setups.
2. If the user's instruction is non-empty, apply it to the spec.
3. Validate the resulting spec on the four axes. Emit issues.
4. Return the complete updated spec as \`patch\`. If no changes are needed, return \`patch: ""\`.
`;
}
