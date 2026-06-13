import { createInterface, type Interface } from "node:readline";
import type { Diagnosis, DiagnosisResult } from "./types.ts";

export type InteractiveChoice = "apply" | "skip" | "manual" | "quit";

export interface InteractivePromptInput {
  result: DiagnosisResult;
  diff: string | null;
  failureExcerpt: string;
}

export async function promptForChoice(input: InteractivePromptInput): Promise<InteractiveChoice> {
  printContext(input);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await question(rl, "[a]pply / [s]kip / [m]anual / [q]uit > ")).trim().toLowerCase();
      switch (answer) {
        case "a":
        case "apply":
          return "apply";
        case "s":
        case "skip":
          return "skip";
        case "m":
        case "manual":
          return "manual";
        case "q":
        case "quit":
          return "quit";
        default:
          process.stdout.write("  please answer a/s/m/q\n");
      }
    }
  } finally {
    rl.close();
  }
}

function question(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function printContext({ result, diff, failureExcerpt }: InteractivePromptInput): void {
  const { diagnosis, confidence, reasoning } = result;
  process.stdout.write("\n");
  process.stdout.write(`[fix] diagnosis: ${diagnosis.type} (confidence ${confidence.toFixed(2)})\n`);
  if (reasoning) process.stdout.write(`[fix] reasoning: ${reasoning}\n`);
  for (const line of formatDiagnosisDetail(diagnosis)) {
    process.stdout.write(`[fix] ${line}\n`);
  }

  if (failureExcerpt) {
    process.stdout.write("\n[fix] failure excerpt:\n");
    process.stdout.write(prefixLines(failureExcerpt, "[fix]   "));
    process.stdout.write("\n");
  }

  if (diff) {
    process.stdout.write("\n[fix] proposed fix:\n");
    process.stdout.write(formatDiff(diff, "[fix]   "));
    process.stdout.write("\n");
  }
  process.stdout.write("\n");
}

/**
 * Per-line ANSI coloring for the unified diff returned by previewDiff(). The
 * prefix is kept dim so the eye focuses on the change column; -/+ rows get
 * GitHub-ish red/green, hunk headers cyan. Falls back to plain text when
 * stdout is not a TTY or NO_COLOR is set (per the no-color.org convention),
 * and accepts CLICOLOR_FORCE=1 as the standard opt-in override.
 */
function formatDiff(diff: string, prefix: string): string {
  const color = wantsColor();
  return diff
    .split("\n")
    .map((line) => `${color ? `${C.dim}${prefix}${C.reset}` : prefix}${colorizeDiffLine(line, color)}`)
    .join("\n");
}

function colorizeDiffLine(line: string, color: boolean): string {
  if (!color) return line;
  if (line.startsWith("@@")) return `${C.cyan}${C.bold}${line}${C.reset}`;
  if (line.startsWith("+")) return `${C.green}${line}${C.reset}`;
  if (line.startsWith("-")) return `${C.red}${line}${C.reset}`;
  return line;
}

function wantsColor(): boolean {
  if (process.env["CLICOLOR_FORCE"] === "1") return true;
  if (process.env["NO_COLOR"] != null) return false;
  return Boolean(process.stdout.isTTY);
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

function formatDiagnosisDetail(diagnosis: Diagnosis): string[] {
  switch (diagnosis.type) {
    case "TIMING_ISSUE": {
      const fixes = diagnosis.fixes
        .map((f) =>
          f.kind === "insert"
            ? `insert ${f.seconds}s @ line ${f.line}`
            : `increase to ${f.increase_to}s @ line ${f.line}`,
        )
        .join(", ");
      return [`fixes: ${fixes}`];
    }
    case "OVER_ASSERTION":
      return [`lines: ${diagnosis.lines.join(", ")}`, `reason: ${diagnosis.reason}`];
    case "SELECTOR_DRIFT":
      return [
        `line ${diagnosis.line}: "${diagnosis.oldSelector}" → "${diagnosis.newSelector}"`,
        `reason: ${diagnosis.reason}`,
      ];
    case "DATA_MISSING":
    case "UNKNOWN":
      return [`reason: ${diagnosis.reason}`];
  }
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => `${prefix}${l}`)
    .join("\n");
}
