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
});
