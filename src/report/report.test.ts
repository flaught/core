import { describe, it, expect } from "vitest";
import { renderMarkdownReport } from "./markdown.js";
import { renderJsonArtifact } from "./json.js";
import type { FindingsArtifact, Finding, NoiseBudget, Severity } from "../schemas/findings.js";
import { SCHEMA_VERSION, FINDINGS_SCHEMA_URL, CAVEAT } from "../schemas/findings.js";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    severity: "high",
    category: "security",
    title: "SQL injection in search endpoint",
    description: "The search endpoint constructs a SQL query using string concatenation.",
    evidence: {
      file: "src/routes/search.ts",
      line_start: 47,
      line_end: 47,
      snippet: 'db.query(`SELECT * FROM users WHERE name LIKE "%${q}%"`)',
      blast_radius: ["src/db/client.ts:12"],
      rule_id: null,
    },
    source: "llm:gpt-4o",
    source_type: "llm",
    confidence: 0.9,
    references: ["https://owasp.org/sql-injection"],
    fingerprint: "sha256:test-fixture-fingerprint",
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
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const bySourceType = { deterministic: 0, llm: 0 };
  const byCategory: Record<string, number> = {};

  for (const f of findings) {
    bySeverity[f.severity]++;
    bySourceType[f.source_type]++;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }

  const noiseBudget: NoiseBudget = {
    critical: { limit: 5, used: bySeverity.critical },
    high: { limit: 10, used: bySeverity.high },
    medium: { limit: 15, used: bySeverity.medium },
    low: { limit: 20, used: bySeverity.low },
    info: { limit: 25, used: bySeverity.info },
  };

  return {
    $schema: FINDINGS_SCHEMA_URL,
    schema_version: SCHEMA_VERSION,
    _caveat: CAVEAT,
    generated_at: "2025-01-15T10:30:00Z",
    flaught_version: "0.4.1",
    repository: { name: "flaught/core", url: "https://github.com/flaught/core", branch: "main" },
    pull_request: { number: 42, url: "https://github.com/flaught/core/pull/42", title: "Add auth", description: "Adds JWT auth", base_sha: "abc123", head_sha: "def456" },
    run: { id: "flaught-1234567890-abc123", ci_url: null, duration_seconds: 47, llm_error: null },
    tools_executed: [],
    findings,
    test_inversion: null,
    scope_creep: null,
    noise_budget: noiseBudget,
    summary: {
      total_findings: findings.length,
      by_severity: bySeverity,
      by_source_type: bySourceType as FindingsArtifact["summary"]["by_source_type"],
      by_category: byCategory as FindingsArtifact["summary"]["by_category"],
      dismissed_count: findings.filter((f) => f.dismissed).length,
    },
    ...overrides,
  };
}

