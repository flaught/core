import { describe, it, expect } from "vitest";
import { gateTripped } from "./review.js";
import type { Finding } from "./schemas/findings.js";

// computeExitCode historically excluded only `dismissed` findings, so a finding
// the skeptic REFUTED (determined fabricated / false) still blocked merge —
// making the refute pass cosmetic for gating. gateTripped now also excludes
// `refute_result.verdict === "refuted"`; 'confirmed' and 'uncertain' still
// gate. Surfaced by PR #77's own review: a refuted hallucination ("missing
// import of path" — the import exists at the top of src/cli.ts) tripped
// fail_on: high and blocked the PR.

describe("gateTripped (severity gate excludes refuted findings)", () => {
  const finding = (overrides: Partial<Finding>): Finding => ({
    id: "F-0001",
    severity: "high",
    category: "security",
    title: "t",
    description: "d",
    evidence: { file: "", line_start: 0, line_end: 0, snippet: "", blast_radius: [], rule_id: null },
    source: "llm",
    source_type: "llm",
    confidence: 0.9,
    references: [],
    fingerprint: "fp",
    dismissed: false,
    dismissed_by: null,
    dismissed_at: null,
    dismissal_reason: null,
    refute_result: null,
    ...overrides,
  });

  it("a HIGH finding the skeptic CONFIRMED trips the gate (fail_on: high)", () => {
    const f = finding({ refute_result: { verdict: "confirmed", reasoning: "real", adjusted_confidence: 0.9 } });
    expect(gateTripped([f], "high")).toBe(true);
  });

  it("a HIGH finding the skeptic REFUTED does NOT trip the gate (the bug fix)", () => {
    const f = finding({ refute_result: { verdict: "refuted", reasoning: "hallucination", adjusted_confidence: 0 } });
    expect(gateTripped([f], "high")).toBe(false);
  });

  it("a HIGH finding the skeptic left UNCERTAIN still trips the gate (conservative)", () => {
    const f = finding({ refute_result: { verdict: "uncertain", reasoning: "could not determine", adjusted_confidence: 0.5 } });
    expect(gateTripped([f], "high")).toBe(true);
  });

  it("a HIGH finding with no skeptic pass (refute_result null) still trips the gate", () => {
    const f = finding({ refute_result: null });
    expect(gateTripped([f], "high")).toBe(true);
  });

  it("a dismissed HIGH finding does not trip the gate (unchanged behavior)", () => {
    const f = finding({ dismissed: true, refute_result: null });
    expect(gateTripped([f], "high")).toBe(false);
  });

  it("a refuted HIGH finding does not mask a separate confirmed HIGH finding", () => {
    const refuted = finding({ id: "F-1", refute_result: { verdict: "refuted", reasoning: "", adjusted_confidence: 0 } });
    const confirmed = finding({ id: "F-2", refute_result: { verdict: "confirmed", reasoning: "", adjusted_confidence: 0.9 } });
    expect(gateTripped([refuted, confirmed], "high")).toBe(true);
  });

  it("fail_on: none never trips, even with a confirmed HIGH finding", () => {
    const f = finding({ severity: "high", refute_result: { verdict: "confirmed", reasoning: "", adjusted_confidence: 0.9 } });
    expect(gateTripped([f], "none")).toBe(false);
  });

  it("a MEDIUM refuted finding does not trip fail_on: high (severity below threshold)", () => {
    const f = finding({ severity: "medium", refute_result: { verdict: "refuted", reasoning: "", adjusted_confidence: 0 } });
    expect(gateTripped([f], "high")).toBe(false);
  });

  it("a CRITICAL refuted finding does not trip fail_on: high (refuted excludes regardless of severity)", () => {
    const f = finding({ severity: "critical", refute_result: { verdict: "refuted", reasoning: "", adjusted_confidence: 0 } });
    expect(gateTripped([f], "high")).toBe(false);
  });
});