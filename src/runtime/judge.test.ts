import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREDENTIAL_ENV_KEYS } from "../claude/env-keys.ts";
import { decideClaim, judgeByLlm, parseVerdict, type TextSource } from "./judge.ts";

describe("parseVerdict", () => {
  it("reads the verdict the model was asked for", () => {
    expect(parseVerdict('{"ok": true, "reason": "the answer lists the steps"}')).toEqual({
      ok: true,
      reason: "the answer lists the steps",
    });
  });

  it("takes the object out of an answer the model wrapped in prose or a fence", () => {
    const wrapped = 'Sure!\n```json\n{"ok": false, "reason": "it says it does not know"}\n```';
    expect(parseVerdict(wrapped)).toEqual({ ok: false, reason: "it says it does not know" });
  });

  it("skips an object that carries no verdict", () => {
    const answer = '{"note": "thinking"}\n{"ok": false, "reason": "the reply is a refusal"}';
    expect(parseVerdict(answer)).toEqual({ ok: false, reason: "the reply is a refusal" });
  });

  // Each of these is a decision that was not made. Reading one as a pass would
  // let a claim go unjudged while the test still went green.
  it("refuses an answer it cannot read a verdict out of", () => {
    for (const answer of ["looks fine to me", "{not json}", '{"reason": "no ok"}', '{"ok": "yes"}']) {
      expect(() => parseVerdict(answer)).toThrow(/no verdict/);
    }
  });

  it("keeps a verdict whose reason the model left out", () => {
    expect(parseVerdict('{"ok": true}')).toEqual({ ok: true, reason: "" });
  });
});

/** A `TextSource` that records which selector it was read with. */
function fakePage(text = "irrelevant"): TextSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    innerText: async (selector: string) => {
      calls.push(selector);
      return text;
    },
  };
}

