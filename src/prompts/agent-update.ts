import { outputLanguageBlock } from "./format.ts";

/**
 * Build the prompts used by `ccqa run --update-agent-prompt` and
 * `ccqa record --update-agent-prompt` to refresh `.ccqa/prompts/<mode>.agent.md`
 * after a run finishes.
 *
 * The agent prompt file is the auto-updated half of the prompt bundle (the
 * other half, `<mode>.user.md`, is human-maintained). We ask Claude to read
 * the previous version of the file alongside a summary of what just happened
 * in the run, then produce a fresh full replacement — concise, deduplicated,
 * focused on stable lessons learned from the run.
 */
export interface BuildAgentUpdatePromptInput {
  mode: "live" | "record";
  /** Current contents of `.ccqa/prompts/<mode>.agent.md`, or null when missing. */
  currentAgentMd: string | null;
  /** Multi-line summary of the run, built by the caller. */
  runSummary: string;
  /** BCP-47 tag or "auto"; passed to outputLanguageBlock. */
  language?: string;
}

export function buildAgentUpdateSystemPrompt(input: BuildAgentUpdatePromptInput): string {
  const modeLabel = input.mode === "live" ? "live (Claude drives every step at run time)" : "record (Claude records browser actions for vitest replay)";
  const userMdLabel = `${input.mode}.user.md`;
  const agentMdLabel = `${input.mode}.agent.md`;
  const languageBlock = outputLanguageBlock(
    input.language ?? "auto",
    "the bullet text",
    "headings, agent-browser subcommand names, selector tokens",
  );

  return `You maintain the auto-learned half of ccqa's prompt bundle for ${modeLabel}.

${languageBlock}## What you are updating

\`.ccqa/prompts/${agentMdLabel}\` is appended to ccqa's system prompt for every ${input.mode === "live" ? "step of every \`mode: live\` spec" : "trace run of \`ccqa record\`"}. It is meant to capture **stable lessons learned from past runs** — concrete selectors that worked, login flow quirks the agent kept tripping on, common "this is fine" warnings to ignore.

The sibling file \`${userMdLabel}\` carries human-maintained project guidance (URLs, naming conventions). Rules already well-covered by \`${userMdLabel}\` should NOT be repeated here.

## Output rules

- Emit the COMPLETE replacement contents of \`${agentMdLabel}\`.
- Concise bullet points. No narrative paragraphs. No preamble. No closing summary.
- Each bullet is a single declarative sentence (or one bullet → one short selector / command).
- Group related bullets under \`### …\` subheaders.
- Skip everything that was already true and well-covered by the previous file or \`${userMdLabel}\`. Only persist new lessons.
- Keep the whole file under ~3 KB.
- Output ONLY the new file contents. NO code fences. NO surrounding prose. NO markdown frontmatter.
- If the run summary contains nothing worth learning from, output the previous file unchanged.
`;
}

export function buildAgentUpdateUserPrompt(input: BuildAgentUpdatePromptInput): string {
  const agentMdLabel = `${input.mode}.agent.md`;
  const previous = input.currentAgentMd && input.currentAgentMd.trim().length > 0
    ? input.currentAgentMd
    : "(no existing file — this will create one)";
  return `## Previous \`${agentMdLabel}\`

${previous}

## Run summary

${input.runSummary}

## Your task

Write the new contents of \`${agentMdLabel}\`. Output ONLY the file contents — no preamble, no fences, no closing note.`;
}
