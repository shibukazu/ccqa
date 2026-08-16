/**
 * Attribution by who acted, for the requests that cannot carry a spec id.
 *
 * The measurement's normal carrier is the request itself — a cookie the browser
 * holds, a baggage header, a Temporal header. A webhook from a chat platform
 * has none of them: the browser only ever talked to the platform, and what
 * reaches the application was sent by the platform's servers. Everything such a
 * flow runs would be unattributed, which for a suite whose majority is chat
 * flows means the measurement misses its main subject.
 *
 * What the webhook does carry is who caused it. If exactly one spec may act as
 * that identity at a time, "who" plus "when" identifies the spec — so the
 * application records only the fact (`this identity acted, at this instant`)
 * and every judgement about which spec that belongs to is made here and in the
 * sink. Nothing flows the other way: the application is never told which
 * identities matter or which windows are open, so there is no table to
 * distribute, go stale, or leak one project's identities into another's logs.
 */

import { iterEnvRefNames, resolveEnvRefs } from "../runtime/env-vars.ts";
import { listAllSpecsWithSpecFile, specKey } from "../store/index.ts";
import { RunUsageError } from "../run/errors.ts";
import type { GroupLookup } from "../run/serial-groups.ts";
import type { CoverageActors } from "../config/project-config.ts";

/**
 * Quiet gap enforced between two specs that act as the same identity.
 *
 * The application stamps events with its own clock and the sink judges them
 * against its own, so an event near a boundary could fall on either side. Three
 * seconds is over two push intervals, which also means the window being closed
 * has had time to receive everything still in flight for it.
 */
export const ACTOR_DRAIN_MS = 3_000;

/**
 * How far outside its recorded bounds a window still accepts an event.
 *
 * Half the drain, so it cannot overlap the neighbouring window on the same
 * identity: consecutive windows are at least a full drain apart, and each
 * reaching half of it inward leaves them touching at most at a point.
 */
export const ACTOR_WINDOW_TOLERANCE_MS = ACTOR_DRAIN_MS / 2;

export interface ActorWindow {
  /**
   * `<provider>:<identity expression, unexpanded>`. The only form shown to a
   * human or sent to the hub, so the identity itself never leaves this process.
   */
  key: string;
  /** `<provider>:<resolved identity>` — what the application's events carry. */
  tag: string;
  /** Spec keys that own this identity's window, in config order. */
  specs: readonly string[];
}

export interface ActorPlan {
  windows: readonly ActorWindow[];
  /** Declared tags to their display key. A tag absent here is somebody else's. */
  tagToKey: ReadonlyMap<string, string>;
  /** Spec key to the windows it owns. A spec may act as more than one identity. */
  windowsForSpec: ReadonlyMap<string, readonly ActorWindow[]>;
}

export const NO_ACTORS: ActorPlan = {
  windows: [],
  tagToKey: new Map(),
  windowsForSpec: new Map(),
};

/**
 * Reads the config's actors into the plan the run plays out, refusing anything
 * ambiguous rather than measuring under a guess.
 *
 * Every rejection here is one that would otherwise surface as "this spec
 * reached nothing": an identity that resolved to nothing matches no event, and
 * two entries resolving alike make each other's events unattributable.
 */
export async function resolveActors(actors: CoverageActors, cwd: string): Promise<ActorPlan> {
  const providers = Object.keys(actors);
  if (providers.length === 0) return NO_ACTORS;

  const known = new Set((await listAllSpecsWithSpecFile(cwd)).map(specKey));
  const windows: ActorWindow[] = [];
  const tagToKey = new Map<string, string>();
  const windowsForSpec = new Map<string, ActorWindow[]>();

  for (const provider of providers) {
    for (const [identity, specs] of Object.entries(actors[provider] ?? {})) {
      const key = `${provider}:${identity}`;
      const refs = [...iterEnvRefNames(identity)];
      // The whole privacy claim rests on this: the key is what a report and the
      // hub see, so an identity written out in full puts it there. A variable
      // keeps the value in the environment where it belongs, and refusing the
      // literal makes that a rule rather than a convention nobody enforces.
      if (refs.length === 0) {
        throw new RunUsageError(
          `coverage.actors.${key} names an identity directly — write it as a variable ` +
            `(e.g. \${TEST_USER_ID}) so the value stays out of reports and the hub`,
        );
      }
      const missing = refs.filter(
        (name) => process.env[name] === undefined || process.env[name] === "",
      );
      if (missing.length > 0) {
        throw new RunUsageError(
          `coverage.actors.${key} needs ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not set — ` +
            `an identity that resolves to nothing matches no event, and the specs under it would report reaching nothing`,
        );
      }
      const tag = `${provider}:${resolveEnvRefs(identity)}`;
      const clash = tagToKey.get(tag);
      if (clash !== undefined) {
        throw new RunUsageError(
          `coverage.actors.${key} and coverage.actors.${clash} name the same identity — ` +
            `their windows would overlap and neither one's events could be told apart`,
        );
      }
      for (const member of specs) {
        if (!known.has(member)) {
          throw new RunUsageError(
            `coverage.actors.${key} lists "${member}", which is not a spec in this project`,
          );
        }
      }
      const window: ActorWindow = { key, tag, specs };
      windows.push(window);
      tagToKey.set(tag, key);
      for (const member of specs) {
        const owned = windowsForSpec.get(member);
        if (owned) owned.push(window);
        else windowsForSpec.set(member, [window]);
      }
    }
  }
  return { windows, tagToKey, windowsForSpec };
}

/**
 * The serial groups the plan implies: two specs acting as one identity cannot
 * overlap, or neither could claim what happened while both were running.
 */
export function actorGroups(plan: ActorPlan): GroupLookup {
  if (plan.windowsForSpec.size === 0) return () => [];
  return (ref) => (plan.windowsForSpec.get(specKey(ref)) ?? []).map((window) => window.key);
}
