import type { StepStatus } from "../types.ts";

const STEP_ICONS: Record<StepStatus, string> = {
  STEP_START: "▶",
  STEP_DONE: "✓",
  ASSERTION_FAILED: "✗",
  STEP_SKIPPED: "⊘",
  RUN_COMPLETED: "■",
};

export function header(command: string, target?: string): void {
  process.stdout.write(`\nccqa ${command}${target ? ` ${target}` : ""}\n\n`);
}

export function meta(key: string, value: string | number): void {
  process.stdout.write(`  ${key}: ${value}\n`);
}

export function blank(): void {
  process.stdout.write("\n");
}

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function step(type: StepStatus, stepId: string, detail: string): void {
  process.stdout.write(`  ${STEP_ICONS[type]} [${stepId}] ${detail}\n`);
}

export function bash(command: string): void {
  process.stdout.write(`  $ ${command.slice(0, 120)}\n`);
}

export function error(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`warn: ${message}\n`);
}

export function hint(message: string): void {
  process.stdout.write(`\nhint: ${message}\n`);
}
