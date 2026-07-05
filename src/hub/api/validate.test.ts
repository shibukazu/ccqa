import { describe, expect, test } from "vitest";
import { HttpError } from "./respond.ts";
import { requireSafeRelPath, requireSafeSegment } from "./validate.ts";

describe("requireSafeSegment", () => {
  test.each(["default", "admin", "profile-1", "user_2.name"])("accepts %s", (value) => {
    expect(requireSafeSegment(value, "name")).toBe(value);
  });

  test.each([
    [".."],
    ["../evil"],
    ["a/b"],
    ["a\\b"],
    [""],
    ["."],
    ["/etc/passwd"],
    ["..%2Fevil".replace("%2F", "/")], // decoded traversal, as the router would hand it over
  ])("rejects %j", (value) => {
    expect(() => requireSafeSegment(value, "name")).toThrow(HttpError);
    try {
      requireSafeSegment(value, "name");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
    }
  });
});

describe("requireSafeRelPath", () => {
  test.each(["evidence/step1.png", "report.json", "index.html", "a/b/c.txt"])("accepts %s", (value) => {
    expect(requireSafeRelPath(value, "path")).toBe(value);
  });

  test.each([
    ["../../../etc/passwd"],
    ["../evil"],
    ["a/../../b"],
    ["/etc/passwd"],
    ["\\windows\\system32"],
    ["a\\..\\..\\b"],
    [""],
    ["."],
    ["a/./b"],
  ])("rejects %j", (value) => {
    expect(() => requireSafeRelPath(value, "path")).toThrow(HttpError);
    try {
      requireSafeRelPath(value, "path");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
    }
  });
});
