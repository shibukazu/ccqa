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
import { HubApiError, hubRequest, type HubClientOptions } from "../hub-client/index.ts";
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

export interface CoverageInboxOptions extends HubClientOptions {
  project: string;
}

export class CoverageInbox implements RunEventInbox {
  private readonly transport: HubClientOptions;
  private readonly path: string;

  // Assigned in the body rather than declared as parameters: node's type
  // stripping runs this file as-is and rejects a parameter property outright.
  constructor(options: CoverageInboxOptions) {
    const { project, ...transport } = options;
    this.transport = transport;
    this.path = `/api/v1/coverage/events?project=${encodeURIComponent(project)}`;
  }

  /**
   * Appends one event to the project's stream. Never throws: a marker that
   * could not be delivered degrades the resolved answer, and failing the run
   * over it would cost the test results the run exists for. The transport is
   * the hub client's, with its one opt-in: an append delivered twice resolves
   * the same as once, so unlike the client's own POSTs it retries once.
   */
  async append(event: RunEvent): Promise<void> {
    try {
      await hubRequest(
        this.transport,
        this.path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        },
        "post-once",
      );
    } catch (err) {
      const reason = err instanceof HubApiError ? `status ${err.status}` : errMessage(err);
      log.warn(`coverage: could not append a ${event.kind} event to the hub inbox (${reason})`);
    }
  }
}
