/**
 * Loads findings.json artifacts from disk for the dashboard.
 *
 * No fetching from CI here on purpose — this repo's GH Actions workflow
 * already uploads each run's findings.json as an artifact (see
 * .github/workflows/adversarial-review.yml); pulling those down is a
 * `gh run download` / GitHub API concern, not something this CLI command
 * needs to own for a first pass. Point --input at a directory of already
 * downloaded artifacts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Recursively collect every `*.json` file under `dir`. */
export function findJsonFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      results.push(full);
    }
  }

  return results;
}

/** Parse each file as JSON, skipping (not throwing on) files that aren't valid JSON. */
export function loadJsonFiles(paths: string[]): unknown[] {
  const parsed: unknown[] = [];
  for (const p of paths) {
    try {
      parsed.push(JSON.parse(fs.readFileSync(p, "utf-8")));
    } catch {
      // Not valid JSON (or unreadable) — skip. computeTrends() further
      // filters out anything that doesn't look like a findings artifact.
    }
  }
  return parsed;
}
