/**
 * TypeScript/TSX form of the instrumenter.
 *
 * The webpack post-loader sees compiled JavaScript and parses with acorn;
 * Turbopack hands loaders the *original* source, before its own TypeScript
 * and JSX transforms, so this dialect parses with the `typescript` compiler
 * API instead and splices the same probes into the untranspiled text. The
 * output stays TypeScript — the bundler's own pipeline compiles it after us —
 * which is what keeps this file free of any JSX/downlevel emit of its own.
 *
 * Same contract as `transform`: insertions only, never a newline, so line
 * numbers and the framework's source maps survive untouched.
 *
 * `typescript` is loaded lazily and is not a dependency of this package: this
 * path only runs at build time inside a project that compiles TypeScript,
 * where the compiler is present by definition. When it is somehow absent the
 * file is left uninstrumented and the loader warns.
 */

import { createRequire } from "node:module";

import {
  DEFAULT_MAX_DEPTH,
  probeTexts,
  splice,
  type TransformOptions,
} from "./transform.ts";

type Ts = typeof import("typescript");
type TsNode = import("typescript").Node;
type TsSourceFile = import("typescript").SourceFile;
type TsBlock = import("typescript").Block;

const require = createRequire(import.meta.url);

let tsModule: Ts | null | undefined;

function loadTypescript(): Ts | null {
  if (tsModule !== undefined) return tsModule;
  try {
    tsModule = require("typescript") as Ts;
  } catch {
    tsModule = null;
  }
  return tsModule;
}

/** Whether the TypeScript dialect can run at all in this process. */
export function typescriptAvailable(): boolean {
  return loadTypescript() !== null;
}

export interface TsTransformOptions extends TransformOptions {
  /** The file's extension, deciding JSX handling. Defaults to `.tsx`. */
  extension?: string;
}

export function transformTs(code: string, options: TsTransformOptions): string | undefined {
  const ts = loadTypescript();
  if (ts === null || code.length === 0) return undefined;

  const kind = scriptKindFor(ts, options.extension ?? ".tsx");
  const sourceFile = ts.createSourceFile("module.tsx", code, ts.ScriptTarget.Latest, false, kind);
  // Parse diagnostics live on an internal field; a file the compiler could
  // not parse gets wrong positions, so it is left alone like acorn does.
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (Array.isArray(diagnostics) && diagnostics.length > 0) return undefined;

  const { enter, prologue } = probeTexts(options.fileId);
  const points: number[] = [];
  collect(ts, sourceFile, options.maxDepth ?? DEFAULT_MAX_DEPTH, points);

  const prologueAt = afterDirectives(ts, sourceFile, sourceFile.statements, shebangEnd(code));
  const edits = points
    .filter((offset) => offset > prologueAt)
    .map((offset) => ({ offset, text: enter }));
  edits.push({ offset: prologueAt, text: prologue });
  edits.sort((a, b) => a.offset - b.offset);
  return splice(code, edits);
}

function scriptKindFor(ts: Ts, extension: string): import("typescript").ScriptKind {
  switch (extension) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      // Next allows JSX in plain .js files; the JSX grammar parses plain
      // JavaScript unchanged, so this is the lenient choice.
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.TSX;
  }
}

function shebangEnd(code: string): number {
  if (!code.startsWith("#!")) return 0;
  const newline = code.indexOf("\n");
  return newline < 0 ? code.length : newline + 1;
}

function collect(ts: Ts, sourceFile: TsSourceFile, maxDepth: number, points: number[]): void {
  walk(sourceFile, 0, false);

  function walk(node: TsNode, depth: number, inClass: boolean): void {
    const isFunction = isFunctionLike(ts, node);
    const nextDepth = isFunction ? depth + 1 : depth;

    if (isFunction) {
      // A class method is always worth recording: it is the entry point
      // callers reach a file through, however deeply the class sits.
      const wanted = inClass || nextDepth <= maxDepth;
      const body = (node as { body?: TsNode }).body;
      if (wanted && body !== undefined && ts.isBlock(body)) {
        points.push(afterDirectives(ts, sourceFile, (body as TsBlock).statements, body.getStart(sourceFile) + 1));
      }
    }

    ts.forEachChild(node, (child) => walk(child, nextDepth, childInClass(ts, node, child, inClass)));
  }
}

function isFunctionLike(ts: Ts, node: TsNode): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/**
 * Mirrors the acorn walk's rule: true for the function a class member *is* or
 * holds, false again once inside any function body. In this AST a class
 * method is itself the function-like — there is no separate `value` node —
 * so membership is decided when the class hands its members down.
 */
function childInClass(ts: Ts, parent: TsNode, child: TsNode, inherited: boolean): boolean {
  if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
    return (
      ts.isMethodDeclaration(child) ||
      ts.isConstructorDeclaration(child) ||
      ts.isGetAccessorDeclaration(child) ||
      ts.isSetAccessorDeclaration(child) ||
      ts.isPropertyDeclaration(child)
    );
  }
  if (ts.isPropertyDeclaration(parent)) return child === (parent as { initializer?: TsNode }).initializer;
  if (isFunctionLike(ts, parent)) return false;
  return inherited;
}

/**
 * Same rule as the acorn dialect: a directive prologue only counts while it
 * is still the first thing in its scope, and `"use client"` / `"use server"`
 * are directives to Next, so nothing may be inserted ahead of them.
 */
function afterDirectives(
  ts: Ts,
  sourceFile: TsSourceFile,
  statements: readonly TsNode[],
  from: number,
): number {
  let offset = from;
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement)) break;
    const expression = (statement as { expression: TsNode }).expression;
    if (!ts.isStringLiteral(expression)) break;
    offset = statement.end;
  }
  return offset;
}
