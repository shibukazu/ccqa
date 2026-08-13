import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it } from "vitest";

import { installRuntime, type CoverageStore } from "../core.ts";

import { slackActor, slackUserId } from "./slack.ts";

/**
 * The list is the whole contract. A shape that falls off it records nothing,
 * which downstream reads as a flow that reached no code — so every shape the
 * platform actually sends is pinned here rather than left to a reader's memory.
 */
const SHAPES: Array<[name: string, body: unknown, expected: string | undefined]> = [
  ["events api, user as an id", { event: { type: "message", user: "U1" } }, "U1"],
  ["events api, user as an object", { event: { type: "app_home_opened", user: { id: "U2" } } }, "U2"],
  ["interactivity, payload as JSON text", { payload: JSON.stringify({ user: { id: "U3" } }) }, "U3"],
  ["interactivity, payload already parsed", { payload: { user: { id: "U4" } } }, "U4"],
  ["interactivity, already unwrapped by bolt", { type: "block_actions", user: { id: "U6" } }, "U6"],
  ["slash command", { user_id: "U5", command: "/do" }, "U5"],
  ["an event with no actor", { event: { type: "app_uninstalled" } }, undefined],
  ["payload that is not JSON", { payload: "not json" }, undefined],
  ["a shape nobody listed", { something: "else" }, undefined],
  ["an empty id", { user_id: "  " }, undefined],
  ["no body at all", undefined, undefined],
];

describe("slackUserId", () => {
  for (const [name, body, expected] of SHAPES) {
    it(`reads ${name}`, () => {
      expect(slackUserId(body)).toBe(expected);
    });
  }
});

describe("slackActor", () => {
  const body = { event: { type: "message", user: "U1" } };

  /** The tags an identity-bearing request opened a bucket for. */
  async function tagsFrom(call: () => Promise<void>): Promise<string[]> {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("ccqa.coverage.runtime")];
    const runtime = installRuntime(new AsyncLocalStorage<CoverageStore>());
    await call();
    return [...runtime.actors.values()].map((bucket) => bucket.tag);
  }

  // Reading the wrong property finds no identity and still calls `next`, so a
  // test that only checked the request was passed on would pass either way.
  it("reads the request body in each shape it accepts", async () => {
    const done = () => Promise.resolve();
    // Bolt hands one argument carrying both.
    expect(await tagsFrom(() => slackActor()({ body, next: done }))).toEqual(["slack:U1"]);
    // Connect: (req, res, next).
    expect(await tagsFrom(() => slackActor()({ body }, {}, done))).toEqual(["slack:U1"]);
    // Context: (ctx, next), where `ctx.body` is the response being built and
    // the payload lives on `ctx.request`.
    expect(await tagsFrom(() => slackActor()({ request: { body }, body: {} }, done))).toEqual([
      "slack:U1",
    ]);
  });

  it("passes the request on even when it can find no payload", async () => {
    let continued = false;
    await slackActor()({}, {}, () => {
      continued = true;
    });
    expect(continued).toBe(true);
  });
});
