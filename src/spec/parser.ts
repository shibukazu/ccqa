import matter from "gray-matter";
import type { TestSpec, TestStep, SetupSpec, SetupRef } from "../types.ts";

export function parseTestSpec(content: string): TestSpec {
  const { data, content: body } = matter(content);

  const steps = parseSteps(body);

  const prerequisites = parsePrerequisites(body);

  return {
    title: String(data["title"] ?? "Untitled"),
    baseUrl: String(data["baseUrl"] ?? "http://localhost:3000"),
    prerequisites: prerequisites || undefined,
    setups: parseSetupRefs(data["setups"]),
    steps,
  };
}

export function parseSetupSpec(content: string): SetupSpec {
  const { data, content: body } = matter(content);

  const steps = parseSteps(body);
  const placeholders = parsePlaceholders(data["placeholders"]);

  return {
    title: String(data["title"] ?? "Untitled"),
    placeholders: Object.keys(placeholders).length > 0 ? placeholders : undefined,
    steps,
  };
}

function parsePlaceholders(raw: unknown): Record<string, { dummy: string; description?: string }> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, { dummy: string; description?: string }> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val && typeof val === "object" && "dummy" in val) {
      const v = val as Record<string, unknown>;
      result[key] = {
        dummy: String(v["dummy"]),
        description: v["description"] ? String(v["description"]) : undefined,
      };
    }
  }
  return result;
}

function parseSetupRefs(raw: unknown): SetupRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs: SetupRef[] = [];
  for (const item of raw) {
    if (typeof item === "object" && item !== null && "name" in item) {
      const i = item as Record<string, unknown>;
      refs.push({
        name: String(i["name"]),
        params: i["params"] && typeof i["params"] === "object"
          ? Object.fromEntries(
              Object.entries(i["params"] as Record<string, unknown>).map(([k, v]) => [k, String(v)])
            )
          : undefined,
      });
    }
  }
  return refs.length > 0 ? refs : undefined;
}

function parsePrerequisites(body: string): string | null {
  const match = body.match(/##\s+Prerequisites\s+([\s\S]*?)(?=##|$)/);
  if (!match || !match[1]) return null;
  return match[1].trim();
}

function parseSteps(body: string): TestStep[] {
  const stepBlocks = body.split(/###\s+Step\s+\d+:/);
  const steps: TestStep[] = [];

  for (let i = 1; i < stepBlocks.length; i++) {
    const block = stepBlocks[i];
    if (!block) continue;

    const titleMatch = block.match(/^(.+)/);
    const instructionMatch = block.match(/\*\*Instruction\*\*:\s*(.+)/);
    const expectedMatch = block.match(/\*\*Expected\*\*:\s*(.+)/);

    if (!titleMatch || !instructionMatch || !expectedMatch) continue;

    steps.push({
      id: `step-${String(i).padStart(2, "0")}`,
      title: titleMatch[1]?.trim() ?? "",
      instruction: instructionMatch[1]?.trim() ?? "",
      expected: expectedMatch[1]?.trim() ?? "",
    });
  }

  return steps;
}
