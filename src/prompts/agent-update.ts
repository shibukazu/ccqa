import { outputLanguageBlock } from "./format.ts";

/**
 * Build the prompts used by `ccqa run --update-agent-prompt` and
 * `ccqa record --update-agent-prompt` to refresh `.ccqa/prompts/<mode>.agent.md`
 * after a run finishes.
 *
 * The agent prompt file is the auto-updated half of the prompt bundle (the
 * other half, `<mode>.user.md`, is human-maintained). We ask Claude to read
 * the previous version of the file alongside a summary of what just happened
 * in the run, then produce a fresh full replacement.
 *
 * The file's purpose is a **fast-path playbook**: it records the shortcuts a
 * slow step revealed so later runs can skip the exploration. Generic advice
 * that applies to any test is explicitly out of scope — it doesn't shave a
 * concrete step and only dilutes the playbook.
 *
 * The two modes differ in how the shortcut is keyed. `live` learns **cross-spec
 * rules** keyed on the *kind* of screen / operation (a rule learned on one
 * spec's login should speed up every spec's login), so it must never anchor to
 * a spec-local step id or a per-run snapshot ref. `record` learns per-spec
 * canonical selectors so its next trace records cleanly, and step-id / concrete
 * selector anchoring is correct there.
 */
/**
 * Generic advice that reads as a lesson but shaves no concrete step — it is
 * already in the base prompt, so both mode bodies ban it verbatim.
 */
const FILLER_BLOCKLIST = `### Never write these (generic filler — already in the base prompt)

- "always take a fresh snapshot before acting"
- "prefer aria-labels / data-testid when available"
- "verify the outcome with two signals"
- "be flexible and explore the DOM as needed"`;

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
  const isLive = input.mode === "live";
  const modeLabel = isLive
    ? "live (Claude drives every step at run time)"
    : "record (Claude records browser actions for vitest replay)";
  const userMdLabel = `${input.mode}.user.md`;
  const agentMdLabel = `${input.mode}.agent.md`;
  const appendedTo = isLive
    ? "every step of every `mode: live` spec"
    : "every trace run of `ccqa record`";
  const languageBlock = outputLanguageBlock(
    input.language ?? "auto",
    "the prose part of each bullet (the 'what to skip' note)",
    "headings, agent-browser subcommand names, stable selector tokens (CSS/text=/role=/aria-label=/placeholder=), URLs",
  );

  const body = isLive ? liveBodySections(agentMdLabel, userMdLabel) : recordBodySections(agentMdLabel, userMdLabel);

  return `You maintain the auto-learned fast-path playbook for ccqa's ${modeLabel} runs.

${languageBlock}## What you are updating

\`.ccqa/prompts/${agentMdLabel}\` is appended to ccqa's system prompt for ${appendedTo}. It is a **fast-path playbook**, NOT a list of general lessons.

${body}
- Emit the COMPLETE replacement contents of \`${agentMdLabel}\`.
- No narrative paragraphs. No preamble. No closing summary.
- Keep the whole file under ~3 KB.
- Output ONLY the new file contents. NO code fences. NO surrounding prose. NO markdown frontmatter.
- If no step in the run summary was slow enough to be worth a shortcut, output the previous file unchanged.
`;
}

/**
 * `live.agent` body: cross-spec rules keyed on screen/operation kind. A rule
 * learned from one spec's login must speed up every spec's login, so anchoring
 * to a step id or a per-run snapshot ref (both spec-/run-local) is forbidden.
 * The three-slot bullet shape (`when → do X not Y → saves`) is the anti-filler
 * gate: a bullet that can't name a trigger other than a step id, or a saving
 * grounded in this run, self-eliminates.
 */
function liveBodySections(agentMdLabel: string, userMdLabel: string): string {
  return `Your goal: make **future live executions across all specs** finish in fewer turns. Distill each slow step into a **reusable rule keyed on the kind of screen or operation** — not on which spec or step it appeared in. A rule learned from one spec's login should speed up every spec's login.

The sibling file \`${userMdLabel}\` carries human-maintained project guidance (URLs, naming conventions). Do not repeat anything already covered there.

## This file is project-private — write concrete but *stable* details

Real URLs, stable selectors (CSS / \`text=\` / \`role=\` / \`aria-label=\` / \`placeholder=\`), and the exact subcommand sequence that worked are what you SHOULD record — this playbook is project-private, not public. But record only what stays valid across runs:

- **NEVER write a snapshot ref (\`@e4\`, \`@e10\`) into this file.** Snapshot refs are renumbered every run — a ref that worked last run points nowhere (or misclicks) next run. When a winning command used \`@eN\`, translate it to the element's **stable identity** (its role + accessible name / label / placeholder / visible text) or describe it abstractly ("the email field", "the primary submit button"). The run summary masks refs as \`@ref\` for this reason.
- **NEVER anchor a bullet to a step id** (\`step-02\`). Step ids are spec-local and meaningless to other specs. Anchor to the **screen class, flow, or operation kind** the step exercised.

## What to write (and what NOT to)

- Only write a rule for a step the summary shows was **slow or took many turns**. Skip steps that already passed in 1–2 turns.
- Every bullet uses this **three-slot shape**:

  \`- when <trigger: screen class / operation kind>: <do X instead of Y> — saves <the probe / snapshot / turns this run wasted>\`

  Examples of good triggers: "a hosted ID-provider login form", "entering text into any field", "confirming a static banner / empty-state is present". If you cannot fill the \`when\` slot with anything other than a step id, or the \`saves\` slot with a cost observed *this run*, the bullet is filler — drop it. In the \`saves\` slot state the magnitude only ("~3 turns", "~\$0.05") — do NOT cite which step you saw it on ("seen on step-01"); step ids are spec-local and must not appear anywhere in the file.
- Merge, don't duplicate: if two specs exercised the same screen class or operation, write **ONE** rule covering both. When carrying a rule forward from the previous file, merge new observations into it rather than appending a spec-specific variant.
- Carry forward still-valid rules. Drop any pre-existing bullet that this run contradicts, that is anchored to a step id, or that contains a \`@eN\` ref.

${FILLER_BLOCKLIST}

A bullet is filler if it is **true without having run anything**, or if it names no command you would otherwise have wasted turns discovering. Every bullet must override a default the agent would otherwise follow.

**Never emit an unconditional or default \`fill\` text-entry rule.** The base prompt already mandates \`keyboard inserttext\` for non-ASCII / contenteditable / rich-text editors, where \`fill\` corrupts input. A \`fill\` win observed on a plain login \`<input>\` must NOT be generalized into "type with \`fill\`" — that rule would reach a Slack/Notion contenteditable field and break it. If you record a text-entry shortcut at all, narrow its \`when\` slot to the element class you actually saw (e.g. "a plain \`<input>\` in a login form") and never phrase it as a cross-field default.

## Output format

Group rules under \`### <screen class or operation pattern>\` subheaders (e.g. \`### ID-provider login\`, \`### Text entry\`, \`### Static-banner / access-denied checks\`). Each rule is one three-slot bullet.

`;
}

