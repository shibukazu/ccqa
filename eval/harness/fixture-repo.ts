import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Mutation } from "./cases.ts";
import { applyMutations } from "./mutate.ts";

const execFileP = promisify(execFile);

/**
 * The app dir is a working dev checkout, so it accumulates installed and
 * generated state (`pnpm install`, a booted app's database, Vite's cache).
 * The app's own .gitignore is the authority on what is not source; this
 * filter exists only because `fs.cp` does not consult it the way
 * `git add -A` would — and `git add -A` in the case repo still applies the
 * real rules, so the filter is a copy-time optimization, not a gate. Only
 * plain names are honored here; anchored or glob patterns are left to git.
 * ".DS_Store" is skipped unconditionally.
 */
const SKIPPED_NAMES = new Set([".DS_Store", ...readAppIgnoreNames()]);

function readAppIgnoreNames(): string[] {
  let raw: string;
  try {
    raw = readFileSync(new URL("../app/.gitignore", import.meta.url), "utf8");
  } catch (err) {
    throw new Error("eval/app/.gitignore is missing — the fixture copy filter derives its skip list from it", {
      cause: err,
    });
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/\/$/, ""))
    .filter((name) => !name.includes("/") && !name.includes("*"));
}

export interface CaseRepo {
  /** Root of the throwaway checkout; also the cwd the ccqa commands run in. */
  dir: string;
  /** The baseline commit — what `select-specs --base` diffs against. */
  baseSha: string;
  /** The mutated commit, checked out as HEAD. */
  headSha: string;
  cleanup: () => Promise<void>;
}

/**
 * Materialize one case as a real two-commit git repo in a temp dir: the
 * baseline app as commit one, the mutations as commit two. A real repo rather
 * than two directory copies because that is what the commands under test
 * consume — `select-specs` diffs commits, and the audit reads a checkout.
 */
export async function buildCaseRepo(appDir: string, mutations: readonly Mutation[]): Promise<CaseRepo> {
  const dir = await mkdtemp(join(tmpdir(), "ccqa-eval-"));
  try {
    await cp(appDir, dir, { recursive: true, filter: (src) => !SKIPPED_NAMES.has(basename(src)) });
    await git(dir, "init", "--initial-branch=main");
    await git(dir, "config", "user.email", "eval@example.com");
    await git(dir, "config", "user.name", "ccqa eval");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-m", "baseline", "--no-gpg-sign");
    const baseSha = await head(dir);
    await applyMutations(dir, mutations);
    await git(dir, "add", "-A");
    // The empty commit carries the zero-mutation baseline case: two commits
    // always exist, so callers never special-case "base equals head". With
    // mutations declared it stays off — an empty diff then means the writes
    // never reached this checkout, which must fail, not score.
    await git(dir, "commit", "-m", "mutation", "--no-gpg-sign", ...(mutations.length === 0 ? ["--allow-empty"] : []));
    const headSha = await head(dir);
    return { dir, baseSha, headSha, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileP("git", args, { cwd });
}

async function head(cwd: string): Promise<string> {
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}
