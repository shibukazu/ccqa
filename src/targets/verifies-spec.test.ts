import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatFinding, parseVerifiesSpecFindings, reviewGeneratedTest } from "./verifies-spec.ts";
import { verifiesSpecPrompt } from "../prompts/verifies-spec.ts";
import type { ExpandedStep } from "../spec/expand.ts";

const steps = [
  { id: "step-01", source: "spec", instruction: "出典のリンクを開く。", expected: "遷移先のページが開いている。" },
] as unknown as ExpandedStep[];

describe("parseVerifiesSpecFindings", () => {
  test("reads findings out of a json block", () => {
    const answer = 'ここまで見ました。\n```json\n{"findings":[{"stepId":"step-05","problem":"元のリンクを見ているだけ"}]}\n```';
    expect(parseVerifiesSpecFindings(answer)).toEqual([
      { stepId: "step-05", problem: "元のリンクを見ているだけ" },
    ]);
  });

  test("an empty findings array is a clean review, not a failed one", () => {
    expect(parseVerifiesSpecFindings('```json\n{"findings":[]}\n```')).toEqual([]);
  });

  // A review that could not be obtained must be distinguishable from a clean
  // one, or a broken reviewer reads as "every step is decided".
  test("null when the answer is not in the agreed shape", () => {
    expect(parseVerifiesSpecFindings("問題ありませんでした")).toBeNull();
    expect(parseVerifiesSpecFindings('```json\n{"findings":[{"problem":"stepId が無い"}]}\n```')).toBeNull();
    // キー名を間違えた返答や指摘を落とした返答が「問題なし」に化けないこと。
    expect(parseVerifiesSpecFindings('```json\n{"issues":[{"stepId":"step-01","problem":"x"}]}\n```')).toBeNull();
    expect(parseVerifiesSpecFindings('```json\n{}\n```')).toBeNull();
  });
});

describe("verifiesSpecPrompt", () => {
  test("carries each step's claim and the code under review", () => {
    const prompt = verifiesSpecPrompt({ steps, source: "await page.click();", language: "ja" });
    expect(prompt).toContain("step-01");
    expect(prompt).toContain("遷移先のページが開いている。");
    expect(prompt).toContain("await page.click();");
  });
});

describe("reviewGeneratedTest", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ccqa-verifies-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function testFile(contents: string): Promise<string> {
    const path = join(dir, "test.spec.ts");
    await writeFile(path, contents);
    return path;
  }

  test("turns each finding into a warning naming the step", async () => {
    const path = await testFile("await page.click();");
    const warnings = await reviewGeneratedTest({
      result: { files: [{ path, kind: "test" }], summary: "", warnings: [], passed: true },
      steps,
      language: "ja",
      cwd: dir,
      invoke: async () => ({
        result: '```json\n{"findings":[{"stepId":"step-01","problem":"元のリンクを見ているだけ"}]}\n```',
        isError: false,
      }) as never,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("step-01");
    expect(warnings[0]).toContain("元のリンクを見ているだけ");
  });

  test("says nothing when every step is decided", async () => {
    const path = await testFile("await expect(other).toBeVisible();");
    const warnings = await reviewGeneratedTest({
      result: { files: [{ path, kind: "test" }], summary: "", warnings: [], passed: true },
      steps,
      language: "ja",
      cwd: dir,
      invoke: async () => ({ result: '```json\n{"findings":[]}\n```', isError: false }) as never,
    });
    expect(warnings).toEqual([]);
  });

  // The generate that produced working files must not fail because the review
  // could not run; the warning it logs is the signal.
  test("a failed review warns rather than throwing", async () => {
    const path = await testFile("await page.click();");
    const warnings = await reviewGeneratedTest({
      result: { files: [{ path, kind: "test" }], summary: "", warnings: [], passed: true },
      steps,
      language: "ja",
      cwd: dir,
      invoke: async () => ({ result: "", isError: true }) as never,
    });
    expect(warnings).toEqual([]);
  });
});

describe("formatFinding", () => {
  test("says the test is green without deciding the claim", () => {
    expect(formatFinding({ stepId: "step-05", problem: "元のリンクを見ているだけ" })).toBe(
      "step step-05: the generated test passes without deciding what this step claims — 元のリンクを見ているだけ",
    );
  });
});
