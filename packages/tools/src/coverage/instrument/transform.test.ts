import { describe, expect, it } from "vitest";

import { transform } from "./transform.ts";

describe("transform", () => {
  it("never inserts a newline, so line numbers survive untouched", () => {
    const source = `export function greet(name) {
  return "hi " + name;
}

export const api = {
  method() {
    return 1;
  },
};

export class Widget {
  render() {
    return 2;
  }
}
`;
    const out = transform(source, { fileId: "src/probe.ts" });
    expect(out).toBeDefined();
    expect(out!.split("\n").length).toBe(source.split("\n").length);
  });

  it("leaves a leading \"use strict\" directive as the first statement", () => {
    const source = '"use strict";\nexport function f() {\n  return 1;\n}\n';
    const out = transform(source, { fileId: "src/strict.ts" });
    expect(out!.startsWith('"use strict";')).toBe(true);
  });

  it("leaves a function body's own directive first, so the code it governs keeps running strict", () => {
    const source = 'function f() { "use strict"; undeclared = 1; }';
    const out = transform(source, { fileId: "src/strict-fn.js" })!;
    // Inserting ahead of the directive would demote it and quietly change the
    // instrumented application's semantics — the one thing measurement must not do.
    expect(out.indexOf('"use strict";')).toBeLessThan(out.indexOf("undeclared = 1"));
    const call = out.lastIndexOf("__ccqa_");
    expect(call).toBeGreaterThan(out.indexOf('"use strict";'));
  });

  it("instruments the body of an exported function, an object-literal method, and a class method", () => {
    const source = `export function greet() {
  return 1;
}

export const api = {
  method() {
    return 2;
  },
};

export class Widget {
  render() {
    return 3;
  }
}
`;
    const out = transform(source, { fileId: "src/shapes.ts" })!;
    expect(out).toMatch(/function greet\(\) \{__ccqa_\w+&&__ccqa_\w+\("src\/shapes\.ts"\);/);
    expect(out).toMatch(/method\(\) \{__ccqa_\w+&&__ccqa_\w+\("src\/shapes\.ts"\);/);
    expect(out).toMatch(/render\(\) \{__ccqa_\w+&&__ccqa_\w+\("src\/shapes\.ts"\);/);
  });

  it("does not instrument a callback nested 3 or more functions deep", () => {
    const source =
      "export function outer() { return function level2() { return function level3() { return function level4() { return 1; }; }; }; }";
    const out = transform(source, { fileId: "src/deep.ts" })!;
    expect(out).toMatch(/function outer\(\) \{__ccqa_\w+&&__ccqa_\w+\("src\/deep\.ts"\);/);
    expect(out).toMatch(/function level2\(\) \{__ccqa_\w+&&__ccqa_\w+\("src\/deep\.ts"\);/);
    expect(out).not.toMatch(/function level3\(\) \{__ccqa_/);
    expect(out).not.toMatch(/function level4\(\) \{__ccqa_/);
  });

  it("keeps a hashbang as the first line of the file", () => {
    const source = '#!/usr/bin/env node\nconsole.log("hi");\n';
    const out = transform(source, { fileId: "bin/cli.ts" });
    expect(out!.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("returns undefined for a source that fails to parse, so callers can pass it through unchanged", () => {
    const out = transform("const x = ;", { fileId: "src/broken.ts" });
    expect(out).toBeUndefined();
  });

  it("produces code that runs without the coverage global installed", () => {
    const source = `function greet(name) {
  return "hi " + name;
}
const api = {
  method() {
    return greet("x");
  },
};
api.method();
`;
    const out = transform(source, { fileId: "src/exec.ts" })!;
    delete (globalThis as Record<string, unknown>).__ccqaCoverage;
    expect(() => new Function(out)()).not.toThrow();
  });
});
