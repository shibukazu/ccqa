/**
 * The Node-only half of the package, loaded with
 * `node --import ccqa-tools/coverage/register` (or via `NODE_OPTIONS`).
 *
 * Everything here would fail inside a bundler — `node:http`, `node:module`,
 * load-time source rewriting — which is exactly why it is not in `core.ts`.
 * When `CCQA_COVERAGE` is unset the process never loads this file at all.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";

import { installRuntime, openBucket, type CoverageRuntime, type CoverageStore } from "./core.ts";
import { collectorOptionsFromEnv, startCollector } from "./collector.ts";
import { installLoadHooks } from "./instrument/hooks.ts";
import { debugLog, readConfig } from "./runtime-env.ts";
import { readBaggage, readCookie } from "./wire.ts";

const config = readConfig();

if (config.enabled) {
  const runtime = installRuntime(new AsyncLocalStorage<CoverageStore>());

  patchServers(runtime);
  installLoadHooks(config, runtime);

  if (config.ambientSpecId !== undefined) {
    // A process dedicated to one spec has no inbound request to read the id
    // from, so the context is entered once for the whole process. `enterWith`
    // is the only API that can do that; it is safe here because this runs on
    // the main synchronous path before any application code.
    const files = openBucket(runtime, config.ambientSpecId);
    (runtime.als as AsyncLocalStorage<CoverageStore>).enterWith({
      specId: config.ambientSpecId,
      files,
    });
  }

  startCollector(collectorOptionsFromEnv(process.env, config), config);

  debugLog(config, `armed in pid ${process.pid}`);
}

/**
 * Wraps inbound requests in the spec's context.
 *
 * Patching `emit` rather than the handler covers servers created before this
 * ran and servers created by frameworks that never expose their handler.
 * `https.Server` does not inherit from `http.Server`, so both are patched.
 */
function patchServers(runtime: CoverageRuntime): void {
  type Emit = (this: object, event: string, ...args: unknown[]) => boolean;
  for (const server of [http.Server, https.Server]) {
    const prototype = server.prototype as unknown as { emit: Emit };
    const original = prototype.emit;
    // `emit` fires for every event a server has (connection, close, upgrade,
    // clientError, ...), not just `request` — read `arguments` directly so
    // only the one event this package cares about pays for an array/spread.
    prototype.emit = function patched(this: object): boolean {
      if (arguments[0] !== "request") return original.apply(this, arguments as never);
      const request = arguments[1] as IncomingMessage;
      const specId =
        readCookie(request.headers.cookie) ?? readBaggage(request.headers.baggage as string);
      if (specId === undefined) return original.apply(this, arguments as never);
      return runtime.als.run({ specId, files: openBucket(runtime, specId) }, () =>
        original.apply(this, arguments as never),
      );
    };
  }
}
