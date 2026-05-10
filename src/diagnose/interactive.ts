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
    process.stdout.write(prefixLines(diff, "[fix]   "));
    process.stdout.write("\n");
  }
  process.stdout.write("\n");
}

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
