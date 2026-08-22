import { describe, it, expect } from "vitest";
import { computeFingerprint, normalizeTitle, computeSimilarityKey, isSimilarFinding } from "./fingerprint.js";
import type { Finding } from "../schemas/findings.js";

describe("computeFingerprint", () => {
  it("is stable across identical deterministic findings", () => {
    const a = computeFingerprint({
      source_type: "deterministic",
      source: "semgrep",
      category: "security",
      title: "SQL injection vulnerability",
      evidence: { file: "src/db/queries.ts", rule_id: "sql-injection" },
    });
    const b = computeFingerprint({
      source_type: "deterministic",
      source: "semgrep",
      category: "security",
      title: "SQL injection vulnerability",
      evidence: { file: "src/db/queries.ts", rule_id: "sql-injection" },
    });
    expect(a).toBe(b);
  });

  it("is unaffected by line-number-carrying fields not present in the input", () => {
    const a = computeFingerprint({
      source_type: "deterministic",
      source: "eslint",
      category: "maintainability",
      title: "no-unused-vars",
      evidence: { file: "src/app.ts", rule_id: "no-unused-vars" },
    });
    const b = computeFingerprint({
      source_type: "deterministic",
      source: "eslint",
      category: "maintainability",
      title: "no-unused-vars",
      evidence: { file: "src/app.ts", rule_id: "no-unused-vars" },
    });
    expect(a).toBe(b);
  });

  it("differs when the rule id differs", () => {
    const a = computeFingerprint({
      source_type: "deterministic",
      source: "semgrep",
      category: "security",
      title: "SQL injection vulnerability",
      evidence: { file: "src/db/queries.ts", rule_id: "sql-injection" },
    });
    const b = computeFingerprint({
      source_type: "deterministic",
      source: "semgrep",
      category: "security",
      title: "SQL injection vulnerability",
      evidence: { file: "src/db/queries.ts", rule_id: "command-injection" },
    });
    expect(a).not.toBe(b);
  });

  it("differs when the file differs", () => {
    const a = computeFingerprint({
      source_type: "deterministic",
      source: "semgrep",
      category: "security",
      title: "SQL injection vulnerability",
      evidence: { file: "src/db/queries.ts", rule_id: "sql-injection" },
    });
    const b = computeFingerprint({
      source_type: "deterministic",
      source: "semgrep",
      category: "security",
      title: "SQL injection vulnerability",
      evidence: { file: "src/db/other.ts", rule_id: "sql-injection" },
    });
    expect(a).not.toBe(b);
  });

  it("LLM findings fingerprint on normalized title + file + category", () => {
    const a = computeFingerprint({
      source_type: "llm",
      source: "llm:gpt-4o",
      category: "architecture",
      title: "Circular dependency between auth and user modules",
      evidence: { file: "src/auth/index.ts", rule_id: null },
    });
    const b = computeFingerprint({
      source_type: "llm",
      source: "llm:gpt-4o",
      category: "architecture",
      title: "  circular   dependency between auth and user modules  ",
      evidence: { file: "src/auth/index.ts", rule_id: null },
    });
    expect(a).toBe(b);
  });

  it("LLM findings with reordered words still match after normalization", () => {
    const a = computeFingerprint({
      source_type: "llm",
      source: "llm:gpt-4o",
      category: "security",
      title: "SQL injection in search endpoint",
      evidence: { file: "src/search.ts", rule_id: null },
    });
    const b = computeFingerprint({
      source_type: "llm",
      source: "llm:gpt-4o",
      category: "security",
      title: "injection SQL endpoint search",
      evidence: { file: "src/search.ts", rule_id: null },
    });
    // After normalization, both become sorted words: "endpoint injection search sql"
    expect(a).toBe(b);
  });

  it("strips common LLM phrasing prefixes", () => {
    const a = computeFingerprint({
      source_type: "llm",
      source: "llm:gpt-4o",
      category: "security",
      title: "SQL injection in search endpoint",
      evidence: { file: "src/search.ts", rule_id: null },
    });
    const b = computeFingerprint({
      source_type: "llm",
      source: "llm:gpt-4o",
      category: "security",
      title: "Potential SQL injection in search endpoint",
      evidence: { file: "src/search.ts", rule_id: null },
    });
    // "Potential" is stripped as an LLM prefix; the rest normalizes to the same
    expect(a).toBe(b);
  });

  it("returns a sha256-prefixed identifier", () => {
    const fp = computeFingerprint({
      source_type: "deterministic",
      source: "semgrep",
      category: "security",
      title: "x",
      evidence: { file: "a.ts", rule_id: "r" },
    });
    expect(fp).toMatch(/^sha256:[0-9a-f]{16}$/);
  });
});

describe("normalizeTitle", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeTitle("  Hello   World  ")).toBe("hello world");
  });

  it("removes stop words", () => {
    const result = normalizeTitle("A circular dependency between the auth and user modules");
    // After removing stop words and sorting: auth circular dependency modules user
    expect(result).not.toContain("a ");
    expect(result).not.toContain("the ");
    expect(result).not.toContain("between ");
  });

  it("strips LLM phrasing prefixes", () => {
    const result = normalizeTitle("Potential SQL injection in search endpoint");
    expect(result).not.toContain("potential");
  });

  it("sorts remaining words alphabetically", () => {
    const result = normalizeTitle("SQL injection endpoint");
    // sorted: endpoint injection sql
    expect(result).toBe("endpoint injection sql");
  });

  it("handles empty titles", () => {
    expect(normalizeTitle("")).toBe("");
    expect(normalizeTitle("  ")).toBe("");
  });
});

