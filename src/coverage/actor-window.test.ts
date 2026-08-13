import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { CoverageSink } from "./sink.ts";
import type { ActorWindow } from "./actors.ts";
import {
  installRuntime,
  record,
  runInSpec,
  type CoverageRuntime,
  type CoverageStore,
} from "../../packages/coverage/src/core.ts";
import { createCollectorState, diff } from "../../packages/coverage/src/collector.ts";
import { slackActor } from "../../packages/coverage/src/presets/slack.ts";

/**
 * The whole chain, both halves, with nothing faked but the network hop.
 *
 * Every piece of this is separately tested; what is not, and what actually
 * breaks, is the agreement between them — the application says who acted, the
 * run says who was measuring, and the two only meet at the sink. A break
 * anywhere along it renders as "the spec reached nothing", so it is asserted
 * end to end rather than per part.
 */

const RUNTIME_KEY = Symbol.for("ccqa.coverage.runtime");
const SPEC = "run-1.chat/create";
const CARRIED = "run-1.chat/other";
const WINDOW: ActorWindow = { key: "slack:${TEST_USER}", tag: "slack:U1", specs: ["chat/create"] };

let runtime: CoverageRuntime;
let sink: CoverageSink;

beforeEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[RUNTIME_KEY];
  delete (globalThis as Record<string, unknown>).__ccqaCoverage;
  runtime = installRuntime(new AsyncLocalStorage<CoverageStore>());
  sink = await CoverageSink.start(
    "127.0.0.1",
    0,
    new Set([SPEC, CARRIED]),
    new Map([[WINDOW.tag, WINDOW.key]]),
  );
});
afterEach(async () => {
  await sink.close();
});

/** One inbound Slack request, handled while whatever it reaches records itself. */
async function handle(body: unknown, reached: readonly string[]): Promise<void> {
  await slackActor()({
    body,
    next: () => {
      for (const file of reached) record(file);
      return Promise.resolve();
    },
  });
}

async function push(): Promise<void> {
  const payload = diff(runtime, createCollectorState());
  if (payload === undefined) return;
  await fetch(sink.url, { method: "POST", body: JSON.stringify(payload) });
}

describe("actor-window attribution", () => {
  test("credits the spec holding the identity's turn, and nobody else's traffic", async () => {
    sink.openWindow(WINDOW, SPEC);
    await handle({ event: { type: "message", user: "U1" } }, ["src/handler.ts", "src/service.ts"]);
    // Somebody else on the same environment, at the same moment.
    await handle({ event: { type: "message", user: "U9" } }, ["src/other.ts"]);
    await push();

    expect(sink.filesFor(SPEC)).toEqual(new Set(["src/handler.ts", "src/service.ts"]));
    expect(sink.actorEventsFor(SPEC).get(WINDOW.key)).toBe(1);
    expect(sink.unmappedActorEvents()).toBe(1);
  });

  test("the gate stays shut for a request nobody can place", async () => {
    // No window is open and no identity is in the payload, so there is nothing
    // to attribute to and nothing should be recorded against anything.
    await handle({ event: { type: "app_uninstalled" } }, ["src/handler.ts"]);
    await push();
    expect(sink.filesFor(SPEC)).toBeUndefined();
    expect(sink.unmappedActorEvents()).toBe(0);
  });

  test("a request that already named its spec is not re-read as an identity", async () => {
    // Carrier wins. The spec a request names is a fact; an identity is only a
    // way to work one out, and letting it override would replace the answer
    // with a guess — here, with the wrong spec, since the window is open.
    sink.openWindow(WINDOW, SPEC);
    await runInSpec(CARRIED, () =>
      handle({ event: { type: "message", user: "U1" } }, ["src/handler.ts"]),
    );
    await push();

    expect(sink.filesFor(CARRIED)).toEqual(new Set(["src/handler.ts"]));
    expect(sink.filesFor(SPEC)).toBeUndefined();
    expect(sink.actorEventsFor(SPEC).get(WINDOW.key)).toBeUndefined();
  });
});
