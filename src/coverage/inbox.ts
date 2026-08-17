/**
 * The run's side of the hub coverage inbox (ADR-0022). Under
 * `--coverage-inbox hub` nothing binds on the runner: the run appends its own
 * facts — spec lifecycle markers, actor-window markers, the browser half, the
 * universe — to the hub's durable stream, next to the pushes the instrumented
 * application sends there itself. The hub stamps arrival order and stores;
 * interpretation happens at read time, in the shared resolver.
 */

import * as log from "../cli/logger.ts";
import { errMessage } from "../run/errors.ts";
import type { RunEvent } from "./events.ts";

/** `--coverage-inbox` values: where the measurement's two sides meet. */
export const COVERAGE_INBOX_MODES = ["local", "hub"] as const;
export type CoverageInboxMode = (typeof COVERAGE_INBOX_MODES)[number];

/**
 * The half of the inbox the coverage session writes to. Structural, so a
 * session test substitutes a recording fake without any HTTP — same reasoning
 * as `CoverageCollector` in `src/targets/types.ts`.
 */
export interface RunEventInbox {
  append(event: RunEvent): Promise<void>;
}

/** Per-attempt fetch timeout, mirroring the hub client's. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Pause before the one retry, mirroring the hub client's first backoff step. */
const RETRY_PAUSE_MS = 100;

export interface CoverageInboxOptions {
  baseUrl: string;
  token: string;
  project: string;
  /** Extra headers sent with every request; never overrides `Authorization`. */
  headers?: Record<string, string>;
  /** Override for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class CoverageInbox implements RunEventInbox {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  // Assigned in the body rather than declared as parameters: node's type
  // stripping runs this file as-is and rejects a parameter property outright.
  constructor(options: CoverageInboxOptions) {
    const base = options.baseUrl.replace(/\/+$/, "");
    this.url = `${base}/api/v1/coverage/events?project=${encodeURIComponent(options.project)}`;
    this.headers = {
      ...options.headers,
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.token}`,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Appends one event to the project's stream. Never throws: a marker that
   * could not be delivered degrades the resolved answer, and failing the run
   * over it would cost the test results the run exists for. One retry, then a
   * warning — markers are low-frequency, so there is no queue to drain.
   */
  async append(event: RunEvent): Promise<void> {
    let reason = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: this.headers,
          body: JSON.stringify(event),
        });
        if (res.ok) return;
        reason = `status ${res.status}`;
        // A 4xx answers the same way twice; only a server error earns the retry.
        if (res.status < 500) break;
      } catch (err) {
        reason = errMessage(err);
      }
    }
    log.warn(`coverage: could not append a ${event.kind} event to the hub inbox (${reason})`);
  }
}
