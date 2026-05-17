import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { invokeClaudeStreaming } from "../claude/invoke.ts";
import { extractJsonBlock } from "../claude/extract-json.ts";
import {
  buildDraftPrompt,
  buildDraftSystemPrompt,
  buildNamingPrompt,
  buildNamingSystemPrompt,
  type ExistingFeatureTree,
} from "../prompts/draft.ts";
import { parseTestSpec } from "../spec/parser.ts";
import {
  ensureCcqaDir,
  listFeatureTree,
  loadAvailableBlocks,
  parseSpecPath,
  saveSpecFile,
  tryReadSpecFile,
} from "../store/index.ts";
import {
  DRAFT_CATEGORY_LABEL,
  DraftNamingSchema,
  DraftReportSchema,
  type DraftIssue,
  type DraftNaming,
  type DraftReport,
} from "../types.ts";
import * as log from "./logger.ts";

const CATEGORY_LABEL = DRAFT_CATEGORY_LABEL;

export const draftCommand = new Command("draft")
  .argument("[feature/spec]", "Optional spec path (e.g. tasks/create-and-complete). If omitted, Claude proposes one from your intent.")
  .description("Interactively draft and refine a spec.yaml with Claude Code")
  .option("--instruction <text>", "Non-interactive single-shot instruction (skips the interactive loop)")
  .option("--apply", "Auto-apply each generated patch without [y/N] confirmation", false)
  .action(async (specPath: string | undefined, opts: { instruction?: string; apply?: boolean }) => {
    await ensureCcqaDir();

    let featureName: string;
    let specName: string;
    let prefilledIntent: string | null = null;

    if (specPath) {
      ({ featureName, specName } = parseSpecPath(specPath));
    } else {
      const { naming, intent } = await proposeNaming(opts);
      featureName = naming.featureName;
      specName = naming.specName;
      prefilledIntent = intent;
    }

    await runDraft(featureName, specName, opts, prefilledIntent);
  });

interface DraftOptions {
  instruction?: string;
  apply?: boolean;
}

async function runDraft(
  featureName: string,
  specName: string,
  opts: DraftOptions,
  /**
   * If we already collected the user's intent during the naming phase,
   * reuse it for the very first turn instead of prompting again.
   */
  prefilledIntent: string | null,
): Promise<void> {
  log.header("draft", `${featureName}/${specName}`);

  const oneShot = opts.instruction !== undefined;
  let useIntentOnce = prefilledIntent !== null && !oneShot;

  while (true) {
    // Re-read on each iteration so changes the user makes in their editor
    // between turns are picked up.
    const existing = await tryReadSpecFile(featureName, specName);
    const isFirstRun = existing === null;

    let userInput: string;
    if (oneShot) {
      userInput = opts.instruction ?? "";
    } else if (useIntentOnce && isFirstRun) {
      userInput = prefilledIntent ?? "";
      useIntentOnce = false;
    } else {
      userInput = await prompt(
        isFirstRun
          ? "What do you want to test? > "
          : "How would you like to refine? (empty = re-validate) > ",
      );
    }

    if (isFirstRun && !userInput.trim()) {
      log.error("intent required for the first draft (no spec exists yet)");
      process.exit(1);
    }

    const turnResult = await runOneTurn({
      featureName,
      specName,
      existing,
      userInput: userInput.trim(),
      autoApply: opts.apply === true,
    });

    if (oneShot) {
      process.exit(turnResult.hasError && !turnResult.applied ? 1 : 0);
    }

    // After every turn, ask whether the user is done. yes ⇒ exit; no ⇒ another turn.
    log.blank();
    const done = /^y/i.test(await prompt("Are you done with this draft? [y/N] "));
    if (done) {
      log.info("draft session complete.");
      log.hint(`run 'ccqa trace ${featureName}/${specName}' to record actions`);
      process.exit(0);
    }
  }
}

interface TurnInput {
  featureName: string;
  specName: string;
  existing: string | null;
  userInput: string;
  autoApply: boolean;
}

interface TurnResult {
  hasError: boolean;
  applied: boolean;
}

