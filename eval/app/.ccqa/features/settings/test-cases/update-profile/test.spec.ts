import { test } from "vitest";
import { spawnSync } from "node:child_process";
import { ab, abWait, abUpload, abAssertTextVisible, abAssertVisible, abAssertNotVisible, abAssertUrl, abAssertEnabled, abAssertDisabled, abAssertChecked, abAssertUnchecked, abStepEvidence, __setCurrentStep } from "ccqa/test-helpers";

// Single session shared across the run. Use ||= so an outer harness
// (e.g. ccqa generate's auto-fix loop) can pre-set the session name
// and inspect the same session after the run finishes.
process.env.AGENT_BROWSER_SESSION ||= `ccqa-run-${Date.now()}`;

test("update the display name in settings", () => {
  // step: step-01 [login]
  __setCurrentStep("step-01", "login");
  ab("open", `${process.env.APP_URL ?? ""}`);
  abStepEvidence("step-01", "login");

  // step: step-02 [login]
  __setCurrentStep("step-02", "login");
  spawnSync("sleep", ["3"], { stdio: "inherit" });
  ab("fill", "#email", `${process.env.APP_EMAIL ?? ""}`);
  abStepEvidence("step-02", "login");

  // step: step-03 [login]
  __setCurrentStep("step-03", "login");
  ab("fill", "#password", `${process.env.APP_PASSWORD ?? ""}`);
  abStepEvidence("step-03", "login");

  // step: step-04 [login]
  __setCurrentStep("step-04", "login");
  ab("click", "text=Sign in");
  abWait("text=Projects");
  abStepEvidence("step-04", "login");

  // step: step-05 [spec]
  __setCurrentStep("step-05", "spec");
  ab("click", "text=Settings");
  abWait("#display-name");
  abStepEvidence("step-05", "spec");

  // step: step-06 [spec]
  __setCurrentStep("step-06", "spec");
  ab("fill", "#display-name", "Weekend Maintainer");
  ab("click", "text=Save changes");
  abWait("text=Settings saved");
  abAssertTextVisible("Settings saved");
  abStepEvidence("step-06", "spec");
}, 5 * 60 * 1000);
