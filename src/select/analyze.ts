import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractJsonBlock } from "../claude/extract-json.ts";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import * as log from "../cli/logger.ts";
import type { ChangedFile } from "../drift/affected.ts";
import { buildSelectPrompt, buildSelectSystemPrompt } from "../prompts/select-specs.ts";
import { parseBlockPath, specKey } from "../store/index.ts";
import type { SpecDescription } from "./inventory.ts";
import {
  SelectModelReplySchema,
  SelectRawAnswerSchema,
  type SelectRawAnswer,
  type SelectReport,
  type SpecSelection,
} from "./types.ts";

export interface SelectSpecsInput {
  changed: readonly ChangedFile[];
  specs: readonly SpecDescription[];
  cwd: string;
  base: string;
  head: string;
  model?: string;
}

/**
 * Decide which specs a change set reaches.
 *
 * Two passes, in this order and for this reason: what can be settled by
 * looking at paths is settled that way, and only the remainder is put to a
 * model. A change to a spec's own file, or to a block it includes, means that
 * spec must re-run — that is set membership, not a judgement, and asking a
 * model would only introduce a way to get it wrong.
 */
export async function selectSpecs(input: SelectSpecsInput): Promise<SelectReport> {
  const { changed, specs, cwd, base, head, model } = input;

  const { productChanges, mechanicallyNeeded } = partitionChanges(changed, specs);
  const byInventoryKey = new Map(specs.map((s) => [specKey(s), s]));
  const byKey = new Map<string, SpecSelection>();

  for (const [key, touchedBy] of mechanicallyNeeded) {
    const spec = byInventoryKey.get(key);
    if (!spec) continue;
    byKey.set(key, {
      featureName: spec.featureName,
      specName: spec.specName,
      verdict: "needed",
      source: "mechanical",
      reason: "the spec's own definition changed, or a block it includes did",
      touchedBy,
    });
  }

  const undecided = specs.filter((s) => !byKey.has(specKey(s)));

  if (productChanges.length === 0) {
    // Nothing outside `.ccqa/` moved, so no product behaviour can have
    // changed. Clearing the rest here costs nothing and skips the model call
    // entirely — the common case on a docs-only or spec-only commit.
    for (const spec of undecided) {
      byKey.set(specKey(spec), {
        featureName: spec.featureName,
        specName: spec.specName,
        verdict: "notNeeded",
        source: "mechanical",
        reason: "no file outside .ccqa/ changed in this range",
      });
    }
  } else if (undecided.length > 0) {
    for (const selection of await judgeWithModel({ productChanges, undecided, cwd, base, head, model })) {
      byKey.set(specKey(selection), selection);
    }
  }

  return {
    base,
    head,
    changedFiles: changed.length,
    // Inventory order, so two runs over the same tree produce comparable
    // output. Every spec is decided by one of the three passes above, but
    // flatMap over a possible miss is cheaper to reason about than asserting it.
    specs: specs.flatMap((s) => byKey.get(specKey(s)) ?? []),
  };
}

/**
 * Split the diff into the part a model has to reason about and the part that
 * decides itself.
 *
 * `.ccqa/` paths are ccqa's own: a spec directory names the spec it belongs
 * to, a block names the specs that include it. Product paths carry no such
 * mapping — that is the whole problem this command exists to solve.
 */
function partitionChanges(
  changed: readonly ChangedFile[],
  specs: readonly SpecDescription[],
): { productChanges: ChangedFile[]; mechanicallyNeeded: Map<string, string[]> } {
  const productChanges: ChangedFile[] = [];
  const mechanicallyNeeded = new Map<string, string[]>();
  const addTouch = (key: string, path: string) => {
    const existing = mechanicallyNeeded.get(key);
    if (existing) existing.push(path);
    else mechanicallyNeeded.set(key, [path]);
  };

  // Reverse index built once, so a changed block is matched against its
  // including specs directly instead of scanning every spec per block file.
  const specsByBlock = new Map<string, SpecDescription[]>();
  for (const spec of specs) {
    for (const blockName of spec.includedBlocks) {
      const including = specsByBlock.get(blockName);
      if (including) including.push(spec);
      else specsByBlock.set(blockName, [spec]);
    }
  }

  for (const file of changed) {
    // A sibling package's `.ccqa/` is not ours: its spec and block names live
    // in a different tree and must not invalidate specs here.
    if (file.outsideCwd) {
      productChanges.push(file);
      continue;
    }

    const specDirKey = parseSpecDirPath(file.path);
    if (specDirKey) {
      addTouch(specDirKey, file.path);
      continue;
    }

    const blockName = parseBlockPath(file.path);
    if (blockName) {
      for (const spec of specsByBlock.get(blockName) ?? []) addTouch(specKey(spec), file.path);
      continue;
    }

    // Anything else under `.ccqa/` (config, sessions, reports) has no spec to
    // attribute it to, and is not product code either. Dropping it keeps it
    // out of the model's evidence rather than inviting a spurious match.
    if (!isCcqaPath(file.path)) productChanges.push(file);
  }

  return { productChanges, mechanicallyNeeded };
}

