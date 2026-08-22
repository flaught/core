/**
 * Dismissal store I/O — loads/saves `.flaught-dismissals.json` and provides
 * lookup/mutation helpers used by both the review pipeline and the CLI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DismissalStoreSchema,
  type DismissalEntry,
  type DismissalStore,
} from "../schemas/dismissals.js";

export const DEFAULT_DISMISSALS_FILENAME = ".flaught-dismissals.json";

export function resolveDismissalsPath(repoRoot: string, configuredPath?: string | null): string {
  return path.resolve(repoRoot, configuredPath ?? DEFAULT_DISMISSALS_FILENAME);
}

export function loadDismissalStore(filePath: string): DismissalStore {
  if (!fs.existsSync(filePath)) {
    return DismissalStoreSchema.parse({});
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return DismissalStoreSchema.parse(raw);
}

/**
 * Save the dismissal store to disk atomically.
 *
 * SECURITY: Writes to a temporary file first, then renames it to the target
 * path. This prevents concurrent processes from reading a partially-written
 * file (TOCTOU / torn-write protection). On most OS/filesystems, rename is
 * atomic, so a concurrent reader will always see either the old or the new
 * version, never a partial write.
 */
export function saveDismissalStore(filePath: string, store: DismissalStore): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + ".tmp." + process.pid + "." + Date.now();
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } catch {
    // If rename fails (e.g., cross-device link), fall back to direct write.
    // This is still safer than no atomicity — most failures will be caught
    // by the writeFileSync above, and the rename is a best-effort atomic swap.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  }
}

export function addDismissal(store: DismissalStore, entry: DismissalEntry): DismissalStore {
  const withoutExisting = store.dismissals.filter((d) => d.fingerprint !== entry.fingerprint);
  return { ...store, dismissals: [...withoutExisting, entry] };
}

export function removeDismissal(store: DismissalStore, fingerprint: string): DismissalStore {
  return { ...store, dismissals: store.dismissals.filter((d) => d.fingerprint !== fingerprint) };
}

export function isExpired(entry: DismissalEntry, now: Date = new Date()): boolean {
  if (!entry.expires_at) return false;
  return new Date(entry.expires_at).getTime() < now.getTime();
}

/** Returns the entry for a fingerprint only if it exists and hasn't expired. */
export function findActiveDismissal(
  store: DismissalStore,
  fingerprint: string,
  now: Date = new Date(),
): DismissalEntry | null {
  const entry = store.dismissals.find((d) => d.fingerprint === fingerprint);
  if (!entry) return null;
  if (isExpired(entry, now)) return null;
  return entry;
}

/** All non-expired entries in the store, most-recently-dismissed first. */
export function getActiveDismissals(
  store: DismissalStore,
  now: Date = new Date(),
): DismissalEntry[] {
  return store.dismissals
    .filter((d) => !isExpired(d, now))
    .sort((a, b) => new Date(b.dismissed_at).getTime() - new Date(a.dismissed_at).getTime());
}
