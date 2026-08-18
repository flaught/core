import { describe, it, expect } from "vitest";
import { computeFingerprint } from "./fingerprint.js";

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
    // Same rule/file at two different "runs" — evidence intentionally omits
    // line numbers because they aren't part of the fingerprint basis at all.
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

  it("LLM findings fingerprint on normalized title + file + category, ignoring whitespace/case", () => {
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

  it("LLM findings with materially different wording do not match (known limitation)", () => {
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
      title: "auth and user modules import each other, forming a cycle",
      evidence: { file: "src/auth/index.ts", rule_id: null },
    });
    expect(a).not.toBe(b);
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
