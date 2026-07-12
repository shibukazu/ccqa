import { languageDirective } from "./language.ts";

/**
 * Prompt strings for the shared LLM generation engine
 * (`src/targets/llm-engine.ts`) and its target adapters (playwright / runn).
 *
 * These strings ship to end users' Claude sessions — keep every example
 * neutral and generic (a "Submit" button, a todo app), never copy from any
 * real product.
 */

/** One prompt-facing entry of the resolved `resources` config. */
export interface PromptResource {
  /** "path" = code in the consumer repo, "package" = installed npm package. */
  kind: "path" | "package";
  /** What to import: the repo path (or glob) / the package name. */
  ref: string;
  /** Where the agent can Read/Grep/Glob the resource's source. */
  root: string;
  description?: string;
}

/** A conventions guide/example body injected verbatim into the prompt. */
export interface PromptConventionSection {
  path: string;
  body: string;
}

export interface LlmGenPromptInput {
  /** Target-specific instructions: what to generate and in which format. */
  taskInstructions: string;
  specTitle: string;
  steps: Array<{ id: string; instruction: string; expected: string }>;
  relatedPaths: string[];
  /** Mechanical-emit draft (playwright): the recorded ground truth. */
  draft?: { path: string; contents: string };
  resources: PromptResource[];
  conventionSections: PromptConventionSection[];
  /** Hub prompt bundle (project guidance + agent learnings), pre-concatenated. */
  promptBundle?: string;
  /** Where generated files must be written (project-root-relative). */
  outDir: string;
  /** Additional write-allowed roots (path resources). */
  extraWriteRoots: string[];
  language?: string;
}

/**
 * The reuse-first contract — the four rules that make generated tests build
 * on the consumer repo's existing assets instead of re-implementing them.
 */
export function reuseFirstContract(hasDraft: boolean): string {
  const rules = [
    `1. **Reuse first.** Before writing any code, search the declared resources ` +
      `(path resources with Glob/Grep/Read; package resources under their resolved roots) ` +
      `and import every asset you can use: page objects, step helpers, fixtures, custom ` +
      `selectors, shared constants and regular expressions. Re-implementing an equivalent ` +
      `of an existing asset — including copy-pasting a constant or a regex — is forbidden.`,
    `2. **Create missing parts as support files.** When a needed part does not exist ` +
      `(e.g. a page object for a screen no resource covers), create it following the ` +
      `conventions guides and the style of the existing resources, and output it with ` +
      `\`"kind": "support"\`. Package resources are read-only: never modify their contents — ` +
      `if a package lacks something, create the missing piece as a new support file in the ` +
      `repo and mention it in \`summary\`.`,
    `3. **Match the examples.** Write in the same style as the conventions examples: ` +
      `naming, structure, assertion phrasing, import layout.`,
  ];
  if (hasDraft) {
    rules.push(
      `4. **The draft is ground truth.** The mechanical draft below encodes the recorded ` +
        `route. Do not change the meaning of its operation sequence or its assertions — ` +
        `no reordering, dropping, or weakening. You may rewrite locators when the ` +
        `conventions or the sources under \`relatedPaths\` justify a better one.`,
    );
  }
  return `## Reuse contract\n\n${rules.join("\n")}`;
}

/**
 * The JSON output contract shared by every LLM generation pass. Mirrors the
 * cleanup prompt's "output ONLY JSON" style so parsing stays uniform.
 */
export function outputContract(outDir: string, extraWriteRoots: string[]): string {
  const roots = [outDir, ...extraWriteRoots].map((r) => `\`${r}\``).join(", ");
  return `## Output format

When you are done exploring, reply with ONLY a JSON object (no explanation, no markdown code fences):

{"files": [{"path": "<project-root-relative path>", "contents": "<full file contents>", "kind": "test" | "support"}], "summary": "<one-paragraph human-readable summary>"}

- \`kind\` MUST be exactly \`"test"\` or \`"support"\` (no other value): \`"test"\` marks an executable test; \`"support"\` marks a companion file (page object, helper, ...).
- Every \`path\` must be relative to the project root and stay under one of: ${roots}.
- Absolute paths, \`..\` segments, and anything under \`node_modules/\` are rejected.
- Emit the complete contents of every file you output — no placeholders or elisions.`;
}

/** Corrective note appended when the previous reply failed the output contract. */
export function retryNote(error: string): string {
  return `\n\n## Previous attempt rejected\n\nYour previous reply violated the output contract: ${error}\nReply again with ONLY the JSON object described in "Output format".`;
}

