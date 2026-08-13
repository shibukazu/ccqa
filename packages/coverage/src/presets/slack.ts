/**
 * Records who caused a Slack request, so the flows a chat platform drives can
 * be attributed at all.
 *
 * Those requests are sent by Slack, not by the browser under test, so none of
 * the carriers the rest of this package relies on is present — no cookie, no
 * baggage header, nothing. What the payload does say is which user acted, and
 * that is the whole of what this records:
 *
 *   app.use(slackActor())        // after whatever parses the body
 *
 * No arguments, no configuration, no environment. It does not know which users
 * are being measured, when a spec is running, or that ccqa exists — the run
 * decides all of that from the other end. With `CCQA_COVERAGE` unset the
 * runtime is absent and every call here returns immediately.
 *
 * Extraction is a fixed list of the places Slack puts a user id. A payload
 * shape not on the list records nothing rather than guessing, because a wrong
 * identity is a wrong answer while a missing one is a counted gap.
 */

import { runAsActor } from "../core.ts";
import { debugLog, readConfig } from "../runtime-env.ts";

/**
 * Read once: the identity of every inbound request would otherwise re-read the
 * environment, and this sits in front of every Slack request the app serves.
 */
const config = readConfig();

/** The tag prefix, and therefore the provider key a project writes in its config. */
export const SLACK_PROVIDER = "slack";

/** Hands the request to the rest of the chain. Awaited, because Bolt's is async. */
type Continue = () => Promise<void> | void;

/**
 * Middleware for either shape a Slack app uses.
 *
 * Bolt hands its middleware one object holding the parsed body and its own
 * `next`, and awaits what comes back. A connect-style stack hands
 * `(request, response, next)`, and a context-style one `(ctx, next)`. All are
 * accepted so the application's one line does not have to know which it is —
 * and in a Bolt app `app.use()` is the only insertion point there is.
 *
 * Place it after whatever parses the body: the payload is what carries the
 * identity, and before parsing there is none. A framework whose body is only
 * available by awaiting it is out of reach here for the same reason — there is
 * nothing to read at the moment this runs.
 */
export function slackActor() {
  return async function coverageSlackActor(...args: unknown[]): Promise<void> {
    const first = args[0];
    // Bolt is the one-argument convention. Deciding on the argument count and
    // not on the presence of a `next` property matters: Express hangs its own
    // `next` off the request object, so a request would otherwise be read as
    // Bolt's argument bag and work only by coincidence.
    const bolt =
      args.length === 1 && isRecord(first) && typeof first.next === "function"
        ? (first as unknown as { body?: unknown; next: Continue })
        : undefined;
    const body = bolt ? bolt.body : requestBody(first);
    // Whichever of the remaining arguments is the continuation — `(req, res,
    // next)` and `(ctx, next)` differ only in where it sits. Passing the
    // request on matters more than measuring it: a middleware that swallows
    // one would take the application down with it.
    const next = bolt ? bolt.next : args.slice(1).find(isFunction);
    if (next === undefined) return;

    const user = slackUserId(body);
    if (user === undefined) {
      await next();
      return;
    }
    const tag = `${SLACK_PROVIDER}:${user}`;
    // The only way to find out what to write in `coverage.actors`: the id is
    // not in the payload a human sees, and configuring it by guess produces a
    // window that matches nothing and a spec that reports reaching nothing.
    debugLog(config, `slack actor ${tag}`);
    // Stamped on arrival, not when the work runs: a job this request schedules
    // may execute much later, and it is the asking that identifies the turn.
    await runAsActor(tag, Date.now(), next);
  };
}

/**
 * The user id in a Slack payload, or undefined if this shape carries none.
 *
 * Exported for its own tests: the list is the entire contract, and a shape
 * silently dropping off it looks exactly like a flow that reached no code.
 */
export function slackUserId(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;

  // Interactivity (block actions, view submissions, shortcuts, options) arrives
  // form-encoded with the real payload as JSON in one field. Bolt has already
  // unwrapped it by the time its middleware runs, hence the top-level case too.
  const payload = parsePayload(body.payload);
  if (payload !== undefined) return idOf(payload.user);

  // Events API.
  const event = body.event;
  if (isRecord(event)) return idOf(event.user);

  if (body.user !== undefined) return idOf(body.user);

  // Slash commands, which are flat form fields.
  if (typeof body.user_id === "string") return nonEmpty(body.user_id);

  return undefined;
}

function parsePayload(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Slack writes a user as a bare id in some payloads and as an object in others. */
function idOf(user: unknown): string | undefined {
  if (typeof user === "string") return nonEmpty(user);
  if (isRecord(user) && typeof user.id === "string") return nonEmpty(user.id);
  return undefined;
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFunction(value: unknown): value is Continue {
  return typeof value === "function";
}

/**
 * The parsed request body, from the request itself or from a context wrapping
 * it. A context's own `body` is the *response* it is building, so reading that
 * would hand the extractor the wrong object and quietly find no identity.
 */
function requestBody(first: unknown): unknown {
  if (!isRecord(first)) return undefined;
  const request = first.request;
  if (isRecord(request) && isRecord(request.body)) return request.body;
  return isRecord(first.body) ? first.body : undefined;
}
