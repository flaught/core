/**
 * Applies the persisted dismissal store to a freshly-assembled findings list.
 *
 * Runs after all findings (deterministic + LLM + test-inversion) are built,
 * and before noise-budget enforcement — a re-surfaced dismissed finding
 * should never crowd out a genuinely new one at the same severity.
 */

import type { Finding } from "../schemas/findings.js";
import type { DismissalStore } from "../schemas/dismissals.js";
import { findActiveDismissal } from "./store.js";

export interface ApplyDismissalsResult {
  findings: Finding[];
  appliedCount: number;
}

export function applyDismissals(
  findings: Finding[],
  store: DismissalStore,
  now: Date = new Date(),
): ApplyDismissalsResult {
  let appliedCount = 0;

  const result = findings.map((finding) => {
    const entry = findActiveDismissal(store, finding.fingerprint, now);
    if (!entry) return finding;

    appliedCount++;
    return {
      ...finding,
      dismissed: true,
      dismissed_by: entry.dismissed_by,
      dismissed_at: entry.dismissed_at,
      dismissal_reason: entry.reason,
    };
  });

  return { findings: result, appliedCount };
}
