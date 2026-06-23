import { describe, expect, test } from "vitest";
import { buildRouterPrompt, buildRouterSystemPrompt } from "./route-new-files.ts";

describe("buildRouterSystemPrompt", () => {
  test("instructs the agent to emit a JSON block with affectedSpecs", () => {
    const sys = buildRouterSystemPrompt();
    expect(sys).toContain("affectedSpecs");
    expect(sys).toMatch(/conservative/i);
  });
});

describe("buildRouterPrompt", () => {
  test("renders each new file with its head preview", () => {
    const p = buildRouterPrompt(
      [{ path: "src/new.ts", head: "export const x = 1;" }],
      [
        {
          featureName: "tasks",
          specName: "create",
          relatedPaths: ["src/features/tasks/**"],
        },
      ],
    );
    expect(p).toContain("### src/new.ts");
    expect(p).toContain("export const x = 1;");
    expect(p).toContain("tasks/create");
    expect(p).toContain("src/features/tasks/**");
  });

  test("handles specs with no relatedPaths declared", () => {
    const p = buildRouterPrompt(
      [{ path: "src/a.ts", head: "" }],
      [{ featureName: "f", specName: "s", relatedPaths: [] }],
    );
    expect(p).toContain("(no relatedPaths declared)");
  });

  test("notes when a file has no readable head", () => {
    const p = buildRouterPrompt([{ path: "src/empty.ts", head: "" }], []);
    expect(p).toContain("(empty or unreadable)");
  });
});
