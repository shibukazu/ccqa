import { describe, expect, test } from "vitest";
import { staleRecordingWarning } from "./generate.ts";

const RECORDED = "2026-02-01T00:00:00.000Z";

describe("staleRecordingWarning", () => {
  /**
   * The failure it exists for: a case edited after recording generates to the
   * old case and passes, and the only clue is that what you just wrote is not
   * in the file — which reads as the generator ignoring you.
   */
  test("names the recording command when the case is the newer of the two", () => {
    const warning = staleRecordingWarning("todo/add_item", new Date("2026-02-02T00:00:00.000Z"), RECORDED);
    expect(warning).toContain("ccqa record todo/add_item");
    expect(warning).toContain(RECORDED);
  });

  test("says nothing when the recording is the newer, or the two are the same moment", () => {
    expect(staleRecordingWarning("x", new Date("2026-01-31T00:00:00.000Z"), RECORDED)).toBeNull();
    expect(staleRecordingWarning("x", new Date(RECORDED), RECORDED)).toBeNull();
  });

  // Nothing to compare against is not evidence of staleness.
  test("says nothing when either side is missing or unreadable", () => {
    expect(staleRecordingWarning("x", null, RECORDED)).toBeNull();
    expect(staleRecordingWarning("x", new Date("2026-02-02T00:00:00.000Z"), undefined)).toBeNull();
    expect(staleRecordingWarning("x", new Date("2026-02-02T00:00:00.000Z"), "not a date")).toBeNull();
  });
});
