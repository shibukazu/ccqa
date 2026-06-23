// Helpers for CCQA_CLAUDE_MOCK_FILE — the env hook that Phase 2 will add in
// src/claude/invoke.ts to replay canned SDK messages from a JSONL fixture.
//
// This module is imported by tests that will only run once Phase 2 lands the
// mock seam. Phase 1 just ships the scaffolding so fixtures can be authored.

import { writeFile } from "node:fs/promises";

export type SdkMessageRecord = Record<string, unknown>;

export async function writeMockMessages(
  path: string,
  messages: readonly SdkMessageRecord[],
): Promise<void> {
  const body = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await writeFile(path, body, "utf8");
}