describe("judgeByLlm / decideClaim", () => {
  const ORIGINAL_KEY = process.env["ANTHROPIC_API_KEY"];
  let tmpDirs: string[] = [];

  afterEach(async () => {
    if (ORIGINAL_KEY === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = ORIGINAL_KEY;
    delete process.env["CCQA_CLAUDE_MOCK_FILE"];
    await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tmpDirs = [];
  });

  /**
   * Points `invokeClaudeStreaming` at a one-message JSONL replay carrying the
   * given verdict, and sets a fake credential so `decideClaim`'s pre-check
   * passes — same mock seam `src/claude/invoke.test.ts` uses.
   */
  async function mockVerdict(verdict: { ok: boolean; reason: string }): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "ccqa-judge-mock-"));
    tmpDirs.push(dir);
    const mockPath = join(dir, "claude-mock.jsonl");
    const message = { type: "result", subtype: "success", is_error: false, result: JSON.stringify(verdict) };
    await writeFile(mockPath, JSON.stringify(message) + "\n", "utf8");
    process.env["CCQA_CLAUDE_MOCK_FILE"] = mockPath;
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
  }

  it("takes a string third argument as the `from` selector, same as `{ from }`", async () => {
    await mockVerdict({ ok: true, reason: "fine" });
    const page = fakePage();
    await judgeByLlm(page, "claim", ".out");
    await judgeByLlm(page, "claim", { from: ".out" });
    await judgeByLlm(page, "claim");
    expect(page.calls).toEqual([".out", ".out", "body"]);
  });

  it("attaches the verdict to testInfo on a passing judgement, and does not throw", async () => {
    await mockVerdict({ ok: true, reason: "it lists steps" });
    const attach = vi.fn().mockResolvedValue(undefined);
    await judgeByLlm(fakePage(), "the answer lists steps", { from: ".out", testInfo: { attach } });
    expect(attach).toHaveBeenCalledWith("ccqa-judge", {
      body: JSON.stringify(
        { claim: "the answer lists steps", from: ".out", ok: true, reason: "it lists steps" },
        null,
        2,
      ),
      contentType: "application/json",
    });
  });

  it("does not fail a passing judgement when the attach itself fails, but reports it to stderr", async () => {
    await mockVerdict({ ok: true, reason: "it lists steps" });
    const attach = vi.fn().mockRejectedValue(new Error("report disk full"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(
        judgeByLlm(fakePage(), "the answer lists steps", { testInfo: { attach } }),
      ).resolves.toBeUndefined();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("report disk full"));
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("attaches the verdict and still throws the claim failure on a failing judgement", async () => {
    await mockVerdict({ ok: false, reason: "it never answers" });
    const attach = vi.fn().mockResolvedValue(undefined);
    await expect(
      judgeByLlm(fakePage(), "the answer lists steps", { testInfo: { attach } }),
    ).rejects.toThrow(/the claim did not hold \(it never answers\)/);
    expect(attach).toHaveBeenCalledWith("ccqa-judge", {
      body: JSON.stringify(
        { claim: "the answer lists steps", from: "body", ok: false, reason: "it never answers" },
        null,
        2,
      ),
      contentType: "application/json",
    });
  });

  it("does not let a failing attach mask the claim's own failure", async () => {
    await mockVerdict({ ok: false, reason: "it never answers" });
    const attach = vi.fn().mockRejectedValue(new Error("report disk full"));
    await expect(
      judgeByLlm(fakePage(), "the answer lists steps", { testInfo: { attach } }),
    ).rejects.toThrow(/the claim did not hold \(it never answers\)/);
  });
});

describe("decideClaim — missing credentials", () => {
  const ORIGINAL_HOME = process.env["HOME"];
  const ORIGINAL_PATH = process.env["PATH"];
  const ORIGINAL_BEDROCK = process.env["CLAUDE_CODE_USE_BEDROCK"];
  const ORIGINAL_VERTEX = process.env["CLAUDE_CODE_USE_VERTEX"];
  const ORIGINAL_CREDS = Object.fromEntries(CREDENTIAL_ENV_KEYS.map((k) => [k, process.env[k]]));

  // On darwin `driftAuthAvailable` also consults the Keychain via the
  // `security` binary — stub it out so this stays deterministic on a
  // developer Mac that has a real Claude Code login (as this repo's own
  // `src/drift/auth.test.ts` does).
  function stubSecurityBinary(exitCode: 0 | 1): void {
    const dir = mkdtempSync(join(tmpdir(), "ccqa-judge-auth-stub-"));
    const stub = join(dir, "security");
    writeFileSync(stub, `#!/bin/sh\nexit ${exitCode}\n`, "utf-8");
    chmodSync(stub, 0o755);
    process.env["PATH"] = `${dir}:${ORIGINAL_PATH ?? ""}`;
  }

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    if (ORIGINAL_PATH === undefined) delete process.env["PATH"];
    else process.env["PATH"] = ORIGINAL_PATH;
    if (ORIGINAL_BEDROCK === undefined) delete process.env["CLAUDE_CODE_USE_BEDROCK"];
    else process.env["CLAUDE_CODE_USE_BEDROCK"] = ORIGINAL_BEDROCK;
    if (ORIGINAL_VERTEX === undefined) delete process.env["CLAUDE_CODE_USE_VERTEX"];
    else process.env["CLAUDE_CODE_USE_VERTEX"] = ORIGINAL_VERTEX;
    for (const [key, value] of Object.entries(ORIGINAL_CREDS)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("says which env vars to set instead of leaking an opaque SDK error", async () => {
    stubSecurityBinary(1);
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "ccqa-judge-auth-"));
    delete process.env["CLAUDE_CODE_USE_BEDROCK"];
    delete process.env["CLAUDE_CODE_USE_VERTEX"];
    for (const key of CREDENTIAL_ENV_KEYS) delete process.env[key];

    await expect(decideClaim({ claim: "c", text: "t" })).rejects.toThrow(
      /judgeByLlm needs Claude credentials: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.*Bedrock.*Vertex.*claude login.*CCQA_JUDGE_MODEL/s,
    );
  });
});
