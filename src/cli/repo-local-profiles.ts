import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileP } from "../drift/affected.ts";
import * as log from "./logger.ts";

/** Where a named profile's variables lived before profiles moved to the hub. */
const PROFILES_DIR = ".ccqa/profiles";

/**
 * Flag `.ccqa/profiles/<name>.env` files the move to hub-stored profiles left
 * behind. Warns, never fails: the run resolved its variables from the right
 * place, so the file's existence is the only thing wrong. A tracked one is
 * called out separately — that is a committed credential, not just dead weight.
 */
export async function warnRepoLocalProfiles(cwd: string): Promise<void> {
  const entries = await readdir(join(cwd, PROFILES_DIR)).catch(() => [] as string[]);
  const paths = entries
    .filter((name) => name.endsWith(".env"))
    .sort()
    .map((name) => `${PROFILES_DIR}/${name}`);
  if (paths.length === 0) return;

  log.warn(
    `ccqa does not read repo-local profile files — the values in ${paths.join(", ")} are not in ` +
      `effect for this run. Profile variables come from the hub: register them with ` +
      `\`ccqa hub var set --profile <name>\`, then delete the ${noun(paths.length)}.`,
  );

  const tracked = await trackedPaths(paths, cwd);
  if (tracked.length === 0) return;
  log.warn(
    `tracked by git: ${tracked.join(", ")} — a profile file holds credentials, so whatever is in ` +
      `there is committed. Rotate those values; deleting the ${noun(tracked.length)} now does not ` +
      `un-commit them.`,
  );
}

function noun(n: number): string {
  return n === 1 ? "file" : "files";
}

/**
 * The subset git reports as tracked. Outside a repository the question has no
 * answer, so stay silent rather than accuse or reassure on a guess.
 */
async function trackedPaths(paths: string[], cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP("git", ["ls-files", "-z", "--", ...paths], { cwd });
    return stdout.split("\0").filter((p) => p !== "");
  } catch {
    return [];
  }
}
