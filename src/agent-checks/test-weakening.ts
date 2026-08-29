import type { DeterministicFinding } from "../tools/runner.js";

const ASSERTION = /\b(?:expect|assert|require|should)\s*\(/;
const SKIP_MARKER = /(?:\.skip\b|\bx(?:it|describe)\b|@Disabled\b|pytest\.mark\.skip\b|\b(?:test|it)\.skip\b)/;

function finding(title: string, line: number, snippet: string, ruleId: string): DeterministicFinding {
  return {
    title,
    severity: "high",
    category: "testing",
    file: "diff",
    line,
    snippet: snippet.trim(),
    source: "test_weakening",
    ruleId,
  };
}

/** Detect common test-weakening edits introduced by the current diff. */
export function detectTestWeakening(diff: string, deletedFiles: string[] = []): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const removed = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
  const added = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));

  const removedAssertions = removed.filter((line) => ASSERTION.test(line));
  if (removedAssertions.length > 0 && removedAssertions.length > added.filter((line) => ASSERTION.test(line)).length) {
    findings.push(finding("Test assertions were removed", 1, removedAssertions[0]!, "deleted-assertion"));
  }

  for (const line of added) {
    if (SKIP_MARKER.test(line)) {
      findings.push(finding("A test skip marker was added", 1, line, "added-skip-marker"));
    }
  }

  const matcherPairs: Array<[RegExp, RegExp, string]> = [
    [/\.toBe\(/, /\.toBeTruthy\(/, "exact-to-truthy"],
    [/\.toEqual\(/, /\.toMatchObject\(/, "exact-to-partial"],
    [/\.toBeCloseTo\(/, /\.toBeGreaterThan\(/, "close-to-range"],
  ];
  for (const [strict, loose, ruleId] of matcherPairs) {
    if (removed.some((line) => strict.test(line)) && added.some((line) => loose.test(line))) {
      findings.push(finding("A test matcher was loosened", 1, added.find((line) => loose.test(line))!, ruleId));
    }
  }

  for (const file of deletedFiles) {
    if (/(?:\.test\.|\.spec\.|(?:^|\/)test_[^/]+\.)/.test(file)) {
      findings.push(finding("A test file was removed", 1, file, "deleted-test-file"));
    }
  }

  if (removed.some((line) => /-\s*(?:it|test)\s*\(/.test(line)) && added.some((line) => /^\+\s*\/\//.test(line))) {
    findings.push(finding("A test body was replaced with comments", 1, added.find((line) => /^\+\s*\/\//.test(line))!, "commented-test-body"));
  }

  return findings;
}
