import { test } from "vitest";
import { spawnSync } from "node:child_process";
import { ab, abWait, abUpload, abAssertTextVisible, abAssertVisible, abAssertNotVisible, abAssertUrl, abAssertEnabled, abAssertDisabled, abAssertChecked, abAssertUnchecked, abStepEvidence, __setCurrentStep } from "ccqa/test-helpers";

// Single session shared across the run. Use ||= so an outer harness
// (e.g. ccqa generate's auto-fix loop) can pre-set the session name
// and inspect the same session after the run finishes.
process.env.AGENT_BROWSER_SESSION ||= `ccqa-run-${Date.now()}`;

test("read the help page", () => {
  // step: step-01 [spec]
  __setCurrentStep("step-01", "spec");
  ab("open", `${process.env.APP_URL ?? ""}/help`);
  abWait("text=How it works");
  abAssertTextVisible("How it works");
  abStepEvidence("step-01", "spec");

  // step: step-02 [spec]
  __setCurrentStep("step-02", "spec");
  ab("click", "text=Back to your tasks");
  abWait("text=Sign in");
  abAssertTextVisible("Sign in");
  abStepEvidence("step-02", "spec");
}, 5 * 60 * 1000);
