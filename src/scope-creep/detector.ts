/**
 * Scope-creep detection — flag diff hunks that don't serve the stated PR intent.
 *
 * Two layers:
 * 1. Heuristic pre-filter: file path analysis (unrelated files, drive-by refactors)
 * 2. LLM validation: the LLM's scope-creep findings are extracted from the
 *    review results and organized into the structured ScopeCreep artifact
 *
 * The heuristic layer catches obvious cases without needing the LLM:
 * - Changes to files unrelated to the PR description's domain
 * - Formatting-only changes (whitespace, semicolons, trailing commas)
 * - Changes to files explicitly excluded from the PR's scope
 *
 * The LLM layer catches subtle cases (refactoring that touches more than
 * necessary, feature additions buried in a bugfix PR, etc.)
 */

import type { ReviewContext, ChangedFile } from "../context/assembler.js";
import type { ScopeCreep, FlaggedHunk, Finding } from "../schemas/findings.js";
import type { FlaughtConfig } from "../schemas/config.js";

// ─── Heuristic scope-creep detection ──────────────────────────────────────────

/**
 * Analyze changed files for obvious scope creep without LLM involvement.
 * Flags hunks that are clearly unrelated to the PR description's intent.
 */
export function detectScopeCreepHeuristic(
  context: ReviewContext,
  prDescription: string | undefined,
  config: FlaughtConfig,
): FlaggedHunk[] {
  if (!config.scope_creep.enabled) return [];
  if (context.changedFiles.length === 0) return [];

  const intent = extractIntent(prDescription);
  const flagged: FlaggedHunk[] = [];

  for (const file of context.changedFiles) {
    // Skip files in common exclusion patterns
    if (isLikelyUnrelated(file, intent)) {
      flagged.push({
        file: file.path,
        lines: `1-${file.additions}`,
        reason: classifyUnrelatedChange(file, intent),
      });
    }

    // Flag formatting-only changes
    if (isFormattingOnlyChange(file)) {
      flagged.push({
        file: file.path,
        lines: `1-${file.additions}`,
        reason: "Formatting-only change (whitespace, trailing commas, semicolons) with no functional impact",
      });
    }
  }

  return flagged;
}

/**
 * Extract scope-creep findings from LLM results and organize into the
 * structured ScopeCreep artifact field.
 */
export function extractScopeCreepFromFindings(
  findings: Finding[],
  prDescription: string | undefined,
): ScopeCreep | null {
  const scopeCreepFindings = findings.filter(
    (f) => f.category === "scope-creep",
  );

  if (scopeCreepFindings.length === 0 && !prDescription) {
    return null;
  }

  const flaggedHunks: FlaggedHunk[] = scopeCreepFindings.map((f) => ({
    file: f.evidence.file || "unknown",
    lines: f.evidence.line_start === f.evidence.line_end
      ? `${f.evidence.line_start}`
      : `${f.evidence.line_start}-${f.evidence.line_end}`,
    reason: f.description,
  }));

  return {
    pr_intent: prDescription ?? "No PR description provided",
    flagged_hunks: flaggedHunks,
  };
}

// ─── Intent extraction ──────────────────────────────────────────────────────────

/**
 * Extract key intent words from a PR description.
 * Strips common filler words and extracts nouns/verbs that indicate
 * what the PR is supposed to do.
 */
function extractIntent(prDescription: string | undefined): string[] {
  if (!prDescription || prDescription.trim().length === 0) {
    return [];
  }

  // Split into words, lowercase, strip punctuation
  const words = prDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2); // Skip very short words

  // Remove common filler words
  const stopWords = new Set([
    "the", "and", "for", "that", "this", "with", "from", "they", "been",
    "have", "will", "was", "are", "but", "not", "all", "can", "had",
    "her", "more", "some", "what", "when", "were", "been", "does",
    "also", "just", "into", "over", "then", "than", "only", "about",
    "which", "would", "there", "their", "could", "other", "after",
    "first", "very", "like", "make", "being", "made", "many", "much",
    "should", "thing", "things", "need", "needs", "needed", "want",
    "wants", "wanted", "using", "used", "use", "uses", "add", "added",
    "adds", "fix", "fixes", "fixed", "update", "updated", "updates",
    "change", "changed", "changes", "remove", "removed", "removes",
    "implement", "implemented", "implements", "create", "created",
    "creates", "set", "sets", "setup", "getting", "able", "doesn",
    "isn", "wasn", "aren", "weren", "hasn", "haven", "hadn", "won",
  ]);

  // Also keep significant words from the PR (domain terms, feature names)
  return words.filter((w) => !stopWords.has(w));
}

// ─── Heuristic classifiers ────────────────────────────────────────────────────

/**
 * Check if a changed file is likely unrelated to the PR's intent.
 * Uses file path patterns and intent keyword matching.
 */
