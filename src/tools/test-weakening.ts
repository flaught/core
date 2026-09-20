import type { DeterministicFinding } from "./runner.js";

const ASSERTION = /\b(?:expect|assert|require|should)\s*\(/;
const SKIP_MARKER = /(?:\.skip\b|\bx(?:it|describe)\b|@Disabled\b|pytest\.mark\.skip\b|\b(?:test|it)\.skip\b)/;

interface DiffLine {
  kind: "added" | "removed";
  file: string;
  oldLine: number;
  newLine: number;
  text: string;
}

function finding(
  title: string,
  location: DiffLine | undefined,
  snippet: string,
  ruleId: string,
  severity = "high",
  fallbackFile = "",
): DeterministicFinding {
  const line = location?.kind === "removed" ? location.oldLine : location?.newLine ?? 0;
  return {
    title,
    severity,
    category: "test-quality",
    file: location?.file || fallbackFile,
    line,
    snippet: snippet.trim(),
    source: "test_weakening",
    ruleId,
  };
}

/** Normalize for move/reindent-insensitive comparison. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Multiset difference: lines from `lines` whose normalized text does not
 * reappear in `other`. A reindented or moved line cancels out (it shows up
 * as removed+added pairs of identical content), so what remains is what was
 * genuinely deleted or genuinely introduced (issue #89).
 */
function genuinelyChanged(lines: DiffLine[], other: DiffLine[]): DiffLine[] {
  const available = new Map<string, number>();
  for (const line of other) {
    const key = normalizeText(line.text);
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  return lines.filter((line) => {
    const key = normalizeText(line.text);
    const count = available.get(key) ?? 0;
    if (count > 0) {
      available.set(key, count - 1);
      return false;
    }
    return true;
  });
}

/**
 * Whether a genuinely-removed line is an executable statement inside a test
 * body — as opposed to a comment, a lone closing brace, or a test/describe
 * header. Used to confirm an actual BODY was removed, not merely a header
 * renamed or a comment added next to intact code (issue #89).
 */
function isExecutableStatement(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^(?:\/\/|\/\*|\*)/.test(t)) return false; // comment lines
  if (/^[}\]);,(]*$/.test(t)) return false; // closing braces/parens only
  if (/\b(?:it|test|describe)\s*\(/.test(t)) return false; // callback headers
  return true;
}

/**
 * Whether an added `//` comment looks like commented-out CODE (a disabled
 * test header or assertion) rather than prose. Commenting out a test is a
 * genuine weakening; adding an explanatory comment inside a helper is not
 * (issue #89).
 */
