/**
 * Instruments modules as Node loads them, so a deployment is instrumented by
 * adding one flag to its command line and rebuilding nothing. What runs is the
 * same artifact production runs, which is most of the reason this path is
 * preferred over a build plugin.
 *
 * Code a bundler already swallowed is out of reach here — the loader only ever
 * sees the bundle. Those runtimes use `ccqa-coverage/next` instead.
 */

import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

import type { CoverageRuntime } from "../core.ts";
import { debugLog, type CoverageConfig } from "../runtime-env.ts";
import { originalFileId } from "./origin.ts";
import { shouldInstrument } from "./select.ts";
import { transform } from "./transform.ts";

// Hoisted: this hook runs for every module Node loads, and a decoder built
// fresh each time would be pure per-call overhead.
const textDecoder = new TextDecoder();

interface LoadResult {
  format?: string | null | undefined;
  source?: string | ArrayBuffer | NodeJS.ArrayBufferView | null | undefined;
  shortCircuit?: boolean | undefined;
}

type RegisterHooks = (hooks: {
  load: (url: string, context: unknown, nextLoad: (url: string, context: unknown) => LoadResult) => LoadResult;
}) => unknown;

export function installLoadHooks(config: CoverageConfig, runtime: CoverageRuntime): void {
  const registerHooks = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks;
  if (typeof registerHooks !== "function") {
    // Node 22.15 / 23.5 added the synchronous, in-thread hook. Older runtimes
    // can still be covered through `ccqa-coverage/next`'s build plugin, so
    // this is a downgrade rather than a failure — but no file in this process
    // will be instrumented via this path, which is a configuration problem
    // worth surfacing without needing CCQA_COVERAGE_DEBUG to see it.
    runtime.uninstrumentedProcess = true;
    process.stderr.write(
      `[ccqa-coverage] load hooks unavailable on node ${process.version}; no file in this process will be instrumented\n`,
    );
    return;
  }

  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith("file:")) return result;
      let filename: string;
      try {
        filename = fileURLToPath(url);
      } catch {
        return result;
      }
      const selectedId = shouldInstrument(filename, config);
      if (selectedId === undefined) return result;
      const source = toText(result.source);
      if (source === undefined) {
        runtime.uninstrumentedFiles++;
        debugLog(config, `could not decode source for ${filename}; left as-is`);
        return result;
      }
      const fileId = originalFileId(filename, source, config.root) ?? selectedId;
      const instrumented = transform(source, { fileId });
      if (instrumented === undefined) {
        runtime.uninstrumentedFiles++;
        debugLog(config, `could not parse ${fileId}; left as-is`);
        return result;
      }
      return { ...result, source: instrumented };
    },
  });

  debugLog(config, `load hooks installed for ${config.include.join(", ")} under ${config.root}`);
}

function toText(source: LoadResult["source"]): string | undefined {
  if (typeof source === "string") return source;
  if (source instanceof ArrayBuffer) return textDecoder.decode(source);
  if (ArrayBuffer.isView(source)) {
    return textDecoder.decode(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
  }
  return undefined;
}
