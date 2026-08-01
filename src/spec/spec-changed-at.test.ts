import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileP } from "../drift/affected.ts";
import { readSpecChangedAt, specKeyOf } from "./spec-changed-at.ts";

describe("specKeyOf", () => {
  test("names the case a path belongs to, whatever file it is", () => {
    // Generated code moving is as much a change to the test as spec.yaml is.
    expect(specKeyOf(".ccqa/features/f/test-cases/s/spec.yaml")).toBe("f/s");
    expect(specKeyOf(".ccqa/features/f/test-cases/s/test.spec.ts")).toBe("f/s");
  });

  test("ignores paths outside a case directory", () => {
    expect(specKeyOf(".ccqa/blocks/login.yaml")).toBeNull();
    expect(specKeyOf("src/app.ts")).toBeNull();
  });
});

describe("readSpecChangedAt", () => {
  test("reports each case's newest commit, and nothing outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-changed-at-"));
    try {
      // Outside a repository the answer is empty, and every caller falls back
      // to the deploy-only comparison rather than treating a spec as fresh.
      expect((await readSpecChangedAt(dir)).size).toBe(0);

      // committer date は既定で「いま」なので、2 つのコミットを区別するには
      // 明示的に渡す必要がある (--date は author 側しか動かさない)。
      const git = (...args: string[]) => execFileP("git", args, { cwd: dir });
      const gitAt = (when: string, ...args: string[]) =>
        execFileP("git", args, {
          cwd: dir,
          env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
        });
      await git("init", "--initial-branch=main");
      await git("config", "user.email", "t@e.x");
      await git("config", "user.name", "t");

      const caseDir = async (feature: string, spec: string, body: string) => {
        const d = join(dir, ".ccqa/features", feature, "test-cases", spec);
        await mkdir(d, { recursive: true });
        await writeFile(join(d, "spec.yaml"), body, "utf8");
      };

      await caseDir("f", "old", "a");
      await caseDir("f", "new", "a");
      await git("add", "-A");
      await gitAt("2020-01-01T00:00:00Z", "commit", "-m", "both", "--no-gpg-sign");

      await caseDir("f", "new", "b");
      await git("add", "-A");
      await gitAt("2021-01-01T00:00:00Z", "commit", "-m", "only new", "--no-gpg-sign");

      const got = await readSpecChangedAt(dir);
      expect(got.has("f/old")).toBe(true);
      expect(got.has("f/new")).toBe(true);
      // The second commit touched only one case, so the two must differ.
      expect(got.get("f/new")! > got.get("f/old")!).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
