import { describe, expect, test } from "vitest";
import { formatFinding, NOTHING_DECIDED, parseVerifiesSpecFindings, reviewGeneratedTest } from "./verifies-spec.ts";
import { verifiesSpecPrompt } from "../prompts/verifies-spec.ts";
import type { ExpandedStep } from "../spec/expand.ts";
import type { ClaudeInvokeOptions } from "../claude/invoke.ts";

const steps = [
  { id: "step-01", source: "spec", instruction: "出典のリンクを開く。", expected: "遷移先のページが開いている。" },
] as unknown as ExpandedStep[];

/** A step that states no outcome: opening a screen claims nothing on its own. */
const actionOnly = [
  { id: "step-01", source: "case", instruction: "一覧画面を開く。", expected: "" },
] as unknown as ExpandedStep[];

const TEST_PATH = "e2e/todos/add-item.spec.ts";

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
  test("carries each step's claim and the paths under review", () => {
    const prompt = verifiesSpecPrompt({ steps, testPath: TEST_PATH, language: "ja" });
    expect(prompt).toContain("step-01");
    expect(prompt).toContain("遷移先のページが開いている。");
    expect(prompt).toContain(TEST_PATH);
  });

  // The reviewer must read the repository to answer "does this match how the
  // rest of the suite does it", and a reviewer handed the code inline reads
  // the copy in front of it instead.
  test("names the files rather than quoting them", () => {
    const prompt = verifiesSpecPrompt({
      steps,
      testPath: TEST_PATH,
      submitted: ["e2e/pages/todo_list.ts"],
      leansOn: ["e2e/pages/base.ts"],
      language: "ja",
    });
    expect(prompt).toContain("e2e/pages/todo_list.ts");
    expect(prompt).toContain("e2e/pages/base.ts");
    expect(prompt).toMatch(/Open them/);
  });

  // A reviewer told the code came out of a machine judges the author instead
  // of the code, and stops asking what it would say on the pull request.
  test("says nothing about where the files came from", () => {
    const prompt = verifiesSpecPrompt({
      steps,
      testPath: TEST_PATH,
      guides: [{ path: "docs/e2e-guide.md", body: "Locators are declared before methods." }],
      language: "ja",
    });
    expect(prompt).not.toMatch(/generat|model|draft|recording|ccqa/i);
  });

  // Style is what the first question refuses to report, and the rules
  // question is the only place it belongs — so a project with no rule
  // documents must get the prompt it has always had.
  test("asks nothing about rules when the project declared none", () => {
    const prompt = verifiesSpecPrompt({ steps, testPath: TEST_PATH, language: "ja" });
    expect(prompt).not.toContain("ruleViolations");
    expect(prompt).not.toContain("Does the code belong in this suite");
  });

  test("carries the project's rule documents and asks which rule was broken", () => {
    const prompt = verifiesSpecPrompt({
      steps,
      testPath: TEST_PATH,
      guides: [{ path: "docs/e2e-guide.md", body: "Locators are declared before methods." }],
      language: "ja",
    });
    expect(prompt).toContain("docs/e2e-guide.md");
    expect(prompt).toContain("Locators are declared before methods.");
    expect(prompt).toContain("ruleViolations");
    // A convention the documents never state is still one the suite follows,
    // and the evidence for it is a count nobody can produce from two files.
    expect(prompt).toContain("Search the repository before you claim one");
    expect(prompt).toContain("advisory");
  });

  // Guides are markdown and carry fences of their own. A three-backtick
  // wrapper around one ends at the guide's first fence, and the rest of the
  // document then reads as the prompt's own words.
  test("wraps a guide in a fence the guide's own fences cannot close", () => {
    const body = "Use this shape:\n\n```ts\nawait expect(x).toBeVisible();\n```";
    const prompt = verifiesSpecPrompt({
      steps,
      testPath: TEST_PATH,
      guides: [{ path: "docs/e2e-guide.md", body }],
      language: "ja",
    });
    expect(prompt).toContain(`\`\`\`\`\n${body}\n\`\`\`\``);
  });
});

