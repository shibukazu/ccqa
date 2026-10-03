import { createHash } from "node:crypto";
import type { TestCase } from "../cases/case.ts";
import { isExpandedActionStep } from "../spec/expand.ts";
import { SETUP_STEP_ID } from "./types.ts";

/**
 * What each step was asked to do when it was recorded, by step id. Case-level
 * checks land on whichever step the recorder chose, so they are part of every
 * step's; setup has no text of its own and stands for the case's context.
 */
export function stepDigests(
  testCase: Pick<TestCase, "steps" | "cleanup" | "expectations" | "cleanupExpectations" | "context">,
): Record<string, string> {
  return {
    [SETUP_STEP_ID]: digest(testCase.context),
    ...Object.fromEntries(
      testCase.steps
        .filter(isExpandedActionStep)
        .map((s) => [s.id, digest([s.instruction, s.expected, testCase.expectations])]),
    ),
    ...Object.fromEntries(
      testCase.cleanup.map((s) => [s.id, digest([s.instruction, s.expected, testCase.cleanupExpectations])]),
    ),
  };
}

/**
 * The steps whose previous commands may be replayed: those still asked to do
 * what they were then. An edited, added or renumbered step, or any step of a
 * recording without digests, would replay what the old step asked.
 */
export function unchangedSteps(
  previous: Readonly<Record<string, string>> | undefined,
  current: Readonly<Record<string, string>>,
): Set<string> {
  return new Set(Object.keys(current).filter((id) => previous?.[id] !== undefined && previous[id] === current[id]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
