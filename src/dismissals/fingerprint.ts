/**
 * Fingerprinting — derives a stable, content-based identifier for a finding
 * so it can be matched against the persisted dismissal store across runs.
 *
 * This is deliberately NOT `Finding.id` (that's just array position within
 * a single run). It's also deliberately NOT based on line numbers, since
 * those drift as unrelated code shifts around a finding.
 *
 * Deterministic findings (semgrep/linter/vuln scanner) fingerprint on the
 * tool's own rule ID, which is stable by construction. LLM findings have no
 * rule ID, so they fall back to a normalized title — which means a finding
 * whose wording changes materially between runs will NOT match its prior
 * dismissal. That's a known limitation, not a bug: exact-match is the
 * conservative choice for a governance-critical suppression list.
 */

import { createHash } from "node:crypto";
import type { Category, Finding, SourceType } from "../schemas/findings.js";

export interface FingerprintInput {
  source_type: SourceType;
  source: string;
  category: Category;
  title: string;
  evidence: {
    file: string;
    rule_id: string | null;
  };
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export function computeFingerprint(finding: FingerprintInput): string {
  const parts =
    finding.source_type === "deterministic"
      ? ["det", finding.source, finding.evidence.rule_id ?? normalizeTitle(finding.title), finding.evidence.file]
      : ["llm", finding.category, finding.evidence.file, normalizeTitle(finding.title)];

  const digest = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `sha256:${digest}`;
}

/** Convenience overload for callers that already have a full Finding. */
export function fingerprintFinding(finding: Finding): string {
  return computeFingerprint(finding);
}
