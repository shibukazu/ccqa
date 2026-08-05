import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMutations, MutationError, validateMutations } from "./mutate.ts";

describe("applyMutations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccqa-eval-mutate-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces a unique match", async () => {
    await writeFile(join(dir, "a.txt"), "one two three", "utf8");
    await applyMutations(dir, [{ file: "a.txt", search: "two", replace: "2" }]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one 2 three");
  });

  it("keeps replacement-pattern characters literal", async () => {
    await writeFile(join(dir, "a.txt"), "value", "utf8");
    await applyMutations(dir, [{ file: "a.txt", search: "value", replace: "$&-${x}" }]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("$&-${x}");
  });

  it("deletes a file", async () => {
    await writeFile(join(dir, "gone.txt"), "x", "utf8");
    await applyMutations(dir, [{ file: "gone.txt", delete: true }]);
    await expect(readFile(join(dir, "gone.txt"), "utf8")).rejects.toThrow();
  });

  it("applies several mutations to the same file in order", async () => {
    await writeFile(join(dir, "a.txt"), "one two three", "utf8");
    await applyMutations(dir, [
      { file: "a.txt", search: "one", replace: "1" },
      { file: "a.txt", search: "three", replace: "3" },
    ]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("1 two 3");
  });

  // An earlier mutation's `replace` must not manufacture a later mutation's
  // match: every search is counted against the untouched baseline first.
  it("rejects a search that only exists after an earlier mutation ran", async () => {
    await writeFile(join(dir, "a.txt"), "alpha", "utf8");
    await expect(
      applyMutations(dir, [
        { file: "a.txt", search: "alpha", replace: "beta" },
        { file: "a.txt", search: "beta", replace: "gamma" },
      ]),
    ).rejects.toThrow(MutationError);
    // Pass one failed before pass two wrote anything.
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("alpha");
  });

  it("rejects a path that escapes the checkout", async () => {
    await expect(
      applyMutations(dir, [{ file: "../escape.txt", search: "x", replace: "y" }]),
    ).rejects.toThrow(/escapes the checkout/);
  });

  // The rule the whole harness leans on — see `applyMutations`' doc.
  it("fails loudly when the search string is gone", async () => {
    await writeFile(join(dir, "a.txt"), "one two three", "utf8");
    await expect(
      applyMutations(dir, [{ file: "a.txt", search: "four", replace: "4" }]),
    ).rejects.toThrow(MutationError);
  });

  it("fails loudly when the search string became ambiguous", async () => {
    await writeFile(join(dir, "a.txt"), "two two", "utf8");
    await expect(
      applyMutations(dir, [{ file: "a.txt", search: "two", replace: "2" }]),
    ).rejects.toThrow(/found 2/);
  });

  it("fails loudly when the target file is missing", async () => {
    await expect(
      applyMutations(dir, [{ file: "missing.txt", search: "x", replace: "y" }]),
    ).rejects.toThrow(MutationError);
    await expect(applyMutations(dir, [{ file: "missing.txt", delete: true }])).rejects.toThrow(
      MutationError,
    );
  });

  // Only ENOENT means "the case names a file the baseline lacks"; any other
  // I/O failure must surface as itself, not as the not-found message.
  it("rethrows a non-ENOENT read failure untranslated", async () => {
    await mkdir(join(dir, "a-dir"));
    await expect(
      applyMutations(dir, [{ file: "a-dir", search: "x", replace: "y" }]),
    ).rejects.toThrow(/EISDIR/);
  });
});

describe("validateMutations", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccqa-eval-validate-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts what an apply would accept without touching the checkout", async () => {
    await writeFile(join(dir, "a.txt"), "one two three", "utf8");
    await writeFile(join(dir, "b.txt"), "gone", "utf8");
    await validateMutations(dir, [
      { file: "a.txt", search: "two", replace: "2" },
      { file: "b.txt", delete: true },
    ]);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one two three");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("gone");
  });

  it("rejects a mutation after a simulated delete, like an apply would", async () => {
    await writeFile(join(dir, "a.txt"), "one", "utf8");
    await expect(
      validateMutations(dir, [
        { file: "a.txt", delete: true },
        { file: "a.txt", search: "one", replace: "1" },
      ]),
    ).rejects.toThrow(MutationError);
  });
});