async function runOneTurn(input: TurnInput): Promise<TurnResult> {
  const { featureName, specName, existing, userInput, autoApply } = input;
  const isFirstRun = existing === null;

  const blocks = await loadAvailableBlocks();
  const systemPrompt = buildDraftSystemPrompt(blocks);
  const userPrompt = buildDraftPrompt({
    mode: isFirstRun ? "create" : "refine",
    existing: existing ?? "",
    userInput,
  });

  log.info(
    isFirstRun
      ? "Reading codebase and drafting spec..."
      : "Re-validating spec against codebase...",
  );

  const toolCounts: Record<string, number> = {};
  const startedAt = Date.now();
  const { result, isError } = await invokeClaudeStreaming(
    {
      prompt: userPrompt,
      systemPrompt,
      allowedTools: ["Read", "Grep", "Glob"],
      silenceBashLog: true,
    },
    (msg: SDKMessage) => {
      if (msg.type !== "assistant") return;
      for (const block of msg.message.content ?? []) {
        if (block.type === "tool_use") {
          toolCounts[block.name] = (toolCounts[block.name] ?? 0) + 1;
        }
      }
    },
  );
  printToolSummary(toolCounts, Date.now() - startedAt);

  if (isError) {
    log.error("Claude returned an error result");
    return { hasError: true, applied: false };
  }

  const json = extractJsonBlock(result);
  if (!json) {
    log.error("Claude did not return a json block");
    log.warn(`raw tail: ${truncate(result, 200)}`);
    return { hasError: true, applied: false };
  }

  let report: DraftReport;
  try {
    report = DraftReportSchema.parse(JSON.parse(json));
  } catch (e) {
    log.error(`failed to parse draft report: ${(e as Error).message}`);
    return { hasError: true, applied: false };
  }

  const hasError = printReviewBlock(report.issues);

  const original = existing ?? "";
  if (!report.patch || report.patch === original) {
    log.blank();
    log.info("no changes proposed.");
    return { hasError, applied: false };
  }

  log.blank();
  log.info("--- proposed changes ---");
  printUnifiedDiff(original, report.patch);
  log.blank();

  const apply = autoApply
    ? true
    : /^y/i.test(await prompt("Apply this patch? [y/N] "));

  if (!apply) {
    log.info("aborted — no changes applied.");
    return { hasError, applied: false };
  }

  try {
    parseTestSpec(report.patch);
  } catch (e) {
    log.error(`refused to apply: patch failed validation (${(e as Error).message})`);
    return { hasError: true, applied: false };
  }

  const saved = await saveSpecFile(featureName, specName, report.patch);
  log.meta("saved", saved);
  return { hasError, applied: true };
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(130);
  });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Aggregated tool-call counts shown after each Claude turn. */
export function formatToolSummary(counts: Record<string, number>, elapsedMs: number): string {
  const entries = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${n} ${name}`);
  const tools = entries.length === 0 ? "no tool calls" : entries.join(", ");
  const seconds = (elapsedMs / 1000).toFixed(1);
  return `  ✓ ${tools}  (${seconds}s)`;
}

function printToolSummary(counts: Record<string, number>, elapsedMs: number): void {
  process.stdout.write(`${formatToolSummary(counts, elapsedMs)}\n`);
}

/**
 * Renders the review report as a visually separated block, grouped by
 * severity. ERROR and WARN findings get full detail; OK findings collapse
 * to a one-line summary of category names. Returns whether any ERROR
 * severity was emitted.
 */
export function printReviewBlock(issues: DraftIssue[]): boolean {
  const RULE = "─".repeat(67);
  const errors = issues.filter((i) => i.severity === "ERROR");
  const warnings = issues.filter((i) => i.severity === "WARN");
  const passed = issues.filter((i) => i.severity === "OK");

  const headerParts: string[] = [];
  if (errors.length) headerParts.push(`${errors.length} error${errors.length > 1 ? "s" : ""}`);
  if (warnings.length) headerParts.push(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}`);
  if (passed.length) headerParts.push(`${passed.length} passed`);
  const headerSuffix = headerParts.length ? `  (${headerParts.join(", ")})` : "";
  const ruleLen = Math.max(0, 60 - headerSuffix.length);
  process.stdout.write(`\n── Review${headerSuffix} ${"─".repeat(ruleLen)}\n\n`);

  if (issues.length === 0) {
    process.stdout.write("  (no findings)\n");
    process.stdout.write(`\n${RULE}\n\n`);
    return false;
  }

  if (errors.length) {
    process.stdout.write(`  ERRORS (${errors.length})\n`);
    for (const issue of errors) writeFinding(issue);
    process.stdout.write("\n");
  }

  if (warnings.length) {
    process.stdout.write(`  WARNINGS (${warnings.length})\n`);
    for (const issue of warnings) writeFinding(issue);
    process.stdout.write("\n");
  }

  if (passed.length) {
    const names = passed.map((i) => CATEGORY_LABEL[i.category]).join(", ");
    process.stdout.write(`  PASSED (${passed.length})\n    ${names}\n`);
  }

  process.stdout.write(`\n${RULE}\n\n`);
  return errors.length > 0;
}

function writeFinding(issue: DraftIssue): void {
  const stepPart = issue.stepId ? `  ${issue.stepId}` : "";
  process.stdout.write(`    ${CATEGORY_LABEL[issue.category]}${stepPart}\n`);
  process.stdout.write(`      ${issue.message}\n`);
  if (issue.detail) {
    process.stdout.write(`      └ ${issue.detail.replace(/\n/g, "\n        ")}\n`);
  }
}

