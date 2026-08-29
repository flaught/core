import { describe, expect, it } from "vitest";
import { detectTestWeakening } from "./test-weakening.js";

describe("test weakening detection", () => {
  it.each([
    ["deleted assertion", "-expect(value).toBe(1)", "deleted-assertion"],
    ["skip marker", "+it.skip(\"important\", () => {})", "added-skip-marker"],
    ["loosened matcher", "-expect(value).toBe(1)\n+expect(value).toBeTruthy()", "exact-to-truthy"],
  ])("detects %s", (_name, diff, ruleId) => {
    expect(detectTestWeakening(diff).some((finding) => finding.ruleId === ruleId)).toBe(true);
  });

  it("detects a deleted test file", () => {
    expect(detectTestWeakening("", ["src/example.test.ts"])[0]?.ruleId).toBe("deleted-test-file");
  });

  it("does not flag a clean test diff", () => {
    expect(detectTestWeakening("+expect(value).toBe(1)")).toEqual([]);
  });
});