function commentLooksLikeCode(text: string): boolean {
  const match = text.match(/^\s*\/\/\s*(.*)$/);
  if (!match) return false;
  const content = match[1] ?? "";
  return /\b(?:it|test)\s*\(/.test(content) || ASSERTION.test(content) || /[;={}]/.test(content);
}

function parseDiffLines(diff: string): DiffLine[] {
  const changedLines: DiffLine[] = [];
  let file = "";
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (header) {
      file = header[2] ?? "";
      continue;
    }

    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path !== "/dev/null") {
        file = path.startsWith("b/") ? path.slice(2) : path;
      }
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1]!, 10);
      newLine = Number.parseInt(hunk[3]!, 10);
      continue;
    }

    if (!file || oldLine < 0 || newLine < 0 || line.startsWith("\\")) {
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      changedLines.push({ kind: "removed", file, oldLine, newLine, text: line.slice(1) });
      oldLine++;
    } else if (line.startsWith("+")) {
      changedLines.push({ kind: "added", file, oldLine, newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }

  // Keep the detector useful for callers that provide only a small change
  // snippet rather than a complete git patch. Complete patches still get
  // precise file/line locations from their hunk metadata.
  if (changedLines.length === 0) {
    return diff.split(/\r?\n/).flatMap((line): DiffLine[] => {
      if (line.startsWith("-") && !line.startsWith("---")) {
        return [{ kind: "removed", file: "", oldLine: 0, newLine: 0, text: line.slice(1) }];
      }
      if (line.startsWith("+")) {
        return [{ kind: "added", file: "", oldLine: 0, newLine: 0, text: line.slice(1) }];
      }
      return [];
    });
  }

  return changedLines;
}

/** Detect common test-weakening edits introduced by the current diff. */
export function detectTestWeakening(diff: string, deletedFiles: string[] = []): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const changedLines = parseDiffLines(diff);
  const removed = changedLines.filter((line) => line.kind === "removed");
  const added = changedLines.filter((line) => line.kind === "added");

  const removedAssertions = removed.filter((line) => ASSERTION.test(line.text));
  if (removedAssertions.length > 0 && removedAssertions.length > added.filter((line) => ASSERTION.test(line.text)).length) {
    findings.push(finding("Test assertions were removed", removedAssertions[0], removedAssertions[0]!.text, "deleted-assertion"));
  }

  for (const line of added) {
    if (SKIP_MARKER.test(line.text)) {
      findings.push(finding("A test skip marker was added", line, line.text, "added-skip-marker", "medium"));
    }
  }

  const matcherPairs: Array<[RegExp, RegExp, string]> = [
    [/\.toBe\(/, /\.toBeTruthy\(/, "exact-to-truthy"],
    [/\.toEqual\(/, /\.toMatchObject\(/, "exact-to-partial"],
    [/\.toBeCloseTo\(/, /\.toBeGreaterThan\(/, "close-to-range"],
  ];

  // Correlation rules (loosened matcher, commented-out test body) must fire
  // WITHIN A SINGLE FILE. Grouping changed lines by file prevents the
  // cross-file false positive where a removed `it()` in one file and an
  // added `//` comment in another file trip a HIGH "test body replaced with
  // comments" finding pointing at the unrelated comment.
  const byFile = new Map<string, { removed: DiffLine[]; added: DiffLine[] }>();
  for (const line of changedLines) {
    let bucket = byFile.get(line.file);
    if (!bucket) {
      bucket = { removed: [], added: [] };
      byFile.set(line.file, bucket);
    }
    (line.kind === "removed" ? bucket.removed : bucket.added).push(line);
  }

  for (const { removed: rem, added: add } of byFile.values()) {
    for (const [strict, loose, ruleId] of matcherPairs) {
      if (rem.some((line) => strict.test(line.text)) && add.some((line) => loose.test(line.text))) {
        const looseLine = add.find((line) => loose.test(line.text));
        findings.push(finding("A test matcher was loosened", looseLine, looseLine?.text ?? "", ruleId));
      }
    }

    // Issue #89: fire only when the evidence survives move/reindent
    // cancellation AND an actual body was removed or code was commented out.
    // Location/snippet point at the removed test callback itself (old line
    // number), not at a nearby comment.
    const genuinelyRemoved = genuinelyChanged(rem, add);
    const genuinelyAdded = genuinelyChanged(add, rem);
    const removedTest = genuinelyRemoved.find((line) => /\b(?:it|test)\s*\(/.test(line.text));
    if (!removedTest) continue;
    const bodyRemoved = genuinelyRemoved.some((line) => isExecutableStatement(line.text));
    const codeCommentedOut = genuinelyAdded.some((line) => commentLooksLikeCode(line.text));
    if (bodyRemoved || codeCommentedOut) {
      findings.push(finding("A test body was replaced with comments", removedTest, removedTest.text, "commented-test-body"));
    }
  }

  for (const file of deletedFiles) {
    if (/(?:\.test\.|\.spec\.|(?:^|\/)test_[^/]+\.)/.test(file)) {
      const location = removed.find((line) => line.file === file);
      findings.push(finding("A test file was removed", location, file, "deleted-test-file", "high", file));
    }
  }

  return findings;
}
