import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadDismissalStore,
  saveDismissalStore,
  addDismissal,
  removeDismissal,
  isExpired,
  findActiveDismissal,
  resolveDismissalsPath,
  DEFAULT_DISMISSALS_FILENAME,
} from "./store.js";
import type { DismissalEntry } from "../schemas/dismissals.js";

function makeEntry(overrides: Partial<DismissalEntry> = {}): DismissalEntry {
  return {
    fingerprint: "sha256:abc123",
    dismissed_by: "jane@example.com",
    dismissed_at: "2025-01-15T10:30:00Z",
    reason: "False positive — sanitized upstream",
    context: { title: "SQL injection vulnerability", file: "src/db/queries.ts" },
    expires_at: null,
    ...overrides,
  };
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flaught-dismissals-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolveDismissalsPath", () => {
  it("defaults to .flaught-dismissals.json at repo root", () => {
    const repoRoot = "/repo";
    expect(resolveDismissalsPath(repoRoot)).toBe(path.resolve(repoRoot, DEFAULT_DISMISSALS_FILENAME));
  });

  it("honors a configured path", () => {
    const repoRoot = "/repo";
    expect(resolveDismissalsPath(repoRoot, "config/dismissals.json")).toBe(
      path.resolve(repoRoot, "config/dismissals.json"),
    );
  });
});

describe("loadDismissalStore / saveDismissalStore", () => {
  it("returns an empty store when the file doesn't exist", () => {
    const repoRoot = tempRepo();
    const filePath = resolveDismissalsPath(repoRoot);
    const store = loadDismissalStore(filePath);
    expect(store.dismissals).toEqual([]);
    expect(store.version).toBe(1);
  });

  it("round-trips through save and load", () => {
    const repoRoot = tempRepo();
    const filePath = resolveDismissalsPath(repoRoot);
    const entry = makeEntry();

    saveDismissalStore(filePath, addDismissal(loadDismissalStore(filePath), entry));

    const reloaded = loadDismissalStore(filePath);
    expect(reloaded.dismissals).toHaveLength(1);
    expect(reloaded.dismissals[0]).toEqual(entry);
  });
});

describe("addDismissal", () => {
  it("replaces an existing entry with the same fingerprint", () => {
    const store = { version: 1, dismissals: [makeEntry({ reason: "old reason" })] };
    const updated = addDismissal(store, makeEntry({ reason: "new reason" }));
    expect(updated.dismissals).toHaveLength(1);
    expect(updated.dismissals[0]!.reason).toBe("new reason");
  });
});

describe("removeDismissal", () => {
  it("removes the matching entry only", () => {
    const store = {
      version: 1,
      dismissals: [makeEntry({ fingerprint: "sha256:a" }), makeEntry({ fingerprint: "sha256:b" })],
    };
    const updated = removeDismissal(store, "sha256:a");
    expect(updated.dismissals).toHaveLength(1);
    expect(updated.dismissals[0]!.fingerprint).toBe("sha256:b");
  });
});

describe("isExpired / findActiveDismissal", () => {
  it("treats a null expires_at as never expiring", () => {
    const entry = makeEntry({ expires_at: null });
    expect(isExpired(entry)).toBe(false);
  });

  it("treats a past expires_at as expired", () => {
    const entry = makeEntry({ expires_at: "2020-01-01T00:00:00Z" });
    expect(isExpired(entry, new Date("2025-01-01T00:00:00Z"))).toBe(true);
  });

  it("treats a future expires_at as not expired", () => {
    const entry = makeEntry({ expires_at: "2030-01-01T00:00:00Z" });
    expect(isExpired(entry, new Date("2025-01-01T00:00:00Z"))).toBe(false);
  });

  it("findActiveDismissal returns null for an expired entry", () => {
    const store = { version: 1, dismissals: [makeEntry({ expires_at: "2020-01-01T00:00:00Z" })] };
    expect(findActiveDismissal(store, "sha256:abc123", new Date("2025-01-01T00:00:00Z"))).toBeNull();
  });

  it("findActiveDismissal returns the entry when active", () => {
    const store = { version: 1, dismissals: [makeEntry()] };
    expect(findActiveDismissal(store, "sha256:abc123")?.reason).toBe("False positive — sanitized upstream");
  });

  it("findActiveDismissal returns null when no fingerprint matches", () => {
    const store = { version: 1, dismissals: [makeEntry()] };
    expect(findActiveDismissal(store, "sha256:does-not-exist")).toBeNull();
  });
});
