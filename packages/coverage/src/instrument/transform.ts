/**
 * Rewrites a module so that entering it, or entering one of its functions,
 * calls `globalThis.__ccqaCoverage`.
 *
 * Two properties drive the whole shape:
 *
 * - **Insertions only, never a newline.** Line numbers survive untouched, so
 *   the source map the application already ships keeps pointing at the right
 *   lines and stack traces stay readable. A codegen round-trip would have
 *   forced us to produce and merge maps of our own.
 * - **File granularity.** The record is "this file ran", so there is no need to
 *   track statements or branches, and the whole class of line/branch
 *   normalisation bugs that follow V8-to-istanbul conversion never appears.
 */

import { parse, type Node } from "acorn";

export interface TransformOptions {
  /** Stable id for the file, normally its path relative to the project root. */
  fileId: string;
  /**
   * How deep a function may sit and still be instrumented, counting from module
   * scope. Depth 2 catches exported functions and the methods of exported
   * object literals while leaving inner callbacks — the hot ones — alone.
   */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 2;

interface FunctionLike extends Node {
  body?: Node | null;
}

export function transform(code: string, options: TransformOptions): string | undefined {
  const program = parseProgram(code);
  if (program === undefined) return undefined;

  const local = `__ccqa_${hash(options.fileId)}`;
  const literal = JSON.stringify(options.fileId);
  const enter = `${local}&&${local}(${literal});`;
  const points: number[] = [];

  collect(program, options.maxDepth ?? DEFAULT_MAX_DEPTH, points);
  if (code.length === 0) return undefined;

  const prologueAt = afterDirectives(code, program);
  const edits = points
    .filter((offset) => offset > prologueAt)
    .map((offset) => ({ offset, text: enter }));
  edits.push({
    offset: prologueAt,
    text: `var ${local}=globalThis.__ccqaCoverage;${local}&&${local}(${literal},true);`,
  });
  // Every point was filtered to offset > prologueAt above, so the prologue
  // edit already holds the minimum offset and sorts first.
  edits.sort((a, b) => a.offset - b.offset);

  const parts: string[] = [];
  let last = 0;
  for (const edit of edits) {
    parts.push(code.slice(last, edit.offset), edit.text);
    last = edit.offset;
  }
  parts.push(code.slice(last));
  return parts.join("");
}

function parseProgram(code: string): Node | undefined {
  for (const sourceType of ["module", "script"] as const) {
    try {
      return parse(code, {
        ecmaVersion: "latest",
        sourceType,
        allowHashBang: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: sourceType === "script",
      }) as unknown as Node;
    } catch {
      // Fall through to the next source type; an unparsable file is left alone.
    }
  }
  return undefined;
}

/**
 * A directive prologue only counts while it is still the first thing in its
 * scope. Inserting ahead of `"use strict"` demotes it to an ordinary string
 * expression, and the code it governed silently starts running sloppy — the
 * instrumentation would be changing the behaviour it is supposed to observe.
 * Applies to a function body as much as to the module.
 */
function afterDirectives(code: string, program: Node): number {
  let offset = (program as unknown as { start: number }).start;
  if (code.startsWith("#!")) {
    const newline = code.indexOf("\n");
    offset = newline < 0 ? code.length : newline + 1;
  }
  return skipDirectives((program as unknown as { body: Node[] }).body, offset);
}

function skipDirectives(statements: readonly Node[], from: number): number {
  let offset = from;
  for (const statement of statements) {
    if (statement.type !== "ExpressionStatement") break;
    const expression = (statement as unknown as { expression: Node }).expression;
    if (expression.type !== "Literal" || typeof (expression as unknown as { value: unknown }).value !== "string") break;
    offset = (statement as unknown as { end: number }).end;
  }
  return offset;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function collect(root: Node, maxDepth: number, points: number[]): void {
  walk(root, 0, false);

  function walk(node: Node, depth: number, inClass: boolean): void {
    const isFunction = FUNCTION_TYPES.has(node.type);
    const nextDepth = isFunction ? depth + 1 : depth;

    if (isFunction) {
      // A class method is always worth recording: it is the entry point callers
      // reach a file through, however deeply the class itself is nested.
      const wanted = inClass || nextDepth <= maxDepth;
      const body = (node as FunctionLike).body;
      if (wanted && body && body.type === "BlockStatement") {
        const statements = (body as unknown as { body: Node[] }).body;
        points.push(skipDirectives(statements, (body as unknown as { start: number }).start + 1));
      }
    }

    // acorn nodes are plain objects with only own enumerable properties, so
    // `for...in` needs no `hasOwnProperty` guard and skips the array alloc
    // `Object.keys` would make on every node.
    for (const key in node) {
      if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") {
        continue;
      }
      const value = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isNode(item)) walk(item, nextDepth, childInClass(node, key, inClass));
        }
      } else if (isNode(value)) {
        walk(value, nextDepth, childInClass(node, key, inClass));
      }
    }
  }
}

/** True while walking the value of a class member, false again inside its body. */
function childInClass(parent: Node, key: string, inherited: boolean): boolean {
  if (parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") {
    return key === "value";
  }
  if (FUNCTION_TYPES.has(parent.type)) return false;
  return inherited;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

/** Short, collision-resistant suffix so bundlers can hoist several modules into one scope. */
function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
