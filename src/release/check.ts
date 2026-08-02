/**
 * The release gate: classify what a release does to a deployed hub, publish
 * the answer, and stop the release when it contradicts the chosen bump
 * (ADR-0018). Run by `.github/workflows/release.yml` before the version is
 * bumped, so the diff it reads is the release's own changes.
 *
 *   node --experimental-strip-types src/release/check.ts --bump minor
 *
 * Not part of the `ccqa` CLI and not bundled into `dist/` — this is repo
 * tooling, and the only reason it lives under `src/` is so `pnpm typecheck`
 * and `pnpm test` cover it.
 */

import { readFile, writeFile, appendFile } from "node:fs/promises";

import { execFileP } from "../drift/affected.ts";
import { classifyRelease, isBump, renderVerdict, type Bump } from "./hub-impact.ts";
import { extractRoutes, extractSchemaNames, removedNames } from "./wire-surface.ts";

/** The files that declare the wire surface; see `wire-surface.ts`. */
const ROUTE_FILE = "src/hub/api/server.ts";
const SCHEMA_FILES = ["src/hub/contract/schema.ts", "src/report/schema.ts"];

/** A file a revision does not have declares nothing, which is not a removal. */
const orEmpty = (): string => "";

interface Args {
  bump: Bump;
  base: string | null;
  override: string | null;
  notesOut: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (flag === undefined || !flag.startsWith("--")) fail(`unexpected argument "${flag}"`);
    flags.set(flag.slice(2), argv[i + 1] ?? "");
  }
  const bump = flags.get("bump") ?? "";
  if (!isBump(bump)) fail(`--bump must be patch, minor or major (got "${bump}")`);
  return {
    bump,
    base: flags.get("base") || null,
    override: flags.get("override")?.trim() || null,
    notesOut: flags.get("notes-out") || null,
  };
}

function fail(message: string): never {
  console.error(`release check: ${message}`);
  process.exit(2);
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

const resolves = (ref: string) =>
  git("rev-parse", "--verify", `${ref}^{commit}`).then(
    () => true,
    () => false,
  );

/**
 * What this release is measured against: `--base` if given, otherwise the
 * newest release tag HEAD descends from, and null when there is none.
 *
 * Version-sorted rather than `git describe`, so a tag added out of order does
 * not become the baseline. A gap — tags deleted, or releases cut by hand —
 * needs no special case: the diff then covers everything since the last tag
 * that survives, which is the right baseline for "what is a hub running the
 * released version missing".
 */
async function resolveBase(explicit: string | null): Promise<string | null> {
  if (explicit !== null) {
    if (!(await resolves(explicit))) fail(`--base "${explicit}" is not a commit in this repository`);
    return explicit;
  }
  const out = await git("tag", "--list", "v*", "--sort=-v:refname", "--merged", "HEAD");
  const tag = out.split("\n").find((line) => line.trim() !== "")?.trim();
  // A tag can be listed but unresolvable in a shallow clone.
  return tag !== undefined && (await resolves(tag)) ? tag : null;
}

async function changedPaths(base: string): Promise<string[]> {
  // `--no-renames` so a file moved out of the hub keeps both of its paths;
  // rename detection would report only the destination.
  const out = await git("diff", "--name-only", "--no-renames", `${base}..HEAD`);
  return out.split("\n").filter((line) => line.trim() !== "");
}

async function wireSurface(readSource: (path: string) => Promise<string>): Promise<string[]> {
  const routes = extractRoutes(await readSource(ROUTE_FILE));
  const schemas = await Promise.all(SCHEMA_FILES.map(async (path) => extractSchemaNames(await readSource(path))));
  return [routes, ...schemas].flat();
}

/** What `base` declared and the tree about to be released no longer does. */
async function removedSince(base: string): Promise<string[]> {
  return removedNames(
    await wireSurface((path) => git("show", `${base}:${path}`).catch(orEmpty)),
    await wireSurface((path) => readFile(path, "utf8").catch(orEmpty)),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = await resolveBase(args.base);

  const verdict = classifyRelease({
    bump: args.bump,
    changedPaths: base === null ? null : await changedPaths(base),
    removedWireNames: base === null ? [] : await removedSince(base),
  });

  const markdown = renderVerdict(verdict, { base, override: args.override });
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (args.notesOut) await writeFile(args.notesOut, markdown);

  if (verdict.disagreement && args.override === null) process.exitCode = 1;
}

// A git call that failed leaves the release unclassified, which must read as
// "the gate could not run" rather than as a stack trace mid-release.
await main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
