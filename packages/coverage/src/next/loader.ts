/**
 * webpack loader form of the instrumenter, for code that reaches the runtime as
 * part of a bundle and so is invisible to the load hooks.
 *
 * It is registered with `enforce: "post"` so it sees JavaScript: webpack runs
 * post loaders last, after the framework's own TypeScript/JSX transform, which
 * keeps this file free of a TypeScript parser.
 */

import { fileIdFor } from "../instrument/select.ts";
import { transform } from "../instrument/transform.ts";

interface LoaderContext {
  resourcePath: string;
  getOptions?: () => { root?: string };
  emitWarning?: (warning: Error) => void;
}

export default function ccqaCoverageLoader(this: LoaderContext, source: string): string {
  const root = this.getOptions?.().root ?? process.cwd();
  const fileId = fileIdFor(this.resourcePath, root);
  if (fileId === undefined) return source;
  const instrumented = transform(source, { fileId });
  if (instrumented === undefined) {
    this.emitWarning?.(new Error(`ccqa-coverage could not parse ${fileId}; left uninstrumented`));
    return source;
  }
  return instrumented;
}