function isLikelyUnrelated(file: ChangedFile, intent: string[]): boolean {
  if (intent.length === 0) return false; // No intent to compare against

  const filePath = file.path.toLowerCase();

  // Common files that are almost always unrelated scope creep
  const alwaysSuspicious = [
    /\/\.editorconfig$/,
    /\/\.eslintrc/,
    /\/\.prettierrc/,
    /\/prettier\.config\./,
    /\/\.gitignore$/,
    /\/\.npmrc$/,
    /\/\.nvmrc$/,
    /\/docker-compose.*\.yml$/,
    /\/Makefile$/,
    /\/README\.md$/,
    /\/CHANGELOG\.md$/,
    /\/CONTRIBUTING\.md$/,
    /\/LICENSE$/,
    /\/\.env\.example$/,
  ];

  for (const pattern of alwaysSuspicious) {
    if (pattern.test(filePath)) return true;
  }

  // If the intent mentions specific domains/paths, flag changes
  // outside those paths
  if (intent.length > 0) {
    // Extract path-like segments from intent (e.g., "auth" -> src/auth)
    const intentPaths = intent.filter((word) => word.includes("/") || word.length > 3);

    // If the file is in a directory that doesn't match any intent keyword
    if (intentPaths.length > 0 && filePath.includes("/")) {
      const dirParts = filePath.split("/").slice(0, -1); // Remove filename
      const matchesIntent = intentPaths.some(
        (keyword) =>
          dirParts.some((part) => part.includes(keyword) || keyword.includes(part)),
      );

      // Don't flag test files or utility files as unrelated — they might
      // legitimately need changes even if they're in a different directory
      if (!matchesIntent && !isTestFile(filePath) && !isUtilityFile(filePath)) {
        // Only flag if the intent is specific enough to be meaningful
        if (intentPaths.length >= 2) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Classify why a file change is likely unrelated to the PR intent.
 */
function classifyUnrelatedChange(file: ChangedFile, intent: string[]): string {
  const filePath = file.path.toLowerCase();

  // Check specific known-unrelated patterns
  if (/\.editorconfig$/.test(filePath)) {
    return "Editor configuration change unrelated to the stated PR intent";
  }
  if (/\.eslintrc/.test(filePath) || /eslint\.config/.test(filePath)) {
    return "Linter configuration change unrelated to the stated PR intent";
  }
  if (/\.prettierrc/.test(filePath) || /prettier\.config/.test(filePath)) {
    return "Formatter configuration change unrelated to the stated PR intent";
  }
  if (/\.gitignore$/.test(filePath)) {
    return "Git ignore change unrelated to the stated PR intent";
  }
  if (/docker-compose/.test(filePath)) {
    return "Docker configuration change unrelated to the stated PR intent";
  }
  if (/README\.md$/.test(filePath)) {
    return "Documentation change unrelated to the stated PR intent";
  }
  if (/CHANGELOG\.md$/.test(filePath)) {
    return "Changelog update unrelated to the stated PR intent";
  }
  if (intent.length > 0) {
    const intentStr = intent.slice(0, 5).join(", ");
    return `Change to ${filePath} appears unrelated to the stated PR intent (${intentStr})`;
  }

  return `Change to ${filePath} appears unrelated to the stated PR intent`;
}

/**
 * Check if a change is formatting-only (whitespace, semicolons, trailing commas).
 * This is a heuristic based on the diff stats — if deletions == 0 and the
 * file is a known formatting target, it's likely formatting.
 */
function isFormattingOnlyChange(file: ChangedFile): boolean {
  // If there are more additions than deletions by a large margin, and
  // the file is a config/style file, it might be formatting
  if (file.deletions === 0 && file.additions > 0 && file.additions <= 5) {
    // Very small addition-only changes to certain files are likely formatting
    const formattingPatterns = [
      /\.json$/,
      /\.yaml$/,
      /\.yml$/,
      /\.toml$/,
      /\.editorconfig$/,
      /\.prettierrc$/,
      /\.eslintrc/,
    ];
    return formattingPatterns.some((p) => p.test(file.path));
  }

  // If additions roughly equal deletions, it might be a find-and-replace
  // or formatting change (e.g., changing quotes, adding semicolons)
  if (file.additions > 0 && file.deletions > 0) {
    const ratio = file.additions / file.deletions;
    if (ratio >= 0.8 && ratio <= 1.2 && file.additions <= 10) {
      // Roughly equal additions and deletions, small total — likely formatting
      return isLikelyFormattingFile(file.path);
    }
  }

  return false;
}

function isLikelyFormattingFile(filePath: string): boolean {
  const formattingFiles = [
    /\.ts$/, /\.tsx$/, /\.js$/, /\.jsx$/, // JS/TS files with quote changes
    /\.css$/, /\.scss$/, // CSS property reordering
    /\.py$/, // Python import sorting
  ];
  return formattingFiles.some((p) => p.test(filePath));
}

function isTestFile(filePath: string): boolean {
  return /\/__tests__\//.test(filePath) ||
    /\.test\./.test(filePath) ||
    /\.spec\./.test(filePath) ||
    /\/tests?\//.test(filePath) ||
    /\/test\//.test(filePath);
}

function isUtilityFile(filePath: string): boolean {
  return /\/utils?\//.test(filePath) ||
    /\/helpers?\//.test(filePath) ||
    /\/shared\//.test(filePath) ||
    /\/common\//.test(filePath);
}

// ─── Format scope-creep findings for the LLM prompt ────────────────────────────

export function formatScopeCreepForPrompt(
  scopeCreep: ScopeCreep | null,
): string {
  if (!scopeCreep || scopeCreep.flagged_hunks.length === 0) {
    return "";
  }

  const lines = [
    `## Scope-Creep Analysis (PR intent: "${scopeCreep.pr_intent}")`,
    "",
    "The following changes appear unrelated to the stated PR intent. Review them critically:",
    "",
  ];

  for (const hunk of scopeCreep.flagged_hunks) {
    lines.push(`- \`${hunk.file}\` (lines ${hunk.lines}): ${hunk.reason}`);
  }

  lines.push("");
  lines.push("If any of these are intentional and necessary for this PR, acknowledge them but don't flag them as scope creep.");

  return lines.join("\n");
}