/** `<feature>/<spec>` for a path inside a spec's own directory, else null. */
export function parseSpecDirPath(path: string): string | null {
  const match = path.match(/(?:^|\/)\.ccqa\/features\/([^/]+)\/test-cases\/([^/]+)\//);
  return match ? `${match[1]}/${match[2]}` : null;
}

function isCcqaPath(path: string): boolean {
  return /(?:^|\/)\.ccqa\//.test(path);
}

interface JudgeInput {
  productChanges: ChangedFile[];
  undecided: SpecDescription[];
  cwd: string;
  base: string;
  head: string;
  model?: string;
}

/**
 * A malformed reply costs the whole selection, so it is worth one more call
 * before giving up. `ccqa drift` retries per spec for the same reason; this
 * call carries every undecided spec at once, so the blast radius is larger,
 * not smaller. Observed in practice: three runs over one commit produced a
 * parse failure, a clean answer, and a different clean answer.
 */
const MAX_ATTEMPTS = 2;

/**
 * One model call for the whole undecided set, not one per spec: the specs are
 * judged against the same diff, and seeing them together is what lets the
 * model tell them apart.
 *
 * A failed or unparsable reply resolves every undecided spec to `unknown`
 * rather than clearing it. The caller runs `unknown`, so a broken selection
 * degrades to running more than necessary — never to skipping something.
 */
async function judgeWithModel(input: JudgeInput): Promise<SpecSelection[]> {
  const { productChanges, undecided, cwd, base, head, model } = input;

  let parsed: unknown;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { result, isError } = await invokeClaudeStreaming(
      {
        prompt: buildSelectPrompt({ changed: productChanges, specs: undecided, base, head }),
        systemPrompt: buildSelectSystemPrompt(),
        allowedTools: ["Read", "Grep", "Glob"],
        silenceBashLog: true,
        cwd,
        ...(model ? { model } : {}),
      },
      (_msg: SDKMessage) => {},
    );

    if (isError) {
      lastError = "the selection model returned an error";
      continue;
    }
    const json = extractJsonBlock(result);
    if (!json) {
      lastError = "the selection model returned no JSON block";
      continue;
    }
    try {
      parsed = JSON.parse(json);
      lastError = "";
      break;
    } catch (e) {
      lastError = `the selection model's JSON did not parse: ${(e as Error).message}`;
    }
  }
  if (lastError) return abandonSelection(undecided, `${lastError} (${MAX_ATTEMPTS} attempts)`);

  const changedPaths = new Set(productChanges.map((f) => f.path));
  const byUndecidedKey = new Map(undecided.map((s) => [specKey(s), s]));
  const answers = new Map<string, SpecSelection>();
  for (const raw of readSpecArray(parsed)) {
    const spec = byUndecidedKey.get(raw.spec);
    if (!spec) continue;
    answers.set(raw.spec, {
      featureName: spec.featureName,
      specName: spec.specName,
      verdict: raw.verdict,
      source: "model",
      reason: raw.reason,
      ...(raw.verdict === "needed"
        // Keep only paths that really are in the diff: a cited path the model
        // invented is not evidence, and the UI shows these as the reason.
        ? { touchedBy: raw.touchedBy.filter((p) => changedPaths.has(p)) }
        : {}),
    });
  }

  const missing = undecided.filter((s) => !answers.has(specKey(s)));
  if (missing.length > 0) {
    log.warn(`select-specs: the model omitted ${missing.length} spec(s); treating them as unknown`);
  }
  return [
    ...answers.values(),
    ...allUnknown(missing, "the selection model did not return a verdict for this spec"),
  ];
}

/**
 * Pull the well-formed entries out of the model's reply, ignoring the rest.
 * Validated per element (`safeParse`), not as one `z.array(...)`, so one
 * malformed entry doesn't discard every other spec's verdict — see
 * `SelectRawAnswerSchema`'s doc.
 */
function readSpecArray(parsed: unknown): SelectRawAnswer[] {
  const reply = SelectModelReplySchema.safeParse(parsed);
  if (!reply.success) return [];

  const out: SelectRawAnswer[] = [];
  for (const entry of reply.data.specs) {
    const raw = SelectRawAnswerSchema.safeParse(entry);
    if (raw.success) out.push(raw.data);
  }
  return out;
}

/**
 * The selection call failed as a whole: every spec becomes `unknown`, and the
 * reason is warned about rather than only recorded per spec.
 *
 * Without the warning the caller reports "N specs could not be decided" and
 * runs them all — which is the safe outcome, but indistinguishable from a
 * genuinely ambiguous diff. A wrong model name or an expired credential would
 * quietly cost a full suite run every time.
 */
function abandonSelection(specs: readonly SpecDescription[], reason: string): SpecSelection[] {
  log.warn(`select-specs: ${reason} — every spec is left undecided and will run`);
  return allUnknown(specs, reason);
}

function allUnknown(specs: readonly SpecDescription[], reason: string): SpecSelection[] {
  return specs.map((s) => ({
    featureName: s.featureName,
    specName: s.specName,
    verdict: "unknown" as const,
    source: "model" as const,
    reason,
  }));
}
