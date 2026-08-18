/**
 * Dismissal store schema — `.flaught-dismissals.json`, a git-tracked record
 * of findings a human has reviewed and suppressed.
 *
 * Design principles (mirrors the findings artifact):
 * - Matched by `fingerprint` (stable, content-based), never by the run-local `id`
 * - Structured disposition, not silent deletion — every entry carries who/when/why
 * - `expires_at` is optional but recommended: forces suppressions to be
 *   periodically re-confirmed instead of rotting forever (see `flaught dismissals audit`)
 */

import { z } from "zod";

export const DismissalEntrySchema = z.object({
  /** Matches Finding.fingerprint */
  fingerprint: z.string(),
  dismissed_by: z.string(),
  dismissed_at: z.string(), // ISO 8601
  reason: z.string(),
  /** Display-only context captured at dismissal time — never used for matching */
  context: z
    .object({
      title: z.string(),
      file: z.string(),
    })
    .nullable()
    .default(null),
  /** ISO 8601. Null means the dismissal never expires. */
  expires_at: z.string().nullable().default(null),
});

export const DismissalStoreSchema = z.object({
  version: z.number().default(1),
  dismissals: z.array(DismissalEntrySchema).default([]),
});

export type DismissalEntry = z.infer<typeof DismissalEntrySchema>;
export type DismissalStore = z.infer<typeof DismissalStoreSchema>;

export const DISMISSAL_STORE_VERSION = 1;