describe("renderMarkdownReport", () => {
  it("renders a header", () => {
    const artifact = makeArtifact();
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("Flaught — Adversarial Code Review");
  });

  it("includes the caveat", () => {
    const artifact = makeArtifact();
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("evidence that adversarial scrutiny occurred");
    expect(md).toContain("NOT evidence that findings are correct");
  });

  it("renders findings with severity emojis", () => {
    const artifact = makeArtifact({ findings: [makeFinding({ severity: "high" })] });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("🟠"); // high severity emoji
    expect(md).toContain("HIGH");
  });

  it("renders critical severity findings", () => {
    const artifact = makeArtifact({ findings: [makeFinding({ severity: "critical" })] });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("🔴");
    expect(md).toContain("CRITICAL");
  });

  it("renders the summary table", () => {
    const artifact = makeArtifact();
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("Severity");
    expect(md).toContain("Count");
    expect(md).toContain("Budget");
  });

  it("shows source type badges", () => {
    const artifact = makeArtifact({ findings: [makeFinding({ source_type: "llm" })] });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("🤖"); // LLM badge
  });

  it("shows deterministic source type badge", () => {
    const artifact = makeArtifact({
      findings: [makeFinding({ source: "semgrep", source_type: "deterministic" })],
    });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("🔧"); // deterministic badge
  });

  it("collapses low and info severity sections", () => {
    const artifact = makeArtifact({
      findings: [
        makeFinding({ id: "F-001", severity: "low", title: "Low finding" }),
        makeFinding({ id: "F-002", severity: "info", title: "Info finding" }),
      ],
    });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("<details>");
    expect(md).toContain("Click to expand");
  });

  it("shows dismissed findings", () => {
    const artifact = makeArtifact({
      findings: [
        makeFinding({
          dismissed: true,
          dismissed_by: "alice",
          dismissed_at: "2025-01-16T09:00:00Z",
          dismissal_reason: "False positive — this is intentional",
        }),
      ],
    });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("DISMISSED");
    expect(md).toContain("alice");
    expect(md).toContain("False positive");
  });

  it("shows blast radius", () => {
    const artifact = makeArtifact({
      findings: [makeFinding({
        evidence: {
          file: "src/routes/search.ts",
          line_start: 47,
          line_end: 47,
          snippet: "db.query(x)",
          blast_radius: ["src/db/client.ts:12", "src/middleware/auth.ts:8"],
          rule_id: null,
        },
      })],
    });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("Blast radius");
    expect(md).toContain("src/db/client.ts:12");
    expect(md).toContain("src/middleware/auth.ts:8");
  });

  it("shows no-findings message when empty", () => {
    const artifact = makeArtifact({ findings: [] });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("No findings");
  });

  it("includes footer with version", () => {
    const artifact = makeArtifact();
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("Flaught v0.4.1");
    expect(md).toContain("Schema v2");
  });

  it("warns when the LLM review failed", () => {
    const artifact = makeArtifact({
      run: { id: "flaught-1", ci_url: null, duration_seconds: 5, llm_error: "Groq API error: 400 Bad Request" },
    });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("LLM adversarial review failed");
    expect(md).toContain("Groq API error: 400 Bad Request");
    expect(md).toContain("not evidence the PR is clean");
  });

  it("does not warn about the LLM when llm_error is null", () => {
    const artifact = makeArtifact({
      run: { id: "flaught-1", ci_url: null, duration_seconds: 5, llm_error: null },
    });
    const md = renderMarkdownReport(artifact);
    expect(md).not.toContain("LLM adversarial review failed");
  });

  it("doesn't throw when run is missing llm_error (public-API callers may pass an unvalidated artifact)", () => {
    const artifact = makeArtifact();
    delete (artifact.run as { llm_error?: unknown }).llm_error;
    expect(() => renderMarkdownReport(artifact)).not.toThrow();
    expect(renderMarkdownReport(artifact)).not.toContain("LLM adversarial review failed");
  });

  it("warns when a deterministic tool failed to run", () => {
    const artifact = makeArtifact({
      tools_executed: [
        { tool: "semgrep", version: "unknown", exit_code: 1, raw_findings_count: 0, command: "(failed)" },
      ],
    });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("did not run");
    expect(md).toContain("`semgrep`");
    expect(md).toContain("not because the scan came back clean");
  });

  it("does not warn when every tool ran (even with 0 findings)", () => {
    const artifact = makeArtifact({
      tools_executed: [
        { tool: "semgrep", version: "1.50.0", exit_code: 0, raw_findings_count: 0, command: "semgrep --config auto --json ." },
      ],
    });
    const md = renderMarkdownReport(artifact);
    expect(md).not.toContain("did not run");
  });

  it("omits the tools warning entirely when tools_executed is empty", () => {
    const artifact = makeArtifact({ tools_executed: [] });
    const md = renderMarkdownReport(artifact);
    expect(md).not.toContain("did not run");
  });

  it("doesn't throw when tools_executed is missing (public-API callers may pass an unvalidated artifact)", () => {
    const artifact = makeArtifact();
    // renderMarkdownReport is exported as public API; a caller isn't
    // guaranteed to hand it an artifact that satisfies the full type at
    // runtime (e.g. an older findings.json, or a hand-built object).
    delete (artifact as { tools_executed?: unknown }).tools_executed;
    expect(() => renderMarkdownReport(artifact)).not.toThrow();
    expect(renderMarkdownReport(artifact)).not.toContain("did not run");
  });

  it("doesn't throw when tools_executed is a malformed non-array value", () => {
    // Public-API callers might hand-build an artifact where tools_executed
    // is a string, object, number, etc. instead of an array.
    const cases: unknown[] = ["oops", 42, { wrong: true }, null];
    for (const bad of cases) {
      const artifact = makeArtifact();
      (artifact as { tools_executed?: unknown }).tools_executed = bad;
      expect(() => renderMarkdownReport(artifact)).not.toThrow();
      expect(renderMarkdownReport(artifact)).not.toContain("did not run");
    }
  });

  it("warns once per failed tool when multiple tools fail to run", () => {
    const artifact = makeArtifact({
      tools_executed: [
        { tool: "semgrep", version: "unknown", exit_code: 1, raw_findings_count: 0, command: "(failed)" },
        { tool: "linter", version: "unknown", exit_code: -1, raw_findings_count: 0, command: "(failed)" },
      ],
    });
    const md = renderMarkdownReport(artifact);
    expect(md).toContain("2 deterministic tool(s) did not run");
    expect(md).toContain("`semgrep`");
    expect(md).toContain("`linter`");
  });
});

describe("renderJsonArtifact", () => {
  it("produces valid JSON", () => {
    const artifact = makeArtifact();
    const json = renderJsonArtifact(artifact);
    const parsed = JSON.parse(json);
    expect(parsed).toBeTruthy();
    expect(parsed.schema_version).toBe(2);
  });

  it("includes the caveat", () => {
    const artifact = makeArtifact();
    const json = renderJsonArtifact(artifact);
    const parsed = JSON.parse(json);
    expect(parsed._caveat).toContain("evidence that adversarial scrutiny occurred");
  });

  it("includes all findings", () => {
    const artifact = makeArtifact({
      findings: [
        makeFinding({ id: "F-001", severity: "high" }),
        makeFinding({ id: "F-002", severity: "medium", category: "architecture" }),
      ],
    });
    const json = renderJsonArtifact(artifact);
    const parsed = JSON.parse(json);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].id).toBe("F-001");
    expect(parsed.findings[1].id).toBe("F-002");
  });

  it("includes noise budget with used counts", () => {
    const artifact = makeArtifact({ findings: [makeFinding({ severity: "high" })] });
    const json = renderJsonArtifact(artifact);
    const parsed = JSON.parse(json);
    expect(parsed.noise_budget.high.used).toBe(1);
    expect(parsed.noise_budget.high.limit).toBe(10);
  });
});