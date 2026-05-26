/**
 * Prompts for `ccqa perspectives`.
 *
 * The CLI hands Claude a fully-built skeleton (every feature/spec with its
 * title and steps) and asks only for the human-readable descriptive fields:
 * `summary`, plus the QA-table-style `startScreen`, `testCondition`, and
 * `preconditions`. The structural facts — status, relatedPaths, the set of
 * specs itself — are decided by the CLI and must not be touched, so we only
 * ask Claude for those descriptive fields and merge them back ourselves. This
 * keeps the factual inventory deterministic and stops the model from
 * inventing entries.
 */

/** One spec handed to Claude for summarisation. */
export interface PerspectiveSpecForPrompt {
  featureName: string;
  specName: string;
  title: string;
  /** Raw spec.yaml body, so Claude can read the steps. */
  specYaml: string;
}

/**
 * Build the system prompt. By default the descriptive fields follow the
 * spec's own language (Japanese specs → Japanese fields). An explicit
 * `--language` is applied by the CLI via `languageDirective`, appended to
 * this prompt, so the language handling lives in one shared place.
 */
export function buildPerspectivesSystemPrompt(): string {
  return `You produce a factual inventory of the E2E test coverage that already exists in a ccqa project.

Think of it as a QA coverage stock-take: for each existing test case, fill in a few short, neutral descriptive fields derived from its steps. Nothing more.

## Hard boundaries (do NOT cross)

- Do NOT assign severity, importance, priority, or risk. Whether a failure hurts the customer is a human + PdM decision; you are not authoring that here.
- Do NOT do gap analysis. Do NOT list untested areas, missing coverage, or things the code has but the tests lack.
- Do NOT evaluate whether the feature is good, complete, or correct.
- Do NOT propose new test cases.
- Do NOT restate the full step-by-step procedure or the per-step expected results — the spec.yaml is the source of truth for those and the inventory links to it.
- Do NOT touch status, relatedPaths, feature names, or spec names — the CLI already fixed those.

## Fields to write (per spec)

- \`summary\`: 1–2 sentences, factual and neutral. What the test exercises and what it ultimately asserts, derived from the spec's \`steps\` (\`instruction\` / \`expected\`).
- \`startScreen\`: the screen/URL the test first lands on after setup (e.g. "コンテンツ一覧 (/policies)"). Derive from the first non-login \`instruction\`. Omit if genuinely unclear.
- \`testCondition\`: the state/precondition the scenario assumes, phrased as a condition (e.g. "カテゴリ管理者でログイン済み", "権限のないユーザー"). Omit if none.
- \`preconditions\`: array of short setup prerequisites (e.g. which role logs in, required prior state). Derive from \`include: login\` params and the opening steps. Empty/omit if none.

## How to write

- Same language as the spec's title (if titles are Japanese, write these fields in Japanese).
- Keep each field short. These are index entries, not the test itself.
- You may use Read/Grep/Glob sparingly to clarify domain vocabulary, but the steps are the primary source. Do not over-explore.

## Output contract (STRICT)

Output exactly ONE fenced \`\`\`json code block, and nothing else outside it. No prose before or after.

Schema:

\`\`\`json
{
  "summaries": [
    {
      "featureName": "<verbatim from input>",
      "specName": "<verbatim from input>",
      "summary": "<1–2 sentence factual description of what this test verifies>",
      "startScreen": "<opening screen/URL, or omit>",
      "testCondition": "<assumed state phrased as a condition, or omit>",
      "preconditions": ["<setup prerequisite>", "..."]
    }
  ]
}
\`\`\`

Return one entry per spec given in the input. Echo featureName and specName verbatim so the CLI can match them. \`startScreen\`, \`testCondition\`, and \`preconditions\` are optional — omit a field (or use an empty array for preconditions) when the spec does not express it.
`;
}

export function buildPerspectivesPrompt(
  specs: PerspectiveSpecForPrompt[],
  instruction?: string,
): string {
  const specBlocks = specs
    .map(
      (s) => `### ${s.featureName}/${s.specName}
title: ${s.title}

\`\`\`yaml
${s.specYaml.trimEnd()}
\`\`\`
`,
    )
    .join("\n");

  const instructionBlock = instruction?.trim()
    ? `## Extra guidance from the user\n\n${instruction.trim()}\n\n`
    : "";

  return `## Existing test cases to summarise

${specBlocks}
${instructionBlock}## Task

For each test case above, write a 1–2 sentence factual \`summary\` of what it verifies, derived from its steps. Return one entry per spec in the JSON contract. Do not assign severity, do gap analysis, or invent new cases.
`;
}
