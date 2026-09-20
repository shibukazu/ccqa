import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileP } from "../drift/affected.ts";
import { readCaseChangedAt } from "./spec-changed-at.ts";

describe("readCaseChangedAt", () => {
  test("reports each case's newest commit, and nothing outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-changed-at-"));
    try {
      const specDoc = (feature: string, spec: string) =>
        join(dir, ".ccqa/features", feature, "test-cases", spec, "spec.yaml");
      const caseDoc = join(dir, "docs/testcase/todo/add_item.md");
      const docs = [specDoc("f", "old"), specDoc("f", "new"), caseDoc];

      // Outside a repository the answer is empty, and every caller falls back
      // to the deploy-only comparison rather than treating a case as fresh.
      expect((await readCaseChangedAt(dir, docs)).size).toBe(0);

      // The committer date defaults to "now", so two commits are only
      // distinguishable when it is passed explicitly (`--date` moves the
      // author side alone).
      const git = (...args: string[]) => execFileP("git", args, { cwd: dir });
      const gitAt = (when: string, ...args: string[]) =>
        execFileP("git", args, {
          cwd: dir,
          env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
        });
      await git("init", "--initial-branch=main");
      await git("config", "user.email", "t@e.x");
      await git("config", "user.name", "t");

      const write = async (path: string, body: string) => {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, body, "utf8");
      };

      await write(specDoc("f", "old"), "a");
      await write(specDoc("f", "new"), "a");
      // A project's own document, which lives nowhere near `.ccqa/`.
      await write(caseDoc, "## Steps\n\n1. Open it\n");
      await git("add", "-A");
      await gitAt("2020-01-01T00:00:00Z", "commit", "-m", "all", "--no-gpg-sign");

      await write(specDoc("f", "new"), "b");
      await write(caseDoc, "## Steps\n\n1. Open it twice\n");
      await git("add", "-A");
      await gitAt("2021-01-01T00:00:00Z", "commit", "-m", "only new", "--no-gpg-sign");

      const got = await readCaseChangedAt(dir, docs);
      expect(got.has(specDoc("f", "old"))).toBe(true);
      // Keyed by the document, so a case a project keeps in its own tree is
      // dated the same way ccqa's own specs are.
      expect(got.has(caseDoc)).toBe(true);
      // The second commit touched only two of the three, so they must differ.
      expect(got.get(specDoc("f", "new"))! > got.get(specDoc("f", "old"))!).toBe(true);
      expect(got.get(caseDoc)! > got.get(specDoc("f", "old"))!).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dates a case from a package below the repository root", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ccqa-changed-at-"));
    try {
      const pkg = join(repo, "packages/web");
      const doc = join(pkg, "docs/testcase/todo/add_item.md");
      await mkdir(join(doc, ".."), { recursive: true });
      await writeFile(doc, "## Steps\n\n1. Open it\n", "utf8");
      const git = (...args: string[]) => execFileP("git", args, { cwd: repo });
      await git("init", "--initial-branch=main");
      await git("config", "user.email", "t@e.x");
      await git("config", "user.name", "t");
      await git("add", "-A");
      await execFileP("git", ["commit", "-m", "the case", "--no-gpg-sign"], {
        cwd: repo,
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
          GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        },
      });

      // `--cwd packages/web`: git prints names from the repository root unless
      // told otherwise, so without `--relative` every lookup here missed and
      // the hub saw no case as ever having been edited.
      expect((await readCaseChangedAt(pkg, [doc])).get(doc)).toBeTruthy();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("ignores a document that lives outside the checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-changed-at-"));
    try {
      expect((await readCaseChangedAt(dir, [join(dir, "../elsewhere/case.md")])).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
