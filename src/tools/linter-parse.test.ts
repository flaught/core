import { describe, it, expect } from "vitest";
import { parseLinterJsonOutput } from "./runner.js";

// Regression tests for issue #85: both JSON linter branches guarded on the
// same `Array.isArray(data)` condition, so the first (ESLint) branch always
// won and flat-array linter output (Ruff, SwiftLint) silently reported zero
// findings. The parser must disambiguate by payload shape.

describe("parseLinterJsonOutput", () => {
  describe("ESLint format (per-file results with nested messages)", () => {
    it("parses findings from nested messages arrays", () => {
      const stdout = JSON.stringify([
        {
          filePath: "/repo/src/index.ts",
          messages: [
            {
              message: "Unexpected console statement.",
              severity: 2,
              line: 12,
              source: "console.log('hi');",
              ruleId: "no-console",
            },
          ],
        },
      ]);
      const findings = parseLinterJsonOutput(stdout);
      expect(findings).toHaveLength(1);
      expect(findings![0]).toMatchObject({
        title: "Unexpected console statement.",
        severity: "high",
        file: "/repo/src/index.ts",
        line: 12,
        source: "eslint",
        ruleId: "no-console",
      });
    });

    it("returns null for ESLint output with no messages", () => {
      const stdout = JSON.stringify([{ filePath: "/repo/src/ok.ts", messages: [] }]);
      expect(parseLinterJsonOutput(stdout)).toBeNull();
    });
  });

  describe("Ruff format (flat array of violations)", () => {
    it("parses flat-array violations instead of silently dropping them", () => {
      // Shape of `ruff check --output-format=json` (issue #85 repro #1).
      const stdout = JSON.stringify([
        {
          code: "F401",
          message: "`os` imported but unused",
          filename: "src/app.py",
          location: { row: 3, column: 1 },
          end_location: { row: 3, column: 13 },
          fix: null,
          url: "https://docs.astral.sh/ruff/rules/unused-import",
        },
      ]);
      const findings = parseLinterJsonOutput(stdout);
      expect(findings).toHaveLength(1);
      expect(findings![0]).toMatchObject({
        title: "`os` imported but unused",
        file: "src/app.py",
        line: 3,
        ruleId: "F401",
        reference: "https://docs.astral.sh/ruff/rules/unused-import",
      });
    });

    it("handles Ruff entries with a null code", () => {
      const stdout = JSON.stringify([
        {
          code: null,
          message: "Trailing whitespace",
          filename: "src/app.py",
          location: { row: 8, column: 20 },
        },
      ]);
      const findings = parseLinterJsonOutput(stdout);
      expect(findings).toHaveLength(1);
      expect(findings![0]!.ruleId).toBe("unknown");
      expect(findings![0]!.line).toBe(8);
    });
  });

  describe("SwiftLint format (flat array, different field names)", () => {
    it("parses swiftlint --reporter json output (issue #85 repro #2)", () => {
      const stdout = JSON.stringify([
        {
          file: "/repo/Sources/App/Thing.swift",
          line: 42,
          character: 10,
          severity: "warning",
          reason: "Type body should span 250 lines or less",
          rule_id: "type_body_length",
        },
        {
          file: "/repo/Sources/App/Other.swift",
          line: 1,
          character: 1,
          severity: "error",
          reason: "Force casts should be avoided",
          rule_id: "force_cast",
        },
      ]);
      const findings = parseLinterJsonOutput(stdout);
      expect(findings).toHaveLength(2);
      expect(findings![0]).toMatchObject({
        title: "Type body should span 250 lines or less",
        severity: "medium",
        file: "/repo/Sources/App/Thing.swift",
        line: 42,
        ruleId: "type_body_length",
      });
      expect(findings![1]).toMatchObject({
        severity: "high",
        ruleId: "force_cast",
      });
    });
  });

  describe("non-finding input", () => {
    it("returns null for an empty array", () => {
      expect(parseLinterJsonOutput("[]")).toBeNull();
    });

    it("returns null for non-array JSON", () => {
      expect(parseLinterJsonOutput(JSON.stringify({ results: [] }))).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      expect(parseLinterJsonOutput("not json at all")).toBeNull();
    });

    it("skips non-object entries in a flat array", () => {
      const stdout = JSON.stringify([
        "garbage line",
        { message: "real issue", filename: "a.py", location: { row: 1 } },
      ]);
      const findings = parseLinterJsonOutput(stdout);
      expect(findings).toHaveLength(1);
      expect(findings![0]!.title).toBe("real issue");
    });
  });
});
