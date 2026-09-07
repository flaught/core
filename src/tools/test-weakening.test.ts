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

  it("reports the changed file and hunk line for a finding", () => {
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "--- a/src/example.test.ts",
      "+++ b/src/example.test.ts",
      "@@ -12,1 +12,0 @@",
      "-expect(value).toBe(1)",
    ].join("\n");

    const finding = detectTestWeakening(diff)[0];
    expect(finding).toMatchObject({
      file: "src/example.test.ts",
      line: 12,
      category: "test-quality",
    });
  });

  it("uses the added line and medium severity for skip markers", () => {
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "--- a/src/example.test.ts",
      "+++ b/src/example.test.ts",
      "@@ -0,0 +24,1 @@",
      "+it.skip(\"important\", () => {})",
    ].join("\n");

    expect(detectTestWeakening(diff)[0]).toMatchObject({
      file: "src/example.test.ts",
      line: 24,
      severity: "medium",
    });
  });

  it("detects a deleted test file", () => {
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "deleted file mode 100644",
      "--- a/src/example.test.ts",
      "+++ /dev/null",
      "@@ -7,1 +0,0 @@",
      "-it(\"important\", () => {})",
    ].join("\n");

    expect(detectTestWeakening(diff, ["src/example.test.ts"])[0]).toMatchObject({
      ruleId: "deleted-test-file",
      file: "src/example.test.ts",
      line: 7,
    });
  });

  it("detects a test body replaced with comments", () => {
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "--- a/src/example.test.ts",
      "+++ b/src/example.test.ts",
      "@@ -7,2 +7,2 @@",
      "-it(\"important\", () => {",
      "+// it(\"important\", () => {",
    ].join("\n");

    expect(detectTestWeakening(diff)[0]).toMatchObject({
      ruleId: "commented-test-body",
      file: "src/example.test.ts",
      line: 7,
    });
  });

  it("does not flag a clean test diff", () => {
    expect(detectTestWeakening("+expect(value).toBe(1)")).toEqual([]);
  });
});
