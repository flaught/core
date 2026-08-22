/**
 * Applies the persisted dismissal store to a freshly-assembled findings list.
 *
 * Runs after all findings (deterministic + LLM + test-inversion) are built,
 * and before noise-budget enforcement — a re-surfaced dismissed finding
 * should never crowd out a genuinely new one at the same severity.
 *
 * Matching strategy:
 * 1. Exact fingerprint match (deterministic findings always match this way)
 * 2. Fuzzy match for LLM findings: same category + file + similar title
 *    bridges the gap when the LLM rephrases a finding across runs.
 */

import type { Finding } from "../schemas/findings.js";
import type { DismissalStore } from "../schemas/dismissals.js";
import { findActiveDismissal } from "./store.js";
import { normalizeTitle } from "./fingerprint.js";

export interface ApplyDismissalsResult {
  findings: Finding[];
  appliedCount: number;
}

/**
 * Compute word-overlap similarity between two normalized titles.
 *
 * Returns a value between 0 and 1, where 1 means all words overlap.
 * This handles cases like:
 *   "circular dependency auth user modules" vs "auth user modules import cycle"
 *   (3 of 7 unique words overlap ≈ 0.43 — not enough for a match)
 *
 * vs:
 *   "sql injection search endpoint" vs "injection sql endpoint search"
 *   (all words overlap = 1.0 — exact match despite word order)
 */
function titleSimilarity(titleA: string, titleB: string): number {
  const wordsA = new Set(normalizeTitle(titleA).split(" ").filter(Boolean));
  const wordsB = new Set(normalizeTitle(titleB).split(" ").filter(Boolean));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }

  return overlap / Math.max(wordsA.size, wordsB.size);
}

export function applyDismissals(
  findings: Finding[],
  store: DismissalStore,
  now: Date = new Date(),
): ApplyDismissalsResult {
  let appliedCount = 0;

  // Pre-build a set of exact fingerprints for O(1) lookup
  const exactFingerprints = new Map<string, typeof store.dismissals[number]>();
  for (const entry of store.dismissals) {
    if (findActiveDismissal(store, entry.fingerprint, now)) {
      exactFingerprints.set(entry.fingerprint, entry);
    }
  }

  const result = findings.map((finding) => {
    // 1. Exact fingerprint match
    const exactMatch = exactFingerprints.get(finding.fingerprint);
    if (exactMatch) {
      appliedCount++;
      return {
        ...finding,
        dismissed: true,
        dismissed_by: exactMatch.dismissed_by,
        dismissed_at: exactMatch.dismissed_at,
        dismissal_reason: exactMatch.reason,
      };
    }

    // 2. Fuzzy match for LLM findings — only if exact match failed
    if (finding.source_type === "llm") {
      for (const entry of store.dismissals) {
        // Skip expired
        if (entry.expires_at && new Date(entry.expires_at).getTime() < now.getTime()) {
          continue;
        }

        // Only fuzzy-match against dismissals with context (should be all of them)
        if (!entry.context?.file) continue;

        // Same file is required for fuzzy matching
        if (entry.context.file.trim() !== finding.evidence.file.trim()) continue;

        // Same category is a strong signal
        if (finding.category && entry.context.title) {
          const sim = titleSimilarity(finding.title, entry.context.title);
          if (sim >= 0.5) {
            appliedCount++;
            return {
              ...finding,
              dismissed: true,
              dismissed_by: entry.dismissed_by,
              dismissed_at: entry.dismissed_at,
              dismissal_reason: entry.reason,
            };
          }
        }
      }
    }

    return finding;
  });

  return { findings: result, appliedCount };
}