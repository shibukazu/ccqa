import { describe, expect, test } from "vitest";
import { extractRoutes, extractSchemaNames, removedNames } from "./wire-surface.ts";

const SCHEMA = `import { z } from "zod";

export const KINDS = ["run", "drift"] as const;

export const StatusSchema = z.enum([
  "passed",
  "failed",
]);

export const RunSchema = z.object({
  id: z.string(),
  // gitHead: dropped in 1.0, and the comment must not resurrect it
  mode: z.enum(["live", "replay"]),
});

export type Run = z.infer<typeof RunSchema>;

export function isRun(value: unknown): boolean {
  const shape = { id: "" };
  return typeof value === typeof shape;
}
`;

describe("extractSchemaNames", () => {
  test("reads keys, inline enums, multi-line enums and `as const` vocabularies", () => {
    expect(extractSchemaNames(SCHEMA)).toEqual([
      "KINDS:drift",
      "KINDS:run",
      "RunSchema.id",
      "RunSchema.mode",
      "RunSchema.mode:live",
      "RunSchema.mode:replay",
      "StatusSchema:failed",
      "StatusSchema:passed",
    ]);
  });
});

describe("extractRoutes", () => {
  test("a route is its method and its path; a commented-out one is not a route", () => {
    const source = `
      router.post("/api/v1/runs", createPushRunHandler());
      router.get("/api/v1/runs/:id", createGetRunHandler(storage));
      // router.delete("/api/v1/runs/:id", ...) — never shipped
    `;

    expect(extractRoutes(source)).toEqual(["GET /api/v1/runs/:id", "POST /api/v1/runs"]);
  });
});

describe("removedNames", () => {
  test("only what went away counts — an addition is what `minor` is for", () => {
    expect(removedNames(["RunSchema.id", "RunSchema.branch"], ["RunSchema.id", "RunSchema.profile"])).toEqual([
      "RunSchema.branch",
    ]);
  });
});
