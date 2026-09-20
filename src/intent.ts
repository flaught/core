/**
 * PR review intent (title/body/acceptance criteria) handling.
 *
 * The PR description is the scope-creep intent anchor: Flaught flags changes
 * that appear unrelated to it. Field evidence (GH#86) showed integrations
 * passing only the PR TITLE, which starves the detector and produces false
 * "unrelated change" findings against work the (unseen) body authorized.
 *
 * This module centralizes:
 * - resolving the intent text from CLI options (inline text or file-backed);
 * - provenance metadata recorded on the artifact (what kind of intent the
 *   review ran against) WITHOUT duplicating the text itself;
 * - the sparse-intent warning, so a title-only anchor surfaces loudly instead
 *   of silently degrading scope-creep detection.
 */

import fs from "node:fs";
import path from "node:path";

export type IntentSource = "cli-text" | "cli-file";

export interface ResolvedIntent {
  text: string | undefined;
  source: IntentSource | undefined;
}

/**
 * Resolve the PR intent text from CLI options.
 *
 * `--pr-description-file` is the recommended path for real PRs: the body is
 * multiline, user-controlled text, and routing it through a file avoids both
 * argv length limits and any temptation to interpolate it into shell code.
 * The file is read verbatim (utf-8) — multiline text, quotes, and literal
 * shell metacharacters are data, never executed.
 *
 * Throws on `--pr-description` + `--pr-description-file` together (ambiguous
 * intent must fail loudly, not pick one silently).
 */
export function resolvePrIntent(opts: {
  prDescription?: string;
  prDescriptionFile?: string;
}): ResolvedIntent {
  if (opts.prDescription !== undefined && opts.prDescriptionFile !== undefined) {
    throw new Error(
      "Use either --pr-description <text> or --pr-description-file <path>, not both.",
    );
  }

  if (opts.prDescriptionFile !== undefined) {
    const filePath = path.resolve(opts.prDescriptionFile);
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new Error(
        `Could not read --pr-description-file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { text, source: "cli-file" };
  }

  if (opts.prDescription !== undefined) {
    return { text: opts.prDescription, source: "cli-text" };
  }

  return { text: undefined, source: undefined };
}

/** Provenance metadata recorded on the artifact — deliberately no intent text. */
export interface IntentProvenance {
  /** How the intent reached flaught (inline text, file, or recovered from a context bundle in the fork-PR split). */
  source: IntentSource | "bundle";
  chars: number;
  lines: number;
  /** True when the intent is a single short line — i.e. almost certainly just the PR title. */
  appears_title_only: boolean;
}

/** A single line of ≤120 chars reads as a PR title, not a body. */
const TITLE_ONLY_MAX_CHARS = 120;

export function buildIntentProvenance(
  text: string,
  source: IntentProvenance["source"],
): IntentProvenance {
  const lines = text.split(/\r?\n/);
  return {
    source,
    chars: text.length,
    lines: lines.length,
    appears_title_only: appearsTitleOnly(text),
  };
}

/**
 * Heuristic: does this intent look like JUST a PR title? Single non-empty
 * line, short. False on multiline bodies; intended only to drive a warning,
 * never to change behavior.
 */
export function appearsTitleOnly(text: string): boolean {
  const nonEmpty = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return nonEmpty.length === 1 && text.trim().length <= TITLE_ONLY_MAX_CHARS;
}

/**
 * Warn (loudly, on the progress channel) when scope-creep detection is
 * running against a sparse or missing intent anchor. No-op when scope-creep
 * detection is disabled or the LLM pass is skipped.
 */
export function warnOnSparseIntent(
  progress: (msg: string) => void,
  scopeCreepEnabled: boolean,
  llmEnabled: boolean,
  intentText: string | undefined,
): void {
  if (!scopeCreepEnabled || !llmEnabled) return;

  if (intentText === undefined || intentText.trim() === "") {
    progress(
      "  ⚠ No PR description provided — scope-creep detection is running WITHOUT an intent anchor. " +
      "Pass the full PR title + body (e.g. --pr-description-file, see docs/github-actions.md).",
    );
    return;
  }

  if (appearsTitleOnly(intentText)) {
    progress(
      `  ⚠ Scope-creep intent looks title-only (${intentText.trim().length} chars, 1 line). ` +
      "The PR body is the intent anchor — title-only intent causes false 'unrelated change' findings " +
      "against work the body authorized (GH#86). Prefer --pr-description-file with title + full body.",
    );
  }
}
