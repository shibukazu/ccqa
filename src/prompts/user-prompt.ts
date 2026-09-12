import { readFile } from "node:fs/promises";
import type { HubContext } from "../cli/hub-conn.ts";
import * as log from "../cli/logger.ts";
import { resolvePromptLocalPath, type PromptName } from "./prompt-names.ts";

/**
 * Where a `.user` prompt is read from.
 *
 * These are the prompts a person writes, and a project that keeps one in its
 * own tree is the ordinary case: it is versioned with the tests it governs and
 * reviewed in the same pull request. The hub answers for a project that keeps
 * it there instead — and a hub is not required to have one at all.
 *
 * The `.agent` prompts have no local form: ccqa writes those itself, at run
 * time, and they have to outlive a checkout.
 */
export interface UserPrompt {
  text: string | null;
  /** True when the project's own copy answered. */
  local: boolean;
}

/** Trim + empty-to-null, applied to either source. */
export function normalizePromptText(content: string | null): string | null {
  const trimmed = content?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

/**
 * The project's copy when it has one, the hub's otherwise. Never both: they
 * are prose, and concatenating two of them puts contradicting instructions in
 * one prompt with nothing to say which is meant.
 */
export async function readUserPrompt(
  ctx: HubContext | null,
  name: PromptName,
  cwd: string,
): Promise<UserPrompt> {
  const path = resolvePromptLocalPath(name, cwd);
  const local = normalizePromptText(await readLocal(path));
  if (local !== null) {
    // A file the project wrote and a document on the hub can say different
    // things, and only one of them is used. Said where both could answer, so
    // a copy pulled months ago cannot quietly outrank an edit made today.
    if (ctx) log.warn(`${name}: using ${path} — the hub's copy is not read`);
    return { text: local, local: true };
  }
  if (!ctx) return { text: null, local: false };
  return { text: normalizePromptText(await ctx.hub.getPrompt(ctx.project, name)), local: false };
}

/**
 * Absent is the only thing that falls through to the hub. A file that is
 * there but cannot be read is a project asking for guidance it is not
 * getting, and answering with somebody else's would be worse than stopping.
 */
async function readLocal(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
}
