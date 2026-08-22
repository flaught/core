/**
 * Trend extraction for the JSON artifact dashboard (core-ns2).
 *
 * Turns a set of findings.json artifacts (one per historical review run)
 * into a time-ordered series of summary points a dashboard can chart.
 * Deliberately doesn't try to fetch artifacts itself — callers hand it
 * already-loaded FindingsArtifact objects, whether those came from a local
 * directory of downloaded CI artifacts or anywhere else.
 */

import type { FindingsArtifact, Severity, RefuteVerdict } from "../schemas/findings.js";

export interface TrendPoint {
  generated_at: string;
  run_id: string;
  pr_number: number | null;
  pr_title: string | null;
  repository: string;
  total_findings: number;
  by_severity: Record<Severity, number>;
  by_source_type: { llm: number; deterministic: number };
  refute: Record<RefuteVerdict, number>;
  dismissed_count: number;
  llm_error: boolean;
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
const VERDICTS: RefuteVerdict[] = ["confirmed", "refuted", "uncertain"];

/**
 * Minimal runtime shape check for a parsed JSON value. The dashboard reads
 * files off disk (potentially hand-edited, from an older schema version, or
 * just not a findings artifact at all) — this is the same "don't throw on a
 * malformed artifact" posture as the markdown renderer, applied at load time
 * instead of render time.
 */
export function isFindingsArtifact(value: unknown): value is FindingsArtifact {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.generated_at === "string" &&
    typeof v.run === "object" && v.run !== null &&
    typeof v.summary === "object" && v.summary !== null &&
    Array.isArray(v.findings)
  );
}

function countRefuteVerdicts(artifact: FindingsArtifact): Record<RefuteVerdict, number> {
  const counts: Record<RefuteVerdict, number> = { confirmed: 0, refuted: 0, uncertain: 0 };
  for (const f of artifact.findings) {
    if (f.refute_result) counts[f.refute_result.verdict]++;
  }
  return counts;
}

function toTrendPoint(artifact: FindingsArtifact): TrendPoint {
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const sev of SEVERITIES) {
    bySeverity[sev] = artifact.summary?.by_severity?.[sev] ?? 0;
  }

  return {
    generated_at: artifact.generated_at,
    run_id: artifact.run?.id ?? "unknown",
    pr_number: artifact.pull_request?.number ?? null,
    pr_title: artifact.pull_request?.title ?? null,
    repository: artifact.repository?.name ?? "unknown",
    total_findings: artifact.summary?.total_findings ?? artifact.findings.length,
    by_severity: bySeverity,
    by_source_type: {
      llm: artifact.summary?.by_source_type?.llm ?? 0,
      deterministic: artifact.summary?.by_source_type?.deterministic ?? 0,
    },
    refute: countRefuteVerdicts(artifact),
    dismissed_count: artifact.summary?.dismissed_count ?? 0,
    llm_error: Boolean(artifact.run?.llm_error),
  };
}

/**
 * Compute a chronologically-sorted trend series from a set of artifacts.
 * Artifacts that fail the shape check are dropped, not thrown on.
 */
export function computeTrends(artifacts: unknown[]): TrendPoint[] {
  return artifacts
    .filter(isFindingsArtifact)
    .map(toTrendPoint)
    .sort((a, b) => a.generated_at.localeCompare(b.generated_at));
}

export { SEVERITIES, VERDICTS };
