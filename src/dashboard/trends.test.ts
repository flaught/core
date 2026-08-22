import { describe, it, expect } from "vitest";
import { computeTrends, isFindingsArtifact } from "./trends.js";
import type { FindingsArtifact, Finding } from "../schemas/findings.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    severity: "high",
    category: "security",
    title: "Test finding",
    description: "Test description",
    evidence: { file: "", line_start: 0, line_end: 0, snippet: "", blast_radius: [], rule_id: null },
    source: "llm:test",
    source_type: "llm",
    confidence: 0.9,
    references: [],
    fingerprint: "sha256:fixture",
    dismissed: false,
    dismissed_by: null,
    dismissed_at: null,
    dismissal_reason: null,
    refute_result: null,
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<FindingsArtifact> = {}): FindingsArtifact {
  const findings = overrides.findings ?? [makeFinding()];
  return {
    $schema: "https://flaught.dev/schemas/findings/v2.schema.json",
    schema_version: 2,
    _caveat: "caveat",
    generated_at: "2026-01-01T00:00:00Z",
    flaught_version: "0.8.0",
    repository: { name: "flaught/core", url: "https://github.com/flaught/core", branch: "main" },
    pull_request: { number: 1, url: null, title: "Test PR", description: null, base_sha: "a", head_sha: "b" },
    run: { id: "run-1", ci_url: null, duration_seconds: 5, llm_error: null },
    tools_executed: [],
    findings,
    test_inversion: null,
    scope_creep: null,
    noise_budget: {
      critical: { limit: 5, used: 0 },
      high: { limit: 10, used: 0 },
      medium: { limit: 15, used: 0 },
      low: { limit: 20, used: 0 },
      info: { limit: 25, used: 0 },
    },
    summary: {
      total_findings: findings.length,
      by_severity: { critical: 0, high: findings.length, medium: 0, low: 0, info: 0 },
      by_source_type: { llm: findings.length, deterministic: 0 },
      by_category: {} as FindingsArtifact["summary"]["by_category"],
      dismissed_count: 0,
    },
    ...overrides,
  };
}

describe("isFindingsArtifact", () => {
  it("accepts a well-formed artifact", () => {
    expect(isFindingsArtifact(makeArtifact())).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(isFindingsArtifact(null)).toBe(false);
    expect(isFindingsArtifact([1, 2, 3])).toBe(false);
    expect(isFindingsArtifact("not an artifact")).toBe(false);
    expect(isFindingsArtifact(42)).toBe(false);
  });

  it("rejects objects missing required fields", () => {
    expect(isFindingsArtifact({})).toBe(false);
    expect(isFindingsArtifact({ generated_at: "2026-01-01" })).toBe(false);
    expect(isFindingsArtifact({ generated_at: "2026-01-01", run: {}, summary: {} })).toBe(false);
  });
});

describe("computeTrends", () => {
  it("drops values that aren't findings artifacts instead of throwing", () => {
    const points = computeTrends([null, "garbage", 42, { foo: "bar" }]);
    expect(points).toEqual([]);
  });

  it("sorts points chronologically by generated_at regardless of input order", () => {
    const early = makeArtifact({ generated_at: "2026-01-01T00:00:00Z", run: { id: "early", ci_url: null, duration_seconds: 1, llm_error: null } });
    const late = makeArtifact({ generated_at: "2026-02-01T00:00:00Z", run: { id: "late", ci_url: null, duration_seconds: 1, llm_error: null } });

    const points = computeTrends([late, early]);
    expect(points.map((p) => p.run_id)).toEqual(["early", "late"]);
  });

  it("extracts severity, source-type, refute, and dismissal counts", () => {
    const artifact = makeArtifact({
      findings: [
        makeFinding({ severity: "critical", source_type: "llm", refute_result: { verdict: "confirmed", reasoning: "yep", adjusted_confidence: 0.9 } }),
        makeFinding({ severity: "critical", source_type: "llm", refute_result: { verdict: "refuted", reasoning: "nope", adjusted_confidence: 0.1 } }),
        makeFinding({ severity: "medium", source_type: "deterministic", dismissed: true }),
      ],
      summary: {
        total_findings: 3,
        by_severity: { critical: 2, high: 0, medium: 1, low: 0, info: 0 },
        by_source_type: { llm: 2, deterministic: 1 },
        by_category: {} as FindingsArtifact["summary"]["by_category"],
        dismissed_count: 1,
      },
    });

    const [point] = computeTrends([artifact]);
    expect(point!.total_findings).toBe(3);
    expect(point!.by_severity.critical).toBe(2);
    expect(point!.by_severity.medium).toBe(1);
    expect(point!.by_source_type).toEqual({ llm: 2, deterministic: 1 });
    expect(point!.refute).toEqual({ confirmed: 1, refuted: 1, uncertain: 0 });
    expect(point!.dismissed_count).toBe(1);
  });

  it("flags llm_error as a boolean", () => {
    const failed = makeArtifact({ run: { id: "r", ci_url: null, duration_seconds: 1, llm_error: "Groq API error" } });
    const ok = makeArtifact({ run: { id: "r2", ci_url: null, duration_seconds: 1, llm_error: null } });

    const points = computeTrends([failed, ok]);
    expect(points.find((p) => p.run_id === "r")!.llm_error).toBe(true);
    expect(points.find((p) => p.run_id === "r2")!.llm_error).toBe(false);
  });
});
