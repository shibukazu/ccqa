import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMutations, MutationError } from "./mutate.ts";

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

  // The rule the whole harness leans on: a mutation that stopped applying
  // must never score as "the app was clean and the audit agreed".
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
});