export function buildLlmGenPrompt(input: LlmGenPromptInput): string {
  const sections: string[] = [];

  sections.push(input.taskInstructions);

  const steps = input.steps
    .map((s) => `- ${s.id}: ${s.instruction}\n  expected: ${s.expected}`)
    .join("\n");
  const related =
    input.relatedPaths.length > 0
      ? `\n\nRelated source paths (verify concrete details against these):\n${input.relatedPaths.map((p) => `- ${p}`).join("\n")}`
      : "";
  sections.push(`## Test spec\n\nTitle: ${input.specTitle}\n\nSteps:\n${steps}${related}`);

  if (input.draft) {
    sections.push(
      `## Mechanical draft (recorded ground truth)\n\nPath: ${input.draft.path}\n\n` +
        "```\n" + input.draft.contents + "\n```",
    );
  }

  if (input.resources.length > 0) {
    const lines = input.resources.map((r) => {
      const what = r.kind === "package" ? `npm package \`${r.ref}\`` : `repo code \`${r.ref}\``;
      const desc = r.description ? ` — ${r.description}` : "";
      return `- ${what}${desc}\n  explore under: ${r.root}`;
    });
    sections.push(
      `## Reusable resources\n\nExisting code assets the generated test MUST reuse ` +
        `(import path resources the way this repo does; import package resources by name):\n\n${lines.join("\n")}`,
    );
  }

  if (input.conventionSections.length > 0) {
    const bodies = input.conventionSections
      .map((c) => `### ${c.path}\n\n\`\`\`\n${c.body}\n\`\`\``)
      .join("\n\n");
    sections.push(`## Conventions\n\nHow generated code should be written:\n\n${bodies}`);
  }

  if (input.promptBundle) {
    sections.push(`## Project prompt guidance\n\n${input.promptBundle}`);
  }

  sections.push(reuseFirstContract(input.draft !== undefined));
  sections.push(outputContract(input.outDir, input.extraWriteRoots));

  return sections.join("\n\n") + languageDirective(input.language);
}

export interface LlmFixPromptInput {
  targetId: string;
  /** The verification command that failed (after `{files}` substitution). */
  command: string;
  /** Tail of the failing run's stdout+stderr. */
  outputTail: string;
  /** Current on-disk contents of every generated file. */
  files: Array<{ path: string; contents: string; kind: "test" | "support" }>;
  outDir: string;
  extraWriteRoots: string[];
  language?: string;
}

/**
 * Prompt for one iteration of the verification loop: the generated files
 * failed their run command; ask for corrected files under the same contract.
 */
export function buildLlmFixPrompt(input: LlmFixPromptInput): string {
  const files = input.files
    .map((f) => `### ${f.path} (${f.kind})\n\n\`\`\`\n${f.contents}\n\`\`\``)
    .join("\n\n");
  const sections = [
    `You generated ${input.targetId} test files for this project, but their verification run failed. ` +
      `Fix the files so the command passes. Keep the tested behaviour identical — fix locators, ` +
      `imports, syntax, and setup, never delete or weaken assertions to force a pass. ` +
      `You may Read/Grep/Glob the project to investigate.`,
    `## Failing command\n\n\`${input.command}\``,
    `## Command output (tail)\n\n\`\`\`\n${input.outputTail}\n\`\`\``,
    `## Current files\n\n${files}`,
    outputContract(input.outDir, input.extraWriteRoots) +
      `\n- Output only the files that need changes; files you omit stay as they are.` +
      `\n- If the failure is NOT caused by the generated files (an environment/setup issue) or the files are already correct, reply \`{"files": [], "summary": "<why no file change is needed>"}\` — verification is then simply re-run.`,
  ];
  return sections.join("\n\n") + languageDirective(input.language);
}

/**
 * Playwright rewrite pass: turn the mechanical draft into a library-reusing
 * spec. The draft carries the recorded route; the resources carry the assets.
 */
export function playwrightTaskInstructions(suggestedPath: string): string {
  return `You are rewriting a machine-generated Playwright test so it reuses this repository's existing test assets.

The mechanical draft below was compiled 1:1 from a recorded browser session — it is plain \`@playwright/test\` code with raw locators (e.g. \`page.getByRole("button", { name: "Submit" })\`). Rewrite it into the shape this repository's test suite actually uses: import and call the declared resources (page objects, step helpers, fixtures, shared constants) instead of inlining raw interactions, and follow the conventions.

Write the rewritten test to \`${suggestedPath}\` unless the conventions/examples clearly place tests elsewhere under the output directory. Locator preference when you do write raw locators: test id > accessible text > role > CSS.`;
}

/**
 * runn generation pass: compile the spec into a runbook. Only the generic
 * runbook shape is prescribed here — concrete endpoints, payloads, and
 * response shapes must be verified against the backend sources referenced by
 * the spec's \`relatedPaths\`.
 */
export function runnTaskInstructions(suggestedPath: string): string {
  return `You are generating a runn runbook (YAML) that covers the test spec below against this repository's backend.

Runbook shape (generic runn structure):
- \`desc:\` — a one-line description of the scenario.
- \`runners:\` — the runners the steps use (typically an HTTP runner, e.g. \`req: \${API_ENDPOINT}\`; use env-var placeholders for endpoints, never hardcode hosts).
- \`vars:\` — variable bindings for values reused across steps (test inputs, ids captured from responses).
- \`steps:\` — one entry per spec step where possible: \`req\` steps perform the API calls, \`test\` steps assert on \`current.res\` (status, body fields). Bind values from earlier responses via \`steps[N]\` references when later steps need them.

Do NOT invent endpoints, request bodies, or response fields: read the backend sources under the spec's related paths (routing tables, handlers, schemas) and derive the concrete paths, methods, parameters, and response shapes from them. If a detail cannot be confirmed from the sources, say so in \`summary\` instead of guessing silently.

Write the runbook to \`${suggestedPath}\` unless the conventions/examples clearly use another layout under the output directory. If shared setup deserves its own helper runbook, output it as \`kind: "support"\`.`;
}
