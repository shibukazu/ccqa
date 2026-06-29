import { test, expect } from "vitest";

// ccqa must expose CCQA_RUN_ID to the replayed (deterministic) test, the same
// unique-per-run id the live path provides. Without it, specs that embed
// `${CCQA_RUN_ID}` in created-content names resolve it to "" and collide.
test("CCQA_RUN_ID is set and non-empty for deterministic specs", () => {
  expect(process.env.CCQA_RUN_ID).toBeTruthy();
});
