/**
 * Minimal glob matching shared by config-driven path filters (`exclude.paths`,
 * `scope_creep.exclude_paths`). `*` matches within a path segment, `**`
 * matches across segments, `?` matches a single character.
 */

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/\*\*/g, "§§") // temp placeholder for **
    .replace(/\*/g, "[^/]*") // * matches anything except /
    .replace(/§§/g, ".*") // ** matches anything including /
    .replace(/\?/g, "[^/]");

  return new RegExp(`^${source}$`); // nosemgrep
}

export function matchesAnyGlob(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath));
}
