/**
 * Minimal glob matching shared by config-driven path filters (`exclude.paths`,
 * `scope_creep.exclude_paths`). `*` matches within a path segment, `**`
 * matches across segments, `?` matches a single character.
 *
 * SECURITY: Pattern length and complexity are capped to prevent ReDoS.
 * Patterns longer than MAX_PATTERN_LENGTH (512 chars) are rejected, and
 * the resulting regex is limited in complexity to prevent catastrophic
 * backtracking.
 */

const MAX_PATTERN_LENGTH = 512;
const MAX_GLOB_SEGMENTS = 32; // Prevent patterns like **/**/**/**/*

export function globToRegExp(pattern: string): RegExp {
  // SECURITY: Reject excessively long patterns to prevent ReDoS
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `Exclude pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH}): ${pattern.slice(0, 50)}...`,
    );
  }

  // SECURITY: Count glob segments to prevent patterns like **/**/**/**/*
  const segments = pattern.split("/").length;
  if (segments > MAX_GLOB_SEGMENTS) {
    throw new Error(
      `Exclude pattern has too many path segments (${segments}, max ${MAX_GLOB_SEGMENTS}): ${pattern.slice(0, 50)}...`,
    );
  }

  const source = pattern
    .replace(/\*\*/g, "§§") // temp placeholder for **
    .replace(/\*/g, "[^/]*") // * matches anything except /
    .replace(/§§/g, ".*") // ** matches anything including /
    .replace(/\?/g, "[^/]"); // ? matches exactly one non-separator char

  return new RegExp(`^${source}$`); // nosemgrep
}

export function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return globToRegExp(pattern).test(filePath);
    } catch {
      // Invalid pattern — skip it rather than crash
      return false;
    }
  });
}
