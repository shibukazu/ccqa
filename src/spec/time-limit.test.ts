import { describe, expect, test } from "vitest";
import { stepTimeLimitMs, stepTimeLimits } from "./time-limit.ts";

describe("stepTimeLimitMs", () => {
  test.each([
    ["The result appears within 40 seconds", 40_000],
    ["wait up to 2 minutes", 120_000],
    ["shows the badge in 45s", 45_000],
    ["done in 1 min 30 sec", 90_000],
    ["30秒以内に表示される", 30_000],
    ["最大３分待つ", 180_000],
    ["1分30秒以内に完了する", 90_000],
    ["within 10 seconds, then within 1.5 minutes", 90_000],
  ])("%s → %d", (text, ms) => {
    expect(stepTimeLimitMs(text)).toBe(ms);
  });

  test.each([
    "Click Submit",
    "全体の3分の1が表示される",
    "画面を2分割する",
    "v2s is shown",
    "500ms",
    "the secret is 30 sections long",
  ])("%s → none", (text) => {
    expect(stepTimeLimitMs(text)).toBeUndefined();
  });
});

test("stepTimeLimits reads instruction and expected, and leaves steps without a limit out", () => {
  const limits = stepTimeLimits([
    { id: "step-01", instruction: "Open the list", expected: "" },
    { id: "step-02", instruction: "Click Submit", expected: "Done appears within 40 seconds" },
  ]);
  expect([...limits]).toEqual([["step-02", 40_000]]);
});
