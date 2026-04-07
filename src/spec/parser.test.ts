import { describe, test, expect } from "bun:test";
import { parseTestSpec } from "./parser.ts";

const BASIC_SPEC = `---
title: My Test
baseUrl: http://localhost:3000
---

### Step 1: Login
**Instruction**: Navigate to the login page
**Expected**: Login form is visible
`;

describe("parseTestSpec", () => {
  test("parses title and baseUrl from frontmatter", () => {
    const result = parseTestSpec(BASIC_SPEC);
    expect(result.title).toBe("My Test");
    expect(result.baseUrl).toBe("http://localhost:3000");
  });

  test("defaults title to Untitled when missing", () => {
    const result = parseTestSpec("---\nbaseUrl: http://localhost:3000\n---\n");
    expect(result.title).toBe("Untitled");
  });

  test("defaults baseUrl to http://localhost:3000 when missing", () => {
    const result = parseTestSpec("---\ntitle: My Test\n---\n");
    expect(result.baseUrl).toBe("http://localhost:3000");
  });

  test("parses a single step correctly", () => {
    const result = parseTestSpec(BASIC_SPEC);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toEqual({
      id: "step-01",
      title: "Login",
      instruction: "Navigate to the login page",
      expected: "Login form is visible",
    });
  });

  test("parses multiple steps with correct id generation", () => {
    const spec = `---
title: Multi
baseUrl: http://localhost
---

### Step 1: First
**Instruction**: Do first
**Expected**: First done

### Step 2: Second
**Instruction**: Do second
**Expected**: Second done
`;
    const result = parseTestSpec(spec);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.id).toBe("step-01");
    expect(result.steps[1]?.id).toBe("step-02");
  });

  test("returns empty steps array when no steps defined", () => {
    const result = parseTestSpec("---\ntitle: No Steps\nbaseUrl: http://localhost\n---\n");
    expect(result.steps).toHaveLength(0);
  });

  test("skips steps missing Instruction or Expected", () => {
    const spec = `---
title: Missing Fields
baseUrl: http://localhost
---

### Step 1: Complete
**Instruction**: Do something
**Expected**: See something

### Step 2: Missing Expected
**Instruction**: Do something

### Step 3: Missing Instruction
**Expected**: See something
`;
    const result = parseTestSpec(spec);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.id).toBe("step-01");
  });

  test("parses prerequisites when present", () => {
    const spec = `---
title: With Prereqs
baseUrl: http://localhost
---

## Prerequisites
User must be logged in as admin.

### Step 1: Check
**Instruction**: Do check
**Expected**: Check done
`;
    const result = parseTestSpec(spec);
    expect(result.prerequisites).toBe("User must be logged in as admin.");
  });

  test("returns undefined for prerequisites when section is absent", () => {
    const result = parseTestSpec(BASIC_SPEC);
    expect(result.prerequisites).toBeUndefined();
  });

  test("parses setups from frontmatter", () => {
    const spec = `---
title: Setup Test
baseUrl: http://localhost:3000
setups:
  - name: login
    params:
      email: user@example.com
      password: secret
---

### Step 1: Check
**Instruction**: Do check
**Expected**: Check done
`;
    const result = parseTestSpec(spec);
    expect(result.setups).toHaveLength(1);
    expect(result.setups![0]!.name).toBe("login");
    expect(result.setups![0]!.params).toEqual({ email: "user@example.com", password: "secret" });
  });

  test("returns undefined for setups when not specified", () => {
    const result = parseTestSpec(BASIC_SPEC);
    expect(result.setups).toBeUndefined();
  });
});
