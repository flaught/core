import { describe, it, expect } from "vitest";
import { applyDismissals } from "./apply.js";
import type { Finding } from "../schemas/findings.js";
import type { DismissalStore } from "../schemas/dismissals.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "D-0001",
    severity: "high",
    category: "security",
    title: "SQL injection vulnerability",
    description: "semgrep found: SQL injection vulnerability (sql-injection)",
    evidence: { file: "src/db.ts", line_start: 5, line_end: 5, snippet: "", blast_radius: [], rule_id: "sql-injection" },
    source: "semgrep",
    source_type: "deterministic",
    confidence: 1.0,
    references: [],
    fingerprint: "sha256:target",
    dismissed: false,
    dismissed_by: null,
    dismissed_at: null,
    dismissal_reason: null,
    refute_result: null,
    ...overrides,
  };
}

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
    fingerprint: "sha256:llm-target",
    dismissed: false,
    dismissed_by: null,
    dismissed_at: null,
    dismissal_reason: null,
    refute_result: null,
    ...overrides,
  };
}

describe("applyDismissals", () => {
  it("marks a finding dismissed when its fingerprint has an active entry", () => {
    const store: DismissalStore = {
      version: 1,
      dismissals: [
        {
          fingerprint: "sha256:target",
          dismissed_by: "jane@example.com",
          dismissed_at: "2025-01-15T10:30:00Z",
          reason: "False positive",
          context: null,
          expires_at: null,
        },
      ],
    };

    const { findings, appliedCount } = applyDismissals([makeFinding()], store);
    expect(appliedCount).toBe(1);
    expect(findings[0]!.dismissed).toBe(true);
    expect(findings[0]!.dismissed_by).toBe("jane@example.com");
    expect(findings[0]!.dismissal_reason).toBe("False positive");
  });

  it("leaves findings untouched when no dismissal matches", () => {
    const store: DismissalStore = { version: 1, dismissals: [] };
    const { findings, appliedCount } = applyDismissals([makeFinding()], store);
    expect(appliedCount).toBe(0);
    expect(findings[0]!.dismissed).toBe(false);
  });

  it("does not apply an expired dismissal", () => {
    const store: DismissalStore = {
      version: 1,
      dismissals: [
        {
          fingerprint: "sha256:target",
          dismissed_by: "jane@example.com",
          dismissed_at: "2025-01-15T10:30:00Z",
          reason: "False positive",
          context: null,
          expires_at: "2020-01-01T00:00:00Z",
        },
      ],
    };

    const { findings, appliedCount } = applyDismissals([makeFinding()], store, new Date("2025-06-01T00:00:00Z"));
    expect(appliedCount).toBe(0);
    expect(findings[0]!.dismissed).toBe(false);
  });

  it("only dismisses the matching finding among several", () => {
    const store: DismissalStore = {
      version: 1,
      dismissals: [
        {
          fingerprint: "sha256:target",
          dismissed_by: "jane@example.com",
          dismissed_at: "2025-01-15T10:30:00Z",
          reason: "False positive",
          context: null,
          expires_at: null,
        },
      ],
    };

    const { findings, appliedCount } = applyDismissals(
      [makeFinding({ id: "D-0001", fingerprint: "sha256:target" }), makeFinding({ id: "D-0002", fingerprint: "sha256:other" })],
      store,
    );
    expect(appliedCount).toBe(1);
    expect(findings.find((f) => f.id === "D-0001")!.dismissed).toBe(true);
    expect(findings.find((f) => f.id === "D-0002")!.dismissed).toBe(false);
  });

  // ─── Fuzzy matching for LLM rephrasings ─────────────────────────────────

  describe("fuzzy matching for LLM findings", () => {
    it("fuzzy-matches an LLM finding with a rephrased title but same file and category", () => {
      const store: DismissalStore = {
        version: 1,
        dismissals: [
          {
            fingerprint: "sha256:original",
            dismissed_by: "jane@example.com",
            dismissed_at: "2025-01-15T10:30:00Z",
            reason: "False positive — not exploitable",
            context: { title: "SQL injection in search endpoint", file: "src/search.ts" },
            expires_at: null,
          },
        ],
      };

      // The LLM rephrased the title, generating a different fingerprint
      const rephrased = makeLLMFinding({
        title: "Injection vulnerability in the search handler",
        fingerprint: "sha256:different",
        evidence: { ...makeLLMFinding().evidence, file: "src/search.ts" },
      });

      const { findings, appliedCount } = applyDismissals([rephrased], store);
      expect(appliedCount).toBe(1);
      expect(findings[0]!.dismissed).toBe(true);
      expect(findings[0]!.dismissal_reason).toBe("False positive — not exploitable");
    });

    it("does not fuzzy-match across different files", () => {
      const store: DismissalStore = {
        version: 1,
        dismissals: [
          {
            fingerprint: "sha256:original",
            dismissed_by: "jane@example.com",
            dismissed_at: "2025-01-15T10:30:00Z",
            reason: "False positive",
            context: { title: "SQL injection in search endpoint", file: "src/search.ts" },
            expires_at: null,
          },
        ],
      };

      const differentFile = makeLLMFinding({
        title: "SQL injection endpoint",  // similar title
        fingerprint: "sha256:different",
        evidence: { ...makeLLMFinding().evidence, file: "src/auth.ts" },  // but different file
      });

      const { findings, appliedCount } = applyDismissals([differentFile], store);
      expect(appliedCount).toBe(0);
      expect(findings[0]!.dismissed).toBe(false);
    });

    it("does not fuzzy-match deterministic findings", () => {
      const store: DismissalStore = {
        version: 1,
        dismissals: [
          {
            fingerprint: "sha256:original",
            dismissed_by: "jane@example.com",
            dismissed_at: "2025-01-15T10:30:00Z",
            reason: "False positive",
            context: { title: "SQL injection vulnerability", file: "src/db.ts" },
            expires_at: null,
          },
        ],
      };

      // Deterministic finding with same file and similar title but different fingerprint
      const det = makeFinding({
        source_type: "deterministic",
        fingerprint: "sha256:different",
      });

      const { findings, appliedCount } = applyDismissals([det], store);
      expect(appliedCount).toBe(0);
      expect(findings[0]!.dismissed).toBe(false);
    });

    it("still exact-matches as the first strategy", () => {
      const store: DismissalStore = {
        version: 1,
        dismissals: [
          {
            fingerprint: "sha256:llm-target",
            dismissed_by: "jane@example.com",
            dismissed_at: "2025-01-15T10:30:00Z",
            reason: "False positive",
            context: { title: "SQL injection in search endpoint", file: "src/search.ts" },
            expires_at: null,
          },
        ],
      };

      const exactMatch = makeLLMFinding({ fingerprint: "sha256:llm-target" });
      const { findings, appliedCount } = applyDismissals([exactMatch], store);
      expect(appliedCount).toBe(1);
      expect(findings[0]!.dismissed).toBe(true);
    });

    it("fuzzy-matches based on title word overlap >= 50%", () => {
      const store: DismissalStore = {
        version: 1,
        dismissals: [
          {
            fingerprint: "sha256:original",
            dismissed_by: "jane@example.com",
            dismissed_at: "2025-01-15T10:30:00Z",
            reason: "Acceptable risk",
            context: { title: "Circular dependency auth user modules", file: "src/auth/index.ts" },
            expires_at: null,
          },
        ],
      };

      // Different wording but overlapping key words: "auth", "modules", "dependency"
      const rephrased = makeLLMFinding({
        title: "Auth module has circular dependency",
        fingerprint: "sha256:rephrased",
        category: "architecture",
        evidence: { file: "src/auth/index.ts", line_start: 12, line_end: 12, snippet: "import { getUserById } from '../user'", blast_radius: [], rule_id: null },
      });

      const { findings, appliedCount } = applyDismissals([rephrased], store);
      expect(appliedCount).toBe(1);
      expect(findings[0]!.dismissed).toBe(true);
    });
  });
});