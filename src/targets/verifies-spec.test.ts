import { describe, expect, test } from "vitest";
import { formatFinding, NOTHING_DECIDED, parseVerifiesSpecFindings, reviewGeneratedTest } from "./verifies-spec.ts";
import { verifiesSpecPrompt } from "../prompts/verifies-spec.ts";
import type { ExpandedStep } from "../spec/expand.ts";

const steps = [
  { id: "step-01", source: "spec", instruction: "出典のリンクを開く。", expected: "遷移先のページが開いている。" },
] as unknown as ExpandedStep[];

/** A step that states no outcome: opening a screen claims nothing on its own. */
const actionOnly = [
  { id: "step-01", source: "case", instruction: "一覧画面を開く。", expected: "" },
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

  // An assertion is only as strong as the locator it names, and the locator
  // lives in the page object — a review shown only the test file cannot see
  // that `.first()` decides nothing about the other matches.
  test("carries the page objects the assertions resolve through", () => {
    const prompt = verifiesSpecPrompt({
      steps,
      source: "await expect(po.status).toBeVisible();",
      support: [{ path: "pages/list.ts", source: 'readonly status = this.page.getByText("Pending").first();' }],
      language: "ja",
    });
    expect(prompt).toContain("pages/list.ts");
    expect(prompt).toContain(".first()");
  });
});

describe("reviewGeneratedTest", () => {
  /** A test whose step-01 plainly decides something, so only the model can object. */
  const DECIDED = '// step: step-01 [spec]\nawait expect(page).toHaveURL("/article");';

  /** Answers the agreed shape with the given findings. */
  function answering(json: string) {
    return async () => ({ result: `\`\`\`json\n${json}\n\`\`\``, isError: false }) as never;
  }

  test("turns each finding into a warning naming the step", async () => {
    const { warnings, findings } = await reviewGeneratedTest({
      source: DECIDED,
      steps,
      language: "ja",
      cwd: ".",
      invoke: answering('{"findings":[{"stepId":"step-01","problem":"元のリンクを見ているだけ"}]}'),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("step-01");
    expect(warnings[0]).toContain("元のリンクを見ているだけ");
    // Kept structured too: the evidence table shows it against the step.
    expect(findings).toEqual([{ stepId: "step-01", problem: "元のリンクを見ているだけ" }]);
  });

  test("says nothing when every step is decided", async () => {
    const { warnings } = await reviewGeneratedTest({
      source: DECIDED,
      steps,
      language: "ja",
      cwd: ".",
      invoke: answering('{"findings":[]}'),
    });
    expect(warnings).toEqual([]);
  });

  // The case the model kept missing: its expectations are stated for the flow,
  // every step's own `expected` is empty, and a step that decides nothing at
  // all still came back clean. Nothing decided is a fact about the file.
  test("reports a step nothing in the test decides, whatever the model answers", async () => {
    const { findings, warnings } = await reviewGeneratedTest({
      source: "// step: step-01 [spec]\nawait page.click();",
      steps,
      expectations: ["遷移先のページが開いている。"],
      language: "ja",
      cwd: ".",
      invoke: answering('{"findings":[]}'),
    });
    expect(findings).toEqual([{ stepId: "step-01", problem: NOTHING_DECIDED }]);
    expect(warnings[0]).toContain("step-01");
  });

  // "Open the list", "click Add", "type a title" claim nothing on their own,
  // and a hand-written test asserts nothing after them either. Reporting one
  // per action step is a false finding per step, and it buries the true one.
  test("says nothing about a step that states no outcome", async () => {
    const { findings } = await reviewGeneratedTest({
      source: "// step: step-01 [case]\nawait page.click();",
      steps: actionOnly,
      expectations: ["一覧が表示されている。"],
      language: "ja",
      cwd: ".",
      invoke: answering('{"findings":[]}'),
    });
    expect(findings).toEqual([]);
  });

  // An empty findings list from a review whose model half never answered is
  // not a clean review, and the evidence table reads `complete` to tell them
  // apart before it says every step is decided.
  test("says the review is incomplete when the model half could not be obtained", async () => {
    const review = await reviewGeneratedTest({
      source: DECIDED,
      steps,
      language: "ja",
      cwd: ".",
      invoke: async () => ({ result: "", isError: true }) as never,
    });
    expect(review.findings).toEqual([]);
    expect(review.complete).toBe(false);
  });

  // The generate that produced working files must not fail because the review
  // could not run; the warning it logs is the signal.
  test("a failed review warns rather than throwing", async () => {
    const { warnings } = await reviewGeneratedTest({
      source: DECIDED,
      steps,
      language: "ja",
      cwd: ".",
      invoke: async () => ({ result: "", isError: true }) as never,
    });
    expect(warnings).toEqual([]);
  });
});
