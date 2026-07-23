import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * The hub UI's i18n dictionary (src/hub/ui/index.ts) has two locales, `en` and
 * `ja`, that must carry the SAME key set — a key present in one but not the
 * other silently falls back to English (t() does), which is exactly the
 * "untranslated string" bug this guards against. Enforced mechanically by
 * extracting each locale's keys from the source and comparing the sets.
 */

const INDEX_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

/** Dotted i18n keys (`"nav.projects":`), never the prose values, which are undotted. */
const KEY_RE = /"([a-zA-Z]\w*(?:\.\w+)+)"\s*:/g;

function keysIn(block: string): Set<string> {
  return new Set([...block.matchAll(KEY_RE)].map((m) => m[1]!));
}

describe("hub UI i18n", () => {
  test("en and ja carry identical key sets", async () => {
    const src = await readFile(INDEX_PATH, "utf8");
    const i18nStart = src.indexOf("var I18N = {");
    const enStart = src.indexOf("en: {", i18nStart);
    const jaStart = src.indexOf("ja: {", enStart);
    const jaEnd = src.indexOf("};", jaStart); // the `};` that closes I18N
    expect(i18nStart).toBeGreaterThan(-1);
    expect(enStart).toBeGreaterThan(-1);
    expect(jaStart).toBeGreaterThan(enStart);
    expect(jaEnd).toBeGreaterThan(jaStart);

    const enKeys = keysIn(src.slice(enStart, jaStart));
    const jaKeys = keysIn(src.slice(jaStart, jaEnd));

    // Extraction sanity: the keys this batch touched must all be present.
    for (const k of ["nav.perspectives", "common.refresh", "prompt.customPrompt.fallback"]) {
      expect(enKeys.has(k)).toBe(true);
      expect(jaKeys.has(k)).toBe(true);
    }

    const missingInJa = [...enKeys].filter((k) => !jaKeys.has(k)).sort();
    const missingInEn = [...jaKeys].filter((k) => !enKeys.has(k)).sort();
    expect({ missingInJa, missingInEn }).toEqual({ missingInJa: [], missingInEn: [] });
  });
});