/**
 * `record.agent` body: cross-spec recipes keyed on screen/operation kind, like
 * `live.agent`, but with selectors kept **verbatim**. Record's `role=` /
 * `label=` / `placeholder=` / `text=` locators are stable across runs (unlike
 * live's per-run `@eN` refs), so the winning selector IS the reusable knowledge
 * — a login recorded on one spec should let every spec's login skip the
 * selector probing next time. The file accretes across runs: each record run
 * merges its selector into the matching screen-class section rather than adding
 * a spec-named one.
 */
function recordBodySections(agentMdLabel: string, userMdLabel: string): string {
  return `Your goal: make **future record traces across all specs** record cleanly on the first pass. Distill each step that churned through selectors into a **reusable recipe keyed on the kind of screen or operation** — not on which spec or step it appeared in. A selector learned from one spec's login should let every spec's login record without re-probing.

The sibling file \`${userMdLabel}\` carries human-maintained project guidance (URLs, naming conventions). Do not repeat anything already covered there.

## This file is project-private — write concrete selectors, but key them on the screen

The exact locator that survived validation (\`label=メールアドレス\`, \`role=button --name Save\`, \`text=…\`) is what you SHOULD record — this playbook is project-private, not public, and a recipe without the real selector is useless. Record's selectors are **stable across runs**, so unlike the live playbook you must NOT abstract them to "the email field" — write the literal token so the next trace uses it immediately. But key each recipe on the **screen class / operation kind**, never on a spec or step id:

- **NEVER title a section with a spec or feature name** (e.g. \`### checkout/guest-payment\`). Titles are screen classes / operation kinds (\`### ID-provider login\`, \`### Text entry\`, \`### Direct-URL access-denied check\`) so the recipe applies to any spec that hits that screen.
- **NEVER anchor a bullet to a step id** (\`step-02:\`). Step ids are spec-local. Anchor to the screen/operation the step exercised.

## What to write (and what NOT to)

- Only write a recipe for a step the summary flags as **high-churn** (its \`churn:\` line shows attempts dropped) or that took many selector tries. Skip steps that recorded cleanly in 1–2 actions. **Prioritize the steps with the most dropped attempts** — those are where re-probing wastes the most next time.
- Every bullet uses this **three-slot shape**:

  \`- when <trigger: screen class / operation kind>: <use selector X instead of probing> — saves <the N selector attempts / dropped actions this run wasted>\`

  If you cannot fill the \`when\` slot with anything but a step id, or the \`saves\` slot with churn observed *this run*, the bullet is filler — drop it.
- **A selector marked \`[unstable]\` in "kept commands" is NOT canonical, even though it was kept.** In lenient mode a fast-but-flaky selector (e.g. an \`[aria-label=…]\` that wasn't present on the fresh replay) survives into the trace but is flagged \`[unstable](<reason>)\`. Never record an \`[unstable]\` selector as the recipe's locator — record a more stable \`find_*\` / \`role=\` / \`label=\` / \`text=\` locator for the same target instead. A selector that got dropped as replay-unstable is likewise not canonical.
- **Balance churn against stability.** A \`churn:\` line rewards cutting selector probing, but a \`replay-unstable:\` line on the same step means the surviving selector is timing-fragile. When a step shows both, prefer the *stable* locator even if it needs one more probe next run — a recipe that records fewer but flaky selectors makes validation replays fail. Speed is only a win if the selector survives replay.
- **Merge, don't fork:** when this run's screen class matches a \`### <screen class>\` section already in the previous file, merge this run's selector into it — do not add a spec-specific section. If two specs' selectors for the same screen genuinely differ, narrow the \`when\` slot (\`when a login form with an email+password pair\`) rather than forcing a wrong merge.

${FILLER_BLOCKLIST}

A bullet is filler if it is **true without having run anything**, or names no selector you would otherwise have wasted attempts discovering.

## Output format

Group recipes under \`### <screen class or operation pattern>\` subheaders (e.g. \`### ID-provider login\`, \`### Text entry\`, \`### Direct-URL access-denied check\`). Each recipe is one three-slot bullet.

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
