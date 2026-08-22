/**
 * Findings JSON schema — the backbone of Flaught's governance positioning.
 *
 * Design principles:
 * - Versioned from day one (schema_version field)
 * - Self-describing outside any dashboard (repo, PR, commit, timestamps)
 * - Every finding carries source_type: "deterministic" | "llm" — evidence quality is legible in the data
 * - Dismissal is structured disposition data, not free-text afterthought
 * - The _caveat field is always present and never stripped
 */

// ─── Enums ────────────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Category =
  | "security"
  | "architecture"
  | "scope-creep"
  | "test-quality"
  | "performance"
  | "maintainability";

export type SourceType = "deterministic" | "llm";

// ─── Core structures ──────────────────────────────────────────────────────

// ─── Refute result ──────────────────────────────────────────────────────────

export type RefuteVerdict = "confirmed" | "refuted" | "uncertain";

export interface RefuteResult {
  /** Whether the skeptic confirmed, refuted, or was uncertain about this finding */
  verdict: RefuteVerdict;
  /** The skeptic's reasoning for the verdict */
  reasoning: string;
  /** Confidence after the refute pass. Same as original if confirmed; reduced if refuted/uncertain. */
  adjusted_confidence: number;
}

// ─── Finding evidence ──────────────────────────────────────────────────────────

export interface FindingEvidence {
  file: string;
  line_start: number;
  line_end: number;
  snippet: string;
  /** file:line refs to files in the one-hop dependency neighborhood */
  blast_radius: string[];
  /** Stable rule/check identifier from the source tool (e.g. semgrep check_id, eslint ruleId). Null for LLM findings and findings with no rule concept. */
  rule_id: string | null;
}

export interface Finding {
  id: string; // e.g. "F-001" — positional within a single run, NOT stable across runs
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  evidence: FindingEvidence;
  /** Which tool or model produced this finding. Tools: "semgrep", "npm_audit", etc. LLM: "llm:gpt-4o" */
  source: string;
  /** The critical governance field: is this from a deterministic tool or an LLM? */
  source_type: SourceType;
  /** 0.0–1.0. Deterministic tools always report 1.0; LLM self-reports. */
  confidence: number;
  /** URLs to rules, docs, or references */
  references: string[];
  /**
   * Stable content-based identifier, unlike `id` which is just array position.
   * Used to match findings against the persisted dismissal store across runs.
   * See src/dismissals/fingerprint.ts for the derivation.
   */
  fingerprint: string;

  // ── Dismissal (structured disposition, not erasure) ──
  dismissed: boolean;
  dismissed_by: string | null;
  dismissed_at: string | null; // ISO 8601
  dismissal_reason: string | null;

  // ── Refute pass result (null if refute pass not run or finding is deterministic) ──
  refute_result: RefuteResult | null;
}

// ─── Test inversion ────────────────────────────────────────────────────────

export interface FlaggedTest {
  test: string;
  reason: string;
}

export interface TestInversion {
  command: string;
  base_passed: string[];
  head_passed: string[];
  flagged: FlaggedTest[];
}

// ─── Scope creep ──────────────────────────────────────────────────────────

export interface FlaggedHunk {
  file: string;
  lines: string; // e.g. "1-30"
  reason: string;
}

export interface ScopeCreep {
  pr_intent: string;
  flagged_hunks: FlaggedHunk[];
}

// ─── Tool execution record ────────────────────────────────────────────────

export interface ToolExecuted {
  tool: string;
  version: string;
  exit_code: number;
  raw_findings_count: number;
  command: string;
}

// ─── Noise budget ─────────────────────────────────────────────────────────

export interface SeverityBudget {
  limit: number;
  used: number;
}

export interface NoiseBudget {
  critical: SeverityBudget;
  high: SeverityBudget;
  medium: SeverityBudget;
  low: SeverityBudget;
  info: SeverityBudget;
}

// ─── Summary ──────────────────────────────────────────────────────────────

export interface FindingsSummary {
  total_findings: number;
  by_severity: Record<Severity, number>;
  by_source_type: Record<SourceType, number>;
  by_category: Record<Category, number>;
  dismissed_count: number;
}

// ─── Top-level artifact ────────────────────────────────────────────────────

export interface FindingsArtifact {
  $schema: string;
  schema_version: number;

  /** Always-present honest caveat about what this artifact represents */
  _caveat: string;

  generated_at: string; // ISO 8601
  flaught_version: string;

  repository: {
    name: string;
    url: string;
    branch: string;
  };

  pull_request: {
    number: number | null;
    url: string | null;
    title: string | null;
    description: string | null;
    base_sha: string;
    head_sha: string;
  };

  run: {
    id: string;
    ci_url: string | null;
    duration_seconds: number;
    /** Error message if the LLM call failed (review still completed with deterministic findings) */
    llm_error: string | null;
  };

  tools_executed: ToolExecuted[];

  findings: Finding[];

  test_inversion: TestInversion | null;
  scope_creep: ScopeCreep | null;

  noise_budget: NoiseBudget;

  summary: FindingsSummary;
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 2;

export const FINDINGS_SCHEMA_URL = "https://flaught.dev/schemas/findings/v2.schema.json";

export const CAVEAT =
  "This artifact is evidence that adversarial scrutiny occurred on this PR. " +
  "It is NOT evidence that findings are correct. LLM-asserted findings may include " +
  "hallucinations. Deterministic-tool findings have their own false-positive rates. " +
  "Treat this as a prompt for human review, not as audit-truth.";