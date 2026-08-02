import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileP } from "../drift/affected.ts";
import * as log from "./logger.ts";
import { resolveProfileEnv } from "./options.ts";

// Driven through `resolveProfileEnv` with no profile: that a run without
// --hub-profile still gets warned is the point of where the check sits, and
// testing the warning anywhere else would not cover it.
describe("repo-local profile files", () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccqa-repo-local-profiles-"));
    warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const writeProfile = async () => {
    await mkdir(join(dir, ".ccqa/profiles"), { recursive: true });
    await writeFile(join(dir, ".ccqa/profiles/stg.env"), "BASE_URL=https://example.test\n", "utf8");
  };

  test("says the file is not read when one is present", async () => {
    await writeProfile();

    await resolveProfileEnv({ profile: undefined, project: "", cwd: dir });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("does not read repo-local profile files"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(".ccqa/profiles/stg.env"));
  });

  test("stays quiet when there is none", async () => {
    await resolveProfileEnv({ profile: undefined, project: "", cwd: dir });

    expect(warn).not.toHaveBeenCalled();
  });

  test("calls a tracked file a committed credential", async () => {
    await writeProfile();
    const git = (...args: string[]) => execFileP("git", args, { cwd: dir });
    await git("init", "--initial-branch=main");
    await git("add", "-A");

    await resolveProfileEnv({ profile: undefined, project: "", cwd: dir });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("tracked by git: .ccqa/profiles/stg.env"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Rotate those values"));
  });
});
