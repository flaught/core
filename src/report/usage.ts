/**
 * Token-usage formatting shared by the markdown PR comment and the inline
 * review comment header.
 *
 * Returns a single human-readable line, or null when there is no usage to
 * show (null = no data, not zero tokens — a --no-llm run). Cost is
 * deliberately not computed here; the raw counts are surfaced so a reader
 * can apply their own pricing.
 */

import type { TokenUsageSummary } from "../schemas/findings.js";

/**
 * Format a token usage summary as a compact one-line string.
 * Returns null when usage is null (nothing to render).
 */
export function formatTokenUsage(usage: TokenUsageSummary | null): string | null {
  if (!usage) return null;
  const review = usage.review.total_tokens;
  const refute = usage.refute?.total_tokens ?? 0;
  const total = review + refute;
  if (refute === 0) {
    return `🪙 Tokens: ${total.toLocaleString()}`;
  }
  return `🪙 Tokens: ${total.toLocaleString()} (review ${review.toLocaleString()} + refute ${refute.toLocaleString()})`;
}