import { writeFileSync } from "node:fs";

export default function globalSetup(): void {
  const sentinel = process.env.CCQA_TEST_SENTINEL;
  if (sentinel) writeFileSync(sentinel, "touched", "utf8");
}
