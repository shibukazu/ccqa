import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { extractJsonCandidates, truncate } from "../diagnose/diagnose.ts";

/** One decided claim. */
export interface Verdict {
  ok: boolean;
  /** Why, in one sentence. Carried into the failure message so a red test says what was wrong. */
  reason: string;
}

const SYSTEM_PROMPT = [
  "You decide whether a claim holds for a piece of text taken from a web page under test.",
  "",
  "Judge only what the claim says. Do not reward text that is merely well-formed,",
  "and do not fail text for wording, length, or formatting the claim does not mention.",
  "An empty or error-like text fails any claim about content.",
  "",
  'Answer with one line of JSON and nothing else: {"ok": true|false, "reason": "<one sentence>"}',
].join("\n");

/** Beyond this the tail is dropped, so one runaway page cannot fill the model's context. */
const MAX_TEXT_CHARS = 20_000;

/** A judge runs inside a test, so a turn that will not finish has to fail rather than hold the run. */
const JUDGE_TIMEOUT_MS = 60_000;

/**
 * The slice of Playwright's `Page` this needs. Structural because ccqa does
 * not depend on Playwright, which also lets a caller pass anything else that
 * can hand over text.
 */
export interface TextSource {
  innerText(selector: string): Promise<string>;
}

/**
 * Fails the test unless a model agrees the claim holds for the text read from
 * `from` (a selector; omitted, the page's body). The reason the model gave
 * rides in the failure, so a red test says what was wrong.
 *
 * A selector matching several elements judges the first, as Playwright's
 * page-level `innerText` does — narrow it if that is not what you mean.
 */
export async function judgeByLlm(page: TextSource, claim: string, from = "body"): Promise<void> {
  const text = await page.innerText(from);
  const verdict = await decideClaim({ claim, text });
  if (!verdict.ok) {
    throw new Error(
      `judgeByLlm: the claim did not hold (${verdict.reason || "no reason given"})\n  claim: ${claim}\n  read from: ${from}`,
    );
  }
}

export interface ClaimInput {
  /** The claim to decide, as written in the spec's `judgeByLlm`. */
  claim: string;
  /** The text it is decided against. */
  text: string;
  model?: string;
  cwd?: string;
}

/**
 * Decides a claim about text a run cannot predict — a generated answer, a
 * summary. A model that will not answer, or answers something this cannot
 * read, is an unmade decision rather than a passing one: it throws, so a
 * claim never goes silently unjudged.
 */
export async function decideClaim(input: ClaimInput): Promise<Verdict> {
  // Marked rather than silently cut: a claim about how the text ends is
  // undecidable once the end is gone, and the model can only say so if it
  // knows something was dropped.
  const prompt = [
    "## Claim",
    input.claim.trim(),
    "",
    "## Text",
    truncate(input.text.trim(), MAX_TEXT_CHARS) || "(the page yielded no text)",
  ].join("\n");

  const { result, isError, errorDetail } = await invokeClaudeStreaming(
    {
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: [],
      maxTurns: 1,
      // A thinking-first model can spend the whole turn inside a thinking
      // block and end with no text, which arrives here as an unreadable
      // verdict and fails the test for a reason that is not the product's.
      disableThinking: true,
      timeoutMs: JUDGE_TIMEOUT_MS,
      ...(input.model ? { model: input.model } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    },
    () => {},
  );
  // `result` is empty on failure — the cause is in `errorDetail`.
  if (isError) throw new Error(`judgeByLlm: the model did not answer (${errorDetail || result})`);
  return parseVerdict(result);
}

/**
 * The model is asked for bare JSON but sometimes wraps it in prose or a fence.
 * An answer with no readable verdict is a failure to decide, not a false one.
 */
export function parseVerdict(answer: string): Verdict {
  for (const candidate of extractJsonCandidates(answer)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const verdict = parsed as { ok?: unknown; reason?: unknown };
    if (typeof verdict?.ok === "boolean") {
      return { ok: verdict.ok, reason: typeof verdict.reason === "string" ? verdict.reason : "" };
    }
  }
  throw new Error(`judgeByLlm: no verdict in the model's answer (${truncate(answer, 200)})`);
}
