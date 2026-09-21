import { describe, expect, test } from "vitest";
import type { RecordedAction } from "../ir/types.ts";
import { auditedRenames, recordingNamesRenamed } from "./renames.ts";

describe("auditedRenames", () => {
  const doc = 'The "Submit" button is visible, and 「送信」 appears beside it.';

  test("keeps the answered order and says which pairs the document holds", () => {
    expect(
      auditedRenames(doc, [
        { from: "送信", to: "確定" },
        { from: "Cancel", to: "Discard" },
      ]),
    ).toEqual([
      { from: "送信", to: "確定", inDocument: true },
      { from: "Cancel", to: "Discard", inDocument: false },
    ]);
  });

  test("drops a pair that names nothing or edits nothing", () => {
    expect(
      auditedRenames(doc, [
        { from: "", to: "Send" },
        { from: "Submit", to: "" },
        { from: "Submit", to: "Submit" },
        // Blank, not short: a run of spaces is in every document there is.
        { from: "  ", to: " - " },
      ]),
    ).toEqual([]);
  });

  test("collapses a repeated pair, and drops a `from` the audit answered two ways", () => {
    const twice = [{ from: "Submit", to: "Send" }, { from: "Submit", to: "Send" }];
    expect(auditedRenames(doc, twice)).toEqual([{ from: "Submit", to: "Send", inDocument: true }]);
    // Applying either would be inventing an answer nobody gave.
    expect(
      auditedRenames(doc, [
        { from: "Submit", to: "Send" },
        { from: "Submit", to: "Confirm" },
      ]),
    ).toEqual([]);
  });
});

describe("recordingNamesRenamed", () => {
  const renamed = [{ from: "Submit", to: "Send" }];
  const navigate: RecordedAction = { action: "navigate", value: "https://example.test" };

  test("finds the old string in what an action asserted or how it addressed an element", () => {
    const asserted: RecordedAction = { action: "assert", assert: "text_visible", value: "Submit" };
    expect(recordingNamesRenamed({ actions: [navigate, asserted] }, renamed)).toBe(true);

    const byRole: RecordedAction = {
      action: "click",
      locator: { by: "role", value: "button", name: "Submit" },
    };
    expect(recordingNamesRenamed({ actions: [byRole] }, renamed)).toBe(true);
    // The ARIA role is not a string the product wrote, so it is not searched.
    expect(recordingNamesRenamed({ actions: [byRole] }, [{ from: "button", to: "link" }])).toBe(false);
  });

  test("searches the recorded cleanup too", () => {
    const click: RecordedAction = { action: "click", locator: { by: "text", value: "送信" } };
    const pair = [{ from: "送信", to: "確定" }];
    expect(recordingNamesRenamed({ actions: [navigate], cleanup: [click] }, pair)).toBe(true);
  });

  // The reason this walks values instead of searching a serialization.
  test("matches a string carrying a quote, which JSON escaping would hide", () => {
    const value = `[aria-label='Submit "now"']`;
    const quoted: RecordedAction = { action: "click", locator: { by: "css", value } };
    const pair = [{ from: `Submit "now"`, to: "Send" }];
    expect(recordingNamesRenamed({ actions: [quoted] }, pair)).toBe(true);
  });

  test("ignores the recorder's own prose about an action", () => {
    const observed: RecordedAction = { action: "snapshot", observation: "the Submit button is shown" };
    expect(recordingNamesRenamed({ actions: [observed] }, renamed)).toBe(false);
  });

  test("is false when the recording names none of them, and when none were named", () => {
    expect(recordingNamesRenamed({ actions: [navigate] }, renamed)).toBe(false);
    expect(recordingNamesRenamed({ actions: [{ action: "fill", value: "Submit" }] }, [])).toBe(false);
  });
});
