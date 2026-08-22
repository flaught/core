import { describe, it, expect } from "vitest";
import {
  detectScopeCreepHeuristic,
  filterExcludedScopeCreep,
  formatScopeCreepExclusionsForPrompt,
} from "./detector.js";
import { FlaughtConfigSchema } from "../schemas/config.js";
import type { Finding } from "../schemas/findings.js";
import type { ReviewContext } from "../context/assembler.js";

function mockDependencyGraph() {
  return {
    getDependentsOf: () => [],
    getDependenciesOf: () => [],
    getImportsFor: () => [],
    getAllFiles: () => [],
  };
}

function mockContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    diff: "",
    changedFiles: [],
    neighborhoodFiles: [],
    changedFileContents: new Map(),
    neighborhoodFileContents: new Map(),
    dependencyGraph: mockDependencyGraph(),
    baseSha: "abc123",
    headSha: "def456",
    repoRoot: "/tmp/test-repo",
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    severity: "critical",
    category: "scope-creep",
    title: "Large ADR and documentation changes unrelated to CI gating",
    description: "test",
    evidence: { file: "docs/adr/0018-example.md", line_start: 1, line_end: 3, snippet: "", blast_radius: [], rule_id: null },
    source: "llm:test",
    source_type: "llm",
    confidence: 0.9,
    references: [],
    fingerprint: "sha256:test",
    dismissed: false,
    dismissed_by: null,
    dismissed_at: null,
    dismissal_reason: null,
    refute_result: null,
    ...overrides,
  };
}

describe("filterExcludedScopeCreep", () => {
  it("drops a scope-creep finding on an excluded path", () => {
    const findings = [makeFinding()];
    const result = filterExcludedScopeCreep(findings, ["docs/adr/**"]);
    expect(result).toHaveLength(0);
  });

  it("keeps a scope-creep finding on a non-excluded path", () => {
    const findings = [makeFinding({ evidence: { ...makeFinding().evidence, file: "src/app.ts" } })];
    const result = filterExcludedScopeCreep(findings, ["docs/adr/**"]);
    expect(result).toHaveLength(1);
  });

  it("keeps non-scope-creep findings on an excluded path", () => {
    const findings = [makeFinding({ category: "security" })];
    const result = filterExcludedScopeCreep(findings, ["docs/adr/**"]);
    expect(result).toHaveLength(1);
  });

  it("is a no-op when excludePaths is empty", () => {
    const findings = [makeFinding()];
    expect(filterExcludedScopeCreep(findings, [])).toBe(findings);
  });
});

describe("formatScopeCreepExclusionsForPrompt", () => {
  it("returns an empty string when there are no exclude paths", () => {
    expect(formatScopeCreepExclusionsForPrompt([])).toBe("");
  });

  it("lists the exempt patterns", () => {
    const formatted = formatScopeCreepExclusionsForPrompt(["docs/adr/**", "docs/**"]);
    expect(formatted).toContain("Scope-Creep Exemptions");
    expect(formatted).toContain("docs/adr/**");
    expect(formatted).toContain("docs/**");
    expect(formatted).toContain("do not flag");
  });
});

describe("detectScopeCreepHeuristic — exclude_paths", () => {
  it("never flags a file matching scope_creep.exclude_paths, even if it looks unrelated", () => {
    const config = FlaughtConfigSchema.parse({
      scope_creep: { exclude_paths: ["docs/adr/**"] },
    });
    const context = mockContext({
      changedFiles: [
        { path: "docs/adr/0018-example.md", additions: 200, deletions: 0, status: "added" as const },
      ],
    });

    const flagged = detectScopeCreepHeuristic(context, "Wire up CI blocking", config);
    expect(flagged.find((h) => h.file === "docs/adr/0018-example.md")).toBeUndefined();
  });

  it("still flags an unrelated file not covered by exclude_paths", () => {
    const config = FlaughtConfigSchema.parse({
      scope_creep: { exclude_paths: ["docs/adr/**"] },
    });
    const context = mockContext({
      changedFiles: [
        { path: ".eslintrc.json", additions: 1, deletions: 0, status: "modified" as const },
      ],
    });

    const flagged = detectScopeCreepHeuristic(context, "Wire up CI blocking for the ci workflow", config);
    expect(flagged.find((h) => h.file === ".eslintrc.json")).toBeTruthy();
  });
});
