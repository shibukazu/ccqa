/**
 * The loader form of the instrumenter, for code that reaches the runtime as
 * part of a bundle and so is invisible to the load hooks. One loader, two
 * dialects, because the two bundlers hand it different inputs:
 *
 * - **webpack** registers it with `enforce: "post"`, so it sees compiled
 *   JavaScript and parses with acorn (`dialect: "compiled"`, the default).
 * - **Turbopack** has no post phase — rule loaders run on the *original*
 *   TypeScript/TSX — so that registration passes `dialect: "source"` and the
 *   file is parsed with the `typescript` compiler API instead.
 *
 * Scoping also differs: webpack's rule carries `include`/`exclude` matchers,
 * while Turbopack rules are extension globs, so the source dialect gets the
 * include prefixes as options and filters here.
 */

import { extname } from "node:path";

import { fileIdFor } from "../instrument/select.ts";
import { transform } from "../instrument/transform.ts";
import { transformTs, typescriptAvailable } from "../instrument/transform-ts.ts";

interface LoaderOptions {
  root?: string;
  /** How the input is parsed; see the module comment. */
  dialect?: "compiled" | "source";
  /** Root-relative directory prefixes to instrument (source dialect only). */
  include?: string[];
}

interface LoaderContext {
  resourcePath: string;
  getOptions?: () => LoaderOptions;
  emitWarning?: (warning: Error) => void;
}

export default function ccqaCoverageLoader(this: LoaderContext, source: string): string {
  const options = this.getOptions?.() ?? {};
  const root = options.root ?? process.cwd();
  if (this.resourcePath.includes("node_modules")) return source;
  const fileId = fileIdFor(this.resourcePath, root);
  if (fileId === undefined) return source;
  if (options.include !== undefined && !underAny(fileId, options.include)) return source;

  if (options.dialect === "source") {
    if (!typescriptAvailable()) {
      this.emitWarning?.(
        new Error(
          "ccqa-tools needs the `typescript` package to instrument Turbopack builds; " +
            `${fileId} left uninstrumented`,
        ),
      );
      return source;
    }
    const instrumented = transformTs(source, { fileId, extension: extname(this.resourcePath) });
    if (instrumented === undefined) {
      this.emitWarning?.(new Error(`ccqa-tools could not parse ${fileId}; left uninstrumented`));
      return source;
    }
    return instrumented;
  }

  const instrumented = transform(source, { fileId });
  if (instrumented === undefined) {
    this.emitWarning?.(new Error(`ccqa-tools could not parse ${fileId}; left uninstrumented`));
    return source;
  }
  return instrumented;
}

function underAny(fileId: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => fileId === prefix || fileId.startsWith(`${prefix}/`));
}