describe("reviewGeneratedTest", () => {
  /** A test whose step-01 plainly decides something, so only the model can object. */
  const DECIDED = '// step: step-01 [spec]\nawait expect(page).toHaveURL("/article");';

  const submitted = (contents = DECIDED) =>
    [{ path: TEST_PATH, contents, kind: "test" as const }];

  /** Answers the agreed shape with the given findings. */
  function answering(json: string) {
    return async () => ({ result: `\`\`\`json\n${json}\n\`\`\``, isError: false }) as never;
  }

  test("turns each finding into a warning naming the step", async () => {
    const { warnings, findings } = await reviewGeneratedTest({
      files: submitted(),
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

  // A reviewer that cannot open the repository cannot answer "does this match
  // how the rest of the suite does it" — the question a blank-slate review
  // exists for — and one turn is not enough to look.
  test("reviews with read-only tools over the project, in more than one turn", async () => {
    let options: ClaudeInvokeOptions | undefined;
    await reviewGeneratedTest({
      files: submitted(),
      steps,
      language: "ja",
      cwd: "/repo",
      invoke: (async (opts: ClaudeInvokeOptions) => {
        options = opts;
        return { result: '```json\n{"findings":[]}\n```', isError: false };
      }) as never,
    });
    expect(options?.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(options?.maxTurns).toBeGreaterThan(1);
    expect(options?.timeoutMs).toBeGreaterThan(0);
    expect(options?.cwd).toBe("/repo");
    // The files are read from disk, not quoted into the prompt.
    expect(options?.prompt).not.toContain(DECIDED);
  });

  // Every rule the loop could already decide is followed by the code it
  // produces; a rule that lives only in the project's prose was read by
  // nothing until here, and by nothing at all in a file this run reused.
  test("reports each file that breaks a rule, naming what the rule was read from", async () => {
    const { ruleViolations, warnings } = await reviewGeneratedTest({
      files: submitted(),
      leansOn: ["e2e/pages/list.ts"],
      guides: [{ path: "docs/e2e-guide.md", body: "Locators are declared before methods." }],
      steps,
      language: "ja",
      cwd: ".",
      invoke: answering(
        '{"findings":[],"ruleViolations":[' +
          '{"file":"e2e/add-item.spec.ts","guide":"docs/e2e-guide.md","rule":"Locators are declared before methods.","code":"const row = …","severity":"blocking"},' +
          '{"file":"e2e/pages/list.ts","guide":"e2e/pages/todo_list.ts","rule":"12 of 14 page objects take the fixture","code":"async open() {}","severity":"advisory"}' +
          "]}",
      ),
    });
    expect(ruleViolations?.map((v) => v.severity)).toEqual(["blocking", "advisory"]);
    expect(warnings).toEqual([
      "e2e/add-item.spec.ts: Locators are declared before methods. (docs/e2e-guide.md)",
      // Marked, so a reader can tell a line that bought a fix round from one
      // the reviewer would have approved anyway.
      "e2e/pages/list.ts: 12 of 14 page objects take the fixture (e2e/pages/todo_list.ts, advisory)",
    ]);
  });

  // A severity nobody stated must not be the way a violation stops costing
  // anything: unsaid reads as blocking, which is what they all used to be.
  test("treats a violation with no severity as blocking", async () => {
    const { ruleViolations } = await reviewGeneratedTest({
      files: submitted(),
      guides: [{ path: "docs/e2e-guide.md", body: "Locators are declared before methods." }],
      steps,
      language: "ja",
      cwd: ".",
      invoke: answering(
        '{"findings":[],"ruleViolations":[{"file":"e2e/add-item.spec.ts","guide":"docs/e2e-guide.md","rule":"Locators are declared before methods.","code":"const row = …"}]}',
      ),
    });
    expect(ruleViolations?.[0]?.severity).toBe("blocking");
  });

  // A strict array is all-or-nothing: one violation the model shaped wrong
  // would discard every well-formed one beside it, and the files they named
  // would read as cleared.
  test("keeps the violations it can read when one of them is malformed", async () => {
    const { ruleViolations } = await reviewGeneratedTest({
      files: submitted(),
      guides: [{ path: "docs/e2e-guide.md", body: "Locators are declared before methods." }],
      steps,
      language: "ja",
      cwd: ".",
      invoke: answering(
        '{"findings":[],"ruleViolations":[' +
          '{"file":"e2e/pages/list.ts","rule":"guide も code も無い"},' +
          '{"file":"e2e/add-item.spec.ts","guide":"docs/e2e-guide.md","rule":"Locators are declared before methods.","code":"const row = …","severity":"blocking"}' +
          "]}",
      ),
    });
    expect(ruleViolations?.map((v) => v.file)).toEqual(["e2e/add-item.spec.ts"]);
  });

  // The mechanical half is a fact about the file and costs nothing; the
  // reviewer is minutes and a bill. The caller says when nothing could act on
  // what it would find.
  test("askModel: false reads the file and never calls the reviewer", async () => {
    let called = false;
    const review = await reviewGeneratedTest({
      files: submitted("// step: step-01 [spec]\nawait page.click();"),
      steps,
      language: "ja",
      cwd: ".",
      askModel: false,
      invoke: (async () => {
        called = true;
        return { result: "", isError: false };
      }) as never,
    });
    expect(called).toBe(false);
    expect(review.findings).toEqual([{ stepId: "step-01", problem: NOTHING_DECIDED }]);
    // Only half of the review happened, which must not read as a clean one.
    expect(review.complete).toBe(false);
  });

  // An answer that came back unreadable is not a reviewer that is gone: the
  // next round asks it again, where a call that errored is not repeated.
  test("says the reviewer failed only when the call itself failed", async () => {
    const asked = { files: submitted(), steps, language: "ja", cwd: "." };
    const errored = await reviewGeneratedTest({
      ...asked,
      invoke: async () => ({ result: "", isError: true }) as never,
    });
    const unreadable = await reviewGeneratedTest({ ...asked, invoke: answering('{"nope":[]}') });
    expect(errored.reviewerFailed).toBe(true);
    expect(unreadable.reviewerFailed).toBeUndefined();
  });

  // A model that answered the steps and skipped the rules has cleared no
  // file, and an absent key must not be the way that gets recorded.
  test("keeps the step findings when the rules half of the answer never came", async () => {
    const review = await reviewGeneratedTest({
      files: submitted(),
      guides: [{ path: "docs/e2e-guide.md", body: "Locators are declared before methods." }],
      steps,
      language: "ja",
      cwd: ".",
      invoke: answering('{"findings":[{"stepId":"step-01","problem":"元のリンクを見ているだけ"}]}'),
    });
    expect(review.findings).toEqual([{ stepId: "step-01", problem: "元のリンクを見ているだけ" }]);
    expect(review.ruleViolations).toBeUndefined();
  });

  test("says nothing when every step is decided", async () => {
    const { warnings } = await reviewGeneratedTest({
      files: submitted(),
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
      files: submitted("// step: step-01 [spec]\nawait page.click();"),
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
      files: submitted("// step: step-01 [case]\nawait page.click();"),
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
      files: submitted(),
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
      files: submitted(),
      steps,
      language: "ja",
      cwd: ".",
      invoke: async () => ({ result: "", isError: true }) as never,
    });
    expect(warnings).toEqual([]);
  });
});
