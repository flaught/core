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

  it("does not flag an explanatory comment inside an executable test helper (GH#89 repro 1)", () => {
    // MysteryMixClub PR #360: a prose comment added inside loadPush(), an
    // async test HELPER (not an it/test callback), while tests were actively
    // extended. The removed `it(` header reappears unmodified (reindent from
    // being wrapped in describe), so nothing was genuinely removed.
    const diff = [
      "diff --git a/src/push.test.ts b/src/push.test.ts",
      "--- a/src/push.test.ts",
      "+++ b/src/push.test.ts",
      "@@ -38,6 +38,10 @@",
      "+describe(\"push registration\", () => {",
      "+  // loadPush resets modules, imports the module and opens the push session",
      "+  async function loadPush() {",
      "+    vi.resetModules();",
      "-  it(\"registers after login\", async () => {",
      "+    it(\"registers after login\", async () => {",
      "+      expect(true).toBe(true);",
      "+    });",
    ].join("\n");

    expect(detectTestWeakening(diff, []).some((f) => f.ruleId === "commented-test-body")).toBe(false);
  });

  it("does not flag reindented/moved test code with a nearby comment (GH#89 repro 2)", () => {
    // MysteryMixClub PR #354: reindentation produces removed+added pairs of
    // identical content; a prose comment added nearby must not combine with
    // the "removed" header into a commented-test-body finding.
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "--- a/src/example.test.ts",
      "+++ b/src/example.test.ts",
      "@@ -10,4 +10,5 @@",
      "-  it(\"keeps state\", () => {",
      "+    it(\"keeps state\", () => {",
      "+    // covers the re-login path too",
    ].join("\n");

    expect(detectTestWeakening(diff, []).some((f) => f.ruleId === "commented-test-body")).toBe(false);
  });

  it("still flags a test body genuinely replaced by comments", () => {
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "--- a/src/example.test.ts",
      "+++ b/src/example.test.ts",
      "@@ -7,4 +7,3 @@",
      "-it(\"validates the token\", () => {",
      "-  const result = validate(token);",
      "-  expect(result.ok).toBe(true);",
      "-});",
      "+// TODO: re-enable once the token endpoint stabilises",
    ].join("\n");

    const findings = detectTestWeakening(diff, []);
    const flagged = findings.find((f) => f.ruleId === "commented-test-body");
    expect(flagged).toBeTruthy();
    // Evidence points at the removed test callback (old line 7), not the comment
    expect(flagged).toMatchObject({ file: "src/example.test.ts", line: 7 });
    expect(flagged?.snippet).toContain('it("validates the token"');
  });

  it("still flags a test commented out wholesale", () => {
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "--- a/src/example.test.ts",
      "+++ b/src/example.test.ts",
      "@@ -7,2 +7,2 @@",
      "-it(\"important\", () => {",
      "+// it(\"important\", () => {",
    ].join("\n");

    expect(detectTestWeakening(diff, []).some((f) => f.ruleId === "commented-test-body")).toBe(true);
  });

it("does not flag a clean test diff", () => {
    expect(detectTestWeakening("+expect(value).toBe(1)")).toEqual([]);
  });

  it("does not fire commented-test-body across different files (regression)", () => {
    // A removed `it()` in a test file plus an added `//` comment in an
    // unrelated source file must NOT trip a cross-file false positive.
    const diff = [
      "diff --git a/src/foo.test.ts b/src/foo.test.ts",
      "--- a/src/foo.test.ts",
      "+++ b/src/foo.test.ts",
      "@@ -5,1 +5,0 @@",
      "-  it(\"old test\", () => {});",
      "diff --git a/src/review.ts b/src/review.ts",
      "--- a/src/review.ts",
      "+++ b/src/review.ts",
      "@@ -1090,1 +1090,2 @@",
      "+  // Registry outage is a tool fault, not a verdict.",
      "+  // CI should warn, not block.",
    ].join("\n");

    const findings = detectTestWeakening(diff, []);
    expect(findings.some((f) => f.ruleId === "commented-test-body")).toBe(false);
    expect(findings.some((f) => f.file === "src/review.ts")).toBe(false);
  });

  it("does not fire a loosened-matcher finding across different files (regression)", () => {
    // A removed `.toBe(` in one test file plus an added `.toBeTruthy(` in a
    // different test file must NOT trip a cross-file matcher finding.
    const diff = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "--- a/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "@@ -1,1 +1,1 @@",
      "-  expect(x).toBe(1);",
      "diff --git a/src/b.test.ts b/src/b.test.ts",
      "--- a/src/b.test.ts",
      "+++ b/src/b.test.ts",
      "@@ -1,1 +1,1 @@",
      "+  expect(y).toBeTruthy();",
    ].join("\n");

    expect(detectTestWeakening(diff, []).some((f) => f.ruleId === "exact-to-truthy")).toBe(false);
  });
});
