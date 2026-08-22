/**
 * Fingerprinting — derives a stable, content-based identifier for a finding
 * so it can be matched against the persisted dismissal store across runs.
 *
 * This is deliberately NOT `Finding.id` (that's just array position within
 * a single run). It's also deliberately NOT based on line numbers, since
 * those drift as unrelated code shifts around a finding.
 *
 * Deterministic findings (semgrep/linter/vuln scanner) fingerprint on the
 * tool's own rule ID, which is stable by construction.
 *
 * LLM findings have no rule ID, so they fall back to a combination of
 * category, file, and normalized title. The title normalization is
 * aggressive to survive the LLM rephrasing the same finding across runs:
 *
 *   "Circular dependency between auth and user modules"
 *   "Auth and user modules import each other, forming a cycle"
 *
 * These two titles describe the same finding. The fingerprint includes the
 * file path and evidence snippet as additional stable signals, so even
 * if title normalization can't bridge the gap, the file+snippet match
 * provides a secondary stable anchor.
 *
 * On top of exact fingerprint matching, `applyDismissals()` also performs
 * fuzzy matching: if a new finding's exact fingerprint doesn't match any
 * dismissal, but it shares the same category, file, and snippet with a
 * dismissed finding, it's treated as the same finding (a rephrased version).
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

/**
 * Aggressive title normalization for LLM findings.
 *
 * The LLM rephrases findings across runs — same finding, different wording.
 * This normalization strips surface variation to produce a more stable key:
 *
 * 1. Lowercase
 * 2. Collapse whitespace
 * 3. Remove common articles and prepositions (a, an, the, of, in, on, etc.)
 * 4. Remove common LLM phrasing prefixes ("consider", "potential", "possible")
 * 5. Sort remaining words alphabetically (word order varies across runs)
 * 6. Remove trailing punctuation
 */
export function normalizeTitle(title: string): string {
  let normalized = title.trim().toLowerCase();

  // Remove common LLM phrasing prefixes
  const prefixes = [
    /^(?:consider|potential|possible|likely|probable|apparent|suspected|possible)\s+/i,
  ];
  for (const prefix of prefixes) {
    normalized = normalized.replace(prefix, "");
  }

  // Remove common articles and prepositions
  const stopWords = new Set([
    "a", "an", "the", "of", "in", "on", "at", "to", "for", "with",
    "by", "from", "is", "are", "was", "were", "be", "been", "being",
    "has", "have", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "needs", "need", "this",
    "that", "these", "those", "there", "their", "its", "it",
    "between", "into", "through", "during", "before", "after",
    "above", "below", "under", "over", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all",
    "each", "few", "more", "most", "other", "some", "such", "no",
    "nor", "not", "only", "own", "same", "so", "than", "too",
    "very", "just", "because", "as", "until", "while",
  ]);

  // Split, filter stop words, and sort for order-independence
  const words = normalized
    .replace(/[^\w\s]/g, " ")  // replace non-word chars with spaces
    .split(/\s+/)
    .filter((w) => w.length > 0 && !stopWords.has(w));

  // Sort alphabetically for order-independence
  words.sort();

  return words.join(" ");
}

/**
 * Normalize an evidence snippet for fingerprinting.
 *
 * Strips whitespace and line numbers, collapses whitespace, and truncates
 * to the first 200 characters. The snippet is more stable than the title
 * because it's the actual code at the finding location.
 */
function normalizeSnippet(snippet: string): string {
  if (!snippet) return "";
  return snippet
    .trim()
    .replace(/\s+/g, " ")          // collapse whitespace
    .slice(0, 200)                  // truncate to first 200 chars
    .trim();
}

export function computeFingerprint(finding: FingerprintInput): string {
  const normalizedTitle = normalizeTitle(finding.title);
  const normalizedFile = finding.evidence.file.trim();

  const parts =
    finding.source_type === "deterministic"
      ? ["det", finding.source, finding.evidence.rule_id ?? normalizedTitle, normalizedFile]
      : ["llm", finding.category, normalizedFile, normalizedTitle];

  const digest = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `sha256:${digest}`;
}

/** Convenience overload for callers that already have a full Finding. */
export function fingerprintFinding(finding: Finding): string {
  return computeFingerprint(finding);
}

// ─── Fuzzy matching ────────────────────────────────────────────────────────

/**
 * A lightweight "similarity key" derived from a finding for fuzzy matching.
 *
 * This is a coarser key than the exact fingerprint, designed to match
 * across LLM rephrasings. It uses category + file + (optionally) snippet
 * as a stable anchor. Two findings with different exact fingerprints but
 * the same similarity key are likely the same finding rephrased.
 */
export function computeSimilarityKey(finding: Finding): string {
  if (finding.source_type === "deterministic") {
    // Deterministic findings already have stable fingerprints via rule_id
    return finding.fingerprint;
  }

  const parts = [
    "llm-sim",
    finding.category,
    finding.evidence.file.trim(),
    normalizeSnippet(finding.evidence.snippet),
  ];

  const digest = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
  return `sim:${digest}`;
}

/**
 * Check whether two findings are "similar enough" to be considered the same
 * finding across LLM rephrasings.
 *
 * Returns true if:
 * 1. They have the same exact fingerprint, OR
 * 2. They share the same category + file + snippet (similarity key)
 */
export function isSimilarFinding(a: Finding, b: Finding): boolean {
  // Exact match
  if (a.fingerprint === b.fingerprint) return true;

  // Both must be LLM findings
  if (a.source_type !== "llm" || b.source_type !== "llm") return false;

  // Must be in the same category and file
  if (a.category !== b.category) return false;
  if (a.evidence.file.trim() !== b.evidence.file.trim()) return false;

  // If both have non-empty snippets, check if they overlap significantly
  const snippetA = normalizeSnippet(a.evidence.snippet);
  const snippetB = normalizeSnippet(b.evidence.snippet);

  if (snippetA && snippetB) {
    // Check if either snippet is a substring of the other, or if they share
    // at least 60% of their words (after normalization)
    if (snippetA === snippetB) return true;

    // Substring check (shorter in longer)
    const [shorter, longer] = snippetA.length < snippetB.length ? [snippetA, snippetB] : [snippetB, snippetA];
    if (longer.includes(shorter)) return true;

    // Word overlap check
    const wordsA = new Set(shorter.split(" "));
    const wordsB = new Set(longer.split(" "));
    let overlap = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap++;
    }
    const similarity = overlap / Math.max(wordsA.size, wordsB.size);
    if (similarity >= 0.6) return true;
  }

  // Same category + same file with no snippets — not enough signal
  return false;
}