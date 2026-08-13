import { describe, expect, it } from "vitest";

import { BAGGAGE_KEY, COOKIE_NAME, parseSpecId, readBaggage, readCookie, writeBaggage } from "./wire.ts";

describe("readCookie", () => {
  it("finds the target cookie among unrelated ones", () => {
    expect(readCookie(`foo=bar; ${COOKIE_NAME}=run1.spec-a; baz=qux`)).toBe("run1.spec-a");
  });
});

describe("parseSpecId", () => {
  it("rejects the sentinel values '1' and 'true', and values with disallowed characters", () => {
    expect(parseSpecId("1")).toBeUndefined();
    expect(parseSpecId("true")).toBeUndefined();
    expect(parseSpecId("run1.spec<a>")).toBeUndefined();
  });
});

describe("readBaggage", () => {
  it("reads the value from a W3C baggage entry that carries properties", () => {
    const header = `${BAGGAGE_KEY}=run1.spec-a;prop1=x;prop2=y,other.key=val`;
    expect(readBaggage(header)).toBe("run1.spec-a");
  });
});

describe("writeBaggage", () => {
  it("replaces an existing entry for the same key while keeping the others", () => {
    const existing = `${BAGGAGE_KEY}=old.spec,other.key=keep-me`;
    const result = writeBaggage(existing, "new.spec");
    const entries = result.split(",");
    expect(entries).toContain(`${BAGGAGE_KEY}=new.spec`);
    expect(entries).toContain("other.key=keep-me");
    expect(result).not.toContain("old.spec");
  });
});