describe("computeSimilarityKey", () => {
  it("returns the exact fingerprint for deterministic findings", () => {
    const finding: Finding = {
      id: "D-0001",
      severity: "high",
      category: "security",
      title: "SQL injection",
      description: "desc",
      evidence: { file: "a.ts", line_start: 1, line_end: 1, snippet: "code", blast_radius: [], rule_id: "sql-injection" },
      source: "semgrep",
      source_type: "deterministic",
      confidence: 1,
      references: [],
      fingerprint: "sha256:abc123",
      dismissed: false,
      dismissed_by: null,
      dismissed_at: null,
      dismissal_reason: null,
      refute_result: null,
    };
    expect(computeSimilarityKey(finding)).toBe("sha256:abc123");
  });

  it("returns a sim:-prefixed key for LLM findings", () => {
    const finding: Finding = {
      id: "F-0001",
      severity: "high",
      category: "security",
      title: "SQL injection",
      description: "desc",
      evidence: { file: "src/search.ts", line_start: 1, line_end: 1, snippet: "db.query(x)", blast_radius: [], rule_id: null },
      source: "llm:gpt-4o",
      source_type: "llm",
      confidence: 0.9,
      references: [],
      fingerprint: "sha256:abc123",
      dismissed: false,
      dismissed_by: null,
      dismissed_at: null,
      dismissal_reason: null,
      refute_result: null,
    };
    const key = computeSimilarityKey(finding);
    expect(key).toMatch(/^sim:[0-9a-f]{16}$/);
  });

  it("produces the same key for findings with the same category/file/snippet", () => {
    const base: Finding = {
      id: "F-0001",
      severity: "high",
      category: "security",
      title: "SQL injection",
      description: "desc",
      evidence: { file: "src/search.ts", line_start: 1, line_end: 1, snippet: "db.query(x)", blast_radius: [], rule_id: null },
      source: "llm:gpt-4o",
      source_type: "llm",
      confidence: 0.9,
      references: [],
      fingerprint: "sha256:abc123",
      dismissed: false,
      dismissed_by: null,
      dismissed_at: null,
      dismissal_reason: null,
      refute_result: null,
    };
    const rephrased: Finding = {
      ...base,
      id: "F-0002",
      title: "Injection vulnerability in database query",
      fingerprint: "sha256:def456",
    };
    expect(computeSimilarityKey(base)).toBe(computeSimilarityKey(rephrased));
  });
});

describe("isSimilarFinding", () => {
  function makeLLMFinding(overrides: Partial<Finding> = {}): Finding {
    return {
      id: "F-0001",
      severity: "high",
      category: "security",
      title: "SQL injection in search endpoint",
      description: "The search endpoint constructs a SQL query using string concatenation.",
      evidence: { file: "src/search.ts", line_start: 47, line_end: 47, snippet: 'db.query(`SELECT * FROM users WHERE name LIKE "%${q}%"`)', blast_radius: [], rule_id: null },
      source: "llm:gpt-oss-20b",
      source_type: "llm",
      confidence: 0.9,
      references: [],
      fingerprint: "sha256:abc123",
      dismissed: false,
      dismissed_by: null,
      dismissed_at: null,
      dismissal_reason: null,
      refute_result: null,
      ...overrides,
    };
  }

  it("findings with the same fingerprint are similar", () => {
    const a = makeLLMFinding();
    const b = makeLLMFinding();
    expect(isSimilarFinding(a, b)).toBe(true);
  });

  it("findings with different fingerprints but same category/file/snippet are similar", () => {
    const a = makeLLMFinding({ fingerprint: "sha256:abc123" });
    const b = makeLLMFinding({
      fingerprint: "sha256:def456",
      title: "Injection vulnerability in database query", // rephrased title
    });
    expect(isSimilarFinding(a, b)).toBe(true);
  });

  it("findings in different files are not similar", () => {
    const a = makeLLMFinding({ evidence: { ...makeLLMFinding().evidence, file: "src/search.ts" } });
    const b = makeLLMFinding({
      fingerprint: "sha256:def456",
      evidence: { ...makeLLMFinding().evidence, file: "src/auth.ts" },
    });
    expect(isSimilarFinding(a, b)).toBe(false);
  });

  it("deterministic findings only match by exact fingerprint", () => {
    const det: Finding = {
      id: "D-0001",
      severity: "high",
      category: "security",
      title: "SQL injection",
      description: "desc",
      evidence: { file: "src/search.ts", line_start: 1, line_end: 1, snippet: "code", blast_radius: [], rule_id: "sql-injection" },
      source: "semgrep",
      source_type: "deterministic",
      confidence: 1,
      references: [],
      fingerprint: "sha256:abc123",
      dismissed: false,
      dismissed_by: null,
      dismissed_at: null,
      dismissal_reason: null,
      refute_result: null,
    };
    const llm = makeLLMFinding({ fingerprint: "sha256:xyz789" });
    // Different source types, different fingerprints — not similar
    expect(isSimilarFinding(det, llm)).toBe(false);
  });

  it("findings with overlapping snippets but different titles are similar", () => {
    const a = makeLLMFinding({
      title: "SQL injection in search",
      evidence: { file: "src/search.ts", line_start: 47, line_end: 47, snippet: 'db.query(`SELECT * FROM users WHERE name LIKE "%${q}%"`)', blast_radius: [], rule_id: null },
    });
    const b = makeLLMFinding({
      fingerprint: "sha256:different",
      title: "Database query vulnerability in search handler",
      evidence: { file: "src/search.ts", line_start: 47, line_end: 47, snippet: 'db.query(`SELECT * FROM users WHERE name LIKE "%${q}%"`)', blast_radius: [], rule_id: null },
    });
    // Same file, same snippet — should be similar even with different titles
    expect(isSimilarFinding(a, b)).toBe(true);
  });
});