async function proposeNaming(
  opts: DraftOptions,
): Promise<{ naming: { featureName: string; specName: string }; intent: string }> {
  const oneShot = opts.instruction !== undefined;

  const intent = oneShot
    ? (opts.instruction ?? "")
    : await prompt("What do you want to test? > ");

  if (!intent.trim()) {
    log.error("intent required to propose a feature/spec name");
    process.exit(1);
  }

  const tree = await listFeatureTree();
  const treeForPrompt: ExistingFeatureTree[] = tree.map((f) => ({
    featureName: f.featureName,
    specs: f.specs.map((s) => ({ specName: s.specName })),
  }));

  log.info("Proposing a feature/spec name based on your intent...");
  const { result, isError } = await invokeClaudeStreaming(
    {
      silenceBashLog: true,
      prompt: buildNamingPrompt(intent.trim(), treeForPrompt),
      systemPrompt: buildNamingSystemPrompt(),
      allowedTools: ["Read", "Grep", "Glob"],
    },
    () => {},
  );

  if (isError) {
    log.error("Claude failed during naming");
    process.exit(1);
  }

  const json = extractJsonBlock(result);
  if (!json) {
    log.error("Claude did not return a json block for naming");
    process.exit(1);
  }

  let proposed: DraftNaming;
  try {
    proposed = DraftNamingSchema.parse(JSON.parse(json));
  } catch (e) {
    log.error(`failed to parse naming response: ${(e as Error).message}`);
    process.exit(1);
  }

  const sanitized = {
    featureName: sanitizeNamePart(proposed.featureName),
    specName: sanitizeNamePart(proposed.specName),
  };
  if (!sanitized.featureName || !sanitized.specName) {
    log.error(`Claude returned an invalid name: ${proposed.featureName}/${proposed.specName}`);
    process.exit(1);
  }

  // If somehow the proposed pair already exists, append a numeric suffix.
  const final = ensureUnique(tree, sanitized.featureName, sanitized.specName);

  log.meta("proposed", `${final.featureName}/${final.specName}`);
  if (proposed.reason) log.meta("reason", proposed.reason);

  if (oneShot || opts.apply === true) {
    return { naming: final, intent: intent.trim() };
  }

  const answer = await prompt(`Use this name? [y/N/edit] > `);
  if (/^y/i.test(answer)) {
    return { naming: final, intent: intent.trim() };
  }
  if (/^e/i.test(answer)) {
    const manual = await prompt("Enter feature/spec (e.g. tasks/create-and-complete) > ");
    const parts = manual.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      log.error(`invalid spec path: "${manual}". Expected "<feature>/<spec>"`);
      process.exit(1);
    }
    const featureName = sanitizeNamePart(parts[0]);
    const specName = sanitizeNamePart(parts[1]);
    if (!featureName || !specName) {
      log.error(`invalid characters in name: ${parts[0]}/${parts[1]}`);
      process.exit(1);
    }
    return { naming: { featureName, specName }, intent: intent.trim() };
  }
  log.info("aborted — no draft created.");
  process.exit(0);
}

/**
 * Restrict to kebab-case-friendly characters: lowercase letters, digits, hyphen.
 * Anything else is dropped or replaced with '-'. Collapses repeated/edge hyphens.
 */
export function sanitizeNamePart(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function ensureUnique(
  tree: Array<{ featureName: string; specs: Array<{ specName: string }> }>,
  featureName: string,
  specName: string,
): { featureName: string; specName: string } {
  const feature = tree.find((f) => f.featureName === featureName);
  if (!feature) return { featureName, specName };
  const taken = new Set(feature.specs.map((s) => s.specName));
  if (!taken.has(specName)) return { featureName, specName };
  for (let i = 2; i < 100; i++) {
    const candidate = `${specName}-${i}`;
    if (!taken.has(candidate)) return { featureName, specName: candidate };
  }
  return { featureName, specName: `${specName}-${Date.now()}` };
}

export { extractJsonBlock } from "../claude/extract-json.ts";

export function printUnifiedDiff(before: string, after: string): void {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lines = computeLineDiff(beforeLines, afterLines);
  for (const line of lines) {
    process.stdout.write(line + "\n");
  }
}

type DiffLine = { kind: "ctx" | "add" | "del"; text: string };

function computeLineDiff(a: string[], b: string[]): string[] {
  // Minimal LCS-based diff; sufficient for spec-sized files.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });

  return out.map((l) => (l.kind === "add" ? `+ ${l.text}` : l.kind === "del" ? `- ${l.text}` : `  ${l.text}`));
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}
