import { describe, expect, test } from "vitest";

import { CoverageSink } from "./sink.ts";
import { COVERAGE_COOKIE, SPEC_ID_PATTERN } from "./contract.ts";
import { COOKIE_NAME, parseSpecId } from "../../packages/coverage/src/wire.ts";
import type { CoveragePush } from "../../packages/coverage/src/collector.ts";

/**
 * The CLI and `@ccqa/coverage` restate the same wire names and shapes rather
 * than share a module — the CLI must not depend on the instrumentation SDK,
 * which installs into the application under test and versions separately.
 *
 * Nothing at runtime notices when the two drift: the sink simply stops
 * recognising what the application sends, and the report says the spec reached
 * no server code — which is exactly the answer coverage exists to produce. So
 * the agreement is asserted here instead.
 */
describe("wire agreement with @ccqa/coverage", () => {
  test("both halves name the cookie the same", () => {
    expect(COVERAGE_COOKIE).toBe(COOKIE_NAME);
  });

  test("both halves accept and reject the same spec ids", () => {
    for (const id of ["run-1.checkout/happy-path", "r.a/b", "a".repeat(200)]) {
      expect(SPEC_ID_PATTERN.test(id)).toBe(true);
      expect(parseSpecId(id)).toBe(id);
    }
    for (const id of ["run 1.feature/spec", "run\n1.feature/spec", "a".repeat(201)]) {
      expect(SPEC_ID_PATTERN.test(id)).toBe(false);
      expect(parseSpecId(id)).toBeUndefined();
    }
  });

  test("a payload of the collector's own type is accepted by the sink", async () => {
    const specId = "run-1.feat/spec-a";
    // Typed as the collector's payload, so a change on that side is a type
    // error here; posted for real, so a change on this side is a test failure.
    const payload: CoveragePush = {
      protocol: 1,
      pid: 1,
      startedAt: 1000,
      unattributed: 2,
      uninstrumentedFiles: 0,
      uninstrumentedProcess: false,
      droppedPushes: 0,
      specs: { [specId]: ["src/a.ts"] },
      boot: ["src/boot.ts"],
      actors: [],
    };
    const sink = await CoverageSink.start("127.0.0.1", 0, new Set([specId]));
    try {
      await fetch(sink.url, { method: "POST", body: JSON.stringify(payload) });
      expect(sink.filesFor(specId)).toEqual(new Set(["src/a.ts"]));
      expect(sink.malformedPushes()).toBe(0);
    } finally {
      await sink.close();
    }
  });
});
