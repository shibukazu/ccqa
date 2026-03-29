import matter from "gray-matter";
import type { TestSpec, TestStep } from "../types.ts";

export function parseTestSpec(content: string): TestSpec {
  const { data, content: body } = matter(content);

  const steps = parseSteps(body);

  const prerequisites = parsePrerequisites(body);

  return {
    title: String(data["title"] ?? "Untitled"),
    baseUrl: String(data["baseUrl"] ?? "http://localhost:3000"),
    prerequisites: prerequisites || undefined,
    steps,
  };
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
