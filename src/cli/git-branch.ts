import { execFileP } from "../drift/affected.ts";

/** Best-effort current branch: CI env vars first, then git, else null. */
export async function detectBranch(cwd: string): Promise<string | null> {
  const fromEnv = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/** Best-effort current commit SHA, or null (e.g. not a git repo). */
export async function getGitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
