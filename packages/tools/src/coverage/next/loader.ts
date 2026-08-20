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
 * include prefixes as options and filters through `shouldInstrument` — the
 * same decision the runtime load hooks use.
 */

import { extname } from "node:path";

import { fileIdFor, shouldInstrument } from "../instrument/select.ts";
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
  const dialect = options.dialect ?? "compiled";

  const fileId =
    dialect === "source"
      ? shouldInstrument(this.resourcePath, { root, include: options.include ?? [] })
      : fileIdFor(this.resourcePath, root);
  if (fileId === undefined) return source;
  if (source.trim().length === 0) return source;

  if (dialect === "source" && !typescriptAvailable(root)) {
    this.emitWarning?.(
      new Error(
        "ccqa-tools needs the `typescript` package to instrument Turbopack builds; " +
          `${fileId} left uninstrumented`,
      ),
    );
    return source;
  }
  const instrumented =
    dialect === "source"
      ? transformTs(source, { fileId, extension: extname(this.resourcePath), resolveFrom: root })
      : transform(source, { fileId });
  if (instrumented === undefined) {
    this.emitWarning?.(new Error(`ccqa-tools could not parse ${fileId}; left uninstrumented`));
    return source;
  }
  return instrumented;
}
